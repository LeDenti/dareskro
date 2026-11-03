/**
 * The Solana rail of the same pay desk. Same statement, same human validation,
 * same escrow with one possible outcome — on Solana, through the local service
 * solana/desk/desk_solana.mjs (the employer's key) and the Solana oracle behind it.
 *
 * Cards: the rail (service, employer, employee, oracle, rate); the statement
 * (bulletin.json, validated by name); funding from any chain (Aurora Intents:
 * a real quote for the statement's USDC, and the run of 1 Nov 2026 on mainnet);
 * the lock (payroll escrow, finish_after, memos); the proofs (three forbidden
 * actions sent without preflight, refused on chain); the registry (the chain
 * itself, merged with the oracle's word).
 */
import { useEffect, useState, type ReactNode } from "react";
import * as solana from "./solana";

type Statement = {
  statement_id: string;
  employee: { label: string; badge: string };
  period: string;
  lines: { item: string; detail: string; amount: string }[];
  total: string;
  currency: string;
  net_to_pay?: string;
  sha256: string;
  computed_by: string;
  computed_at: string;
};

const short = (s: string, n = 8) => `${s.slice(0, n)}…${s.slice(-4)}`;
const fmtDate = (unix: number | null) => (unix == null ? "—" : new Date(unix * 1000).toISOString().slice(0, 19).replace("T", " ") + "Z");

export function SolanaDesk() {
  // ---- the rail
  const [id, setId] = useState<solana.Identity>();
  const [idChecked, setIdChecked] = useState(false);
  const refreshId = async () => {
    setId(await solana.identity());
    setIdChecked(true);
  };
  useEffect(() => {
    refreshId();
    const t = setInterval(refreshId, 10000);
    return () => clearInterval(t);
  }, []);

  // ---- the statement
  const [statement, setStatement] = useState<Statement>();
  const [statementError, setStatementError] = useState<unknown>();
  const [validatorName, setValidatorName] = useState("");
  const [validation, setValidation] = useState<{ by: string; at: string }>();
  const loadStatement = async () => {
    setStatementError(undefined);
    setValidation(undefined);
    try {
      const res = await fetch(`/bulletin.json?t=${Date.now()}`);
      if (!res.ok) throw new Error(`bulletin.json: ${res.status}`);
      setStatement(await res.json());
    } catch (e) {
      setStatementError(e);
    }
  };
  useEffect(() => {
    loadStatement();
  }, []);
  const amount = statement ? Number(statement.net_to_pay ?? statement.total) : 0;
  const currency = statement?.currency ?? "USD";

  // ---- funding from any chain
  const [tokens, setTokens] = useState<solana.FundToken[]>([]);
  const [origin, setOrigin] = useState("nep141:xrp.omft.near");
  const [refundTo, setRefundTo] = useState("rNY2Vc9hBPBcbZZVqzLgzxtTp7e9wVGknb");
  const [quote, setQuote] = useState<solana.FundQuote>();
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState<unknown>();
  const [proof, setProof] = useState<solana.FundProof>();
  useEffect(() => {
    if (!id) return;
    solana.fundTokens().then((t) => setTokens(t.tokens)).catch(() => setTokens([]));
    solana.fundProof().then(setProof);
  }, [id?.employer.address]);
  const askQuote = async () => {
    setQuoteBusy(true);
    setQuoteError(undefined);
    setQuote(undefined);
    try {
      setQuote(await solana.fundQuote(origin, amount, refundTo.trim(), true));
    } catch (e) {
      setQuoteError(e);
    } finally {
      setQuoteBusy(false);
    }
  };

  // ---- the lock
  const [destination, setDestination] = useState("");
  const [delayS, setDelayS] = useState(90);
  const [scale, setScale] = useState(1);
  const [lockBusy, setLockBusy] = useState(false);
  const [lockError, setLockError] = useState<unknown>();
  const [locked, setLocked] = useState<solana.LockRecord>();
  useEffect(() => {
    if (id && !destination) setDestination(id.employee.address);
  }, [id?.employee.address]);
  const neededSol = id?.rate ? amount / id.rate.usdPerSol / scale : undefined;
  const canLock = !!id && !!statement && !!validation && !!destination && !locked && !lockBusy && neededSol !== undefined && (id.employer.balanceSol ?? 0) > neededSol + 0.01;
  const doLock = async () => {
    if (!statement || !validation) return;
    setLockBusy(true);
    setLockError(undefined);
    try {
      const r = await solana.lock({
        statementSha256: statement.sha256,
        statementId: statement.statement_id,
        fiat: { amount: String(amount), currency },
        destination: destination.trim(),
        finishAfterS: delayS,
        kind: "payroll",
        scale,
        validatedBy: validation.by,
      });
      setLocked(r);
      setAttempts([]);
      refreshId();
    } catch (e) {
      setLockError(e);
    } finally {
      setLockBusy(false);
    }
  };
  const resetLock = () => {
    setLocked(undefined);
    setAttempts([]);
    setLockError(undefined);
  };

  // ---- the proofs
  const [attempts, setAttempts] = useState<solana.Attempt[]>([]);
  const [attemptBusy, setAttemptBusy] = useState<string>();
  const [attemptError, setAttemptError] = useState<unknown>();
  const tryIt = async (what: solana.Attempt["what"]) => {
    if (!locked) return;
    setAttemptBusy(what);
    setAttemptError(undefined);
    try {
      const a = await solana.attempt(locked.escrow, what);
      setAttempts((xs) => [...xs, a]);
    } catch (e) {
      setAttemptError(e);
    } finally {
      setAttemptBusy(undefined);
    }
  };

  // ---- the registry: the chain itself, every 5 s
  const [registry, setRegistry] = useState<solana.OnChainEscrow[]>([]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const poll = async () => {
      try {
        const all = await solana.escrows();
        if (!stop) setRegistry(all);
      } catch {
        /* the service will be back */
      }
    };
    poll();
    const t = setInterval(poll, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop = true;
      clearInterval(t);
      clearInterval(tick);
    };
  }, [id?.employer.address]);
  const mine = locked ? registry.find((e) => e.address === locked.escrow) : undefined;
  const secondsToDate = locked?.finishAfter ? Math.ceil((locked.finishAfter * 1000 - now) / 1000) : undefined;
  const originToken = tokens.find((t) => t.assetId === origin);

  return (
    <>
      <Card n="1" title="The Solana rail — same desk, another ledger">
        <p className="hint">
          The escrow is a program with no owner: funds sit in a program-derived account, the destination is fixed at creation, anyone may release,
          nobody can redirect, nobody can take it back before the date. The employer signs with a key held by the local desk service, not a Ledger:
          on Solana the hardware path is not built yet.
        </p>
        {!idChecked && <p className="pending">Looking for the desk service…</p>}
        {idChecked && !id && (
          <p className="ko">
            No desk service on 127.0.0.1:8790. Start it: <code>cd solana/desk && node oracle_solana.mjs watch</code> and <code>node desk_solana.mjs</code>.
          </p>
        )}
        {id && (
          <dl>
            <dt>Cluster · program</dt>
            <dd>
              {id.cluster} · <a href={id.programExplorer} target="_blank" rel="noreferrer">{short(id.programId)}</a>
            </dd>
            <dt>Employer</dt>
            <dd>
              <a href={id.employer.explorer} target="_blank" rel="noreferrer">{id.employer.address}</a> · {id.employer.balanceSol?.toFixed(3) ?? "?"} SOL
            </dd>
            <dt>Employee (demo wallet)</dt>
            <dd>
              <a href={id.employee.explorer} target="_blank" rel="noreferrer">{id.employee.address}</a> · {id.employee.balanceSol?.toFixed(4) ?? "?"} SOL
            </dd>
            <dt>Oracle</dt>
            <dd>
              {id.oracle ? (
                <>
                  <a href={id.oracle.explorer} target="_blank" rel="noreferrer">{id.oracle.address}</a> · {id.oracle.balanceSol?.toFixed(3)} SOL for fees · watching {id.oracle.watching}
                </>
              ) : (
                <span className="ko">not running — the release stays manual, the escrow does not depend on it</span>
              )}
            </dd>
            <dt>Rate</dt>
            <dd>{id.rate ? `1 SOL = ${id.rate.usdPerSol} USD (${id.rate.source})` : "—"}</dd>
            <dt>Fee per act</dt>
            <dd>
              {id.fee ? (
                <>
                  {id.fee.feeBps || id.fee.feeMinSol
                    ? `${id.fee.feeBps} bps of the SOL locked, floor ${id.fee.feeMinSol} SOL — paid by the employer on top, never out of the employee's amount`
                    : "zero (the administrator has not set one)"}
                  ; capped by the program at {id.fee.ceiling.bps} bps / {id.fee.ceiling.minSol} SOL whoever administers · {id.fee.actsCharged} act(s) charged, {id.fee.feesHeldSol.toFixed(4)} SOL in the till ·{" "}
                  <a href={id.fee.explorer} target="_blank" rel="noreferrer">
                    schedule
                  </a>
                </>
              ) : (
                "no schedule account yet: acts cost rent and gas only"
              )}
            </dd>
          </dl>
        )}
      </Card>

      <Card n="2" title="The statement — computed by code, validated by a human" disabled={!id}>
        <div className="row">
          <button onClick={loadStatement}>Reload bulletin.json</button>
          {statement && (
            <span className="muted">
              {statement.employee.label} · {statement.period} · sha256 {short(statement.sha256, 10)}
            </span>
          )}
        </div>
        <ErrorBox error={statementError} />
        {statement && (
          <>
            <table className="lines">
              <tbody>
                {statement.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.item}</td>
                    <td className="muted">{l.detail}</td>
                    <td className="num">{l.amount}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Net to pay</td>
                  <td className="muted">{statement.computed_by}</td>
                  <td className="num">
                    {amount.toFixed(2)} {currency}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="row">
              <label className="grow">
                Validated by
                <input value={validatorName} onChange={(e) => setValidatorName(e.target.value)} placeholder="name of the human who checked the lines" disabled={!!validation} />
              </label>
              <button className="primary" onClick={() => validatorName.trim() && setValidation({ by: validatorName.trim(), at: new Date().toISOString() })} disabled={!!validation || !validatorName.trim()}>
                Validate
              </button>
            </div>
            {validation && (
              <p className="ok">
                Validated by {validation.by} at {validation.at.slice(11, 19)}Z — the sha256 goes in the first memo of the escrow.
              </p>
            )}
          </>
        )}
      </Card>

      <Card n="3" title="Funding from any chain — Aurora Intents brings the USDC to the employer's Solana address" disabled={!id || !statement}>
        <p className="hint">
          The employer rarely holds Solana USDC. A quote delivers exactly the statement's amount in USDC on Solana, paid in whatever the employer holds on
          another chain; refunds go to the address they name. This quote is <strong>dry</strong>: a real one hands out a deposit address valid 15 minutes.
        </p>
        <div className="row">
          <label className="grow">
            Pay with
            <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
              {tokens.map((t) => (
                <option key={t.assetId} value={t.assetId}>
                  {t.symbol} on {t.blockchain} · {t.price >= 100 ? t.price.toFixed(0) : t.price.toFixed(3)} $
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            Refund address ({originToken?.blockchain ?? "origin chain"})
            <input value={refundTo} onChange={(e) => setRefundTo(e.target.value)} />
          </label>
          <button className="primary" onClick={askQuote} disabled={quoteBusy || !amount || !refundTo.trim()}>
            {quoteBusy ? "Asking Aurora…" : `Quote ${amount.toFixed(2)} USDC`}
          </button>
        </div>
        <ErrorBox error={quoteError} />
        {quote && (
          <dl>
            <dt>Employer pays</dt>
            <dd>
              {quote.amountIn} {originToken?.symbol} (≈ {Number(quote.amountInUsd).toFixed(2)} $) for {quote.amountOut} USDC on Solana, in ≈ {quote.timeEstimate} s
            </dd>
            <dt>Withdraw fee in this quote</dt>
            <dd>{(Number(quote.withdrawFee) / 1e6).toFixed(3)} USDC (Aurora's figure; it was 0.254 USDC on the 3 USDC run)</dd>
            <dt>App fee on the bridge</dt>
            <dd>
              asked {quote.appFeeAsked.bps} bps for {quote.appFeeAsked.recipient} · Aurora applied{" "}
              {quote.appFeeApplied ? quote.appFeeApplied.map((f) => `${f.fee} bps to ${short(f.recipient)}`).join(", ") : "none"}
              <span className="muted"> (measured 03/11/2026: Aurora's API keeps its own 10 bps whatever is asked — no dareskro cut on this leg)</span>
            </dd>
            <dt>Deadline</dt>
            <dd>{quote.deadline.slice(0, 19).replace("T", " ")}Z{quote.dry ? " (dry: no deposit address issued)" : ` · deposit to ${quote.depositAddress}`}</dd>
          </dl>
        )}
        {proof && (
          <p className="ok">
            Run for real on {proof.at.slice(0, 10)} (mainnet): {proof.amountIn} from {short(proof.payer)} →{" "}
            <a href={proof.solanaExplorer} target="_blank" rel="noreferrer">{proof.amountOut}</a> on {short(proof.recipient)} in {proof.seconds} s · XRPL{" "}
            <a href={proof.xrpl.explorer} target="_blank" rel="noreferrer">{proof.xrpl.hash.slice(0, 8)}…</a> {proof.xrpl.result} · USDC {proof.usdcBefore} → {proof.usdcAfter}
          </p>
        )}
      </Card>

      <Card n="4" title="Lock — create(finish_after) on the employer's key, memos: sha256 · fiat line · oracle" disabled={!validation || !id}>
        <div className="row">
          <label className="grow">
            Employee's Solana address (destination, fixed forever)
            <input value={destination} onChange={(e) => setDestination(e.target.value)} disabled={!!locked} />
          </label>
        </div>
        <div className="row">
          <label>
            Payable in (seconds)
            <input type="number" min={5} value={delayS} onChange={(e) => setDelayS(Number(e.target.value))} disabled={!!locked} />
          </label>
          <label>
            Scale (devnet rehearsal)
            <select value={scale} onChange={(e) => setScale(Number(e.target.value))} disabled={!!locked}>
              <option value={1}>1 : the full amount</option>
              <option value={10}>1/10</option>
              <option value={100}>1/100</option>
            </select>
          </label>
          <span className="muted">
            {neededSol !== undefined ? `${neededSol.toFixed(4)} SOL at the rate above` : "rate unknown"}
            {!locked && id && neededSol !== undefined && (id.employer.balanceSol ?? 0) <= neededSol + 0.01 && <span className="ko"> · employer balance too low: lower the scale</span>}
          </span>
        </div>
        <div className="row">
          <button className="primary" onClick={doLock} disabled={!canLock}>
            {lockBusy ? "Locking on devnet…" : "Lock the net pay"}
          </button>
          {locked && <button onClick={resetLock}>New lock</button>}
        </div>
        <ErrorBox error={lockError} />
        {locked && (
          <dl>
            <dt>Escrow</dt>
            <dd>
              <a href={locked.escrowExplorer} target="_blank" rel="noreferrer">{locked.escrow}</a> · {locked.sol} SOL for {locked.fiat.amount} {locked.fiat.currency}
              {locked.scale !== 1 ? ` (scale 1/${locked.scale})` : ""}
            </dd>
            <dt>Transaction</dt>
            <dd>
              <a href={locked.explorer} target="_blank" rel="noreferrer">{short(locked.signature, 12)}</a>
            </dd>
            <dt>Payable at</dt>
            <dd>
              {fmtDate(locked.finishAfter)}
              {secondsToDate !== undefined && secondsToDate > 0 && <span className="pending"> · in {secondsToDate} s</span>}
              {secondsToDate !== undefined && secondsToDate <= 0 && <span className="ok"> · date passed</span>}
            </dd>
            <dt>Memos</dt>
            <dd>
              <pre className="wrap">{locked.memos.join("\n")}</pre>
            </dd>
            <dt>Oracle</dt>
            <dd>
              {mine?.oracle?.status === "finished" && mine.oracle.finishExplorer ? (
                <span className="ok">
                  finished by the oracle — <a href={mine.oracle.finishExplorer} target="_blank" rel="noreferrer">finish</a> · {locked.sol} SOL now with the employee
                </span>
              ) : mine?.status === "finished" ? (
                <span className="ok">finished by {mine.closedBy ? short(mine.closedBy) : "someone"}</span>
              ) : locked.watched ? (
                `watching — it will call finish after the date`
              ) : (
                locked.watchError ?? "not told"
              )}
            </dd>
          </dl>
        )}
      </Card>

      <Card n="5" title="Proofs — forbidden actions sent without preflight, refused on chain" disabled={!locked}>
        <p className="hint">
          Each attempt is a real transaction, kept by the ledger with its refusal, like a tec code on XRPL. A passer-by is a fresh key the employer
          funds with the fee, so the refusal is signed by a stranger.
        </p>
        <div className="row">
          <button onClick={() => tryIt("early-finish")} disabled={!!attemptBusy || !mine || mine.status !== "locked"}>
            Passer-by releases before the date
          </button>
          <button onClick={() => tryIt("cancel")} disabled={!!attemptBusy || !mine || mine.status !== "locked"}>
            Employer takes the money back
          </button>
          <button onClick={() => tryIt("wrong-destination")} disabled={!!attemptBusy || !mine || mine.status !== "locked"}>
            Passer-by releases to themselves
          </button>
          <button onClick={() => tryIt("finish")} disabled={!!attemptBusy || !mine || mine.status !== "locked" || (secondsToDate ?? 1) > 0}>
            Passer-by releases after the date
          </button>
          {attemptBusy && <span className="pending">sending {attemptBusy}…</span>}
        </div>
        <ErrorBox error={attemptError} />
        {attempts.length > 0 && (
          <table className="lines">
            <tbody>
              {attempts.map((a, i) => (
                <tr key={i}>
                  <td>
                    {a.what} by {a.who}
                  </td>
                  <td className={a.refused ? "ko" : "ok"}>
                    {a.refused ? `refused: ${a.got}` : "accepted"} {a.expected !== a.got && a.expected !== "(release)" ? `(expected ${a.expected})` : ""}
                  </td>
                  <td className="muted">{a.message ?? ""}</td>
                  <td className="num">
                    <a href={a.explorer} target="_blank" rel="noreferrer">{a.signature.slice(0, 8)}…</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card n="6" title="Registry — the chain itself: every escrow of this employer, and the oracle's word" disabled={!id}>
        {registry.length === 0 && <p className="muted">No escrow yet for this employer on {id?.cluster}.</p>}
        {registry.length > 0 && (
          <table className="lines registry">
            <thead>
              <tr>
                <th>escrow</th>
                <th>status</th>
                <th className="num">SOL</th>
                <th>destination</th>
                <th>payable at</th>
                <th>closed by</th>
                <th>oracle</th>
              </tr>
            </thead>
            <tbody>
              {[...registry].reverse().map((e) => (
                <tr key={e.address}>
                  <td>
                    <a href={e.explorer} target="_blank" rel="noreferrer">{short(e.address)}</a>
                  </td>
                  <td className={e.status === "locked" ? "pending" : e.status === "finished" ? "ok" : "muted"}>{e.status}</td>
                  <td className="num">{(Number(e.amount) / 1e9).toFixed(4)}</td>
                  <td className="muted">{short(e.destination)}</td>
                  <td className="muted">{fmtDate(e.finishAfter)}</td>
                  <td className="muted">{e.closedBy ? short(e.closedBy) : "—"}</td>
                  <td className="muted">
                    {e.oracle ? (
                      <>
                        {e.oracle.status}
                        {e.oracle.finishExplorer && (
                          <>
                            {" "}
                            <a href={e.oracle.finishExplorer} target="_blank" rel="noreferrer">finish</a>
                          </>
                        )}
                        {e.oracle.lastResult && e.oracle.status === "waiting" ? ` (${e.oracle.lastResult})` : ""}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
