#!/usr/bin/env node
/**
 * dareskro's PayPal desk — every shape of the ledger desk, with PayPal's verbs.
 *
 *   node service.mjs                 http://127.0.0.1:8796   (PAYPAL_PORT; env in paypal/.env)
 *   hosted (Render, see ../render.yaml): PORT and RENDER_EXTERNAL_URL are the host's; the service then listens on
 *   0.0.0.0 and also serves the built desk (../app/dist, or DESK_DIST) at /, so one URL is the whole demo.
 *
 * The shapes are in kinds.mjs (payroll, delivery, presence, affiliate, pool, vault, advance);
 * the verbs in rail.mjs (authorize = lock, capture = release, void = refund, payout = pay);
 * the model in seat.mjs (it reads, it never pays). This file is the state machine and the HTTP.
 *
 *   drafted ──offer / fund──▶ offered ──the payer approves on PayPal──▶ locked (every hold on file)
 *   locked ──deliver──▶ delivered ──review (AI seat)──▶ reviewed ──validate (human)──▶ validated
 *   … ──release──▶ released (captures, then ONE payout batch)      … ──void──▶ expired / refused
 *   advance only: released ──repay (the debtor's CAPTURE order)──▶ repaid
 *
 * ROUTES (JSON; CORS open for the desk)
 *   GET  /identity                        mode, seat, hold length, fee, counts by state
 *   GET  /kinds                           the seven shapes and what each needs
 *   GET  /missions · /missions/<id> · /missions/<id>/memo
 *   POST /missions                        { kind, ...fields of that kind }  (kinds.mjs: draft)
 *   POST /missions/<id>/offer             one PayPal order per payer (intent AUTHORIZE; CAPTURE in custody)
 *   POST /missions/<id>/fund              pool: { name, email?, amount } → a payer and its order
 *   GET  /paypal/return?mission=&payer=   PayPal sends the payer back: the desk authorizes (the hold)
 *   POST /missions/<id>/lock              authorize every approved order by hand
 *   POST /missions/<id>/deliver           delivery: { url }
 *   POST /missions/<id>/review            delivery, advance: the AI seat writes the memo; advance: then the policy
 *   POST /missions/<id>/validate          { by, decision: release|refuse } — the named human
 *   POST /missions/<id>/confirm           affiliate: { token, orderRef }
 *   POST /missions/<id>/probe             presence: read the post now (decision if checkAfter is reached)
 *   POST /missions/<id>/vote              vault: { party, toBeneficiary }
 *   POST /missions/<id>/release           the kind's gate, then captures + payout; 409 with every reason
 *   POST /missions/<id>/void              the kind's gate, then void; 409 with every reason
 *   POST /missions/<id>/repay             advance: the debtor's repayment order → approveUrl
 *   GET  /mock/approve/<orderId>          mock mode only: plays the payer's click
 *   GET  /fixtures/<file>                 the demo documents
 */
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { railFromEnv } from "./rail.mjs";
import { KINDS, kindOf, money } from "./kinds.mjs";
import { deadlineFitsHold, sha256 } from "./gate.mjs";
import { fetchDeliverable } from "./fetch_deliverable.mjs";
import { review } from "./seat.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(HERE, ".env"));
const PORT = Number(process.env.PORT || process.env.PAYPAL_PORT || 8796); // PORT: the host's (Render)
const HOST = process.env.PAYPAL_HOST || (process.env.PORT || process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const BASE = process.env.PAYPAL_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;
const DESK_DIST = process.env.DESK_DIST ? path.resolve(process.env.DESK_DIST) : path.join(HERE, "..", "app", "dist"); // the built desk, served at / when it exists
const OUT = process.env.PAYPAL_OUT ? path.resolve(process.env.PAYPAL_OUT) : path.join(HERE, "sortie"); // PAYPAL_OUT: keep a sandbox run apart from a mock run
const MEMOS = path.join(OUT, "memos");
const REGISTRY = path.join(OUT, "missions.json");
const LOG = path.join(OUT, "service.log");
for (const d of [OUT, MEMOS]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

const rail = railFromEnv(process.env, { mockApproveBase: BASE });
const SEAT = process.env.SEAT_MODE === "mock" || !process.env.ANTHROPIC_API_KEY ? "mock" : process.env.SEAT_MODEL || "claude-opus-5-5";
const tarif = (() => {
  try {
    const t = JSON.parse(readFileSync(path.join(HERE, "tarif.json"), "utf8"));
    const bps = Number.isInteger(t.bps) && t.bps >= 0 ? t.bps : 0;
    if (bps > 100) throw new Error(`tarif.json: ${bps} bps is above the 100 bps (1 %) the code allows`);
    return { bps };
  } catch (e) {
    if (/above/.test(e.message)) throw e;
    return { bps: 0 };
  }
})();
const log = (s) => {
  const line = `${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC  ${s}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
};
const missions = existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, "utf8")) : [];
const save = () => writeFileSync(REGISTRY, JSON.stringify(missions, null, 2) + "\n");
const byId = (id) => missions.find((m) => m.id === id);
const history = (m, what, extra = {}) => (m.history ??= []).push({ at: new Date().toISOString(), what, ...extra });
const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, extra });
const states = ["drafted", "offered", "locked", "delivered", "reviewed", "validated", "released", "repaid", "refused", "expired"];

// ---- PayPal, per payer
async function orderFor(m, i) {
  const p = m.payers[i];
  if (p.orderId) return p;
  const amount = p.trimmedTo ?? p.amount;
  const args = { amount, currency: m.currency, description: `dareskro ${m.kind} ${m.id}: ${m.title}`, customId: `${m.id}:${i}`, returnUrl: `${BASE}/paypal/return?mission=${m.id}&payer=${i}`, cancelUrl: `${BASE}/paypal/cancel?mission=${m.id}&payer=${i}` };
  const o = m.custody ? await rail.createCaptureOrder(args) : await rail.createOrder(args);
  Object.assign(p, { orderId: o.id, orderStatus: o.status, approveUrl: o.approveUrl, intent: m.custody ? "CAPTURE" : "AUTHORIZE" });
  history(m, "order", { payer: p.name, orderId: o.id, intent: p.intent, amount: money(amount) });
  log(`${m.id}: order ${o.id} for ${p.name} — ${money(amount)} ${m.currency}, intent ${p.intent}; approve at ${o.approveUrl}`);
  return p;
}
async function holdFor(m, i) {
  const p = m.payers[i];
  if (p.authorizationId || p.captureId) return p;
  if (m.custody) {
    const c = await rail.captureOrder(p.orderId);
    Object.assign(p, { captureId: c.captureId, captureStatus: c.status, orderStatus: "COMPLETED", paidFrom: c.payerEmail || p.email });
    history(m, "custody-capture", { payer: p.name, captureId: c.captureId });
    log(`${m.id}: ${p.name}'s ${money(p.amount)} ${m.currency} captured into custody (${c.captureId})`);
    return p;
  }
  const a = await rail.authorize(p.orderId);
  Object.assign(p, { authorizationId: a.authorizationId, authorizationStatus: a.status, held: a.amount, expiresAt: a.expiresAt, orderStatus: "COMPLETED", paidFrom: a.payerEmail || p.email });
  const fit = deadlineFitsHold(m.deadlineAt, a.expiresAt);
  if (!fit.ok) {
    await rail.void(a.authorizationId);
    p.authorizationStatus = "VOIDED";
    history(m, "void", { payer: p.name, why: fit.why });
    log(`${m.id}: ${fit.why} — ${p.name}'s hold voided at once`);
    throw fail(422, fit.why);
  }
  history(m, "hold", { payer: p.name, authorizationId: a.authorizationId, held: a.amount, expiresAt: a.expiresAt });
  log(`${m.id}: hold ${a.authorizationId} — ${a.amount.value} ${a.amount.currency_code} of ${p.name} until ${a.expiresAt}`);
  return p;
}
async function holds(m) {
  return Promise.all(m.payers.map(async (p) => (p.authorizationId ? rail.getAuthorization(p.authorizationId).catch(() => null) : null)));
}
function settle(m) {
  const k = kindOf(m);
  if (["drafted", "offered"].includes(m.state) && k.lockedWhen(m)) {
    m.state = "locked";
    history(m, "locked");
    log(`${m.id}: locked — ${k.label}`);
  } else if (m.state === "drafted" && m.payers.some((p) => p.orderId)) m.state = "offered";
  save();
}

// ---- the steps
function draft(b) {
  const k = KINDS[b.kind];
  if (!k) throw fail(400, `kind: one of ${Object.keys(KINDS).join(", ")}`);
  const { errors, fields } = k.draft(b);
  if (errors.length) throw fail(400, "draft refused", { errors });
  const m = { id: `${b.kind.slice(0, 3).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`, kind: b.kind, state: "drafted", ...fields, createdAt: new Date().toISOString(), history: [] };
  let once = {};
  if (b.kind === "affiliate") {
    // the merchant's token: given once, only its hash is kept (the oracle's rule on XRPL)
    const token = randomBytes(24).toString("base64url");
    m.confirmTokenSha256 = sha256(token);
    once = { confirmToken: token };
  }
  history(m, "draft");
  missions.push(m);
  log(`${m.id}: drafted ${m.kind} "${m.title}" — ${m.currency}, deadline ${m.deadlineAt}`);
  settle(m); // a shape with no hold (the advance) is locked at once
  return { ...m, ...once };
}
async function offer(m) {
  if (!["drafted", "offered"].includes(m.state)) throw fail(409, `mission is ${m.state}`);
  if (m.kind === "pool") throw fail(409, "a pool is funded payer by payer: POST /fund");
  for (let i = 0; i < m.payers.length; i++) await orderFor(m, i);
  settle(m);
  return m;
}
async function fund(m, b) {
  const k = kindOf(m);
  if (!k.fund) throw fail(409, `${m.kind} has one payer: POST /offer`);
  if (!["drafted", "offered"].includes(m.state)) throw fail(409, `mission is ${m.state}`);
  const r = k.fund(m, b);
  if (r.error) throw fail(400, r.error);
  m.payers.push(r.payer);
  await orderFor(m, m.payers.length - 1);
  settle(m);
  return { mission: m, payer: m.payers.at(-1) };
}
async function lock(m, onlyPayer) {
  if (!["drafted", "offered"].includes(m.state)) throw fail(409, `mission is ${m.state}`);
  for (let i = 0; i < m.payers.length; i++) {
    if (onlyPayer !== undefined && i !== onlyPayer) continue;
    const p = m.payers[i];
    if (!p.orderId || p.authorizationId || p.captureId) continue;
    try {
      await holdFor(m, i);
    } catch (e) {
      if (onlyPayer !== undefined || e.status === 422) throw e;
      log(`${m.id}: ${p.name}'s order ${p.orderId} not authorizable yet — ${e.message.split("\n")[0]}`);
    }
  }
  settle(m);
  return m;
}
async function deliver(m, { url }) {
  if (!kindOf(m).needs?.deliver) throw fail(409, `${m.kind} has nothing to deliver`);
  if (!["locked", "delivered", "reviewed"].includes(m.state)) throw fail(409, `mission is ${m.state}: deliver needs a locked hold`);
  if (!url || !/^https?:\/\//.test(url)) throw fail(400, "url: http(s) URL of the deliverable");
  const f = await fetchDeliverable(url);
  m.deliverable = { url, sha256: f.sha256 ?? null, bytes: f.bytes ?? null, status: f.status, ok: f.ok, why: f.why ?? null, at: new Date().toISOString() };
  m.state = "delivered";
  delete m.memo;
  delete m.validation;
  history(m, "deliver", { url, sha256: f.sha256 ?? null, ok: f.ok });
  log(`${m.id}: delivered ${url} — ${f.ok ? `${f.bytes} bytes, sha256 ${f.sha256.slice(0, 12)}…` : f.why}`);
  save();
  return m;
}
async function reviewMission(m) {
  const k = kindOf(m);
  if (!k.needs?.review) throw fail(409, `${m.kind} has no memo: the code decides`);
  const url = m.kind === "advance" ? m.invoiceUrl : m.deliverable?.url;
  if (!url) throw fail(409, `mission is ${m.state}: nothing delivered to review`);
  const fetched = await fetchDeliverable(url); // read again now: the memo is about what is online at review time
  const seatMission = { ...m, paypal: { orderId: m.payers[0]?.orderId, authorizationId: m.payers[0]?.authorizationId }, amount: m.advance ?? m.payers[0]?.amount };
  const r = await review({ mission: seatMission, fetched, env: process.env, log });
  const file = path.join(MEMOS, `${m.id}.json`);
  writeFileSync(file, r.text);
  m.memo = { sha256: r.sha256, file: path.relative(HERE, file), recommendation: r.memo.recommendation, model: r.memo.model, at: r.memo.at, deliverableUrl: url, deliverableSha256: fetched.sha256 ?? null, criteriaMet: r.memo.criteria.filter((c) => c.met).length, criteriaTotal: r.memo.criteria.length };
  if (["locked", "delivered", "reviewed"].includes(m.state)) m.state = "reviewed";
  history(m, "review", { memoSha256: r.sha256, recommendation: r.memo.recommendation, model: r.memo.model });
  log(`${m.id}: memo ${r.sha256.slice(0, 12)}… by ${r.memo.model} — ${m.memo.criteriaMet}/${m.memo.criteriaTotal} criteria, recommends ${r.memo.recommendation}`);
  if (k.policy) policy(m);
  save();
  return { mission: m, memo: r.memo };
}
function policy(m) {
  const k = kindOf(m);
  if (!k.policy) throw fail(409, `${m.kind} has no risk policy`);
  const r = k.policy(m);
  m.signatures = { ...(m.signatures ?? {}), policy: { ok: r.ok, reasons: r.reasons, at: new Date().toISOString() } };
  history(m, "policy", { ok: r.ok, refused: r.reasons.filter((x) => !x.ok).map((x) => x.check) });
  log(`${m.id}: policy ${r.ok ? "signs" : "REFUSES"} — ${r.reasons.map((x) => `${x.check}: ${x.ok ? "ok" : x.why}`).join("; ")}`);
  save();
  return m;
}
function validate(m, { by, decision }) {
  if (!kindOf(m).needs?.validate) throw fail(409, `${m.kind}: no human decision at this step (the code or the date decides)`);
  if (!["locked", "delivered", "reviewed", "validated"].includes(m.state)) throw fail(409, `mission is ${m.state}`);
  if (m.kind === "delivery" && m.state !== "reviewed" && m.state !== "validated") throw fail(409, "a human validates a reviewed delivery (the memo first)");
  if (m.kind === "pool" && m.finishAfter) throw fail(409, "this pool is released by its date, not by a human");
  if (!by || String(by).trim().length < 2) throw fail(400, "by: the validator's name");
  if (!["release", "refuse"].includes(decision)) throw fail(400, "decision: release | refuse");
  m.validation = { by: String(by).trim(), decision, at: new Date().toISOString(), memoSha256: m.memo?.sha256 ?? null };
  m.state = "validated";
  history(m, "validate", { by: m.validation.by, decision });
  log(`${m.id}: ${m.validation.by} decided ${decision}${m.memo ? ` on memo ${m.memo.sha256.slice(0, 12)}…` : ""}`);
  save();
  return m;
}
function confirm(m, { token, orderRef }) {
  if (!kindOf(m).needs?.confirm) throw fail(409, `${m.kind} has no merchant confirmation`);
  if (m.state !== "locked") throw fail(409, `mission is ${m.state}: the money must be locked BEFORE the sale`);
  const given = Buffer.from(sha256(String(token ?? "")), "hex");
  const kept = Buffer.from(m.confirmTokenSha256, "hex");
  if (given.length !== kept.length || !timingSafeEqual(given, kept)) {
    history(m, "confirm-refused");
    log(`${m.id}: confirmation with a bad token refused`);
    throw fail(403, "bad token");
  }
  const orderHash = sha256(JSON.stringify({ mission: m.id, orderRef: String(orderRef ?? m.orderRef ?? ""), at: new Date().toISOString() }));
  m.confirmed = { orderRef: String(orderRef ?? m.orderRef ?? ""), orderHash, at: new Date().toISOString() };
  history(m, "confirm", { orderHash });
  log(`${m.id}: the merchant confirms order ${m.confirmed.orderRef} — sha256 ${orderHash.slice(0, 12)}…`);
  save();
  return m;
}
async function probe(m) {
  if (!kindOf(m).needs?.probe) throw fail(409, `${m.kind} has nothing to probe`);
  const f = await fetchDeliverable(m.proof.url);
  const has = m.proof.mustContain ? (f.text ?? "").includes(m.proof.mustContain) : true;
  const ok = f.ok && has;
  const why = !f.ok ? f.why : !has ? `"${m.proof.mustContain}" not in the page` : `HTTP ${f.status}, ${f.bytes} bytes${m.proof.mustContain ? `, contains "${m.proof.mustContain}"` : ""}`;
  m.lastSeen = { at: new Date().toISOString(), ok, why, sha256: f.sha256 ?? null, decision: Date.parse(m.checkAfter) <= Date.now() };
  m.looks = (m.looks ?? 0) + 1;
  appendFileSync(path.join(OUT, `observations_${m.id}.jsonl`), JSON.stringify(m.lastSeen) + "\n");
  history(m, "probe", m.lastSeen);
  log(`${m.id}: post ${ok ? "live" : "NOT live"} — ${why}${m.lastSeen.decision ? " (decision)" : " (watch)"}`);
  save();
  return m;
}
function vote(m, b) {
  const k = kindOf(m);
  if (!k.vote) throw fail(409, `${m.kind} has no votes`);
  if (m.state !== "locked") throw fail(409, `mission is ${m.state}: votes need the deposit on file`);
  const r = k.vote(m, b);
  if (r.error) throw fail(400, r.error);
  history(m, "vote", { party: b.party, toBeneficiary: Number(b.toBeneficiary), decided: r.decided });
  log(`${m.id}: ${b.party} votes ${money(b.toBeneficiary)} to the beneficiary — ${r.decided !== null ? `DECIDED by ${r.agreeing.join(" + ")}` : `${m.votes.length} vote(s), no decision`}`);
  save();
  return { mission: m, decided: r.decided, agreeing: r.agreeing };
}
async function release(m) {
  const k = kindOf(m);
  const hs = await holds(m);
  const plan = k.release(m, hs, Date.now());
  const refused = plan.reasons.filter((r) => !r.ok);
  history(m, "release-attempt", { ok: !refused.length, refused: refused.map((r) => `${r.check}: ${r.why}`) });
  if (refused.length) {
    log(`${m.id}: release REFUSED — ${refused.map((r) => `${r.check}: ${r.why}`).join("; ")}`);
    save();
    throw fail(409, "the gate refuses the release", { reasons: plan.reasons });
  }
  const captures = [];
  for (const c of plan.captures) {
    const p = m.payers[c.payer];
    const r = await rail.capture(p.authorizationId, { amount: c.amount, currency: m.currency, note: `dareskro ${m.id} — ${plan.note}`.slice(0, 255), invoiceId: `dareskro-${m.id}-${c.payer}` });
    Object.assign(p, { captureId: r.captureId, captured: r.captured, releasedToPayer: r.releasedToPayer, authorizationStatus: "CAPTURED" });
    captures.push({ payer: p.name, captureId: r.captureId, captured: r.captured, releasedToPayer: r.releasedToPayer });
    log(`${m.id}: captured ${r.captured} ${m.currency} of ${p.name} (${r.captureId})${Number(r.releasedToPayer) > 0 ? `, ${r.releasedToPayer} released back` : ""}`);
  }
  if (plan.voidIfNoCapture) {
    for (const p of m.payers) if (p.authorizationId && p.authorizationStatus === "CREATED") {
      await rail.void(p.authorizationId);
      p.authorizationStatus = "VOIDED";
      log(`${m.id}: nothing to the beneficiary — ${p.name}'s hold voided, the whole deposit stays with the owner`);
    }
  }
  // the fee per act: taken on what leaves the platform, bounded by the code (≤ 1 %), zero by default
  const items = plan.payouts.map((x) => {
    const fee = Math.round(x.amount * tarif.bps) / 100 / 100;
    return { label: x.label, email: x.email, amount: Math.round((x.amount - fee) * 100) / 100, fee };
  });
  let payout = null;
  if (items.length) {
    try {
      payout = await rail.payout({ items, currency: m.currency, subject: `dareskro: ${m.title}`, note: `dareskro ${m.id} — ${plan.note}`.slice(0, 1000), batchId: `dareskro-${m.id}-${randomBytes(3).toString("hex")}` });
      log(`${m.id}: payout ${payout.batchId} (${payout.status}) — ${items.map((x) => `${money(x.amount)} to ${x.email}${x.fee ? ` (fee ${money(x.fee)})` : ""}`).join(", ")}`);
    } catch (e) {
      payout = { error: e.message.slice(0, 300), items };
      log(`${m.id}: payout FAILED after the captures — ${e.message}`);
    }
  }
  m.release = { at: new Date().toISOString(), captures, payout, fee: { bps: tarif.bps, total: money(items.reduce((a, x) => a + x.fee, 0)) }, gate: plan.reasons };
  m.state = "released";
  history(m, "release", { captures: captures.map((c) => c.captureId), payout: payout?.batchId ?? payout?.error ?? null });
  save();
  return m;
}
async function voidMission(m) {
  const k = kindOf(m);
  const hs = await holds(m);
  const reasons = k.voidable(m, hs, Date.now());
  const refused = reasons.filter((r) => !r.ok);
  history(m, "void-attempt", { ok: !refused.length, refused: refused.map((r) => `${r.check}: ${r.why}`) });
  if (refused.length) {
    log(`${m.id}: void REFUSED — ${refused.map((r) => `${r.check}: ${r.why}`).join("; ")}`);
    save();
    throw fail(409, "the gate refuses the void", { reasons });
  }
  const voided = [];
  for (const [i, p] of m.payers.entries()) {
    if (p.authorizationId && hs[i]?.status === "CREATED") {
      await rail.void(p.authorizationId);
      p.authorizationStatus = "VOIDED";
      voided.push(p.authorizationId);
    }
  }
  let refund = null;
  if (m.custody && m.payers.some((p) => p.captureId)) {
    refund = await rail.payout({ items: m.payers.filter((p) => p.captureId).map((p) => ({ label: `deposit back to ${p.name}`, email: p.paidFrom || p.email, amount: p.amount })), currency: m.currency, subject: `dareskro: ${m.title} — deposit returned`, note: `dareskro ${m.id}: no decision before ${m.deadlineAt}`, batchId: `dareskro-${m.id}-back-${randomBytes(3).toString("hex")}` });
    log(`${m.id}: custody refund payout ${refund.batchId} (${refund.status})`);
  }
  m.state = m.validation?.decision === "refuse" ? "refused" : "expired";
  m.closed = { at: new Date().toISOString(), voided, refund, gate: reasons };
  history(m, "void", { voided, refund: refund?.batchId ?? null });
  log(`${m.id}: ${m.state} — ${voided.length ? `${voided.length} hold(s) voided, the payer(s) never charged` : "no hold to void"}`);
  save();
  return m;
}
async function repay(m) {
  if (!kindOf(m).needs?.repay) throw fail(409, `${m.kind} has no repayment`);
  if (m.state !== "released") throw fail(409, `mission is ${m.state}: the advance must be paid first`);
  if (m.repayment?.orderId) return m;
  const o = await rail.createCaptureOrder({ amount: m.invoiceAmount, currency: m.currency, description: `dareskro ${m.id}: repayment of the invoice by ${m.debtor.name}`, customId: `${m.id}:repay`, returnUrl: `${BASE}/paypal/return?mission=${m.id}&repay=1`, cancelUrl: `${BASE}/paypal/cancel?mission=${m.id}` });
  m.repayment = { orderId: o.id, approveUrl: o.approveUrl, amount: m.invoiceAmount, dueAt: m.dueAt };
  history(m, "repayment-order", { orderId: o.id });
  log(`${m.id}: repayment order ${o.id} — ${money(m.invoiceAmount)} ${m.currency} by ${m.debtor.name}, due ${m.dueAt}; approve at ${o.approveUrl}`);
  save();
  return m;
}
async function repaid(m) {
  const c = await rail.captureOrder(m.repayment.orderId);
  Object.assign(m.repayment, { captureId: c.captureId, status: c.status, at: new Date().toISOString() });
  m.state = "repaid";
  history(m, "repaid", { captureId: c.captureId });
  log(`${m.id}: repaid — ${c.amount?.value ?? money(m.invoiceAmount)} ${m.currency} captured (${c.captureId}); the pool's capital is back`);
  save();
  return m;
}

// ---- HTTP
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
  res.end(JSON.stringify(body, null, 2));
};
const html = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" }); // the desk tab fetches the mock approve page
  res.end(`<!doctype html><meta charset="utf-8"><title>dareskro · PayPal</title><body style="font:16px system-ui;max-width:40em;margin:3em auto">${body}</body>`);
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}"));
      } catch (e) {
        reject(fail(400, `bad JSON body: ${e.message}`));
      }
    });
  });

createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname;
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (req.method === "GET" && p === "/identity") return json(res, 200, { mode: rail.mode, seat: SEAT, holdDays: rail.holdDays, feeBps: tarif.bps, base: BASE, counts: Object.fromEntries(states.map((s) => [s, missions.filter((m) => m.state === s).length])) });
    if (req.method === "GET" && p === "/kinds") return json(res, 200, Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { label: v.label, needs: v.needs ?? {} }])));
    if (req.method === "GET" && p === "/missions") return json(res, 200, missions);
    if (req.method === "POST" && p === "/missions") return json(res, 201, draft(await readBody(req)));
    const mm = p.match(/^\/missions\/([A-Z0-9-]+)(?:\/([a-z]+))?$/);
    if (mm) {
      const m = byId(mm[1]);
      if (!m) throw fail(404, `unknown mission ${mm[1]}`);
      const action = mm[2];
      if (req.method === "GET" && !action) return json(res, 200, m);
      if (req.method === "GET" && action === "memo") {
        if (!m.memo) throw fail(404, "no memo yet");
        return json(res, 200, JSON.parse(readFileSync(path.join(HERE, m.memo.file), "utf8")));
      }
      if (req.method !== "POST") throw fail(405, "POST");
      const b = await readBody(req);
      const table = { offer: () => offer(m), fund: () => fund(m, b), lock: () => lock(m), deliver: () => deliver(m, b), review: () => reviewMission(m), policy: () => policy(m), validate: () => validate(m, b), confirm: () => confirm(m, b), probe: () => probe(m), vote: () => vote(m, b), release: () => release(m), void: () => voidMission(m), repay: () => repay(m) };
      if (!table[action]) throw fail(404, `unknown action ${action}`);
      return json(res, 200, await table[action]());
    }
    if (req.method === "GET" && p === "/paypal/return") {
      const m = byId(url.searchParams.get("mission") ?? "");
      if (!m) return html(res, 404, "<p>Unknown mission.</p>");
      if (url.searchParams.get("repay")) {
        await repaid(m);
        return html(res, 200, `<h1>dareskro · PayPal</h1><p>Invoice repaid: ${money(m.invoiceAmount)} ${m.currency} for mission <b>${m.id}</b>. You can close this tab.</p>`);
      }
      const i = Number(url.searchParams.get("payer") ?? 0);
      await lock(m, i);
      const pr = m.payers[i];
      return html(res, 200, `<h1>dareskro · PayPal</h1><p>Mission <b>${m.id}</b> — ${m.title}.</p><p>${m.custody ? `Your ${money(pr.amount)} ${m.currency} is in the desk's custody (capture ${pr.captureId}).` : `PayPal now holds <b>${pr.held?.value} ${pr.held?.currency_code}</b> (authorization ${pr.authorizationId}) until ${pr.expiresAt}. Nothing was charged.`} The money moves only when the mission's rule says so. Mission state: <b>${m.state}</b>.</p><p>You can close this tab.</p>`);
    }
    if (req.method === "GET" && p === "/paypal/cancel") {
      const m = byId(url.searchParams.get("mission") ?? "");
      if (m) {
        history(m, "payer-cancelled", { payer: url.searchParams.get("payer") });
        log(`${m.id}: a payer cancelled on PayPal's page`);
        save();
      }
      return html(res, 200, "<h1>dareskro · PayPal</h1><p>Nothing was held and nothing was charged.</p>");
    }
    const ma = p.match(/^\/mock\/approve\/([A-Z0-9-]+)$/);
    if (ma && req.method === "GET") {
      if (rail.mode !== "mock") throw fail(404, "not in mock mode");
      rail.mockApprove(ma[1]);
      for (const m of missions) {
        const i = m.payers.findIndex((x) => x.orderId === ma[1]);
        if (i >= 0 && ["drafted", "offered"].includes(m.state)) await lock(m, i);
        if (m.repayment?.orderId === ma[1] && m.state === "released") await repaid(m);
      }
      return html(res, 200, `<h1>mock PayPal</h1><p>Order ${ma[1]} approved by the (mock) payer.</p>`);
    }
    const mf = p.match(/^\/fixtures\/([\w.-]+)$/);
    if (mf && req.method === "GET") {
      const f = path.join(HERE, "fixtures", mf[1]);
      if (!existsSync(f)) throw fail(404, "no such fixture");
      res.writeHead(200, { "Content-Type": /\.html?$/.test(f) ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      return res.end(readFileSync(f));
    }
    if ((req.method === "GET" || req.method === "HEAD") && existsSync(DESK_DIST)) {
      // the built desk: a file under app/dist, or index.html for the app's own routes (no extension)
      const rel = path.normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, "");
      let f = path.join(DESK_DIST, rel);
      if (!f.startsWith(DESK_DIST)) throw fail(403, "no");
      if (!existsSync(f) || !path.extname(f)) f = path.join(DESK_DIST, "index.html");
      const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon" };
      res.writeHead(200, { "Content-Type": types[path.extname(f)] ?? "application/octet-stream", "Cache-Control": path.extname(f) === ".html" ? "no-cache" : "public, max-age=3600" });
      return res.end(req.method === "HEAD" ? undefined : readFileSync(f));
    }
    throw fail(404, `no route ${req.method} ${p}`);
  } catch (e) {
    const status = e.status ?? 500;
    if (status >= 500) log(`500 ${req.method} ${p}: ${e.stack ?? e.message}`);
    return json(res, status, { error: e.message, ...(e.extra ?? {}) });
  }
}).listen(PORT, HOST, () => log(`PayPal desk on ${BASE} (${HOST}:${PORT}${existsSync(DESK_DIST) ? ", serving the built desk" : ""}) — mode ${rail.mode}, seat ${SEAT}, hold ${rail.holdDays} days, fee ${tarif.bps} bps`));

/** paypal/.env (0600, gitignored): KEY=value lines; the environment wins over the file. */
function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined && m[2] !== "") process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
