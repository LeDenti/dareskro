/**
 * Placement desk — BottomRadar pays a creator for a publication that must
 * still be online, with the agreed text, at the end of the period.
 *
 * The first real use of dareskro: the advertiser is BottomRadar (Julien's own
 * site), the creators are X accounts, YouTube channels, newsletters. The desk
 * talks to the placement service (placements/server.mjs), which keeps the
 * campaigns and talks to the oracle; signing goes through the parent's device
 * session, exactly as the other cases do.
 *
 * Cards: the campaign (creator, publication, text, amount, dates; a look at the
 * URL now; the contract hashed into the memo) → lock, signed on the device →
 * what the oracle sees (every look it kept, the release or the refund) and the
 * link to give the creator.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { EscrowCreate, Transaction } from "xrpl";
import type * as oracle from "./oracle";
import * as placements from "./placements";
import * as xrpl from "./xrpl";

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
const utc = (iso: string) => `${iso.slice(11, 19)} UTC`;
const xrpOfDrops = (drops: string) => String(Number(drops) / 1e6);
/** datetime-local wants local time without zone, to the minute. */
const toLocalInput = (d: Date) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 16);
};
const plusDays = (days: number) => new Date(Date.now() + days * 86400 * 1000);

const STATUS_WORDS: Record<placements.CampaignStatus, string> = {
  draft: "draft — not locked yet",
  locked: "locked — handed to the oracle",
  watching: "locked — the oracle watches the publication until the date",
  deciding: "date passed — the oracle reads the publication and decides",
  released: "RELEASED — the publication was live at the date, the creator is paid",
  refunded: "REFUNDED — the publication was not live at the date, the advertiser got its money back",
  gone: "gone — someone else finished or cancelled the escrow",
  failed: "failed — the oracle gave up, see the explorer",
  invalid: "invalid",
};

export function PlacementDesk(props: {
  payer?: { address: string; publicKey: string };
  compact: boolean;
  oracleId?: oracle.OracleIdentity;
  signHex: (tx: Transaction) => Promise<string | undefined>;
  signStatus: ReactNode;
  resetSign?: () => void;
  onPayerChanged: () => void;
}) {
  const { payer, oracleId } = props;

  // ---- the service and the existing campaigns
  const [serviceUp, setServiceUp] = useState<boolean>();
  const [all, setAll] = useState<placements.Campaign[]>([]);
  const refreshList = async () => {
    const up = await placements.alive();
    setServiceUp(up);
    if (up) setAll(await placements.list());
  };
  useEffect(() => {
    refreshList();
  }, []);

  // ---- the campaign form
  const [handle, setHandle] = useState("");
  const [creator, setCreator] = useState("");
  const [creatorBusy, setCreatorBusy] = useState(false);
  const [creatorError, setCreatorError] = useState<unknown>();
  const [url, setUrl] = useState("");
  const [mustContain, setMustContain] = useState("bottomradar.com");
  const [amountXrp, setAmountXrp] = useState("25");
  const [periodEnd, setPeriodEnd] = useState(() => toLocalInput(plusDays(30)));
  const [deadline, setDeadline] = useState(() => toLocalInput(plusDays(37)));
  const [publicUrl, setPublicUrl] = useState(false);
  const [rehearsalS, setRehearsalS] = useState("120");
  const [look, setLook] = useState<placements.Observation>();
  const [lookBusy, setLookBusy] = useState(false);
  const [lookError, setLookError] = useState<unknown>();
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<unknown>();

  // ---- the campaign being worked on
  const [camp, setCamp] = useState<placements.Campaign>();

  // ---- lock on the device
  const [tx, setTx] = useState<EscrowCreate>();
  const [prepareError, setPrepareError] = useState<unknown>();
  const [signing, setSigning] = useState(false);
  const [signedHex, setSignedHex] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>();
  const [submitted, setSubmitted] = useState<{ hash: string; result: string; sequence: number }>();
  const [handOverError, setHandOverError] = useState<unknown>();
  const [creatorBalance, setCreatorBalance] = useState<number | null>();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll the campaign every 5 s once it exists: the service merges the oracle's entry and the observations.
  useEffect(() => {
    if (!camp?.id) return;
    let stop = false;
    const poll = async () => {
      try {
        const fresh = await placements.get(camp.id);
        if (!stop) setCamp(fresh);
      } catch {
        /* service gone for a moment */
      }
    };
    const t = setInterval(poll, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camp?.id]);

  useEffect(() => {
    if (!camp) return;
    if (camp.status === "released" && creatorBalance === undefined) {
      xrpl.getBalance(camp.contract.creator.address).then(setCreatorBalance);
      props.onPayerChanged();
    }
    if (camp.status === "refunded") props.onPayerChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camp?.status]);

  const resetLock = () => {
    setTx(undefined);
    setPrepareError(undefined);
    setSignedHex(undefined);
    props.resetSign?.();
    setSubmitError(undefined);
    setSubmitted(undefined);
    setHandOverError(undefined);
    setCreatorBalance(undefined);
  };

  const createTestCreator = async () => {
    setCreatorBusy(true);
    setCreatorError(undefined);
    try {
      setCreator((await xrpl.newFundedWallet()).classicAddress);
    } catch (e) {
      setCreatorError(e);
    } finally {
      setCreatorBusy(false);
    }
  };

  const rehearsal = () => {
    const s = Number(rehearsalS) || 120;
    setPeriodEnd(toLocalInput(new Date(Date.now() + s * 1000)));
    setDeadline(toLocalInput(new Date(Date.now() + 2 * s * 1000)));
  };

  const lookNow = async () => {
    setLookBusy(true);
    setLookError(undefined);
    setLook(undefined);
    try {
      setLook(await placements.observeNow(url.trim(), mustContain.trim()));
    } catch (e) {
      setLookError(e);
    } finally {
      setLookBusy(false);
    }
  };

  const createCampaign = async () => {
    setCreateBusy(true);
    setCreateError(undefined);
    resetLock();
    try {
      // datetime-local is local time: Date parses it as such; seconds are kept for rehearsals under a minute
      const pe = new Date(periodEnd);
      const dl = new Date(deadline);
      if (Number.isNaN(pe.getTime()) || Number.isNaN(dl.getTime())) throw new Error("pick the check date and the deadline");
      const c = await placements.create({
        advertiser: { name: "BottomRadar", address: payer?.address },
        creator: { address: creator.trim(), handle: handle.trim() || undefined },
        url: url.trim(),
        mustContain: mustContain.trim(),
        amountXrp: amountXrp.trim(),
        periodEnd: pe.toISOString(),
        deadline: dl.toISOString(),
        publicUrl,
        // rehearsals (under an hour) are looked at every 20 s, real campaigns every 5 min
        probeEveryS: pe.getTime() - Date.now() < 3600 * 1000 ? 20 : 300,
        note: "pay desk · placement",
      });
      setCamp(c);
      refreshList();
    } catch (e) {
      setCreateError(e);
    } finally {
      setCreateBusy(false);
    }
  };

  const open = async (id: string) => {
    resetLock();
    setCreateError(undefined);
    try {
      setCamp(await placements.get(id));
    } catch (e) {
      setCreateError(e);
    }
  };

  const prepare = async () => {
    if (!payer || !camp) return;
    resetLock();
    try {
      setTx(
        await xrpl.prepareConditionalEscrowCreate({
          account: payer.address,
          publicKey: payer.publicKey,
          destination: camp.contract.creator.address,
          amountXrp: camp.contract.amountXrp,
          condition: camp.condition,
          cancelAfter: xrpl.fromRippleTime(camp.cancelAfter),
          finishAfter: xrpl.fromRippleTime(camp.finishAfter),
          memos: props.compact ? camp.memosCompact : camp.memos,
          compact: props.compact,
        }),
      );
    } catch (e) {
      setPrepareError(e);
    }
  };

  const sign = async () => {
    if (!tx) return;
    setSignedHex(undefined);
    setSigning(true);
    try {
      setSignedHex(await props.signHex(tx));
    } finally {
      setSigning(false);
    }
  };

  const submit = async () => {
    if (!signedHex || !tx || !camp) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const out = await xrpl.submit(signedHex);
      setSubmitted({ hash: out.hash, result: out.result, sequence: tx.Sequence! });
      props.onPayerChanged();
      if (out.result === "tesSUCCESS") {
        try {
          const r = await placements.locked(camp.id, { owner: tx.Account, sequence: tx.Sequence!, createHash: out.hash });
          setCamp(r.campaign);
          refreshList();
        } catch (e) {
          setHandOverError(e);
        }
      }
    } catch (e) {
      setSubmitError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const secondsTo = (iso?: string) => (iso ? Math.ceil((new Date(iso).getTime() - now) / 1000) : undefined);
  const toCheck = secondsTo(camp?.contract.periodEnd);
  const toCancel = secondsTo(camp?.contract.deadline);
  const countdown = (s?: number) => (s === undefined ? "" : s > 0 ? (s > 7200 ? `${Math.round(s / 3600)} h to go` : `${s} s to go`) : "passed");
  const txLink = (hash: string, label: string) => (
    <a href={xrpl.explorerTxUrl(hash)} target="_blank">
      {label}
    </a>
  );
  const formOk = !!payer && !!creator.trim() && !!url.trim() && !!mustContain.trim() && Number(amountXrp) > 0;
  const lockedCamp = camp?.escrow;
  const observations = camp?.observations ?? [];

  return (
    <>
      <Card n="2" title="The campaign — BottomRadar pays a creator for a publication that stays online" disabled={!payer}>
        <p className="hint">
          The money is locked before the publication, behind a condition only the oracle can fulfil, and only after the date. At the date
          the oracle reads the publication like anyone would: still there, with the agreed text → the creator is paid. Deleted, or text
          removed → the advertiser is refunded at the deadline. Nobody holds the money in between.
        </p>
        {serviceUp === false && (
          <p className="ko">
            No placement service (<code>cd placements && npm install && node server.mjs</code>): the campaigns live there.
          </p>
        )}
        {all.length > 0 && (
          <details>
            <summary>{all.length} existing campaign(s) — open one to follow it</summary>
            <table className="lines">
              <tbody>
                {all
                  .slice()
                  .reverse()
                  .map((c) => (
                    <tr key={c.id}>
                      <td>
                        <code>{c.id}</code>
                      </td>
                      <td>{c.contract.creator.handle ?? short(c.contract.creator.address)}</td>
                      <td className="muted">{c.contract.publication.url.slice(0, 50)}</td>
                      <td className="num">{c.contract.amountXrp} XRP</td>
                      <td className="muted">{c.contract.periodEnd.slice(0, 16).replace("T", " ")}Z</td>
                      <td>{c.status}</td>
                      <td>
                        <button onClick={() => open(c.id)} disabled={camp?.id === c.id}>
                          {camp?.id === c.id ? "open" : "Open"}
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        )}
        <div className="row">
          <label>
            Creator (handle, optional)
            <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@creator" size={14} />
          </label>
          <label className="grow">
            Creator's XRPL address (paid there, written in the escrow)
            <input value={creator} onChange={(e) => setCreator(e.target.value)} placeholder="r…" />
          </label>
          <button onClick={createTestCreator} disabled={creatorBusy}>
            {creatorBusy ? "Creating…" : "Create a test creator"}
          </button>
          <label>
            Amount (XRP)
            <input value={amountXrp} onChange={(e) => setAmountXrp(e.target.value)} size={8} />
          </label>
        </div>
        <ErrorBox error={creatorError} />
        <div className="row">
          <label className="grow">
            Publication URL (an X post, a YouTube video, any page)
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://x.com/creator/status/…" />
          </label>
          <label className="grow">
            Required text (must be in the publication, and stay)
            <input value={mustContain} onChange={(e) => setMustContain(e.target.value)} />
          </label>
          <button onClick={lookNow} disabled={!url.trim() || lookBusy || serviceUp === false}>
            {lookBusy ? "Looking…" : "Look at the URL now"}
          </button>
        </div>
        <ErrorBox error={lookError} />
        {look && (
          <p className={look.ok ? "ok" : "ko"}>
            {look.platform}/{look.method} · HTTP {look.status} · {look.why}
            {look.jsRendered && " · this page draws itself in JavaScript: the oracle cannot read its text"}
            {look.bodySha256 && (
              <span className="muted">
                {" "}
                · sha256 {short(look.bodySha256)}
              </span>
            )}
          </p>
        )}
        <div className="row">
          <label>
            Checked at (end of the period)
            <input type="datetime-local" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </label>
          <label>
            Deadline (refund after)
            <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
          <label>
            Rehearsal: check in (s)
            <input value={rehearsalS} onChange={(e) => setRehearsalS(e.target.value)} size={5} />
          </label>
          <button onClick={rehearsal}>Set rehearsal dates</button>
          <label className="check">
            <input type="checkbox" checked={publicUrl} onChange={(e) => setPublicUrl(e.target.checked)} />
            &nbsp;write the URL in clear on the ledger (otherwise only its SHA-256, until the publication exists)
          </label>
        </div>
        <p className="hint">
          In production: checked after 30 days, refund 7 days later. The oracle looks every 5 minutes before the date (every 20 s in a
          rehearsal) and keeps every look as evidence.
        </p>
        <div className="row">
          <button className="primary" onClick={createCampaign} disabled={!formOk || !oracleId || createBusy || serviceUp === false}>
            {createBusy ? "Creating…" : "Create the campaign (the oracle issues the condition)"}
          </button>
          {!oracleId && (
            <span className="ko">
              No oracle running (<code>cd oracle && node oracle.mjs watch</code>): the campaign needs it.
            </span>
          )}
        </div>
        <ErrorBox error={createError} />
        {camp && (
          <dl>
            <dt>Campaign</dt>
            <dd>
              <code>{camp.id}</code> · {STATUS_WORDS[camp.status] ?? camp.status}
            </dd>
            <dt>Contract SHA-256</dt>
            <dd>
              <code>{camp.contractSha256}</code>
              <br />
              <span className="muted">goes in the memo dareskro/placement-sha256; the creator's page shows the JSON it hashes</span>
            </dd>
            <dt>Condition</dt>
            <dd>
              <code>{short(camp.condition)}</code> · PREIMAGE-SHA-256, the oracle keeps the secret (delivery id <code>{camp.deliveryId}</code>)
            </dd>
            <dt>Agreed</dt>
            <dd>
              <a href={camp.contract.publication.url} target="_blank">
                {camp.contract.publication.url}
              </a>{" "}
              ({camp.contract.publication.platform}) must contain <code>{camp.contract.publication.mustContain}</code> at{" "}
              {new Date(camp.contract.periodEnd).toLocaleString()} · refund after {new Date(camp.contract.deadline).toLocaleString()}
            </dd>
            <dt>Memos</dt>
            <dd>
              {(props.compact ? camp.memosCompact : camp.memos).map((m) => (
                <div key={m.type}>
                  <code>{m.type}</code> = <code>{m.data}</code>
                </div>
              ))}
            </dd>
            <dt>Creator's page</dt>
            <dd>
              <a href={camp.links.creator} target="_blank">
                {camp.links.creator}
              </a>{" "}
              <span className="muted">— give this link to the creator: what to publish, when it is paid, the escrow, what the oracle sees</span>
            </dd>
          </dl>
        )}
      </Card>

      <Card n="3" title="Lock, signed on the device — EscrowCreate with Condition, FinishAfter and CancelAfter" disabled={!camp || !!lockedCamp}>
        <p className="hint">
          What the device shows: the amount, the creator's address, the check date, the refund date, and the memos: the case, the contract
          hash{props.compact ? "" : ", the agreed proof"}, the oracle. Once signed, only the oracle's secret after the date, or the deadline, moves the money.
        </p>
        {lockedCamp ? (
          <p className="ok">
            Locked on {new Date(lockedCamp.lockedAt).toLocaleString()} · escrow #{lockedCamp.sequence} of {short(lockedCamp.owner)} ·{" "}
            {txLink(lockedCamp.createHash, "see it on the explorer")}
          </p>
        ) : (
          <>
            <div className="row">
              <button onClick={prepare} disabled={!payer || !camp}>
                1. Prepare
              </button>
              <button className="primary" onClick={sign} disabled={!tx || signing}>
                {signing ? "Signing…" : "2. Sign on the Ledger"}
              </button>
              <button onClick={submit} disabled={!signedHex || submitting}>
                {submitting ? "Submitting…" : "3. Submit to XRPL"}
              </button>
            </div>
            <ErrorBox error={prepareError} />
            {tx && (
              <details>
                <summary>
                  Unsigned EscrowCreate · {xrpOfDrops(tx.Amount as string)} XRP · checked at {xrpl.fromRippleTime(tx.FinishAfter!).toLocaleString()} ·
                  refund after {xrpl.fromRippleTime(tx.CancelAfter!).toLocaleString()}
                </summary>
                <pre>{JSON.stringify(tx, null, 2)}</pre>
              </details>
            )}
            {props.signStatus}
            {signedHex && (
              <details>
                <summary>Signed by the device (hex)</summary>
                <pre className="wrap">{signedHex}</pre>
              </details>
            )}
            <ErrorBox error={submitError} />
            {submitted && (
              <p className={submitted.result === "tesSUCCESS" ? "ok" : "ko"}>
                {submitted.result} · escrow #{submitted.sequence} · {txLink(submitted.hash, "see it on the explorer")}
              </p>
            )}
            <ErrorBox error={handOverError} />
          </>
        )}
      </Card>

      <Card n="4" title="What the oracle sees — and what the creator can see too" disabled={!lockedCamp}>
        {camp && lockedCamp && (
          <>
            <p className="hint">
              Checked at {new Date(camp.contract.periodEnd).toLocaleString()} ({countdown(toCheck)}) · refund after{" "}
              {new Date(camp.contract.deadline).toLocaleString()} ({countdown(toCancel)}) · the oracle looks every {camp.probeEveryS} s before the date.
            </p>
            <p className={camp.status === "released" ? "ok" : camp.status === "refunded" ? "ko" : "pending"}>
              {STATUS_WORDS[camp.status] ?? camp.status}
              {camp.oracle?.lastSeen && (
                <>
                  {" "}
                  · last look {utc(camp.oracle.lastSeen.at)}: {camp.oracle.lastSeen.live ? "LIVE with the text" : (camp.oracle.lastSeen as { online?: boolean }).online ? "online WITHOUT the text" : "NOT LIVE"}
                  {camp.oracle.lastSeen.why && ` (${camp.oracle.lastSeen.why})`}
                </>
              )}
            </p>
            {camp.links.release && <p className="ok">{txLink(camp.oracle!.finishHash!, "EscrowFinish with the fulfillment, signed by the oracle")}</p>}
            {camp.links.refund && <p className="ko">{txLink(camp.oracle!.refundHash!, "EscrowCancel signed by the oracle: the advertiser is refunded")}</p>}
            {creatorBalance !== undefined && (
              <p className="ok">
                Creator balance: {creatorBalance === null ? "?" : `${creatorBalance} XRP`} ·{" "}
                <a href={camp.links.creatorAccount} target="_blank">
                  account
                </a>
              </p>
            )}
            {observations.length > 0 ? (
              <>
                <p className="hint">
                  {observations.length} observation(s) kept by the oracle (oracle/observations/{camp.deliveryId}.jsonl), latest first:
                </p>
                <table className="lines">
                  <tbody>
                    {observations
                      .slice(-12)
                      .reverse()
                      .map((o, i) => (
                        <tr key={`${o.at}-${i}`}>
                          <td className="muted">{utc(o.at)}</td>
                          <td>{o.phase === "decision" ? "decision" : "watch"}</td>
                          <td className={o.ok ? "ok" : "ko"}>{o.ok ? "live + text" : o.live ? "online, no text" : "not live"}</td>
                          <td className="muted">
                            {o.platform}/{o.method} {o.status}
                          </td>
                          <td>{o.why}</td>
                          <td className="muted">
                            <code>{o.bodySha256 ? short(o.bodySha256) : "—"}</code>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="hint">No look yet: the oracle's first look comes within its tick.</p>
            )}
            <p className="hint">
              The creator follows the same facts on{" "}
              <a href={camp.links.creator} target="_blank">
                {camp.links.creator}
              </a>
              . Delete the publication (or the text) before the date and the oracle refunds instead of paying — measured, see README.
            </p>
          </>
        )}
      </Card>
    </>
  );
}

function Card(props: { n: string; title: string; disabled?: boolean; children: ReactNode }) {
  return (
    <section className={props.disabled ? "card disabled" : "card"}>
      <h2>
        <span className="step">Step {props.n}</span> {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as { message?: string };
  return <pre className="error wrap">{e.message ?? String(error)}</pre>;
}
