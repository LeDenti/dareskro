/**
 * Real mode — "what leaves, to whom, when", for an employer who is not a technician.
 *
 * Shown between Prepare and Sign, from the very transactions the device is about to sign:
 * one row per leg (the replacement pharmacist's net pay, the URSSAF contributions, the
 * income tax to DGFiP), the amount in euros and in XRP at the rate of the moment, the
 * account it goes to, the date it can leave, how (escrow or Check), and what the device
 * will show for that approval. Then the balance check, and the button-by-button
 * instructions for the Nano S Plus — including the one press too many that gives 6985.
 */
import type { CheckCreate, EscrowCreate, Transaction } from "xrpl";
import * as xrpl from "./xrpl";

type StatementLike = {
  statement_id: string;
  period: string;
  currency: string;
  sha256: string;
  status: string;
  gross?: string;
  net_paid?: string;
  net_to_pay?: string;
  total: string;
  contributions?: { recipient: string; due: string; total_to_urssaf: string; employee: { amount: string }; employer: { amount: string } };
  withholding?: { recipient: string; due: string; amount: string; rate: string };
  evidence: { schedule: { date: string; slot: string; type: string } };
};

type LegLike = {
  id: "urssaf" | "dgfip";
  kind: "check" | "escrow";
  label: string;
  fiat: string;
  xrp: string;
  tx: Transaction;
  signedHex?: string;
};

export function PaieReelle(props: {
  statement: StatementLike;
  payTx: EscrowCreate;
  legs: LegLike[];
  batch: boolean;
  rate?: xrpl.Rate;
  employer: { address: string };
  balance?: number | null;
  neededXrp: number;
  employee: string;
  employeeIsTest: boolean;
  deviceSigner: boolean;
  deviceName?: string;
  oracleAddress?: string;
  payoutMode: "crypto" | "usd";
  signed: boolean;
  /** The pay escrow is on the ledger: the money has left, the balance line must not read "too low" any more. */
  locked?: boolean;
}) {
  const { statement: s, payTx, legs, batch, rate, balance, neededXrp } = props;
  const sym = s.currency === "EUR" ? "€" : s.currency === "USD" ? "$" : s.currency;
  const netFiat = s.net_paid ?? s.net_to_pay ?? s.total;
  const payXrp = xrpl.dropsToXrpString(payTx.Amount as string);
  const when = (t: number) => xrpl.fromRippleTime(t).toLocaleString();
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const approvals = batch ? 1 : 1 + legs.length;
  const totalXrp = Number(payXrp) + legs.reduce((acc, l) => acc + Number(l.xrp), 0);
  const enough = balance !== undefined && balance !== null && balance >= neededXrp;
  const fee = 0.000012 * (legs.length + 1);

  const rows: { leg: string; fiat: string; xrp: string; to: string; toNote: string; when: string; how: string; device: string }[] = [
    {
      leg: "The replacement pharmacist — net pay",
      fiat: netFiat,
      xrp: payXrp,
      to: props.employee,
      toNote: props.employeeIsTest ? "a fresh test account created by this page" : "the address the employee gave",
      when: `${when(payTx.FinishAfter!)} — not one second before, by nobody`,
      how: props.oracleAddress
        ? `escrow: locked now, released at the date by the oracle ${short(props.oracleAddress)} (or by anyone after the date); no one can take it back`
        : "escrow: locked now, released at the date by anyone; no one can take it back",
      device: "Create Escrow · Amount · Destination · Finish After · memos (statement hash, fiat at rate, oracle) · Sign transaction?",
    },
    ...legs.map((l) => {
      if (l.kind === "check") {
        const c = l.tx as CheckCreate;
        return {
          leg: `${s.contributions?.recipient ?? "URSSAF"} — contributions (employee ${s.contributions?.employee.amount} + employer ${s.contributions?.employer.amount})`,
          fiat: l.fiat,
          xrp: l.xrp,
          to: c.Destination,
          toNote: "a stand-in account on testnet; URSSAF does not cash XRP today (see README, last mile)",
          when: `whenever ${s.contributions?.recipient ?? "URSSAF"} cashes it, before ${when(c.Expiration!)} — the money stays in your balance until then`,
          how: "Check: a right to pull that you sign once; it cashes it itself, up to this amount, for this statement only (InvoiceID = the hash)",
          device: "Create Check · Send Max · Destination · Expiration · Invoice ID · Sign transaction?",
        };
      }
      const e = l.tx as EscrowCreate;
      return {
        leg: `${s.withholding?.recipient ?? "DGFiP"} — income tax withheld at source (${Number(s.withholding?.rate ?? 0) * 100} %)`,
        fiat: l.fiat,
        xrp: l.xrp,
        to: e.Destination,
        toNote: "a stand-in account on testnet; DGFiP does not cash XRP today (see README, last mile)",
        when: `${when(e.FinishAfter!)} (due date ${s.withholding?.due ?? ""} in real life)`,
        how: "escrow: locked now, released at the due date by the oracle; no one can take it back",
        device: "Create Escrow · Amount · Destination · Finish After · memos · Sign transaction?",
      };
    }),
  ];

  return (
    <div className="reel">
      <h3>
        What leaves, to whom, when — {rows.length} payments, {approvals} approval{approvals > 1 ? "s" : ""} on {props.deviceSigner ? props.deviceName ?? "the Ledger device" : "the test wallet (rehearsal)"}
      </h3>
      <p className="hint">
        Statement {s.statement_id} · {s.evidence.schedule.date} {s.evidence.schedule.slot}, {s.evidence.schedule.type} · gross {s.gross ?? s.total} {sym} ·
        hash <code>{s.sha256.slice(0, 16)}…</code> (on the device, in the first memo) · {s.currency} converted at {rate ? `${rate.eurPerXrp} ${rate.currency}/XRP (${rate.source}, ${rate.at.slice(11, 16)} UTC)` : "…"} ·
        the employee is paid {props.payoutMode === "usd" ? "in dollars (RLUSD through Mastercard) once the ledger has released" : "in XRP, kept as is"}.
      </p>
      <table className="lines reel-table">
        <thead>
          <tr>
            <th>Payment</th>
            <th className="num">Amount</th>
            <th>To whom</th>
            <th>When it can leave</th>
            <th>How</th>
            <th>On the device</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <b>{i + 1}. {r.leg}</b>
              </td>
              <td className="num">
                {r.fiat} {sym}
                <br />
                <span className="muted">{r.xrp} XRP</span>
              </td>
              <td>
                <a href={xrpl.explorerAccountUrl(r.to)} target="_blank"><code>{short(r.to)}</code></a>
                <br />
                <span className="muted">{r.toNote}</span>
              </td>
              <td>{r.when}</td>
              <td className="muted">{r.how}</td>
              <td className="muted">{batch ? "inside the Batch" : `approval ${i + 1}: ${r.device}`}</td>
            </tr>
          ))}
          <tr className="total">
            <td>Leaving your account{batch ? " (all three or none)" : ""}</td>
            <td className="num">{totalXrp.toFixed(6)} XRP</td>
            <td colSpan={4} className={enough || props.locked ? "ok" : "ko"}>
              {props.locked
                ? `locked on the ledger — balance now ${balance ?? "…"} XRP`
                : balance === undefined || balance === null
                ? "balance unknown"
                : enough
                  ? `balance ${balance} XRP: enough for the escrows, the ${legs.some((l) => l.kind === "check") ? "Check, the " : ""}reserve and the fees (about ${fee.toFixed(6)} XRP)`
                  : `balance ${balance} XRP, ${neededXrp} XRP needed: too low — the ledger would refuse the lock (tecUNFUNDED_ESCROW)`}
            </td>
          </tr>
        </tbody>
      </table>
      {props.deviceSigner && !batch && !props.signed && (
        <p className="hint reel-steps">
          <b>On the Nano S Plus, {approvals} times in a row:</b> read each screen with the right button, check the amount and the destination
          against this table, approve on <b>Sign transaction?</b> with both buttons — and stop there. One more press to the right lands on
          <b> Reject transaction</b>, and a double press there refuses with 6985 (measured 26/10/2026). The page waits between the approvals; nothing is
          sent to the ledger before you click Submit.
        </p>
      )}
      {props.deviceSigner && batch && (
        <p className="hint reel-steps ko">
          Batch mode with a device: the XRP app 2.8.2 refuses a Batch by itself (6985, "blind signing must be enabled") — nobody is asked anything.
          Untick "one signature for all" for one approval per transaction, or enable blind signing in the XRP app's settings.
        </p>
      )}
      {!props.deviceSigner && (
        <p className="hint reel-steps">Rehearsal: the test wallet signs the {batch ? "Batch" : `${approvals} transaction${approvals > 1 ? "s" : ""}`} by itself, nothing is reviewed on a screen. For the real pay, connect the Ledger.</p>
      )}
    </div>
  );
}
