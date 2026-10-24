/**
 * Affiliate commission, live on testnet: the money is locked BEFORE the sale,
 * and the merchant's own sales system releases it.
 *
 *   1. merchant and affiliate get testnet accounts
 *   2. the oracle issues a condition for an expected order (ORD-2026-1045) and hands
 *      the merchant's sales system a confirmation token, once
 *   3. the merchant locks 20 XRP: Condition + CancelAfter, memos = order ref + oracle
 *   4. the sales system confirms with a WRONG token      → 403, nothing moves
 *   5. the sales system confirms the attributed sale: sha256 of the order record + the right token
 *      → the oracle reveals the secret; the EscrowFinish carries the order hash in a memo
 *   6. the finish is read back from the ledger: the memo equals the order hash
 *   7. a second escrow, no sale ever confirmed → after CancelAfter the oracle refunds the merchant
 *
 * Here the merchant is a party: the oracle does not judge the sale. What it
 * guarantees is that the commission was locked before the sale, and that the
 * release names the order. Nothing to poll: no URL, no page.
 *
 * Usage: node demo_affiliation.mjs     (the oracle must be running: node oracle.mjs watch)
 */
import { createHash, randomBytes } from "node:crypto";
import { Client, xrpToDrops } from "xrpl";

const ORACLE = process.env.ORACLE_URL || "http://127.0.0.1:8787";
const ORDER_REF = "ORD-2026-1045";
const ORDER_REF_2 = "ORD-2026-1046";  // the next expected commission, never earned
const AMOUNT_XRP = "20";  // the faucet gives 100 XRP: two escrows plus the reserve must fit
const DEADLINE_1 = 150;   // seconds: time for the sale to be confirmed
const DEADLINE_2 = 75;    // seconds: no sale → refund
const RIPPLE_EPOCH = 946684800;
const rippleTime = (d) => Math.floor(d.getTime() / 1000) - RIPPLE_EPOCH;
const secondsUntil = (rt) => Math.round(rt + RIPPLE_EPOCH - Date.now() / 1000);
const hex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const unhex = (h) => Buffer.from(h ?? "", "hex").toString("utf8");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const explorer = (h) => `https://testnet.xrpl.org/transactions/${h}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The testnet websocket drops now and then: reconnect and retry a ledger call a few times. */
async function onLedger(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      if (!c.isConnected()) await c.connect();
      return await fn();
    } catch (err) {
      if (i >= tries - 1) throw err;
      log(`ledger hiccup (${String(err?.message ?? err).split("\n")[0].slice(0, 80)}), retrying in 5 s…`);
      try { await c.disconnect(); } catch { /* already closed */ }
      await sleep(5000);
    }
  }
}


async function oracleGet(p) {
  const r = await fetch(ORACLE + p);
  if (!r.ok) throw new Error(`GET ${p}: HTTP ${r.status}`);
  return r.json();
}
/** POST and return the status with the body: the demo expects some refusals. */
async function oraclePostRaw(p, body) {
  const r = await fetch(ORACLE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; }
  return { status: r.status, json };
}
async function oraclePost(p, body) {
  const { status, json } = await oraclePostRaw(p, body);
  if (status === 404 && p === "/condition") throw new Error("the running oracle has no POST /condition: restart it with the four-case oracle.mjs");
  if (status < 200 || status >= 300) throw new Error(`POST ${p}: HTTP ${status} — ${json.error ?? JSON.stringify(json)}`);
  return json;
}
async function mine(owner, seq) {
  return (await oracleGet("/escrows")).escrows.find((e) => e.owner === owner && e.sequence === seq);
}
/** What the oracle currently sees of an affiliate escrow, in one line. */
function view(e) {
  const confirmed = e.confirmed ? `confirmed (order ${String(e.confirmed.orderHash ?? "").slice(0, 10)}…)` : "no confirmation";
  return `status ${e.status}, ${confirmed}${e.lastWhy ? `, last word: ${e.lastWhy}` : ""}${e.lastResult ? `, last result ${e.lastResult}` : ""}`;
}
/** Poll the oracle's view every 3 s; log each change so the trace reads by itself. */
async function follow(owner, seq, pred, maxS, label) {
  const until = Date.now() + maxS * 1000;
  let last = "";
  let e;
  do {
    e = await mine(owner, seq);
    if (e) {
      const v = view(e);
      if (v !== last) { log(`${label}: oracle sees — ${v}`); last = v; }
      if (pred(e)) return e;
    } else if (!last) {
      log(`${label}: not in the oracle's registry yet`);
      last = "?";
    }
    await sleep(3000);
  } while (Date.now() < until);
  return e;
}
/** The finish is validated when the oracle reports it; still, give the node a few tries. */
async function readTx(c, hash) {
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await c.request({ command: "tx", transaction: hash });
      if (r.result.validated) return r.result;
    } catch (err) { lastErr = err; }
    await sleep(2000);
  }
  throw new Error(`cannot read ${hash} back: ${lastErr?.message ?? "not validated yet"}`);
}
const decodeMemos = (memos) => (memos ?? []).map((m) => ({ type: unhex(m.Memo?.MemoType), data: unhex(m.Memo?.MemoData) }));

const problems = [];
const expect = (ok, what) => { if (!ok) problems.push(what); return ok; };
let c;

async function main() {
  let oracle;
  try {
    oracle = await oracleGet("/identity");
  } catch (err) {
    throw new Error(`no oracle at ${ORACLE} (${err.message}) — start it with: node oracle.mjs watch`);
  }
  log(`oracle ${oracle.address} (${oracle.name})`);

  c = new Client("wss://s.altnet.rippletest.net:51233");
  await c.connect();
  log("funding merchant and affiliate on testnet…");
  const { wallet: merchant } = await onLedger(() => c.fundWallet());
  const { wallet: affiliate } = await onLedger(() => c.fundWallet());
  log(`merchant ${merchant.classicAddress}, affiliate ${affiliate.classicAddress}`);

  async function lock(label, orderRef, deadlineS) {
    const cond = await oraclePost("/condition", { kind: "affiliate", orderRef, note: label });
    if (!cond.deliveryId || !cond.condition) throw new Error(`${label}: the oracle answered without deliveryId/condition: ${JSON.stringify(cond)}`);
    if (!cond.confirmToken) throw new Error(`${label}: the oracle gave no confirmToken, the merchant's system could never confirm`);
    // The token is a secret of the merchant's sales system: never printed, the oracle keeps only its hash.
    log(`${label}: condition ${cond.condition.slice(0, 16)}… (deliveryId ${cond.deliveryId}) for ${orderRef}; confirmation token (${cond.confirmToken.length} hex) handed once to the merchant's sales system`);
    const cancelAfter = rippleTime(new Date(Date.now() + deadlineS * 1000));
    const tx = {
      TransactionType: "EscrowCreate",
      Account: merchant.classicAddress,
      Destination: affiliate.classicAddress,
      Amount: xrpToDrops(AMOUNT_XRP),
      Condition: cond.condition,
      CancelAfter: cancelAfter,  // no FinishAfter: the sale can be confirmed any time before the deadline
      Memos: [
        { Memo: { MemoType: hex("dareskro/case"), MemoData: hex("affiliate"), MemoFormat: hex("text/plain") } },
        { Memo: { MemoType: hex("dareskro/proof"), MemoData: hex(orderRef), MemoFormat: hex("text/plain") } },
        { Memo: { MemoType: hex("dareskro/oracle"), MemoData: hex(oracle.address) } },
      ],
    };
    const r = await c.submitAndWait(tx, { wallet: merchant, autofill: true });
    const code = r.result.meta.TransactionResult;
    const seq = r.result.tx_json?.Sequence ?? r.result.Sequence;
    if (code !== "tesSUCCESS") throw new Error(`${label}: EscrowCreate ${code} — nothing locked, stopping`);
    log(`${label}: EscrowCreate ${code}, #${seq}, ${AMOUNT_XRP} XRP locked before any sale, refund after ${deadlineS} s — ${explorer(r.result.hash)}`);
    const w = await oraclePost("/watch", {
      kind: "affiliate", deliveryId: cond.deliveryId, owner: merchant.classicAddress, sequence: seq,
      destination: affiliate.classicAddress, amountXrp: AMOUNT_XRP, cancelAfter,
      proof: cond.proof ?? { orderRef }, createHash: r.result.hash,
    });
    log(`${label}: oracle watching${w.note ? ` (${w.note})` : ""} — nothing to poll, it waits for the merchant's confirmation`);
    return { deliveryId: cond.deliveryId, seq, createHash: r.result.hash, cancelAfter, orderRef, token: cond.confirmToken };
  }

  // 2-3. escrow 1: the expected commission
  const affiliateBefore = await onLedger(() => c.getXrpBalance(affiliate.classicAddress));
  const e1 = await lock("escrow 1 (the sale)", ORDER_REF, DEADLINE_1);

  // 4. a wrong token: whoever holds the deliveryId but not the token cannot release
  const bogus = randomBytes(32).toString("hex");
  const bad = await oraclePostRaw("/affiliate/confirm", { deliveryId: e1.deliveryId, orderHash: sha256("not the order"), token: bogus });
  log(`sales system confirms with a WRONG token: HTTP ${bad.status} ${JSON.stringify(bad.json)}`);
  expect(bad.status === 403, `wrong token answered HTTP ${bad.status}, expected 403`);
  const still = await mine(merchant.classicAddress, e1.seq);
  log(`escrow 1 after the wrong token: status ${still?.status ?? "unknown"} — nothing moved`);
  expect(still?.status === "waiting", `escrow 1 is ${still?.status ?? "unknown"} after a wrong token, expected waiting`);

  // 5. the attributed sale, confirmed by the merchant's system
  const order = {
    orderRef: ORDER_REF, merchant: merchant.classicAddress, affiliate: affiliate.classicAddress,
    total: "149.00 EUR", customer: "c-7f3a", returnWindowClosed: true, at: new Date().toISOString(),
  };
  const record = JSON.stringify(order);
  const orderHash = sha256(record);
  log(`order record: ${record}`);
  log(`sha256 of the order record: ${orderHash}`);
  const good = await oraclePostRaw("/affiliate/confirm", { deliveryId: e1.deliveryId, orderHash, token: e1.token });
  log(`sales system confirms with the right token: HTTP ${good.status} ${JSON.stringify(good.json)}`);
  expect(good.status === 202, `right token answered HTTP ${good.status}, expected 202`);

  const s1 = await follow(merchant.classicAddress, e1.seq, (e) => e.status !== "waiting", 90, "escrow 1");
  if (s1?.status === "finished" && s1.finishHash) {
    log(`escrow 1: finished — ${AMOUNT_XRP} XRP to the affiliate — ${explorer(s1.finishHash)}`);
  } else {
    log(`escrow 1: ${s1?.status ?? "unknown"} — ${s1?.lastWhy ?? s1?.lastResult ?? s1?.note ?? "no word from the oracle"}`);
  }
  expect(s1?.status === "finished" && !!s1.finishHash, `escrow 1 ended ${s1?.status ?? "unknown"} instead of finished`);
  if (s1?.orderHash) expect(s1.orderHash === orderHash, `oracle recorded orderHash ${s1.orderHash}, not ${orderHash}`);
  const affiliateAfter = await onLedger(() => c.getXrpBalance(affiliate.classicAddress));
  log(`affiliate balance: ${affiliateBefore} → ${affiliateAfter} XRP`);

  // 6. read the finish back from the ledger: the release names the order
  let memoHash = null;
  if (s1?.finishHash) {
    const t = await readTx(c, s1.finishHash);
    const tx = t.tx_json ?? t;
    const memos = decodeMemos(tx.Memos);
    log(`EscrowFinish read back: by ${tx.Account}, Fulfillment ${tx.Fulfillment ? "present" : "ABSENT"}, ${memos.length} memo(s): ${memos.map((m) => m.type).join(", ") || "none"}`);
    memoHash = memos.find((m) => m.type === "dareskro/order-sha256")?.data ?? null;
    log(`memo dareskro/order-sha256 = ${memoHash ?? "(missing)"}`);
    log(`order hash                 = ${orderHash}`);
    log(memoHash === orderHash ? "equal: the release names the order, anyone can check it on the explorer" : "NOT EQUAL");
    expect(memoHash === orderHash, "the finish memo does not carry the order hash");
  }

  // 7. escrow 2: the next commission, never earned
  const merchantBefore = await onLedger(() => c.getXrpBalance(merchant.classicAddress));
  const e2 = await lock("escrow 2 (no sale)", ORDER_REF_2, DEADLINE_2);
  log(`no sale is confirmed; waiting ${DEADLINE_2} s for the deadline…`);
  const s2 = await follow(merchant.classicAddress, e2.seq, (e) => e.status !== "waiting", secondsUntil(e2.cancelAfter) + 60, "escrow 2");
  if (s2?.status === "expired-refunded" && s2.refundHash) {
    log(`escrow 2: ${s2.status} — no sale, the commission goes back — ${explorer(s2.refundHash)}`);
  } else {
    log(`escrow 2: ${s2?.status ?? "unknown"} — ${s2?.lastWhy ?? s2?.lastResult ?? s2?.note ?? "no word from the oracle"}`);
  }
  expect(s2?.status === "expired-refunded" && !!s2.refundHash, `escrow 2 ended ${s2?.status ?? "unknown"} instead of expired-refunded`);
  const merchantAfter = await onLedger(() => c.getXrpBalance(merchant.classicAddress));
  log(`merchant balance: ${merchantBefore} → ${merchantAfter} XRP (20 locked then refunded, minus fees)`);

  // --- summary
  log("summary");
  log(`  oracle ${oracle.address} — merchant ${merchant.classicAddress} — affiliate ${affiliate.classicAddress}`);
  log(`  escrow 1 #${e1.seq} (${ORDER_REF}): lock ${explorer(e1.createHash)}`);
  log(`    wrong token: HTTP ${bad.status} — right token: HTTP ${good.status}`);
  log(`    release: ${s1?.status ?? "?"}${s1?.finishHash ? ` ${explorer(s1.finishHash)}` : ""}`);
  log(`    memo dareskro/order-sha256 ${memoHash === orderHash ? "equals" : "differs from"} the order hash ${orderHash.slice(0, 16)}…`);
  log(`  escrow 2 #${e2.seq} (${ORDER_REF_2}): lock ${explorer(e2.createHash)}`);
  log(`    no sale: ${s2?.status ?? "?"}${s2?.refundHash ? ` ${explorer(s2.refundHash)}` : ""}`);
  const { token: _t1, ...e1Public } = e1;
  const { token: _t2, ...e2Public } = e2;
  console.log(JSON.stringify({
    oracle: oracle.address, merchant: merchant.classicAddress, affiliate: affiliate.classicAddress,
    escrow1: { ...e1Public, wrongToken: bad.status, rightToken: good.status, orderHash, memoHash, status: s1?.status, finishHash: s1?.finishHash ?? null },
    escrow2: { ...e2Public, status: s2?.status, refundHash: s2?.refundHash ?? null },
    balances: { affiliate: [affiliateBefore, affiliateAfter], merchant: [merchantBefore, merchantAfter] },
  }, null, 2));
}

async function cleanup() {
  try { if (c?.isConnected()) await c.disconnect(); } catch {}
}

try {
  await main();
  await cleanup();
  if (problems.length) {
    log(`FAILED: ${problems.join("; ")}`);
    process.exit(1);
  }
  log("both scenarios behaved as expected");
  process.exit(0);
} catch (err) {
  log(`FAILED: ${err.message.split("\n")[0]}`);
  await cleanup();
  process.exit(1);
}
