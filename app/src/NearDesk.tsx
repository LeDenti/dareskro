/**
 * The NEAR rail of the same pay desk (NEAR Hackathon, Nov 2026). Same statement, same
 * human validation, same escrow with one possible outcome — and the two records that
 * exist only here: the sealed payslip (a token the employee owns and nobody can transfer)
 * and the shared deposit, a vault decided by 2 parties out of 3 (tenant, landlord,
 * mediator), the rental deposit dareskro first built on XRPL as a 2-of-3 signer list.
 *
 * Everything goes through the local service near/desk/desk_near.mjs, which holds the
 * testnet keys of the demo roles and records every signature in near/desk/sortie/.
 */
import { useEffect, useState, type ReactNode } from "react";
import * as near from "./near";

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

const short = (s: string, n = 10) => (s.length > n + 6 ? `${s.slice(0, n)}…${s.slice(-4)}` : s);
const fmtNs = (ns: string | null) => (ns == null ? "—" : new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(0, 19).replace("T", " ") + "Z");
const PARTIES: near.Role[] = ["tenant", "landlord", "mediator"];

export function NearDesk() {
  // ---- the rail
  const [id, setId] = useState<near.Identity>();
  const [idChecked, setIdChecked] = useState(false);
  const refreshId = async () => {
    setId(await near.identity());
    setIdChecked(true);
  };
  useEffect(() => {
    refreshId();
    const t = setInterval(refreshId, 10000);
    return () => clearInterval(t);
  }, []);
  const roleName = (acct: string) => {
    if (!id) return acct;
    const hit = (Object.keys(id.roles) as near.Role[]).filter((r) => id.roles[r].account === acct);
    return hit.length ? `${hit.filter((r) => !["employee", "employer"].includes(r))[0] ?? hit[0]} · ${short(acct)}` : short(acct);
  };

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
  const currency = statement?.currency ?? "EUR";

  // ---- the lock
  const [delayS, setDelayS] = useState(90);
  const [nearAmount, setNearAmount] = useState(1);
  const [lockBusy, setLockBusy] = useState(false);
  const [lockError, setLockError] = useState<unknown>();
  const [locked, setLocked] = useState<near.LockRecord>();
  const doLock = async () => {
    if (!statement || !validation) return;
    setLockBusy(true);
    setLockError(undefined);
    try {
      setLocked(await near.lock({ statementSha256: statement.sha256, fiat: { amount: String(amount), currency }, finishAfterS: delayS, nearAmount, validatedBy: validation.by }));
      setAttempts([]);
      refreshId();
    } catch (e) {
      setLockError(e);
    } finally {
      setLockBusy(false);
    }
  };

  // ---- the proofs
  const [attempts, setAttempts] = useState<near.Attempt[]>([]);
  const [attemptBusy, setAttemptBusy] = useState<string>();
  const [attemptError, setAttemptError] = useState<unknown>();
  const tryIt = async (what: near.Attempt["what"]) => {
    if (!locked) return;
    setAttemptBusy(what);
    setAttemptError(undefined);
    try {
      const a = await near.attempt(locked.id, what);
      setAttempts((xs) => [...xs, a]);
    } catch (e) {
      setAttemptError(e);
    } finally {
      setAttemptBusy(undefined);
    }
  };

  // ---- the shared deposit
  const [depositNear, setDepositNear] = useState(1);
  const [deadlineS, setDeadlineS] = useState(600);
  const [threshold, setThreshold] = useState(2);
  const [lease, setLease] = useState("L-2026-11 · 12 rue de la Paix · deposit 1 200 EUR");
  const [quote, setQuote] = useState("repainting quote 180 EUR");
  const [vaultBusy, setVaultBusy] = useState<string>();
  const [vaultError, setVaultError] = useState<unknown>();
  const [vaultId, setVaultId] = useState<string>();
  const [events, setEvents] = useState<near.VaultEvent[]>([]);
  const [voteAmount, setVoteAmount] = useState<Record<string, string>>({ tenant: "0", landlord: "0.15", mediator: "0.15", stranger: "0.15" });
  const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const createVault = async () => {
    setVaultBusy("create");
    setVaultError(undefined);
    try {
      const memos = [`lease:${lease}`, `inventory_in:sha256:${await sha("entry inventory " + lease)}`, `inventory_out:sha256:${await sha("exit inventory " + lease)}`, `quote:sha256:${await sha(quote)} ${quote}`];
      const ev = await near.vaultCreate({ owner: "tenant", beneficiary: "landlord", parties: PARTIES, threshold, deadlineS, nearAmount: depositNear, memos });
      setVaultId(ev.id);
      setEvents([ev]);
      refreshId();
    } catch (e) {
      setVaultError(e);
    } finally {
      setVaultBusy(undefined);
    }
  };
  const vote = async (as: near.Role) => {
    if (!vaultId) return;
    setVaultBusy(as);
    setVaultError(undefined);
    try {
      const ev = await near.vaultVote(vaultId, as, voteAmount[as] ?? "0");
      setEvents((xs) => [...xs, ev]);
      if (ev.decided) refreshId();
    } catch (e) {
      setVaultError(e);
    } finally {
      setVaultBusy(undefined);
    }
  };
  const timeout = async () => {
    if (!vaultId) return;
    setVaultBusy("timeout");
    setVaultError(undefined);
    try {
      const ev = await near.vaultTimeout(vaultId, "stranger");
      setEvents((xs) => [...xs, ev]);
      refreshId();
    } catch (e) {
      setVaultError(e);
    } finally {
      setVaultBusy(undefined);
    }
  };

  // ---- the registry: the chain itself, every 5 s
  const [escrows, setEscrows] = useState<near.Escrow[]>([]);
  const [vaults, setVaults] = useState<near.Vault[]>([]);
  const [payslips, setPayslips] = useState<near.Payslip[]>([]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const poll = async () => {
      try {
        const [e, v, p] = await Promise.all([near.escrows(), near.vaults(), near.payslips()]);
        if (!stop) {
          setEscrows(e);
          setVaults(v);
          setPayslips(p);
        }
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
  }, [id?.contract]);
  const mine = locked ? escrows.find((e) => e.id === locked.id) : undefined;
  const secondsToDate = locked ? Math.ceil((locked.finishAfterMs - now) / 1000) : undefined;
  const vault = vaultId ? vaults.find((v) => v.id === vaultId) : undefined;
  const secondsToDeadline = vault?.deadline ? Math.ceil((Number(BigInt(vault.deadline) / 1_000_000n) - now) / 1000) : undefined;

  return (
    <>
      <Card n="1" title="The NEAR rail — same desk, a contract with no owner">
        <p className="hint">
          NEAR has no native escrow, so the escrow is a contract: destination fixed at creation, no address in <code>finish</code>, the clock refuses
          early release, no <code>cancel_after</code> means nobody can cancel. Once its full-access keys are deleted, the only moves left are its
          methods. The parties sign with keys held by the local desk service, not a Ledger.
        </p>
        {!idChecked && <p className="pending">Looking for the desk service…</p>}
        {idChecked && !id && (
          <p className="ko">
            No desk service on 127.0.0.1:8794. Start it: <code>cd near/desk && node desk_near.mjs</code> (and <code>cd near && node oracle_near.mjs watch</code> for the oracle).
          </p>
        )}
        {id && (
          <dl>
            <dt>Network · contract</dt>
            <dd>
              {id.network} · <a href={id.contractExplorer} target="_blank" rel="noreferrer">{id.contract}</a> · {id.counts.escrows} escrows, {id.counts.vaults} deposits, {id.counts.payslips} payslips
            </dd>
            {(["employer", "employee", "mediator", "stranger"] as near.Role[]).map((r) => (
              <RoleRow key={r} label={r === "employer" ? "Employer · landlord" : r === "employee" ? "Employee · tenant" : r === "mediator" ? "Mediator · oracle" : "Stranger"} role={id.roles[r]} />
            ))}
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

      <Card n="3" title="Lock — create(finish_after) on the employer's key, memos: sha256 · fiat line · oracle" disabled={!validation || !id}>
        <div className="row">
          <label>
            Payable in (seconds)
            <input type="number" min={5} value={delayS} onChange={(e) => setDelayS(Number(e.target.value))} disabled={!!locked} />
          </label>
          <label>
            NEAR locked (testnet stands in for the euros)
            <input type="number" min={0.1} step={0.1} value={nearAmount} onChange={(e) => setNearAmount(Number(e.target.value))} disabled={!!locked} />
          </label>
          <button className="primary" onClick={doLock} disabled={!!locked || lockBusy || !validation}>
            {lockBusy ? "Locking on testnet…" : "Lock the net pay"}
          </button>
          {locked && (
            <button
              onClick={() => {
                setLocked(undefined);
                setAttempts([]);
              }}
            >
              New lock
            </button>
          )}
        </div>
        <ErrorBox error={lockError} />
        {locked && (
          <dl>
            <dt>Escrow</dt>
            <dd>
              #{locked.id} · {locked.amountNear} NEAR to {roleName(locked.destination)} · <a href={locked.explorer} target="_blank" rel="noreferrer">{short(locked.hash)}</a>
            </dd>
            <dt>Payable at</dt>
            <dd>
              {new Date(locked.finishAfterMs).toISOString().slice(0, 19).replace("T", " ")}Z
              {secondsToDate !== undefined && secondsToDate > 0 && <span className="pending"> · in {secondsToDate} s</span>}
              {secondsToDate !== undefined && secondsToDate <= 0 && <span className="ok"> · date passed</span>}
            </dd>
            <dt>Memos</dt>
            <dd>
              <pre className="wrap">{locked.memos.join("\n")}</pre>
            </dd>
            <dt>On chain</dt>
            <dd>{mine ? `${mine.status}${mine.closed_by ? ` by ${roleName(mine.closed_by)}` : ""}` : "…"}</dd>
          </dl>
        )}
      </Card>

      <Card n="4" title="Proofs — forbidden actions sent for real, refused by the contract" disabled={!locked}>
        <div className="row">
          <button onClick={() => tryIt("early-finish")} disabled={!!attemptBusy || !mine || mine.status !== "Locked"}>
            Stranger releases before the date
          </button>
          <button onClick={() => tryIt("cancel")} disabled={!!attemptBusy || !mine || mine.status !== "Locked"}>
            Employer takes the money back
          </button>
          <button onClick={() => tryIt("finish")} disabled={!!attemptBusy || !mine || mine.status !== "Locked" || (secondsToDate ?? 1) > 0}>
            Stranger releases after the date
          </button>
          {attemptBusy && <span className="pending">sending {attemptBusy}…</span>}
        </div>
        <ErrorBox error={attemptError} />
        {attempts.length > 0 && <Outcomes rows={attempts.map((a) => ({ what: `${a.what} by ${roleName(a.who)}`, refused: a.refused, text: a.refused ? `refused: ${a.error}` : "accepted", explorer: a.explorer, hash: a.hash }))} />}
      </Card>

      <Card n="5" title="The deposit — a vault decided 2 of 3: tenant, landlord, mediator" disabled={!id}>
        <p className="hint">
          A rental deposit is usually returned in part, so it is not an escrow. The tenant funds the vault; each party votes the amount that goes to
          the landlord, the rest returns to the tenant; the vote that reaches the threshold pays both sides in the same call. Past the deadline with no
          decision, anyone returns everything to the tenant. Memos: lease id, sha256 of the inventories and of the quote — what a judge reads.
        </p>
        <div className="row">
          <label className="grow">
            Lease
            <input value={lease} onChange={(e) => setLease(e.target.value)} disabled={!!vaultId} />
          </label>
          <label className="grow">
            Deduction claimed (quote)
            <input value={quote} onChange={(e) => setQuote(e.target.value)} disabled={!!vaultId} />
          </label>
        </div>
        <div className="row">
          <label>
            NEAR locked
            <input type="number" min={0.1} step={0.1} value={depositNear} onChange={(e) => setDepositNear(Number(e.target.value))} disabled={!!vaultId} />
          </label>
          <label>
            Threshold
            <select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} disabled={!!vaultId}>
              <option value={2}>2 of 3</option>
              <option value={3}>3 of 3</option>
            </select>
          </label>
          <label>
            Deadline (seconds)
            <input type="number" min={5} value={deadlineS} onChange={(e) => setDeadlineS(Number(e.target.value))} disabled={!!vaultId} />
          </label>
          <button className="primary" onClick={createVault} disabled={!!vaultId || !!vaultBusy}>
            {vaultBusy === "create" ? "Locking on testnet…" : "Tenant locks the deposit"}
          </button>
          {vaultId && (
            <button
              onClick={() => {
                setVaultId(undefined);
                setEvents([]);
              }}
            >
              New deposit
            </button>
          )}
        </div>
        <ErrorBox error={vaultError} />
        {vault && (
          <dl>
            <dt>Vault</dt>
            <dd>
              #{vault.id} · {vault.amountNear} NEAR · {vault.threshold} of {vault.parties.length} · <span className={vault.status === "Locked" ? "pending" : vault.status === "Finished" ? "ok" : "muted"}>{vault.status}</span>
              {vault.status === "Finished" && ` — ${vault.paidToBeneficiaryNear} NEAR to the landlord, the rest back to the tenant, decided by ${roleName(vault.closed_by ?? "")}`}
              {vault.status === "Cancelled" && ` — everything back to the tenant, called by ${roleName(vault.closed_by ?? "")}`}
            </dd>
            <dt>Deadline</dt>
            <dd>
              {fmtNs(vault.deadline)}
              {secondsToDeadline !== undefined && secondsToDeadline > 0 && vault.status === "Locked" && <span className="pending"> · in {secondsToDeadline} s</span>}
              {secondsToDeadline !== undefined && secondsToDeadline <= 0 && vault.status === "Locked" && <span className="ok"> · passed: anyone may return the deposit</span>}
            </dd>
            <dt>Votes</dt>
            <dd>{vault.votes.length ? vault.votes.map((v) => `${roleName(v.party)} → ${v.toBeneficiaryNear} NEAR to the landlord`).join(" · ") : "none yet"}</dd>
          </dl>
        )}
        {vaultId && (
          <div className="row">
            {([...PARTIES, "stranger"] as near.Role[]).map((r) => (
              <label key={r}>
                {r} votes (NEAR to the landlord)
                <input type="number" min={0} step={0.01} value={voteAmount[r]} onChange={(e) => setVoteAmount({ ...voteAmount, [r]: e.target.value })} />
                <button onClick={() => vote(r)} disabled={!!vaultBusy || vault?.status !== "Locked"}>
                  {vaultBusy === r ? "sending…" : `${r} votes`}
                </button>
              </label>
            ))}
            <button onClick={timeout} disabled={!!vaultBusy || vault?.status !== "Locked"}>
              {vaultBusy === "timeout" ? "sending…" : "Stranger calls the deadline"}
            </button>
          </div>
        )}
        {events.length > 0 && (
          <Outcomes
            rows={events.map((ev) => ({
              what: `${ev.action}${ev.action === "vote" ? ` ${ev.toBeneficiaryNear} NEAR` : ""} by ${roleName(ev.by)}`,
              refused: !!ev.refused,
              text: ev.refused ? `refused: ${ev.error}` : ev.action === "vote" ? (ev.decided ? "threshold reached: paid" : "recorded, nothing moves") : ev.action === "timeout" ? "returned to the tenant" : "locked",
              explorer: ev.explorer,
              hash: ev.hash,
            }))}
          />
        )}
      </Card>

      <Card n="6" title="Registry — the chain itself: escrows, deposits, sealed payslips" disabled={!id}>
        {escrows.length > 0 && (
          <table className="lines registry">
            <thead>
              <tr>
                <th>escrow</th>
                <th>status</th>
                <th className="num">NEAR</th>
                <th>destination</th>
                <th>payable at</th>
                <th>closed by</th>
              </tr>
            </thead>
            <tbody>
              {[...escrows].reverse().slice(0, 12).map((e) => (
                <tr key={e.id}>
                  <td>#{e.id}</td>
                  <td className={e.status === "Locked" ? "pending" : e.status === "Finished" ? "ok" : "muted"}>{e.status}</td>
                  <td className="num">{e.amountNear}</td>
                  <td className="muted">{roleName(e.destination)}</td>
                  <td className="muted">{fmtNs(e.finish_after)}</td>
                  <td className="muted">{e.closed_by ? roleName(e.closed_by) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {vaults.length > 0 && (
          <table className="lines registry">
            <thead>
              <tr>
                <th>deposit</th>
                <th>status</th>
                <th className="num">NEAR</th>
                <th>votes</th>
                <th className="num">to landlord</th>
                <th>deadline</th>
                <th>decided by</th>
              </tr>
            </thead>
            <tbody>
              {[...vaults].reverse().slice(0, 12).map((v) => (
                <tr key={v.id}>
                  <td>#{v.id}</td>
                  <td className={v.status === "Locked" ? "pending" : v.status === "Finished" ? "ok" : "muted"}>{v.status}</td>
                  <td className="num">{v.amountNear}</td>
                  <td className="muted">
                    {v.votes.length}/{v.threshold}
                  </td>
                  <td className="num">{v.status === "Finished" ? v.paidToBeneficiaryNear : "—"}</td>
                  <td className="muted">{fmtNs(v.deadline)}</td>
                  <td className="muted">{v.closed_by ? roleName(v.closed_by) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {payslips.length > 0 && (
          <p className="muted">
            Sealed payslips of the employee: {payslips.map((p) => `${p.token_id} (${p.metadata.title}, readers ${p.extra.readers?.join("/") ?? "?"}, ${p.extra.sealed_bytes ?? "?"} opaque bytes)`).join(" · ")} — a token the
            employee owns; <code>nft_transfer</code> is refused by the contract.
          </p>
        )}
        {escrows.length === 0 && vaults.length === 0 && <p className="muted">Nothing on {id?.contract} yet.</p>}
      </Card>
    </>
  );
}

function RoleRow({ label, role }: { label: string; role: { account: string; balanceNear: string; explorer: string } }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <a href={role.explorer} target="_blank" rel="noreferrer">{role.account}</a> · {role.balanceNear} NEAR
      </dd>
    </>
  );
}

function Outcomes({ rows }: { rows: { what: string; refused: boolean; text: string; explorer: string; hash: string }[] }) {
  return (
    <table className="lines">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.what}</td>
            <td className={r.refused ? "ko" : "ok"}>{r.text}</td>
            <td className="num">
              <a href={r.explorer} target="_blank" rel="noreferrer">{r.hash.slice(0, 8)}…</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
