/**
 * Influencer product placement, live on testnet: the oracle checks the post is
 * STILL THERE at the date.
 *
 *   1. brand and influencer get testnet accounts
 *   2. the oracle issues a condition for an agreed presence: URL + required text
 *   3. the brand locks 20 XRP: Condition + FinishAfter (the date) + CancelAfter
 *   4. the oracle watches the URL; before the date it only looks, it cannot pay
 *   5. a bystander tries to finish before the date → refused by the ledger
 *   6. at the date the post is live       → the oracle reveals the secret, the influencer is paid
 *   7. a second escrow, post deleted before the date → at CancelAfter the oracle refunds the brand
 *
 * The "platform" is a tiny HTTP server on this machine: the oracle reads it
 * like any URL. Point POST_URL at a public page for a public demo. The date is
 * 45 s away instead of 30 days: the escrow shape is the same.
 *
 * Usage: node demo_influenceur.mjs     (the oracle must be running: node oracle.mjs watch)
 */
import { createServer } from "node:http";
import { Client, xrpToDrops } from "xrpl";

const ORACLE = process.env.ORACLE_URL || "http://127.0.0.1:8787";
const PORT = Number(process.env.POST_PORT || 8791);
const POST_URL = process.env.POST_URL || `http://127.0.0.1:${PORT}/post.html`;
const MUST_CONTAIN = "#ad @dareskro";
const AMOUNT_XRP = "20";  // the faucet gives 100 XRP: two escrows plus the reserve must fit
const PERIOD_S = 45;      // seconds until the date the post must still be live (30 days in real life)
const GRACE_S = 90;       // seconds after the date before the brand is refunded
const RIPPLE_EPOCH = 946684800;
const rippleTime = (d) => Math.floor(d.getTime() / 1000) - RIPPLE_EPOCH;
const secondsUntil = (rt) => Math.round(rt + RIPPLE_EPOCH - Date.now() / 1000);
const hex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
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


// --- the post, and the "platform" that serves it while it is live
const page = `<!doctype html><html><body><p>Unboxing the new kit, link in bio. ${MUST_CONTAIN}</p></body></html>\n`;
let live = false;
const hits = { live: 0, gone: 0 };
const server = createServer((req, res) => {
  if (req.url === "/post.html" && live) {
    hits.live++;
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    return res.end(page);
  }
  hits.gone++;
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("post deleted");
});

async function oracleGet(p) {
  const r = await fetch(ORACLE + p);
  if (!r.ok) throw new Error(`GET ${p}: HTTP ${r.status}`);
  return r.json();
}
async function oraclePost(p, body) {
  const r = await fetch(ORACLE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { error: text.slice(0, 200) }; }
  if (r.status === 404 && p === "/condition") throw new Error("the running oracle has no POST /condition: restart it with the four-case oracle.mjs");
  if (!r.ok) throw new Error(`POST ${p}: HTTP ${r.status} — ${j.error ?? text}`);
  return j;
}
async function mine(owner, seq) {
  return (await oracleGet("/escrows")).escrows.find((e) => e.owner === owner && e.sequence === seq);
}
/** What the oracle currently sees of a presence escrow, in one line. */
function view(e) {
  const seen = e.lastSeen
    ? `post ${e.lastSeen.live ? "live" : "NOT live"}${e.lastSeen.why ? ` (${e.lastSeen.why})` : ""}`
    : "not looked yet";
  return `status ${e.status}, ${seen}${e.lastWhy ? `, last word: ${e.lastWhy}` : ""}${e.checks ? `, checks ${e.checks}` : ""}`;
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

const problems = [];
const expect = (ok, what) => { if (!ok) problems.push(what); return ok; };
let c;

async function main() {
  await new Promise((resolve, reject) => {
    server.once("error", (err) => reject(new Error(`cannot serve the post on port ${PORT}: ${err.message}`)));
    server.listen(PORT, "127.0.0.1", resolve);
  });

  let oracle;
  try {
    oracle = await oracleGet("/identity");
  } catch (err) {
    throw new Error(`no oracle at ${ORACLE} (${err.message}) — start it with: node oracle.mjs watch`);
  }
  log(`oracle ${oracle.address} (${oracle.name})`);

  c = new Client("wss://s.altnet.rippletest.net:51233");
  await c.connect();
  log("funding brand, influencer and a bystander on testnet…");
  const { wallet: brand } = await onLedger(() => c.fundWallet());
  const { wallet: influencer } = await onLedger(() => c.fundWallet());
  const { wallet: bystander } = await onLedger(() => c.fundWallet());
  log(`brand ${brand.classicAddress}, influencer ${influencer.classicAddress}, bystander ${bystander.classicAddress}`);

  async function lock(label) {
    const cond = await oraclePost("/condition", { kind: "presence", url: POST_URL, mustContain: MUST_CONTAIN, note: label });
    if (!cond.deliveryId || !cond.condition) throw new Error(`${label}: the oracle answered without deliveryId/condition: ${JSON.stringify(cond)}`);
    log(`${label}: condition ${cond.condition.slice(0, 16)}… (deliveryId ${cond.deliveryId}) for ${POST_URL} containing "${MUST_CONTAIN}"`);
    const checkAfter = rippleTime(new Date(Date.now() + PERIOD_S * 1000));
    const cancelAfter = checkAfter + GRACE_S;
    const tx = {
      TransactionType: "EscrowCreate",
      Account: brand.classicAddress,
      Destination: influencer.classicAddress,
      Amount: xrpToDrops(AMOUNT_XRP),
      Condition: cond.condition,
      FinishAfter: checkAfter,  // even with the secret, nobody can pay before the date
      CancelAfter: cancelAfter,
      Memos: [
        { Memo: { MemoType: hex("dareskro/case"), MemoData: hex("influencer"), MemoFormat: hex("text/plain") } },
        { Memo: { MemoType: hex("dareskro/proof"), MemoData: hex(`url:${POST_URL};mustContain:${MUST_CONTAIN}`), MemoFormat: hex("text/plain") } },
        { Memo: { MemoType: hex("dareskro/oracle"), MemoData: hex(oracle.address) } },
      ],
    };
    const r = await c.submitAndWait(tx, { wallet: brand, autofill: true });
    const code = r.result.meta.TransactionResult;
    const seq = r.result.tx_json?.Sequence ?? r.result.Sequence;
    if (code !== "tesSUCCESS") throw new Error(`${label}: EscrowCreate ${code} — nothing locked, stopping`);
    log(`${label}: EscrowCreate ${code}, #${seq}, ${AMOUNT_XRP} XRP locked — payable at the date (in ${PERIOD_S} s) if the post is live, refund ${GRACE_S} s after the date — ${explorer(r.result.hash)}`);
    const w = await oraclePost("/watch", {
      kind: "presence", deliveryId: cond.deliveryId, owner: brand.classicAddress, sequence: seq,
      destination: influencer.classicAddress, amountXrp: AMOUNT_XRP,
      checkAfter, cancelAfter, finishAfter: checkAfter,
      proof: cond.proof ?? { url: POST_URL, mustContain: MUST_CONTAIN }, createHash: r.result.hash,
    });
    log(`${label}: oracle watching${w.note ? ` (${w.note})` : ""}`);
    return { deliveryId: cond.deliveryId, seq, createHash: r.result.hash, checkAfter, cancelAfter };
  }

  // 2-4. escrow 1: the post is published and stays live
  live = true;
  log(`influencer publishes the post at ${POST_URL}`);
  const influencerBefore = await onLedger(() => c.getXrpBalance(influencer.classicAddress));
  const e1 = await lock("escrow 1 (post stays live)");

  // 5. a bystander tries before the date, without the secret
  const left = secondsUntil(e1.checkAfter);
  log(`bystander tries EscrowFinish without the secret, ${left} s before the date${left <= 0 ? " (LATE: the date has passed, the code below may differ)" : ""}…`);
  let bystanderCode = "rejected";
  let bystanderHash = null;
  try {
    const r = await c.submitAndWait(
      { TransactionType: "EscrowFinish", Account: bystander.classicAddress, Owner: brand.classicAddress, OfferSequence: e1.seq },
      { wallet: bystander, autofill: true },
    );
    bystanderCode = r.result.meta.TransactionResult;
    bystanderHash = r.result.hash;
    const why = { tecNO_PERMISSION: "too early, FinishAfter not reached", tecCRYPTOCONDITION_ERROR: "no fulfillment for the condition" }[bystanderCode] ?? "unexpected";
    log(`bystander finish: ${bystanderCode} (${why}) — ${explorer(bystanderHash)}`);
  } catch (err) {
    log(`bystander finish: rejected before validation — ${err.message.split("\n")[0]}`);
  }
  expect(["tecNO_PERMISSION", "tecCRYPTOCONDITION_ERROR"].includes(bystanderCode), `bystander finish gave ${bystanderCode}, expected tecNO_PERMISSION or tecCRYPTOCONDITION_ERROR`);

  // 6. the date comes, the post is still there
  log(`waiting for the date (${Math.max(0, secondsUntil(e1.checkAfter))} s), the oracle only looks until then…`);
  const s1 = await follow(brand.classicAddress, e1.seq, (e) => e.status !== "waiting", secondsUntil(e1.cancelAfter) + 60, "escrow 1");
  if (s1?.status === "finished" && s1.finishHash) {
    log(`escrow 1: finished — ${s1.lastWhy ?? "post live at the date"} — ${explorer(s1.finishHash)}`);
  } else {
    log(`escrow 1: ${s1?.status ?? "unknown"} — ${s1?.lastWhy ?? s1?.lastResult ?? s1?.note ?? "no word from the oracle"}`);
  }
  expect(s1?.status === "finished" && !!s1.finishHash, `escrow 1 ended ${s1?.status ?? "unknown"} instead of finished`);
  const influencerAfter = await onLedger(() => c.getXrpBalance(influencer.classicAddress));
  log(`influencer balance: ${influencerBefore} → ${influencerAfter} XRP`);

  // 7. escrow 2: same deal, but the post disappears before the date
  const brandBefore = await onLedger(() => c.getXrpBalance(brand.classicAddress));
  const e2 = await lock("escrow 2 (post deleted)");
  // let the oracle look once while the post is live, so the trace shows the transition
  await follow(brand.classicAddress, e2.seq, (e) => !!e.lastSeen, Math.min(30, Math.max(5, secondsUntil(e2.checkAfter) - 10)), "escrow 2");
  live = false;
  log(`influencer DELETES the post (${POST_URL} now answers 404), ${secondsUntil(e2.checkAfter)} s before the date`);
  log(`waiting for the date, then for the refund (${Math.max(0, secondsUntil(e2.cancelAfter))} s)…`);
  const s2 = await follow(brand.classicAddress, e2.seq, (e) => e.status !== "waiting", secondsUntil(e2.cancelAfter) + 60, "escrow 2");
  if (s2?.status === "expired-refunded" && s2.refundHash) {
    log(`escrow 2: ${s2.status} — deleted post, no pay — ${explorer(s2.refundHash)}`);
  } else {
    log(`escrow 2: ${s2?.status ?? "unknown"} — ${s2?.lastWhy ?? s2?.lastResult ?? s2?.note ?? "no word from the oracle"}`);
  }
  expect(s2?.status === "expired-refunded" && !!s2.refundHash, `escrow 2 ended ${s2?.status ?? "unknown"} instead of expired-refunded`);
  const brandAfter = await onLedger(() => c.getXrpBalance(brand.classicAddress));
  log(`brand balance: ${brandBefore} → ${brandAfter} XRP (20 locked then refunded, minus fees)`);
  log(`the platform served the post ${hits.live} time(s) and answered 404 ${hits.gone} time(s)`);

  // --- summary
  log("summary");
  log(`  oracle ${oracle.address} — brand ${brand.classicAddress} — influencer ${influencer.classicAddress}`);
  log(`  escrow 1 #${e1.seq}: lock ${explorer(e1.createHash)}`);
  log(`    bystander before the date: ${bystanderCode}${bystanderHash ? ` ${explorer(bystanderHash)}` : ""}`);
  log(`    at the date, post live: ${s1?.status ?? "?"}${s1?.finishHash ? ` ${explorer(s1.finishHash)}` : ""}`);
  log(`  escrow 2 #${e2.seq}: lock ${explorer(e2.createHash)}`);
  log(`    post deleted before the date: ${s2?.status ?? "?"}${s2?.refundHash ? ` ${explorer(s2.refundHash)}` : ""}`);
  console.log(JSON.stringify({
    oracle: oracle.address, brand: brand.classicAddress, influencer: influencer.classicAddress, postUrl: POST_URL,
    escrow1: { ...e1, bystander: { code: bystanderCode, hash: bystanderHash }, status: s1?.status, finishHash: s1?.finishHash ?? null },
    escrow2: { ...e2, status: s2?.status, refundHash: s2?.refundHash ?? null },
    balances: { influencer: [influencerBefore, influencerAfter], brand: [brandBefore, brandAfter] },
  }, null, 2));
}

async function cleanup() {
  try { if (c?.isConnected()) await c.disconnect(); } catch {}
  server.closeAllConnections();
  server.close();
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
