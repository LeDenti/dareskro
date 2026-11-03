/**
 * The PayPal rail of the same pay desk (PayPal AI Hackathon, Nov 2026). No ledger: the hold is an
 * order the payer approves on PayPal's page (intent AUTHORIZE, nothing charged), the release a
 * capture — partial when the rule says so, the rest returns to the payer — the refund a void, the
 * pay a payout. Seven shapes, the same rule tables as on XRPL, Solana and NEAR; and a seat the
 * other rails never had: Claude reads the deliverable and what PayPal holds, through PayPal's own
 * Agent Toolkit in read-only, and writes a memo that is hashed before a human sees it. The model
 * has no tool that moves money: the gate and the human do.
 *
 * Everything goes through the local service paypal/service.mjs (127.0.0.1:8796), which holds the
 * sandbox credentials and records every mission in paypal/sortie/missions.json.
 */
import { useEffect, useState, type ReactNode } from "react";
import * as pp from "./paypal";

const short = (s: string | undefined | null, n = 10) => (!s ? "—" : s.length > n + 6 ? `${s.slice(0, n)}…${s.slice(-4)}` : s);
const when = (iso: string | undefined | null) => (iso ? iso.slice(0, 19).replace("T", " ") + "Z" : "—");
const inS = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const money = (n: number | string | undefined) => (n === undefined ? "—" : Number(n).toFixed(2));
/** What a mission is worth: its amount, its target, its invoice — or what its payers hold. */
const worth = (x: pp.Mission) => x.amount ?? x.target ?? x.invoiceAmount ?? (x.payers.length ? x.payers.reduce((a, p) => a + (p.trimmedTo ?? p.amount), 0) : undefined);

/** What each shape is, in one line, and what decides the release. */
const SHAPES: Record<pp.Kind, { label: string; decides: string }> = {
  payroll: { label: "Payroll — paid at the date", decides: "the date; one approval by the employer, one payout batch of three (net, URSSAF, DGFiP)" },
  delivery: { label: "Delivery — the AI reads, a human validates", decides: "a named human, after the seat's memo; the memo alone never pays" },
  presence: { label: "Presence — the post is live at the date", decides: "the desk reads the page at the date; live → capture, gone → void" },
  affiliate: { label: "Affiliate — the merchant confirms the sale", decides: "the merchant's token, given once at the draft; the money is locked before the sale" },
  pool: { label: "Pool — several payers, trimmed at the target", decides: "the date, once the target is reached; the filling share is trimmed" },
  vault: { label: "Deposit — decided 2 of 3", decides: "tenant, landlord, mediator vote an amount; 2 agree → partial capture, the rest back; custody for a lease longer than the 29-day hold" },
  advance: { label: "Invoice advance — AI + policy + operator", decides: "2 of 3 signers; the pool pays the supplier, the debtor repays with a CAPTURE order" },
};

type Draft = {
  kind: pp.Kind;
  title: string;
  amount: string;
  second: string; // target (pool) · invoice (advance)
  payerName: string;
  payerEmail: string;
  payeeName: string;
  payeeEmail: string;
  dateS: string;
  text: string; // brief · proof url · order ref · invoice url · lease
  mustContain: string;
  custody: boolean;
};
const defaults = (kind: pp.Kind, payee: string): Draft => {
  const base: Draft = { kind, title: "", amount: "120", second: "", payerName: "BottomRadar", payerEmail: "payer-mock@example.com", payeeName: "the freelancer", payeeEmail: payee, dateS: "60", text: "", mustContain: "", custody: false };
  switch (kind) {
    case "payroll":
      return { ...base, title: "Sunday shift, 25/10 — net, URSSAF, DGFiP", amount: "801.66", payerName: "the pharmacy", payeeName: "the employee" };
    case "delivery":
      return { ...base, title: "Landing copy for BottomRadar's overbought alert", payeeName: "the copywriter", text: pp.fixture("deliverable_landing.md") };
    case "presence":
      return { ...base, title: "Influencer post, live at the date", amount: "80", payeeName: "the creator", text: pp.fixture("post_influencer.html"), mustContain: "#BottomRadar" };
    case "affiliate":
      return { ...base, title: "Affiliate commission on order BR-2026-0417", amount: "25", payeeName: "the affiliate", text: "BR-2026-0417" };
    case "pool":
      return { ...base, title: "Deposit funded by the tenant and a guarantor", amount: "", second: "1000", payeeName: "the landlord" };
    case "vault":
      return { ...base, title: "Rental deposit, lease 12-rue-des-Lices", amount: "1200", payerName: "tenant", payeeName: "landlord", text: "lease 12-rue-des-Lices", dateS: "3600" };
    case "advance":
      return { ...base, title: "Invoice 2026-0117, Atelier Verne → BottomRadar", amount: "800", second: "900", payerName: "BottomRadar SAS", payeeName: "Atelier Verne", text: pp.fixture("invoice_2026-11-02.md") };
  }
};
const body = (d: Draft): Record<string, unknown> => {
  const amount = Number(d.amount);
  const common = { kind: d.kind, title: d.title, currency: "USD", deadlineAt: inS(3600) };
  switch (d.kind) {
    case "payroll": {
      const net = Math.round(amount * 0.508 * 100) / 100, urssaf = Math.round(amount * 0.4507 * 100) / 100, tax = Math.round((amount - net - urssaf) * 100) / 100;
      return { ...common, amount, employer: { name: d.payerName, email: d.payerEmail }, payees: [{ label: `net paid to ${d.payeeName}`, email: d.payeeEmail, amount: net }, { label: "contributions to URSSAF", email: "urssaf-mock@example.com", amount: urssaf }, { label: "income tax withheld, to DGFiP", email: "dgfip-mock@example.com", amount: tax }], statement: { sha256: "a".repeat(64), id: "stmt-desk" }, validatedBy: "the desk's operator", finishAfter: inS(Number(d.dateS)) };
    }
    case "delivery":
      return { ...common, amount, client: { name: d.payerName, email: d.payerEmail }, freelancer: { email: d.payeeEmail, name: d.payeeName }, brief: "Write the English landing copy for the overbought alert of bottomradar.com: what the alert does, what it is not, and how to start. Plain words, no hype, no promise of returns.", criteria: ["At least 250 words [min-words 250]", "Names the BR Score [contains BR Score]", "Ends with a call to action to bottomradar.com [contains bottomradar.com]", "Does not promise profits or returns [absent guaranteed]"] };
    case "presence":
      return { ...common, amount, brand: { name: d.payerName, email: d.payerEmail }, creator: { email: d.payeeEmail, name: d.payeeName }, proof: { url: d.text, mustContain: d.mustContain || undefined }, checkAfter: inS(Number(d.dateS)) };
    case "affiliate":
      return { ...common, amount, merchant: { name: d.payerName, email: d.payerEmail }, affiliate: { email: d.payeeEmail, name: d.payeeName }, orderRef: d.text };
    case "pool":
      return { ...common, target: Number(d.second), destination: { name: d.payeeName, email: d.payeeEmail }, finishAfter: inS(Number(d.dateS)) };
    case "vault":
      return { ...common, amount, custody: d.custody, owner: { name: d.payerName, email: d.payerEmail }, beneficiary: { name: d.payeeName, email: d.payeeEmail }, parties: ["tenant", "landlord", "mediator"], memos: [d.text, "entry inventory sha256 …", "exit inventory sha256 …"], deadlineAt: inS(Number(d.dateS)) };
    case "advance":
      return { ...common, invoiceAmount: Number(d.second), amount, supplier: { name: d.payeeName, email: d.payeeEmail }, debtor: { name: d.payerName, email: d.payerEmail }, dueAt: inS(29 * 86400), invoiceUrl: d.text, criteria: ["The document is an invoice [contains invoice]", "It names the debtor [contains BottomRadar]", "It states a due date [contains due]"] };
  }
};

type Outcome = { at: string; what: string; refused: boolean; text: string };

export function PaypalDesk() {
  // ---- the rail
  const [id, setId] = useState<pp.Identity>();
  const [idChecked, setIdChecked] = useState(false);
  const refreshId = async () => {
    setId(await pp.identity());
    setIdChecked(true);
  };
  useEffect(() => {
    refreshId();
    const t = setInterval(refreshId, 10000);
    return () => clearInterval(t);
  }, []);
  const mock = id?.mode === "mock";

  // ---- the draft
  const [payee, setPayee] = useState("payee-mock@example.com");
  const [draft, setDraft] = useState<Draft>(() => defaults("delivery", "payee-mock@example.com"));
  const pick = (kind: pp.Kind) => setDraft(defaults(kind, payee));
  const set = (k: keyof Draft, v: string | boolean) => setDraft((d) => ({ ...d, [k]: v }));
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [mission, setMission] = useState<pp.Mission>();
  const [token, setToken] = useState<string>(); // the affiliate's token, shown once
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [memo, setMemo] = useState<pp.MemoFull>();
  const note = (what: string, r: pp.Answer<unknown>) => {
    const b = r.body as { error?: string; reasons?: pp.Reason[]; errors?: string[] };
    const refusedChecks = b.reasons?.filter((x) => !x.ok).map((x) => `${x.check}: ${x.why}`) ?? [];
    setOutcomes((xs) => [...xs, { at: new Date().toISOString(), what, refused: !r.ok, text: r.ok ? "accepted" : `${r.status} ${b.error ?? ""}${refusedChecks.length ? ` — ${refusedChecks.join("; ")}` : ""}${b.errors?.length ? ` — ${b.errors.join("; ")}` : ""}` }]);
  };
  const run = async (what: string, f: () => Promise<pp.Answer<unknown>>, then?: (r: pp.Answer<unknown>) => void) => {
    setBusy(what);
    setError(undefined);
    try {
      const r = await f();
      note(what, r);
      then?.(r);
      if (mission) setMission(await pp.mission(mission.id));
      refreshId();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  };
  const doDraft = () =>
    run("draft", () => pp.draft(body(draft)), (r) => {
      if (!r.ok) return;
      const m = r.body as pp.Mission;
      setToken(m.confirmToken);
      setMission(m);
      setMemo(undefined);
      setOutcomes([]);
    });
  const reset = () => {
    setMission(undefined);
    setToken(undefined);
    setMemo(undefined);
    setOutcomes([]);
    setError(undefined);
  };

  // ---- the mission, re-read every 2 s while it lives (the return from PayPal's page lands in the service, not here)
  useEffect(() => {
    if (!mission) return;
    let stop = false;
    const poll = async () => {
      try {
        const m = await pp.mission(mission.id);
        if (!stop && m.id) setMission(m);
      } catch {
        /* the service will be back */
      }
    };
    const t = setInterval(poll, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [mission?.id]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const date = mission?.finishAfter ?? mission?.checkAfter;
  const toDate = date ? Math.ceil((Date.parse(date) - now) / 1000) : undefined;
  const toDeadline = mission?.deadlineAt ? Math.ceil((Date.parse(mission.deadlineAt) - now) / 1000) : undefined;
  const act = (action: pp.Action, b: Record<string, unknown> = {}, what: string = action) => mission && run(what, () => pp.act(mission.id, action, b));
  const approve = async (p: pp.Payer, what: string) => {
    if (!mission || !p.approveUrl) return;
    if (mock) {
      await run(what, async () => ({ ok: await pp.mockApprove(p.approveUrl!), status: 200, body: {} }));
    } else {
      window.open(p.approveUrl, "_blank", "noopener");
      setOutcomes((xs) => [...xs, { at: new Date().toISOString(), what, refused: false, text: "PayPal's page opened in a new tab: approve there with the sandbox buyer; the hold appears here when PayPal sends the payer back" }]);
    }
  };
  const [fundRow, setFundRow] = useState({ name: "the tenant", email: "payer-mock@example.com", amount: "600" });
  const [deliverUrl, setDeliverUrl] = useState("");
  const [validator, setValidator] = useState("");
  const [confirmToken, setConfirmToken] = useState("");
  const [votes, setVotes] = useState<Record<string, string>>({ tenant: "0", landlord: "180", mediator: "180", stranger: "180" });
  const loadMemo = async () => mission && setMemo(await pp.memo(mission.id));

  // ---- the registry
  const [all, setAll] = useState<pp.Mission[]>([]);
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const poll = async () => {
      try {
        const ms = await pp.missions();
        if (!stop && Array.isArray(ms)) setAll(ms);
      } catch {
        /* the service will be back */
      }
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [id?.mode]);

  const m = mission;
  const k = m?.kind;
  const holdOpen = (p: pp.Payer) => !!p.authorizationId && !p.captureId;
  const locked = !!m && ["locked", "delivered", "reviewed", "validated"].includes(m.state);
  const closed = !!m && ["released", "repaid", "refused", "expired"].includes(m.state);
  const stateClass = (s: pp.State) => (["released", "repaid"].includes(s) ? "ok" : ["refused", "expired"].includes(s) ? "muted" : "pending");

  return (
    <>
      <Card n="1" title="The PayPal rail — same desk, no ledger: a hold, a capture, a void, a payout">
        <p className="hint">
          PayPal has no escrow. An order with intent <code>AUTHORIZE</code>, approved by the payer on PayPal's page, holds the amount for {id?.holdDays ?? 29} days
          without charging it; the capture releases what the rule says (partial if it says so, the rest returns to the payer); the void refunds a payer who was
          never charged; the payout pays several people in one batch. The seat is a model: it reads, it never moves money. Fee: {id ? `${id.feeBps} bp (${(id.feeBps / 100).toFixed(2)} %)` : "…"} of what is released, kept on the platform's account.
        </p>
        {!idChecked && <p className="pending">Looking for the desk service…</p>}
        {idChecked && !id && (
          <p className="ko">
            No desk service on 127.0.0.1:8796. Start it: <code>cd paypal && node service.mjs</code> (sandbox, from <code>paypal/.env</code>) or{" "}
            <code>PAYPAL_MODE=mock SEAT_MODE=mock node service.mjs</code> (no credentials).
          </p>
        )}
        {id && (
          <dl>
            <dt>Rail · seat</dt>
            <dd>
              <b>{id.mode === "sandbox" ? "PayPal sandbox" : "mock PayPal (in memory, same answers, ids start with MOCK-)"}</b> · seat {id.seat} · hold {id.holdDays} days ·{" "}
              {Object.entries(id.counts)
                .filter(([, n]) => n > 0)
                .map(([s, n]) => `${n} ${s}`)
                .join(", ") || "no mission yet"}
            </dd>
            <dt>The payee's PayPal</dt>
            <dd>
              <input value={payee} onChange={(e) => (setPayee(e.target.value), set("payeeEmail", e.target.value))} placeholder="sandbox personal account that receives the payouts" style={{ minWidth: 360 }} />
              <span className="muted"> · the sandbox Personal account in sandbox; any address in mock</span>
            </dd>
          </dl>
        )}
      </Card>

      <Card n="2" title="Draft — pick the shape; the rule table is chosen with it" disabled={!id}>
        <div className="segmented" style={{ flexWrap: "wrap" }}>
          {pp.KINDS.map((x) => (
            <button key={x} className={draft.kind === x ? "active" : ""} onClick={() => pick(x)} disabled={!!m}>
              {x}
            </button>
          ))}
        </div>
        <p className="hint">
          <b>{SHAPES[draft.kind].label}.</b> Decides: {SHAPES[draft.kind].decides}.
        </p>
        <div className="row">
          <label className="grow">
            Title
            <input value={draft.title} onChange={(e) => set("title", e.target.value)} disabled={!!m} />
          </label>
          {draft.kind !== "pool" && (
            <label>
              {draft.kind === "advance" ? "Advance (USD)" : "Amount (USD)"}
              <input type="number" min={1} step={0.01} value={draft.amount} onChange={(e) => set("amount", e.target.value)} disabled={!!m} />
            </label>
          )}
          {(draft.kind === "pool" || draft.kind === "advance") && (
            <label>
              {draft.kind === "pool" ? "Target (USD)" : "Invoice (USD)"}
              <input type="number" min={1} step={0.01} value={draft.second} onChange={(e) => set("second", e.target.value)} disabled={!!m} />
            </label>
          )}
          {["payroll", "presence", "pool"].includes(draft.kind) && (
            <label>
              The date, in seconds
              <input type="number" min={5} value={draft.dateS} onChange={(e) => set("dateS", e.target.value)} disabled={!!m} />
            </label>
          )}
          {draft.kind === "vault" && (
            <label>
              Deadline, in seconds
              <input type="number" min={5} value={draft.dateS} onChange={(e) => set("dateS", e.target.value)} disabled={!!m} />
            </label>
          )}
        </div>
        <div className="row">
          {draft.kind !== "pool" && (
            <>
              <label>
                {draft.kind === "advance" ? "Debtor" : draft.kind === "vault" ? "Owner (tenant)" : "Payer"}
                <input value={draft.payerName} onChange={(e) => set("payerName", e.target.value)} disabled={!!m} />
              </label>
              <label className="grow">
                Payer's PayPal (the buyer who approves)
                <input value={draft.payerEmail} onChange={(e) => set("payerEmail", e.target.value)} disabled={!!m} />
              </label>
            </>
          )}
          <label>
            {draft.kind === "advance" ? "Supplier" : draft.kind === "vault" ? "Beneficiary (landlord)" : draft.kind === "pool" ? "Destination" : "Payee"}
            <input value={draft.payeeName} onChange={(e) => set("payeeName", e.target.value)} disabled={!!m} />
          </label>
        </div>
        <div className="row">
          {draft.kind === "delivery" && <span className="muted grow">Brief and four criteria are the demo's (the overbought-alert landing copy); the deliverable's URL comes at step 4.</span>}
          {draft.kind === "presence" && (
            <>
              <label className="grow">
                The post's URL (read at the date)
                <input value={draft.text} onChange={(e) => set("text", e.target.value)} disabled={!!m} />
              </label>
              <label>
                Must contain
                <input value={draft.mustContain} onChange={(e) => set("mustContain", e.target.value)} disabled={!!m} />
              </label>
            </>
          )}
          {draft.kind === "affiliate" && (
            <label className="grow">
              Order reference
              <input value={draft.text} onChange={(e) => set("text", e.target.value)} disabled={!!m} />
            </label>
          )}
          {draft.kind === "vault" && (
            <>
              <label className="grow">
                Lease (first memo)
                <input value={draft.text} onChange={(e) => set("text", e.target.value)} disabled={!!m} />
              </label>
              <label>
                <input type="checkbox" checked={draft.custody} onChange={(e) => set("custody", e.target.checked)} disabled={!!m} /> custody (a lease outlives the {id?.holdDays ?? 29}-day hold: captured at lock, paid back by payout)
              </label>
            </>
          )}
          {draft.kind === "advance" && (
            <label className="grow">
              Invoice URL (the seat reads it; the policy needs the memo to name it)
              <input value={draft.text} onChange={(e) => set("text", e.target.value)} disabled={!!m} />
            </label>
          )}
          <button className="primary" onClick={doDraft} disabled={!!m || busy === "draft" || !draft.title.trim()}>
            {busy === "draft" ? "Drafting…" : "Draft the mission"}
          </button>
          {m && <button onClick={reset}>New mission</button>}
        </div>
        <ErrorBox error={error} />
        {m && (
          <dl>
            <dt>Mission</dt>
            <dd>
              <b>{m.id}</b> · {m.kind} · <span className={stateClass(m.state)}>{m.state}</span> · {m.currency} {money(worth(m))}
              {toDate !== undefined && !closed && (toDate > 0 ? <span className="pending"> · the date in {toDate} s</span> : <span className="ok"> · date passed</span>)}
              {toDeadline !== undefined && !closed && toDeadline <= 0 && <span className="muted"> · deadline passed</span>}
            </dd>
            {token && (
              <>
                <dt>Merchant's token</dt>
                <dd>
                  <code>{token}</code> <span className="ko">— shown once; only its sha256 is kept by the desk</span>
                </dd>
              </>
            )}
          </dl>
        )}
      </Card>

      <Card n="3" title={k === "pool" ? "Fund — payer by payer, each one approves on PayPal's page" : k === "advance" ? "No hold — the advance is paid by the pool, not held" : "Lock — the payer approves an AUTHORIZE order on PayPal's page; nothing is charged"} disabled={!m}>
        {m && k === "pool" && (
          <div className="row">
            <label>
              Payer
              <input value={fundRow.name} onChange={(e) => setFundRow({ ...fundRow, name: e.target.value })} />
            </label>
            <label className="grow">
              Their PayPal
              <input value={fundRow.email} onChange={(e) => setFundRow({ ...fundRow, email: e.target.value })} />
            </label>
            <label>
              Brings (USD)
              <input type="number" min={1} value={fundRow.amount} onChange={(e) => setFundRow({ ...fundRow, amount: e.target.value })} />
            </label>
            <button className="primary" onClick={() => act("fund", { name: fundRow.name, email: fundRow.email, amount: Number(fundRow.amount) }, `fund ${fundRow.amount} by ${fundRow.name}`)} disabled={!!busy || closed}>
              {busy?.startsWith("fund") ? "Creating the order…" : "Add this payer"}
            </button>
          </div>
        )}
        {m && k !== "pool" && k !== "advance" && (
          <div className="row">
            <button className="primary" onClick={() => act("offer")} disabled={!!busy || m.state !== "drafted"}>
              {busy === "offer" ? "Creating the order…" : m.custody ? "Create the CAPTURE order (custody)" : "Create the AUTHORIZE order"}
            </button>
          </div>
        )}
        {m && m.payers.length > 0 && (
          <table className="lines">
            <tbody>
              {m.payers.map((p, i) => (
                <tr key={i}>
                  <td>
                    {p.name} · {money(p.trimmedTo ?? p.amount)}
                    {p.trimmedTo !== undefined && p.trimmedTo !== p.amount && <span className="muted"> (asked {money(p.amount)}, trimmed to what was missing)</span>}
                  </td>
                  <td className="muted">
                    {p.orderId ? `order ${p.orderId} · ${p.intent}` : "no order yet"}
                    {p.authorizationId && ` · hold ${p.authorizationId} (${p.authorizationStatus}) until ${when(p.expiresAt)}`}
                    {p.captureId && ` · captured ${p.captured ?? money(p.amount)} (${p.captureId})`}
                    {p.releasedToPayer && Number(p.releasedToPayer) > 0 && ` · ${p.releasedToPayer} back to the payer`}
                    {p.paidFrom && ` · paid from ${p.paidFrom}`}
                  </td>
                  <td className="num">
                    {p.approveUrl && !p.authorizationId && !p.captureId && (
                      <button onClick={() => approve(p, `${p.name} approves ${p.orderId}`)} disabled={!!busy}>
                        {mock ? `${p.name} approves (mock click)` : `${p.name} approves on PayPal`}
                      </button>
                    )}
                    {holdOpen(p) && <span className="ok">held, nothing charged</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {m && !mock && m.payers.some((p) => p.approveUrl && !p.authorizationId && !p.captureId) && (
          <p className="hint">In the sandbox the hold appears when PayPal sends the buyer back to the desk (127.0.0.1:8796/paypal/return). If the tab was closed first, press "lock" below.</p>
        )}
        {m && !mock && m.payers.some((p) => p.orderId && !p.authorizationId && !p.captureId) && (
          <button onClick={() => act("lock")} disabled={!!busy}>
            lock (authorize the approved orders)
          </button>
        )}
      </Card>

      <Card n="4" title={k ? stepTitle(k) : "The shape's own step"} disabled={!m || !(locked || closed || (k === "pool" && m?.state === "offered"))}>
        {m && k === "payroll" && <p className="hint">Nothing to do: the statement was validated by a named human before the lock, and the date decides. Press release at the date; before it, the gate refuses.</p>}
        {m && k === "pool" && <p className="hint">Nothing to do once the target is held: the date decides. A payer offering more than what is missing gets an order for the difference; a payer once full is refused.</p>}
        {m && k === "delivery" && (
          <>
            <div className="row">
              <label className="grow">
                The deliverable's URL (fetched and hashed by the code, then read by the seat)
                <input value={deliverUrl || pp.fixture("deliverable_landing.md")} onChange={(e) => setDeliverUrl(e.target.value)} />
              </label>
              <button className="primary" onClick={() => act("deliver", { url: deliverUrl || pp.fixture("deliverable_landing.md") })} disabled={!!busy || closed}>
                {busy === "deliver" ? "Fetching…" : "The freelancer delivers"}
              </button>
              <button className="primary" onClick={() => act("review", {}, "the seat reads")} disabled={!!busy || !m.deliverable || closed}>
                {busy === "the seat reads" ? `The seat (${id?.seat}) is reading…` : "The AI seat reads and writes its memo"}
              </button>
            </div>
            {m.deliverable && (
              <p className={m.deliverable.ok ? "ok" : "ko"}>
                {m.deliverable.ok ? `fetched: ${m.deliverable.bytes} bytes, sha256 ${short(m.deliverable.sha256, 12)}` : `not fetched: ${m.deliverable.why}`}
              </p>
            )}
          </>
        )}
        {m && k === "presence" && (
          <div className="row">
            <button className="primary" onClick={() => act("probe")} disabled={!!busy || closed}>
              {busy === "probe" ? "Reading the page…" : (toDate ?? 0) > 0 ? "The desk reads the page (before the date: it only watches)" : "The desk reads the page (at the date: it decides)"}
            </button>
            {m.lastSeen && (
              <span className={m.lastSeen.ok ? "ok" : "ko"}>
                {when(m.lastSeen.at)} · {m.lastSeen.why} · {m.lastSeen.decision ? "a decision" : "a watch, not a decision"}
              </span>
            )}
          </div>
        )}
        {m && k === "affiliate" && (
          <div className="row">
            <label className="grow">
              The merchant's token (the one shown once at the draft — try a wrong one first)
              <input value={confirmToken} onChange={(e) => setConfirmToken(e.target.value)} />
            </label>
            <button className="primary" onClick={() => act("confirm", { token: confirmToken, orderRef: m.orderRef }, "the merchant confirms the sale")} disabled={!!busy || closed}>
              {busy?.startsWith("the merchant") ? "…" : "The merchant's system confirms the sale"}
            </button>
            {m.confirmation && <span className="ok">confirmed {when(m.confirmation.at)} · order sha256 {short(m.confirmation.orderSha256, 12)}</span>}
          </div>
        )}
        {m && k === "vault" && (
          <>
            <div className="row">
              {["tenant", "landlord", "mediator", "stranger"].map((r) => (
                <label key={r}>
                  {r} says (USD to the landlord)
                  <input type="number" min={0} step={0.01} value={votes[r]} onChange={(e) => setVotes({ ...votes, [r]: e.target.value })} />
                  <button onClick={() => act("vote", { party: r, toBeneficiary: Number(votes[r]) }, `${r} votes ${votes[r]}`)} disabled={!!busy || closed}>
                    {r} votes
                  </button>
                </label>
              ))}
            </div>
            <p className="muted">
              {m.votes?.length ? m.votes.map((v) => `${v.party} → ${money(v.toBeneficiary)}`).join(" · ") : "no vote yet"} · {m.threshold} of {m.parties?.length} must agree on the same amount
            </p>
          </>
        )}
        {m && k === "advance" && (
          <>
            <div className="row">
              <button className="primary" onClick={() => act("review", {}, "the seat reads the invoice")} disabled={!!busy || closed}>
                {busy?.startsWith("the seat") ? `The seat (${id?.seat}) is reading…` : "The AI seat reads the invoice (then the policy runs)"}
              </button>
              <button onClick={() => act("policy")} disabled={!!busy || closed}>
                Run the policy alone
              </button>
              <label>
                Operator
                <input value={validator} onChange={(e) => setValidator(e.target.value)} placeholder="name" />
                <button onClick={() => act("validate", { by: validator, decision: "release" }, `${validator} signs`)} disabled={!!busy || !validator.trim() || closed}>
                  signs
                </button>
              </label>
            </div>
            {m.signatures && (
              <p className="muted">
                signatures: AI {m.signatures.ai ? "✓" : "—"} · policy {m.signatures.policy ? "✓" : "—"} · operator {m.signatures.operator ? "✓" : "—"} → {m.signatures.count} of 3
              </p>
            )}
            {m.policy && (
              <table className="lines">
                <tbody>
                  {m.policy.checks.map((c, i) => (
                    <tr key={i}>
                      <td>{c.check}</td>
                      <td className={c.ok ? "ok" : "ko"}>{c.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {m.state === "released" && !m.repayment && (
              <button onClick={() => act("repay")} disabled={!!busy}>
                Create the debtor's repayment order (intent CAPTURE, {money(m.invoiceAmount)})
              </button>
            )}
            {m.repayment && (
              <p className="muted">
                repayment order {m.repayment.orderId} · {money(m.repayment.amount)}{" "}
                {!m.repayment.captureId && (mock ? <button onClick={() => run("the debtor pays", async () => ({ ok: await pp.mockApprove(m.repayment!.approveUrl), status: 200, body: {} }))}>the debtor pays (mock click)</button> : <a href={m.repayment.approveUrl} target="_blank" rel="noreferrer">the debtor pays on PayPal</a>)}
                {m.repayment.captureId && <span className="ok"> · repaid {m.repayment.captureId}: the pool's capital is back</span>}
              </p>
            )}
          </>
        )}
        {m && (k === "delivery" || k === "advance") && m.memo && (
          <dl>
            <dt>Memo</dt>
            <dd>
              by {m.memo.model} at {when(m.memo.at)} · recommends <b>{m.memo.recommendation}</b>
              {m.memo.criteriaTotal !== undefined && ` · ${m.memo.criteriaMet}/${m.memo.criteriaTotal} criteria`} · sha256 {short(m.memo.sha256, 12)} (hashed before any human saw it){" "}
              <button onClick={loadMemo}>{memo ? "reload" : "read the memo"}</button>
            </dd>
            {memo && (
              <>
                <dt>Summary</dt>
                <dd>{memo.summary}</dd>
                <dt>Evidence</dt>
                <dd>
                  <ul className="muted">
                    {memo.evidence.map((e, i) => (
                      <li key={i}>
                        {e.fact} <i>({e.source})</i>
                      </li>
                    ))}
                  </ul>
                </dd>
                {memo.criteria.length > 0 && (
                  <>
                    <dt>Criteria</dt>
                    <dd>
                      <table className="lines">
                        <tbody>
                          {memo.criteria.map((c, i) => (
                            <tr key={i}>
                              <td>{c.criterion}</td>
                              <td className={c.met ? "ok" : "ko"}>{c.why}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </dd>
                  </>
                )}
                {memo.unverified.length > 0 && (
                  <>
                    <dt>Not verified</dt>
                    <dd className="muted">{memo.unverified.join(" · ")}</dd>
                  </>
                )}
              </>
            )}
          </dl>
        )}
        {m && k === "delivery" && (
          <div className="row">
            <label className="grow">
              A named human decides (the memo alone never pays)
              <input value={validator} onChange={(e) => setValidator(e.target.value)} placeholder="name of the human who read the memo" />
            </label>
            <button className="primary" onClick={() => act("validate", { by: validator, decision: "release" }, `${validator} validates: release`)} disabled={!!busy || !validator.trim() || closed}>
              validates: release
            </button>
            <button onClick={() => act("validate", { by: validator, decision: "refuse" }, `${validator} decides: refuse`)} disabled={!!busy || !validator.trim() || closed}>
              decides: refuse
            </button>
            {m.validation && <span className="ok">{m.validation.by} → {m.validation.decision} at {when(m.validation.at)}</span>}
          </div>
        )}
      </Card>

      <Card n="5" title="Release · void — every attempt goes to the gate; the refusals are the proof" disabled={!m}>
        <div className="row">
          <button className="primary" onClick={() => act("release")} disabled={!!busy || !m || closed}>
            {busy === "release" ? "Asking the gate…" : "Release (capture, then payout)"}
          </button>
          <button onClick={() => act("void")} disabled={!!busy || !m || closed}>
            {busy === "void" ? "Asking the gate…" : m?.custody ? "Deadline: pay the deposit back" : "Void (refund: the payer was never charged)"}
          </button>
          {m && <span className="muted">state: <b className={stateClass(m.state)}>{m.state}</b></span>}
        </div>
        {m?.release && (
          <dl>
            <dt>Released</dt>
            <dd>
              {when(m.release.at)} · {m.release.captures.map((c) => `${c.payer}: captured ${c.captured} (${c.captureId})${c.releasedToPayer && Number(c.releasedToPayer) > 0 ? `, ${c.releasedToPayer} back` : ""}`).join(" · ")}
            </dd>
            <dt>Payout</dt>
            <dd>
              {m.release.payout ? (
                <>
                  batch <b>{m.release.payout.batchId}</b> ({m.release.payout.status}) · {m.release.payout.items.map((x) => `${x.amount} → ${x.receiver} (${x.label})`).join(" · ")}
                  {Number(m.release.fee?.total) > 0 && <span className="muted"> · fee {m.release.fee.total} kept on the platform ({m.release.fee.bps} bp)</span>}
                </>
              ) : (
                "none"
              )}
            </dd>
          </dl>
        )}
        {outcomes.length > 0 && (
          <table className="lines">
            <tbody>
              {outcomes.map((o, i) => (
                <tr key={i}>
                  <td className="muted">{o.at.slice(11, 19)}Z</td>
                  <td>{o.what}</td>
                  <td className={o.refused ? "ko" : "ok"}>{o.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card n="6" title="Registry — paypal/sortie/missions.json: every mission, every PayPal id, every refusal" disabled={!id}>
        {all.length > 0 ? (
          <table className="lines registry">
            <thead>
              <tr>
                <th>mission</th>
                <th>shape</th>
                <th>state</th>
                <th className="num">USD</th>
                <th>holds / captures</th>
                <th>payout</th>
                <th>memo</th>
              </tr>
            </thead>
            <tbody>
              {[...all].reverse().slice(0, 20).map((x) => (
                <tr key={x.id}>
                  <td>{x.id}</td>
                  <td className="muted">{x.kind}{x.custody ? " · custody" : ""}</td>
                  <td className={stateClass(x.state)}>{x.state}</td>
                  <td className="num">{money(worth(x))}</td>
                  <td className="muted">{x.payers.map((p) => `${p.name}: ${p.captureId ? `captured ${p.captured ?? money(p.amount)}` : p.authorizationId ? `held ${p.held?.value ?? money(p.amount)}` : p.orderId ? "order, not approved" : "—"}`).join(" · ") || "—"}</td>
                  <td className="muted">{x.release?.payout ? `${x.release.payout.batchId} (${x.release.payout.status})` : x.refund?.batchId ? `refund ${x.refund.batchId}` : "—"}</td>
                  <td className="muted">{x.memo ? `${x.memo.model} → ${x.memo.recommendation}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No mission yet.</p>
        )}
      </Card>
    </>
  );
}

function stepTitle(k: pp.Kind) {
  switch (k) {
    case "payroll":
      return "The date — nothing else decides";
    case "delivery":
      return "Deliver → the AI seat reads → a named human validates";
    case "presence":
      return "The page — watched before the date, decided at the date";
    case "affiliate":
      return "The sale — the merchant's token, once";
    case "pool":
      return "The target, then the date";
    case "vault":
      return "The votes — 2 of 3 on the same amount; a stranger is refused";
    case "advance":
      return "Three seats — the AI reads, the policy checks, the operator signs; 2 of 3 pay";
  }
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
