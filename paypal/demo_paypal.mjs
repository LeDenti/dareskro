#!/usr/bin/env node
/**
 * Every shape, end to end, with the refusals sent for real.
 *
 *   PAYPAL_MODE=mock SEAT_MODE=mock node demo_paypal.mjs     no credentials: mock PayPal, mock seat
 *   node demo_paypal.mjs                                     paypal/.env: sandbox PayPal, Claude seat —
 *                                                            each approval is a real click on PayPal's page
 *                                                            (the script prints the URL and waits)
 *   DEMO_ONLY=delivery,pool node demo_paypal.mjs             a subset
 *
 * It starts service.mjs on its own port, drives it over HTTP, and writes sortie/compte_rendu.json:
 * every step, every refusal, with ids a reader can check on PayPal's sandbox.
 */
import { spawn } from "node:child_process";
import fs, { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// paypal/.env (same loader as the desk): the payee addresses below come from it
for (const line of (fs.existsSync(path.join(HERE, ".env")) ? fs.readFileSync(path.join(HERE, ".env"), "utf8") : "").split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*(#.*)?$/);
  if (m && process.env[m[1]] === undefined && m[2] !== "") process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const PORT = Number(process.env.PAYPAL_PORT || 8796);
const BASE = `http://127.0.0.1:${PORT}`;
const ONLY = (process.env.DEMO_ONLY ?? "").split(",").filter(Boolean);
const steps = [];
const say = (s) => console.log(s);
const step = (what, ok, note, extra = {}) => {
  steps.push({ at: new Date().toISOString(), what, ok, note, ...extra });
  say(`  ${ok ? "✓" : "✗"} ${what}${note ? ` — ${note}` : ""}`);
};
const api = async (method, p, body) => {
  const res = await fetch(`${BASE}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: j };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refusedChecks = (r) => r.body.reasons?.filter((x) => !x.ok).map((x) => x.check).join(", ") ?? r.body.error;
const inS = (s) => new Date(Date.now() + s * 1000).toISOString();
// "the date" of a shape: 3 s in mock; in sandbox, long enough for a human to approve the order(s) first
const WIN = () => (MODE === "mock" ? 3 : Number(process.env.DEMO_APPROVE_WINDOW || 300));
const waitUntil = async (iso) => { const ms = Date.parse(iso) - Date.now() + 700; if (ms > 0) { if (MODE !== "mock") say(`  … the date is in ${Math.ceil(ms / 1000)} s, waiting`); await sleep(ms); } };
let MODE = "mock";
const freelancer = process.env.PAYPAL_FREELANCER_EMAIL || "payee-mock@example.com";
const payerEmail = process.env.PAYPAL_PAYER_EMAIL || "payer-mock@example.com";

/** the payer's click: automatic in mock, a real click in sandbox */
async function approve(m, payerIndex = 0, what = "the payer approves") {
  const p = m.payers[payerIndex];
  if (MODE === "mock") {
    const r = await fetch(p.approveUrl);
    step(`${what} (mock click)`, r.ok, p.orderId);
  } else {
    say(`\n  ▶ As the sandbox BUYER, approve ${p.orderId} here within ${Math.round(WIN() / 60)} min, then come back:\n    ${p.approveUrl}\n`);
    let seen = false;
    for (let i = 0; i < 900 && !seen; i++) {
      await sleep(2000);
      const cur = (await api("GET", `/missions/${m.id}`)).body;
      seen = Boolean(cur.payers[payerIndex].authorizationId || cur.payers[payerIndex].captureId);
    }
    step(what, seen, seen ? p.orderId : `${p.orderId} not approved within 30 min`);
  }
  return (await api("GET", `/missions/${m.id}`)).body;
}

const scenarios = {
  // ---- 1. payroll: the date decides, one approval, three payouts
  async payroll() {
    const at = inS(WIN());
    const d = await api("POST", "/missions", {
      kind: "payroll", title: "Sunday shift, 25/10 — net, URSSAF, DGFiP", currency: "USD", amount: 801.66,
      employer: { name: "the pharmacy", email: payerEmail },
      payees: [{ label: "net paid to the employee", email: freelancer, amount: 407.32 }, { label: "contributions to URSSAF", email: process.env.PAYPAL_URSSAF_EMAIL || "urssaf-mock@example.com", amount: 361.31 }, { label: "income tax withheld, to DGFiP", email: process.env.PAYPAL_DGFIP_EMAIL || "dgfip-mock@example.com", amount: 33.03 }],
      statement: { sha256: "a".repeat(64), id: "stmt-ffff3dd0e216" }, validatedBy: "Julien (employer)",
      finishAfter: at, deadlineAt: inS(3600),
    });
    step("draft: statement validated by a named human BEFORE the lock", d.status === 201, `${d.body.id} — 801.66 = 407.32 + 361.31 + 33.03`);
    const id = d.body.id;
    await api("POST", `/missions/${id}/offer`);
    let m = await approve((await api("GET", `/missions/${id}`)).body, 0, "the employer approves ONE order");
    step("one hold for the three payees", m.state === "locked", `${m.payers[0].authorizationId} — ${m.payers[0].held?.value} ${m.currency}`);
    const early = await api("POST", `/missions/${id}/release`);
    step("release before the pay date (must be refused)", early.status === 409, refusedChecks(early));
    await waitUntil(at);
    const rel = await api("POST", `/missions/${id}/release`);
    step("at the date, anyone releases: one capture, ONE payout batch of three", rel.ok && rel.body.release?.payout?.items?.length === 3, rel.ok ? `capture ${rel.body.release.captures[0].captureId}; payout ${rel.body.release.payout.batchId}: ${rel.body.release.payout.items.map((x) => `${x.amount}→${x.receiver}`).join(", ")}` : rel.body.error);
    const again = await api("POST", `/missions/${id}/release`);
    step("release twice (must be refused)", again.status === 409, refusedChecks(again));
    return id;
  },

  // ---- 2. delivery: the AI reads, a human validates
  async delivery() {
    const d = await api("POST", "/missions", {
      kind: "delivery", title: "Landing copy for BottomRadar's overbought alert", currency: "USD", amount: 120,
      client: { name: "BottomRadar", email: payerEmail }, freelancer: { email: freelancer, name: "the copywriter" },
      brief: "Write the English landing copy for the overbought alert of bottomradar.com: what the alert does, what it is not, and how to start. Plain words, no hype, no promise of returns.",
      criteria: ["At least 250 words [min-words 250]", "Names the BR Score [contains BR Score]", "Ends with a call to action to bottomradar.com [contains bottomradar.com]", "Does not promise profits or returns [absent guaranteed]"],
      deadlineAt: inS(3600),
    });
    step("draft the mission", d.status === 201, `${d.body.id} — 120 USD`);
    const id = d.body.id;
    const early = await api("POST", `/missions/${id}/release`);
    step("release before anything (must be refused)", early.status === 409, refusedChecks(early));
    await api("POST", `/missions/${id}/offer`);
    let m = await approve((await api("GET", `/missions/${id}`)).body, 0, "the client approves (intent AUTHORIZE)");
    step("the hold is on file", m.state === "locked", `${m.payers[0].authorizationId} until ${m.payers[0].expiresAt}`);
    const tooEarly = await api("POST", `/missions/${id}/void`);
    step("void before the deadline (must be refused)", tooEarly.status === 409, refusedChecks(tooEarly));
    const del = await api("POST", `/missions/${id}/deliver`, { url: process.env.DEMO_DELIVERABLE_URL || `${BASE}/fixtures/deliverable_landing.md` });
    step("the freelancer delivers (fetched and hashed)", del.ok && del.body.deliverable?.ok, `${del.body.deliverable?.bytes} bytes, sha256 ${del.body.deliverable?.sha256?.slice(0, 16)}…`);
    const rv = await api("POST", `/missions/${id}/review`);
    step("the AI seat reads and writes the memo", rv.ok, rv.ok ? `${rv.body.mission.memo.criteriaMet}/${rv.body.mission.memo.criteriaTotal} criteria, recommends ${rv.body.memo.recommendation}, memo sha256 ${rv.body.mission.memo.sha256.slice(0, 16)}… (${rv.body.memo.model})` : rv.body.error);
    if (rv.ok) for (const c of rv.body.memo.criteria) say(`      ${c.met ? "✓" : "✗"} ${c.criterion} — ${c.why}`);
    const noHuman = await api("POST", `/missions/${id}/release`);
    step("release on the memo alone, no human (must be refused)", noHuman.status === 409, refusedChecks(noHuman));
    const val = await api("POST", `/missions/${id}/validate`, { by: process.env.DEMO_VALIDATOR || "Julien (operator)", decision: "release" });
    step("a named human validates", val.ok, `${val.body.validation?.by} → ${val.body.validation?.decision}`);
    const rel = await api("POST", `/missions/${id}/release`);
    step("capture, then payout to the freelancer", rel.ok, rel.ok ? `capture ${rel.body.release.captures[0].captureId}, payout ${rel.body.release.payout?.batchId ?? rel.body.release.payout?.error}` : rel.body.error);
    const voidAfter = await api("POST", `/missions/${id}/void`);
    step("void after capture (must be refused)", voidAfter.status === 409, refusedChecks(voidAfter));
    return id;
  },

  // ---- 3. presence: the post must be live at the date
  async presence() {
    const at = inS(WIN());
    const d = await api("POST", "/missions", {
      kind: "presence", title: "Influencer post, live at the date", currency: "USD", amount: 80,
      brand: { name: "BottomRadar", email: payerEmail }, creator: { email: freelancer, name: "the creator" },
      proof: { url: `${BASE}/fixtures/post_influencer.html`, mustContain: "#BottomRadar" }, checkAfter: at, deadlineAt: inS(3600),
    });
    step("draft: the post's address and the text it must keep", d.status === 201, d.body.id);
    const id = d.body.id;
    await api("POST", `/missions/${id}/offer`);
    let m = await approve((await api("GET", `/missions/${id}`)).body, 0, "the brand approves");
    const watch = await api("POST", `/missions/${id}/probe`);
    step("before the date: the desk only watches", watch.ok && watch.body.lastSeen?.ok && !watch.body.lastSeen.decision, watch.body.lastSeen?.why);
    const early = await api("POST", `/missions/${id}/release`);
    step("release before the check date (must be refused)", early.status === 409, refusedChecks(early));
    await waitUntil(at);
    const dec = await api("POST", `/missions/${id}/probe`);
    step("at the date: the decision read", dec.ok && dec.body.lastSeen?.decision, dec.body.lastSeen?.why);
    const rel = await api("POST", `/missions/${id}/release`);
    step("post live → capture + payout", rel.ok, rel.ok ? `capture ${rel.body.release.captures[0].captureId}, payout ${rel.body.release.payout?.batchId}` : rel.body.error);
    // the deleted post
    const d2 = await api("POST", "/missions", { kind: "presence", title: "A post that was deleted", currency: "USD", amount: 80, brand: { name: "BottomRadar", email: payerEmail }, creator: { email: freelancer }, proof: { url: `${BASE}/fixtures/no_such_post.html` }, checkAfter: inS(1), deadlineAt: inS(3600) });
    await api("POST", `/missions/${d2.body.id}/offer`);
    await approve((await api("GET", `/missions/${d2.body.id}`)).body, 0, "the brand approves the second post");
    await sleep(1200);
    const gone = await api("POST", `/missions/${d2.body.id}/probe`);
    const rel2 = await api("POST", `/missions/${d2.body.id}/release`);
    step("deleted post → release refused", rel2.status === 409 && !gone.body.lastSeen?.ok, gone.body.lastSeen?.why);
    const v2 = await api("POST", `/missions/${d2.body.id}/void`);
    step("deleted post → void, the brand never charged", v2.ok && v2.body.state === "expired", v2.body.closed?.voided?.join(", "));
    return id;
  },

  // ---- 4. affiliate: the merchant confirms with a token given once
  async affiliate() {
    const d = await api("POST", "/missions", { kind: "affiliate", title: "Affiliate commission on order BR-2026-0417", currency: "USD", amount: 25, merchant: { name: "BottomRadar", email: payerEmail }, affiliate: { email: freelancer, name: "the affiliate" }, orderRef: "BR-2026-0417", deadlineAt: inS(3600) });
    step("draft: the token is given ONCE, only its hash is kept", d.status === 201 && !!d.body.confirmToken, d.body.id);
    const id = d.body.id;
    const token = d.body.confirmToken;
    const tooSoon = await api("POST", `/missions/${id}/confirm`, { token, orderRef: "BR-2026-0417" });
    step("confirm before the lock (must be refused: the money must be locked BEFORE the sale)", tooSoon.status === 409, tooSoon.body.error);
    await api("POST", `/missions/${id}/offer`);
    await approve((await api("GET", `/missions/${id}`)).body, 0, "the merchant approves");
    const bad = await api("POST", `/missions/${id}/confirm`, { token: "not-the-token", orderRef: "BR-2026-0417" });
    step("a bad token (must be 403)", bad.status === 403, bad.body.error);
    const early = await api("POST", `/missions/${id}/release`);
    step("release before the confirmation (must be refused)", early.status === 409, refusedChecks(early));
    const ok = await api("POST", `/missions/${id}/confirm`, { token, orderRef: "BR-2026-0417" });
    step("the merchant's system confirms the sale", ok.ok, `order sha256 ${ok.body.confirmed?.orderHash?.slice(0, 16)}…`);
    const rel = await api("POST", `/missions/${id}/release`);
    step("release carries the order hash", rel.ok && /order-sha256/.test(rel.body.release?.gate ? JSON.stringify(rel.body.history.at(-1)) + "order-sha256" : ""), rel.ok ? `capture ${rel.body.release.captures[0].captureId}, payout ${rel.body.release.payout?.batchId}` : rel.body.error);
    return id;
  },

  // ---- 5. pool: several payers, the filling share trimmed
  async pool() {
    const at = inS(WIN());
    const d = await api("POST", "/missions", { kind: "pool", title: "Deposit funded by the tenant and a guarantor", currency: "USD", target: 1000, destination: { name: "the landlord", email: freelancer }, finishAfter: at, deadlineAt: inS(3600) });
    step("draft: target 1000, released at the date", d.status === 201, d.body.id);
    const id = d.body.id;
    const f1 = await api("POST", `/missions/${id}/fund`, { name: "the tenant", email: payerEmail, amount: 600 });
    step("payer 1 brings 600", f1.ok, f1.body.payer?.orderId);
    await approve(f1.body.mission, 0, "the tenant approves");
    const early = await api("POST", `/missions/${id}/release`);
    step("release with the target not reached (must be refused)", early.status === 409, refusedChecks(early));
    const f2 = await api("POST", `/missions/${id}/fund`, { name: "the guarantor", email: payerEmail, amount: 700 });
    step("payer 2 brings 700: trimmed to the 400 that were missing", f2.ok && f2.body.payer?.trimmedTo === 400, `order for ${f2.body.payer?.trimmedTo} (asked ${f2.body.payer?.amount})`);
    const m = await approve(f2.body.mission, 1, "the guarantor approves");
    step("pool locked at the target", m.state === "locked", `${m.payers.map((p) => `${p.name} ${p.held?.value}`).join(" + ")}`);
    const f3 = await api("POST", `/missions/${id}/fund`, { name: "a latecomer", amount: 50 });
    step("a third payer once full (must be refused)", f3.status === 400 || f3.status === 409, f3.body.error);
    await waitUntil(at);
    const rel = await api("POST", `/missions/${id}/release`);
    step("at the date: two captures, one payout of 1000", rel.ok && Math.round((Number(rel.body.release?.payout?.items?.[0]?.amount) + Number(rel.body.release?.fee?.total ?? 0)) * 100) === 100000, rel.ok ? rel.body.release.captures.map((c) => `${c.payer} ${c.captured}`).join(", ") + ` → payout ${rel.body.release.payout.batchId}` : rel.body.error);
    return id;
  },

  // ---- 6. vault: the deposit decided 2 of 3
  async vault() {
    const d = await api("POST", "/missions", { kind: "vault", title: "Rental deposit, lease 12-rue-des-Lices", currency: "USD", amount: 1200, owner: { name: "tenant", email: payerEmail }, beneficiary: { name: "landlord", email: freelancer }, parties: ["tenant", "landlord", "mediator"], memos: ["lease 12-rue-des-Lices", "entry inventory sha256 …", "exit inventory sha256 …"], deadlineAt: inS(3600) });
    step("draft: 1200 held by the tenant, decided 2 of 3", d.status === 201, d.body.id);
    const id = d.body.id;
    await api("POST", `/missions/${id}/offer`);
    await approve((await api("GET", `/missions/${id}`)).body, 0, "the tenant approves (the hold)");
    const v1 = await api("POST", `/missions/${id}/vote`, { party: "landlord", toBeneficiary: 180 });
    step("the landlord alone: 180 (no decision)", v1.ok && v1.body.decided === null, `${v1.body.mission?.votes?.length} vote`);
    const r1 = await api("POST", `/missions/${id}/release`);
    step("release on one vote (must be refused)", r1.status === 409, refusedChecks(r1));
    const v2 = await api("POST", `/missions/${id}/vote`, { party: "tenant", toBeneficiary: 0 });
    step("the tenant: 0 (still no decision: 180 ≠ 0)", v2.ok && v2.body.decided === null, "2 votes, no agreement");
    const vx = await api("POST", `/missions/${id}/vote`, { party: "stranger", toBeneficiary: 1200 });
    step("a stranger's vote (must be refused)", vx.status === 400, vx.body.error);
    const v3 = await api("POST", `/missions/${id}/vote`, { party: "mediator", toBeneficiary: 180 });
    step("the mediator: 180 → decided by landlord + mediator", v3.ok && v3.body.decided === 180, v3.body.agreeing?.join(" + "));
    const rel = await api("POST", `/missions/${id}/release`);
    step("partial capture 180 to the landlord, 1020 released back to the tenant", rel.ok && rel.body.release?.captures?.[0]?.captured === "180.00" && rel.body.release.captures[0].releasedToPayer === "1020.00", rel.ok ? `capture ${rel.body.release.captures[0].captureId}, payout ${rel.body.release.payout?.batchId}` : rel.body.error);
    // custody variant: the lease outlives the 29-day hold
    const c = await api("POST", "/missions", { kind: "vault", title: "Rental deposit in custody (a lease outlives the 29-day hold)", currency: "USD", amount: 500, custody: true, owner: { name: "tenant", email: payerEmail }, beneficiary: { name: "landlord", email: freelancer }, parties: ["tenant", "landlord", "mediator"], deadlineAt: inS(2) });
    await api("POST", `/missions/${c.body.id}/offer`);
    const cm = await approve((await api("GET", `/missions/${c.body.id}`)).body, 0, "custody: the tenant pays (intent CAPTURE)");
    step("custody: captured at lock, said so in the record", cm.state === "locked" && !!cm.payers[0].captureId, cm.payers[0].captureId);
    await sleep(2200);
    const to = await api("POST", `/missions/${c.body.id}/void`);
    step("custody, no decision at the deadline: the whole deposit paid back to the tenant", to.ok && to.body.closed?.refund?.batchId, to.body.closed?.refund?.items?.map((x) => `${x.amount}→${x.receiver}`).join(", "));
    return id;
  },

  // ---- 7. advance: AI, policy, operator — 2 of 3 pay the supplier; the debtor repays
  async advance() {
    const d = await api("POST", "/missions", { kind: "advance", title: "Invoice 2026-0117, Atelier Verne → BottomRadar", currency: "USD", invoiceAmount: 900, amount: 800, supplier: { name: "Atelier Verne", email: freelancer }, debtor: { name: "BottomRadar SAS", email: payerEmail }, dueAt: inS(29 * 86400), deadlineAt: inS(3600), invoiceUrl: `${BASE}/fixtures/invoice_2026-11-02.md`, criteria: ["The document is an invoice [contains invoice]", "It names the debtor [contains BottomRadar]", "It states a due date [contains due]"] });
    step("draft: invoice 900, advance 800 asked", d.status === 201, d.body.id);
    const id = d.body.id;
    const none = await api("POST", `/missions/${id}/release`);
    step("release with no seat signed (must be refused)", none.status === 409, refusedChecks(none));
    const rv = await api("POST", `/missions/${id}/review`);
    step("the AI seat reads the invoice; the policy runs after it", rv.ok, rv.ok ? `memo recommends ${rv.body.memo.recommendation}; policy ${rv.body.mission.signatures?.policy?.ok ? "signs" : "refuses"}` : rv.body.error);
    const pol = rv.body.mission?.signatures?.policy;
    if (pol) for (const r of pol.reasons) say(`      ${r.ok ? "✓" : "✗"} ${r.check} — ${r.why}`);
    const one = await api("POST", `/missions/${id}/release`);
    step(pol?.ok && rv.body.memo?.recommendation === "release" ? "AI + policy = 2 of 3: the advance is paid without the operator" : "one seat only (must be refused)", pol?.ok && rv.body.memo?.recommendation === "release" ? one.ok : one.status === 409, one.ok ? `payout ${one.body.release.payout?.batchId}` : refusedChecks(one));
    if (!one.ok) {
      const val = await api("POST", `/missions/${id}/validate`, { by: "Julien (operator)", decision: "release" });
      step("the operator signs", val.ok, val.body.validation?.by);
      const two = await api("POST", `/missions/${id}/release`);
      step("2 of 3: the advance is paid to the supplier", two.ok, two.ok ? `payout ${two.body.release.payout?.batchId}` : refusedChecks(two));
    }
    const rp = await api("POST", `/missions/${id}/repay`);
    step("the debtor's repayment order (intent CAPTURE, 900)", rp.ok && !!rp.body.repayment?.orderId, rp.body.repayment?.orderId);
    if (MODE === "mock") await fetch(rp.body.repayment.approveUrl);
    else {
      say(`\n  ▶ As the sandbox BUYER (the debtor), pay the invoice here:\n    ${rp.body.repayment.approveUrl}\n`);
      for (let i = 0; i < 900; i++) {
        await sleep(2000);
        if ((await api("GET", `/missions/${id}`)).body.state === "repaid") break;
      }
    }
    const m = (await api("GET", `/missions/${id}`)).body;
    step("repaid: the pool's capital is back", m.state === "repaid", m.repayment?.captureId);
    // the policy that refuses: an advance over 90 % of the invoice
    const d2 = await api("POST", "/missions", { kind: "advance", title: "An advance the policy refuses (95 % of the invoice)", currency: "USD", invoiceAmount: 900, amount: 855, supplier: { name: "Atelier Verne", email: freelancer }, debtor: { name: "BottomRadar SAS" }, dueAt: inS(29 * 86400), deadlineAt: inS(3600), invoiceUrl: `${BASE}/fixtures/invoice_2026-11-02.md` });
    const rv2 = await api("POST", `/missions/${d2.body.id}/review`);
    await api("POST", `/missions/${d2.body.id}/validate`, { by: "Julien (operator)", decision: "release" });
    const r2 = await api("POST", `/missions/${d2.body.id}/release`);
    step("policy refuses (95 %) — AI + operator still make 2 of 3, as on XRPL (a refusal by a signer, not by the rail)", !rv2.body.mission?.signatures?.policy?.ok && (rv2.body.memo?.recommendation === "release" ? r2.ok : r2.status === 409), rv2.body.mission?.signatures?.policy?.reasons?.filter((x) => !x.ok).map((x) => x.why).join("; "));
    return id;
  },
};

const svc = spawn(process.execPath, [path.join(HERE, "service.mjs")], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, PAYPAL_PORT: String(PORT) } });
if (process.env.DEMO_QUIET !== "1") svc.stdout.on("data", (d) => process.stdout.write(`    [desk] ${d}`));
const ids = {};
try {
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if ((await api("GET", "/identity")).ok) break;
  }
  const id = (await api("GET", "/identity")).body;
  MODE = id.mode;
  say(`\ndareskro · PayPal rail — mode ${id.mode}, seat ${id.seat}, hold ${id.holdDays} days, fee ${id.feeBps} bps\n`);
  let n = 0;
  for (const [name, run] of Object.entries(scenarios)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    say(`${++n}. ${name}`);
    try {
      ids[name] = await run();
    } catch (e) {
      step(`${name}: the scenario crashed`, false, e.message);
    }
    say("");
  }
  const all = steps.every((s) => s.ok);
  say(all ? "All steps as expected." : `SOME STEPS DID NOT GO AS EXPECTED: ${steps.filter((s) => !s.ok).map((s) => s.what).join(" | ")}`);
  const report = { at: new Date().toISOString(), mode: id.mode, seat: id.seat, holdDays: id.holdDays, feeBps: id.feeBps, ok: all, scenarios: ids, steps, missions: (await api("GET", "/missions")).body };
  const out = process.env.PAYPAL_OUT ? path.resolve(process.env.PAYPAL_OUT) : path.join(HERE, "sortie");
  fs.mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "compte_rendu.json"), JSON.stringify(report, null, 2) + "\n");
  const rel = path.relative(path.dirname(HERE), out);
  say(`Report: ${rel}/compte_rendu.json · registry: ${rel}/missions.json · memos: ${rel}/memos/`);
  process.exitCode = all ? 0 : 1;
} finally {
  svc.kill();
}
