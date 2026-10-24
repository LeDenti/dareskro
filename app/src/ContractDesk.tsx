/**
 * The three contract cases on the same oracle account: the freelancer's
 * delivery, the influencer's product placement, the affiliate's commission.
 *
 * The escrow is conditional (Condition + CancelAfter): the oracle holds the
 * secret and decides *whether*, bounded by the refund date. Signing goes
 * through the parent's device session, exactly as the employee flow does: the
 * payer reads the amount, the destination, the deadline and the memos on the
 * Ledger screen before anything is locked.
 *
 * Cards: the contract (payer, beneficiary, amount, the agreed proof, the
 * condition issued by the oracle) → lock, signed on the device → what the
 * oracle sees (polled every 3 s) → for affiliate, the merchant's confirmation.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { EscrowCreate, Transaction } from "xrpl";
import * as oracle from "./oracle";
import * as xrpl from "./xrpl";

export type ContractKind = "freelance" | "influencer" | "affiliate";

const copy: Record<
  ContractKind,
  { payer: string; beneficiary: string; oracleKind: "delivery" | "presence" | "affiliate"; title: string; hint: string }
> = {
  freelance: {
    payer: "client",
    beneficiary: "freelancer",
    oracleKind: "delivery",
    title: "The contract — a delivery, proven by a hash",
    hint:
      "The oracle holds the secret and reads a public fact by itself: the file at the agreed URL has the agreed SHA-256. It cannot redirect the money; it can only block, and blocking ends at the deadline, when it refunds the client.",
  },
  influencer: {
    payer: "brand",
    beneficiary: "influencer",
    oracleKind: "presence",
    title: "The contract — a post that must still be there at the date",
    hint:
      "The oracle reads the platform: the post at the agreed address, with the agreed text, must be live at the date. Deleted post, no pay. Past the deadline, the brand is refunded.",
  },
  affiliate: {
    payer: "merchant",
    beneficiary: "affiliate",
    oracleKind: "affiliate",
    title: "The contract — a commission the merchant confirms",
    hint:
      "The merchant is a party to the dispute, so the money is locked before the sale. Its sales system confirms with a token given once; the release carries the order hash on the ledger. No confirmation by the deadline, the merchant is refunded.",
  },
};

/** SHA-256 of a text, lowercase hex, in the browser (Web Crypto needs localhost or https). */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
const utc = (iso: string) => `${iso.slice(11, 19)} UTC`;
const HEX64 = /^[0-9a-f]{64}$/i;
/** The XRP amount the signed transaction carries, without trailing zeros ("20", not "20.000000"). */
const xrpOfDrops = (drops: string) => String(Number(drops) / 1e6);

/** What the merchant's sales system would hash: the attributed order, nothing personal. */
const defaultOrderRecord = (orderRef: string) =>
  JSON.stringify(
    { orderRef, amount: "149.00 EUR", customer: "c-8841", paidAt: new Date().toISOString(), returnWindowClosed: true },
    null,
    2,
  );

export function ContractDesk(props: {
  kind: ContractKind;
  /** The connected address and public key, from the shared device card. */
  payer?: { address: string; publicKey: string };
  /** A real device (USB/BLE): shorter memos, no MemoFormat. */
  compact: boolean;
  oracleId?: oracle.OracleIdentity;
  /** Signs a prepared transaction the way the employee flow does: on the device, or with the test wallet. */
  signHex: (tx: Transaction) => Promise<string | undefined>;
  /** The device prompt and result of the last signHex, rendered by the parent. */
  signStatus: ReactNode;
  /** Clears that prompt: a new Prepare must not show the previous sign's verdict. */
  resetSign?: () => void;
  /** The shared card refreshes the payer's balance. */
  onPayerChanged: () => void;
}) {
  const { kind, payer, oracleId } = props;
  const c = copy[kind];

  // ---- the contract
  const [beneficiary, setBeneficiary] = useState("");
  const [beneficiaryBusy, setBeneficiaryBusy] = useState(false);
  const [beneficiaryError, setBeneficiaryError] = useState<unknown>();
  const [amountXrp, setAmountXrp] = useState("20");
  // freelance: the agreed proof is a URL and a hash
  const [proofUrl, setProofUrl] = useState("http://127.0.0.1:8790/livrable.txt");
  const [proofSha256, setProofSha256] = useState("");
  // influencer: the post, the text it must contain, the date it is checked at
  const [postUrl, setPostUrl] = useState("http://127.0.0.1:8791/post.html");
  const [mustContain, setMustContain] = useState("#ad @dareskro");
  const [periodSec, setPeriodSec] = useState("90");
  // affiliate: what the merchant expects to confirm, and how long the money waits
  const [orderRef, setOrderRef] = useState("ORD-2026-1045");
  const [deadlineSec, setDeadlineSec] = useState(kind === "affiliate" ? "180" : "300");
  const [cond, setCond] = useState<oracle.ConditionResponse>();
  const [condBusy, setCondBusy] = useState(false);
  const [condError, setCondError] = useState<unknown>();

  // ---- lock on the device
  const [tx, setTx] = useState<EscrowCreate>();
  const [prepareError, setPrepareError] = useState<unknown>();
  const [signing, setSigning] = useState(false);
  const [signedHex, setSignedHex] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>();
  // What was signed, read from the transaction itself: the fields may be edited afterwards, the ledger entry cannot.
  const [escrow, setEscrow] = useState<{
    owner: string;
    sequence: number;
    hash: string;
    result: string;
    destination: string;
    amountXrp: string;
    cancelAfter: Date;
    checkAfter?: Date;
  }>();

  // ---- what the oracle sees
  const [watched, setWatched] = useState<oracle.WatchedEscrow>();
  // true once the oracle has accepted the watch: before that a confirmation would be refused (409)
  const [handed, setHanded] = useState(false);
  const [oracleError, setOracleError] = useState<unknown>();
  const [beneficiaryBalance, setBeneficiaryBalance] = useState<number | null>();
  const [now, setNow] = useState(Date.now());

  // ---- affiliate: the merchant's sales system
  const [orderRecord, setOrderRecord] = useState(() => defaultOrderRecord(orderRef));
  const [orderHash, setOrderHash] = useState("");
  const [orderHashError, setOrderHashError] = useState<string>();
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<unknown>();
  const [confirmations, setConfirmations] = useState<{ label: string; status: number; body: string; error?: string }[]>([]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Same polling as the employee flow: this owner + sequence, every 3 s.
  useEffect(() => {
    if (!escrow || !oracleId) return;
    let stop = false;
    const poll = async () => {
      const mine = (await oracle.escrows()).find((e) => e.owner === escrow.owner && e.sequence === escrow.sequence);
      if (!stop && mine) setWatched(mine);
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [escrow, oracleId]);

  useEffect(() => {
    if (!escrow) return;
    if (watched?.status === "finished" && beneficiaryBalance === undefined) {
      xrpl.getBalance(escrow.destination).then(setBeneficiaryBalance);
      props.onPayerChanged();
    }
    if (watched?.status === "expired-refunded") props.onPayerChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched?.status]);

  // A prepared escrow does not outlive its fields: editing the beneficiary, the
  // amount or the dates drops the unsigned transaction (not a submitted escrow).
  useEffect(() => {
    if (!tx || escrow) return;
    setTx(undefined);
    setSignedHex(undefined);
    setPrepareError(undefined);
    props.resetSign?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beneficiary, amountXrp, periodSec, deadlineSec]);

  useEffect(() => {
    if (kind !== "affiliate") return;
    let stale = false;
    sha256Hex(orderRecord).then(
      (h) => {
        if (!stale) setOrderHash(h);
      },
      () => {
        // crypto.subtle is only there in a secure context (localhost or https)
        if (stale) return;
        setOrderHash("");
        setOrderHashError("SHA-256 needs a secure context: open the desk on localhost or https");
      },
    );
    return () => {
      stale = true;
    };
  }, [orderRecord, kind]);

  const resetLock = () => {
    setTx(undefined);
    setPrepareError(undefined);
    setSignedHex(undefined);
    props.resetSign?.();
    setSubmitError(undefined);
    setEscrow(undefined);
    setWatched(undefined);
    setHanded(false);
    setOracleError(undefined);
    setBeneficiaryBalance(undefined);
    setConfirmations([]);
    setConfirmError(undefined);
  };

  const createBeneficiary = async () => {
    setBeneficiaryBusy(true);
    setBeneficiaryError(undefined);
    try {
      setBeneficiary((await xrpl.newFundedWallet()).classicAddress);
    } catch (e) {
      setBeneficiaryError(e);
    } finally {
      setBeneficiaryBusy(false);
    }
  };

  const askCondition = async () => {
    setCondError(undefined);
    setCond(undefined);
    resetLock();
    try {
      const note = `pay desk · ${kind}`;
      let body: oracle.ConditionRequest;
      if (kind === "freelance") {
        if (!HEX64.test(proofSha256.trim())) throw new Error("the agreed SHA-256 must be 64 hex characters");
        body = { kind: "delivery", url: proofUrl.trim(), sha256: proofSha256.trim().toLowerCase(), note };
      } else if (kind === "influencer") {
        body = { kind: "presence", url: postUrl.trim(), mustContain: mustContain.trim() || undefined, note };
      } else {
        body = { kind: "affiliate", orderRef: orderRef.trim() || undefined, note };
      }
      setCondBusy(true);
      const issued = await oracle.condition(body);
      setCond(issued);
      // the record the merchant's system will hash names the order the condition was issued for
      if (kind === "affiliate") setOrderRecord(defaultOrderRecord(issued.proof.orderRef ?? orderRef.trim()));
    } catch (e) {
      setCondError(e);
    } finally {
      setCondBusy(false);
    }
  };

  const prepare = async () => {
    if (!payer || !cond || !beneficiary) return;
    resetLock();
    try {
      if (!(Number(amountXrp) > 0)) throw new Error("amount must be a positive number of XRP");
      const period = Number(periodSec) * 1000;
      const deadline = Number(deadlineSec) * 1000;
      if (kind === "influencer" ? !(period > 0) : !(deadline > 0)) throw new Error("the delay must be a positive number of seconds");
      const start = Date.now();
      // influencer: the oracle looks at the date (FinishAfter = checkAfter), the brand is refunded 120 s later if the post is gone
      const checkAfter = kind === "influencer" ? new Date(start + period) : undefined;
      const cancelAfter = checkAfter ? new Date(checkAfter.getTime() + 120_000) : new Date(start + deadline);
      const proofText = kind === "affiliate" ? cond.proof.orderRef : cond.proof.url;
      setTx(
        await xrpl.prepareConditionalEscrowCreate({
          account: payer.address,
          publicKey: payer.publicKey,
          destination: beneficiary.trim(),
          amountXrp: amountXrp.trim(),
          condition: cond.condition,
          cancelAfter,
          finishAfter: checkAfter,
          memos: [
            { type: "dareskro/case", data: kind },
            ...(proofText ? [{ type: "dareskro/proof", data: proofText }] : []),
            ...(oracleId ? [{ type: "dareskro/oracle", data: oracleId.address }] : []),
          ],
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
    if (!signedHex || !tx || !payer || !cond) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const out = await xrpl.submit(signedHex);
      // From the signed transaction, not the fields: what the device showed is what the ledger holds.
      const sequence = tx.Sequence!;
      const owner = tx.Account;
      const destination = tx.Destination;
      const amount = xrpOfDrops(tx.Amount as string);
      setEscrow({
        owner,
        sequence,
        hash: out.hash,
        result: out.result,
        destination,
        amountXrp: amount,
        cancelAfter: xrpl.fromRippleTime(tx.CancelAfter!),
        checkAfter: tx.FinishAfter ? xrpl.fromRippleTime(tx.FinishAfter) : undefined,
      });
      props.onPayerChanged();
      // Hand the escrow to the oracle: it holds the secret, so without it nothing releases before the refund.
      if (out.result === "tesSUCCESS" && oracleId) {
        try {
          const base = {
            deliveryId: cond.deliveryId,
            owner,
            sequence,
            destination,
            amountXrp: amount,
            cancelAfter: tx.CancelAfter!,
            proof: cond.proof,
            createHash: out.hash,
          };
          if (kind === "influencer") {
            await oracle.watch({ kind: "presence", ...base, checkAfter: tx.FinishAfter!, finishAfter: tx.FinishAfter! });
          } else {
            await oracle.watch({ kind: c.oracleKind, ...base });
          }
          setHanded(true);
        } catch (e) {
          setOracleError(e);
        }
      }
    } catch (e) {
      setSubmitError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const confirm = async (token: string, label: string) => {
    if (!cond || !orderHash) return;
    setConfirmBusy(true);
    setConfirmError(undefined);
    try {
      const r = await oracle.confirmAffiliate({ deliveryId: cond.deliveryId, orderHash, token });
      const error = typeof r.json.error === "string" ? r.json.error : undefined;
      setConfirmations((a) => [...a, { label, status: r.status, body: JSON.stringify(r.json), error }]);
    } catch (e) {
      setConfirmError(e);
    } finally {
      setConfirmBusy(false);
    }
  };

  const secondsTo = (d?: Date) => (d ? Math.ceil((d.getTime() - now) / 1000) : undefined);
  const toCheck = secondsTo(escrow?.checkAfter);
  const toCancel = secondsTo(escrow?.cancelAfter);
  const txLink = (hash: string, label: string) => (
    <a href={xrpl.explorerTxUrl(hash)} target="_blank">
      {label}
    </a>
  );

  return (
    <>
      <Card n="2" title={c.title} disabled={!payer}>
        <p className="hint">{c.hint}</p>
        <dl>
          <dt>Payer ({c.payer})</dt>
          <dd>
            {payer ? (
              <a href={xrpl.explorerAccountUrl(payer.address)} target="_blank">
                {payer.address}
              </a>
            ) : (
              "connect the Ledger above"
            )}
          </dd>
        </dl>
        <div className="row">
          <label className="grow">
            {c.beneficiary[0].toUpperCase() + c.beneficiary.slice(1)}'s XRPL address (destination)
            <input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} placeholder="r…" />
          </label>
          <button onClick={createBeneficiary} disabled={beneficiaryBusy}>
            {beneficiaryBusy ? "Creating…" : "Create a test beneficiary"}
          </button>
          <label>
            Amount (XRP)
            <input value={amountXrp} onChange={(e) => setAmountXrp(e.target.value)} size={8} />
          </label>
        </div>
        <ErrorBox error={beneficiaryError} />
        {kind === "freelance" && (
          <div className="row">
            <label className="grow">
              Proof URL (where the deliverable will be published)
              <input value={proofUrl} onChange={(e) => setProofUrl(e.target.value)} />
            </label>
            <label className="grow">
              Agreed SHA-256 of the deliverable (64 hex)
              <input value={proofSha256} onChange={(e) => setProofSha256(e.target.value)} placeholder="3be52427…" spellCheck={false} />
            </label>
            <label>
              Deadline (seconds)
              <input value={deadlineSec} onChange={(e) => setDeadlineSec(e.target.value)} size={6} />
            </label>
          </div>
        )}
        {kind === "influencer" && (
          <div className="row">
            <label className="grow">
              Post URL
              <input value={postUrl} onChange={(e) => setPostUrl(e.target.value)} />
            </label>
            <label className="grow">
              Required text (optional)
              <input value={mustContain} onChange={(e) => setMustContain(e.target.value)} placeholder="#ad @brand" />
            </label>
            <label>
              Checked in (seconds)
              <input value={periodSec} onChange={(e) => setPeriodSec(e.target.value)} size={6} />
            </label>
          </div>
        )}
        {kind === "affiliate" && (
          <div className="row">
            <label className="grow">
              Order reference the merchant expects (optional)
              <input value={orderRef} onChange={(e) => setOrderRef(e.target.value)} />
            </label>
            <label>
              Deadline (seconds)
              <input value={deadlineSec} onChange={(e) => setDeadlineSec(e.target.value)} size={6} />
            </label>
          </div>
        )}
        <p className="hint">
          {kind === "freelance" && "In production the deadline is the contract's: weeks. Here, seconds, so the refund can be shown live."}
          {kind === "influencer" && "In production the post is checked after 30 days. Here, seconds; the brand is refunded 120 s after the check if the post is gone."}
          {kind === "affiliate" && "In production the deadline is the end of the campaign plus the return window. Here, seconds."}
        </p>
        <div className="row">
          <button className="primary" onClick={askCondition} disabled={!payer || !oracleId || condBusy}>
            {condBusy ? "Asking…" : "Ask the oracle for the condition"}
          </button>
          {!oracleId && (
            <span className="ko">
              No oracle running (<code>cd oracle && node oracle.mjs watch</code>): a conditional escrow needs it.
            </span>
          )}
        </div>
        <ErrorBox error={condError} />
        {cond && (
          <dl>
            <dt>Delivery id</dt>
            <dd>
              <code>{cond.deliveryId}</code>
            </dd>
            <dt>Condition</dt>
            <dd>
              <code>{short(cond.condition)}</code> · PREIMAGE-SHA-256, the oracle keeps the secret
            </dd>
            <dt>Agreed proof</dt>
            <dd>
              {cond.proof.url && (
                <>
                  <a href={cond.proof.url} target="_blank">
                    {cond.proof.url}
                  </a>{" "}
                </>
              )}
              {cond.proof.sha256 && <code>sha256 {short(cond.proof.sha256)}</code>}
              {cond.proof.mustContain && (
                <>
                  must contain <code>{cond.proof.mustContain}</code>
                </>
              )}
              {cond.proof.orderRef && (
                <>
                  order <code>{cond.proof.orderRef}</code>
                </>
              )}
              {!cond.proof.url && !cond.proof.orderRef && "none: the merchant's word, with the token"}
            </dd>
            {cond.confirmToken && (
              <>
                <dt>Confirm token</dt>
                <dd>
                  <code>{cond.confirmToken}</code>
                  <br />
                  <span className="muted">given once to the merchant's sales system; the oracle keeps only its SHA-256</span>
                </dd>
              </>
            )}
          </dl>
        )}
      </Card>

      <Card n="3" title="Lock, signed on the device — EscrowCreate with Condition and CancelAfter" disabled={!cond || !beneficiary}>
        <p className="hint">
          What the device shows: the amount, the destination, the refund date{kind === "influencer" && ", the check date"} and the memos: the case,
          the agreed proof, the oracle. Once signed, only the oracle's secret or the deadline moves the money.
        </p>
        <div className="row">
          <button onClick={prepare} disabled={!payer || !cond || !beneficiary}>
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
              Unsigned EscrowCreate · {xrpl.dropsToXrpString(tx.Amount as string)} XRP · refund after{" "}
              {xrpl.fromRippleTime(tx.CancelAfter!).toLocaleTimeString()}
              {tx.FinishAfter && ` · checked at ${xrpl.fromRippleTime(tx.FinishAfter).toLocaleTimeString()}`}
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
        {escrow && (
          <p className={escrow.result === "tesSUCCESS" ? "ok" : "ko"}>
            {escrow.result} · escrow #{escrow.sequence} · {txLink(escrow.hash, "see it on the explorer")}
          </p>
        )}
        <ErrorBox error={oracleError} />
      </Card>

      <Card n="4" title="What the oracle sees" disabled={!escrow}>
        {escrow && (
          <p className="hint">
            {escrow.checkAfter &&
              `Checked at ${escrow.checkAfter.toLocaleTimeString()} (${toCheck! > 0 ? `${toCheck} s to go` : "passed"}) · `}
            Refund after {escrow.cancelAfter.toLocaleTimeString()} ({toCancel! > 0 ? `${toCancel} s to go` : "passed"}).
          </p>
        )}
        {escrow && oracleId && (
          <p className={watched?.status === "finished" ? "ok" : watched?.status === "expired-refunded" ? "ko" : "pending"}>
            Oracle {oracleId.address.slice(0, 8)}…:{" "}
            {!watched && "not watching this escrow yet"}
            {watched?.status === "waiting" && kind === "freelance" && (
              <>
                watching the URL · {watched.checks ?? 0} checks · {watched.lastWhy ?? "no look yet"}
              </>
            )}
            {watched?.status === "waiting" && kind === "influencer" && (
              <>
                {toCheck! > 0 ? "watching the post until the date" : `deciding · ${watched.checks ?? 0} looks`} ·{" "}
                {watched.lastSeen
                  ? `last seen ${watched.lastSeen.live ? "LIVE" : "NOT LIVE"} at ${utc(watched.lastSeen.at)}${watched.lastSeen.why ? ` (${watched.lastSeen.why})` : ""}`
                  : "no look yet"}
                {watched.lastWhy && ` · ${watched.lastWhy}`}
              </>
            )}
            {watched?.status === "waiting" && kind === "affiliate" && (
              <>
                money locked, nothing to poll:{" "}
                {watched.confirmed
                  ? `the merchant confirmed at ${utc(watched.confirmed.at)} (order ${short(watched.confirmed.orderHash)}), finishing on the next tick`
                  : "waiting for the merchant's confirmation, refund at the deadline"}
              </>
            )}
            {watched?.status === "finished" && (
              <>
                finished at {watched.finishedAt ? utc(watched.finishedAt) : "?"} · {txLink(watched.finishHash!, "EscrowFinish with the fulfillment, signed by the oracle")}
                {watched.orderHash && (
                  <>
                    {" "}
                    · order hash in the memo: <code>{watched.orderHash}</code>
                  </>
                )}
              </>
            )}
            {watched?.status === "expired-refunded" && (
              <>
                no proof by the deadline: refunded the {c.payer} · {watched.refundHash && txLink(watched.refundHash, "EscrowCancel signed by the oracle")}
              </>
            )}
            {watched?.status === "gone" && `nothing left to do: ${watched.note}`}
            {watched?.status === "failed" && `gave up after ${watched.attempts} tries (${watched.lastResult})`}
          </p>
        )}
        {beneficiaryBalance !== undefined && (
          <p className="ok">
            {c.beneficiary[0].toUpperCase() + c.beneficiary.slice(1)} balance: {beneficiaryBalance === null ? "?" : `${beneficiaryBalance} XRP`} ·{" "}
            <a href={xrpl.explorerAccountUrl(escrow?.destination ?? beneficiary)} target="_blank">
              account
            </a>
          </p>
        )}
        {kind === "freelance" && escrow && (
          <p className="hint">
            Publish the agreed file at the proof URL and the oracle pays on its next look; publish anything else and it says why it does not.
            A third party without the secret gets tecCRYPTOCONDITION_ERROR (measured, see README).
          </p>
        )}
      </Card>

      {kind === "affiliate" && (
        <Card n="5" title="The merchant's sales system confirms the order" disabled={!escrow || !cond?.confirmToken}>
          <p className="hint">
            The merchant is a party: it does not reveal the secret, it tells the oracle, with the token given once, that the sale is attributed.
            The oracle finishes with the order's SHA-256 in a memo, so the release can be matched to the order forever.
          </p>
          <label className="grow">
            Order record (what the sales system hashes; stays off the ledger)
            <textarea value={orderRecord} onChange={(e) => setOrderRecord(e.target.value)} rows={7} spellCheck={false} />
          </label>
          <dl>
            <dt>SHA-256</dt>
            <dd>
              <code>{orderHash || "…"}</code>
              {orderHashError && <span className="ko"> · {orderHashError}</span>}
            </dd>
          </dl>
          <div className="row">
            <button className="primary" onClick={() => confirm(cond!.confirmToken!, "Confirm the sale (right token)")} disabled={!escrow || !handed || !cond?.confirmToken || !orderHash || confirmBusy}>
              Confirm the sale
            </button>
            <button onClick={() => confirm("not-the-merchants-token", "Wrong token")} disabled={!escrow || !handed || !cond || !orderHash || confirmBusy}>
              Wrong token
            </button>
          </div>
          <ErrorBox error={confirmError} />
          {confirmations.length > 0 && (
            <table className="lines">
              <tbody>
                {confirmations.map((a, i) => (
                  <tr key={i}>
                    <td>{a.label}</td>
                    <td className={a.status === 202 || (a.label === "Wrong token" && a.status === 403) ? "ok" : "ko"}>
                      HTTP {a.status}
                      {a.status === 202 && " (accepted: the oracle finishes on its next tick)"}
                      {a.status === 403 && " (refused: bad token)"}
                      {a.status >= 400 && a.status !== 403 && ` (${a.error ?? "refused"})`}
                    </td>
                    <td className="muted">
                      <code>{a.body}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}

/** Same markup as App.tsx's Card; kept here so this file does not import App. */
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
