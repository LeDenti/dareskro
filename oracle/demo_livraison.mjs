/**
 * Example 3, live on testnet: the oracle verifies the delivery ONLINE.
 *
 *   1. client and freelancer get testnet accounts
 *   2. the oracle issues a condition for an agreed proof: URL + SHA-256
 *   3. the client locks 120 XRP: Condition + CancelAfter, memos = proof + oracle
 *   4. the oracle watches the URL
 *   5. a WRONG file is published        → the oracle says "not yet", pays nothing
 *   6. a third party tries to finish    → tecCRYPTOCONDITION_ERROR (no secret)
 *   7. the RIGHT file is published      → the oracle reveals the secret, the freelancer is paid
 *   8. a second escrow, nothing ever published → after CancelAfter the oracle refunds the client
 *
 * The "publication" is a tiny HTTP server on this machine: the oracle reads it
 * like any URL. Point PROOF_URL at a public address for a public demo.
 *
 * Usage: node demo_livraison.mjs     (the oracle must be running: node oracle.mjs watch)
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Client, xrpToDrops } from "xrpl";

const ORACLE = process.env.ORACLE_URL || "http://127.0.0.1:8787";
const PORT = Number(process.env.PROOF_PORT || 8790);
const PROOF_URL = process.env.PROOF_URL || `http://127.0.0.1:${PORT}/livrable.txt`;
const AMOUNT_XRP = "40";   // the faucet gives 100 XRP: two escrows plus the reserve must fit
const DEADLINE_1 = 300;   // seconds: time to publish wrong, then right
const DEADLINE_2 = 75;    // seconds: nothing published → refund
const RIPPLE_EPOCH = 946684800;
const rippleTime = (d) => Math.floor(d.getTime() / 1000) - RIPPLE_EPOCH;
const hex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const explorer = (h) => `https://testnet.xrpl.org/transactions/${h}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the deliverable, and the server the freelancer "publishes" on
const deliverable = `dareskro deliverable — landing page copy v1 — ${new Date().toISOString()}\n`;
const wrong = "dareskro deliverable — draft v0, not the agreed one\n";
let published = null;
const server = createServer((req, res) => {
  if (req.url === "/livrable.txt" && published !== null) {
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    return res.end(published);
  }
  res.writeHead(404);
  res.end("not published");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

async function oracleGet(p) { return (await fetch(ORACLE + p)).json(); }
async function oraclePost(p, body) {
  const r = await fetch(ORACLE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
async function mine(owner, seq) {
  return (await oracleGet("/escrows")).escrows.find((e) => e.owner === owner && e.sequence === seq);
}
async function waitFor(owner, seq, pred, maxS) {
  for (let i = 0; i < maxS / 3; i++) {
    const e = await mine(owner, seq);
    if (e && pred(e)) return e;
    await sleep(3000);
  }
  return mine(owner, seq);
}

const oracle = await oracleGet("/identity");
log(`oracle ${oracle.address} (${oracle.name})`);

const c = new Client("wss://s.altnet.rippletest.net:51233");
await c.connect();
log("funding client and freelancer on testnet…");
const { wallet: client } = await c.fundWallet();
const { wallet: freelancer } = await c.fundWallet();
log(`client ${client.classicAddress}, freelancer ${freelancer.classicAddress}`);

async function lock(proof, deadlineS, label) {
  const cond = await oraclePost("/delivery/condition", { url: proof.url, sha256: proof.sha256, note: label });
  const cancelAfter = rippleTime(new Date(Date.now() + deadlineS * 1000));
  const tx = {
    TransactionType: "EscrowCreate",
    Account: client.classicAddress,
    Destination: freelancer.classicAddress,
    Amount: xrpToDrops(AMOUNT_XRP),
    Condition: cond.condition,
    CancelAfter: cancelAfter,
    Memos: [
      { Memo: { MemoType: hex("dareskro/delivery-proof"), MemoData: hex(`sha256:${proof.sha256};url:${proof.url}`), MemoFormat: hex("text/plain") } },
      { Memo: { MemoType: hex("dareskro/oracle"), MemoData: hex(oracle.address) } },
    ],
  };
  const r = await c.submitAndWait(tx, { wallet: client, autofill: true });
  const code = r.result.meta.TransactionResult;
  const seq = r.result.tx_json.Sequence;
  if (code !== "tesSUCCESS") throw new Error(`${label}: EscrowCreate ${code} — nothing locked, stopping`);
  log(`${label}: EscrowCreate ${code}, #${seq}, ${AMOUNT_XRP} XRP locked behind the condition, refund after ${deadlineS} s — ${explorer(r.result.hash)}`);
  await oraclePost("/watch", { kind: "delivery", deliveryId: cond.deliveryId, owner: client.classicAddress, sequence: seq,
    cancelAfter, destination: freelancer.classicAddress, amountXrp: AMOUNT_XRP, proof: cond.proof, createHash: r.result.hash });
  return { seq, createHash: r.result.hash, cancelAfter };
}

// 3-4. escrow 1: the real job
const e1 = await lock({ url: PROOF_URL, sha256: sha256(deliverable) }, DEADLINE_1, "escrow 1 (the job)");

// 5. wrong file
published = wrong;
log("freelancer publishes the WRONG file…");
let s = await waitFor(client.classicAddress, e1.seq, (e) => e.checks >= 2, 20);
log(`oracle says: ${s?.lastWhy ?? "?"} — status ${s?.status}`);

// 6. a third party tries without the secret
const { wallet: third } = await c.fundWallet();
try {
  const r = await c.submitAndWait({ TransactionType: "EscrowFinish", Account: third.classicAddress, Owner: client.classicAddress, OfferSequence: e1.seq }, { wallet: third, autofill: true });
  log(`third party finish without the secret: ${r.result.meta.TransactionResult} — ${explorer(r.result.hash)}`);
} catch (err) {
  log(`third party finish without the secret: rejected — ${err.message.split("\n")[0]}`);
}

// 7. right file
published = deliverable;
log("freelancer publishes the RIGHT file…");
s = await waitFor(client.classicAddress, e1.seq, (e) => e.status !== "waiting", 90);
log(`escrow 1: ${s.status} — ${s.lastWhy} — ${s.finishHash ? explorer(s.finishHash) : s.lastResult}`);
log(`freelancer balance: ${await c.getXrpBalance(freelancer.classicAddress)} XRP`);

// 8. escrow 2: nothing ever published at another URL
const e2 = await lock({ url: PROOF_URL.replace("livrable", "jamais"), sha256: sha256("never") }, DEADLINE_2, "escrow 2 (no delivery)");
log(`waiting ${DEADLINE_2} s for the deadline…`);
s = await waitFor(client.classicAddress, e2.seq, (e) => e.status !== "waiting", DEADLINE_2 + 60);
log(`escrow 2: ${s.status} — ${s.refundHash ? explorer(s.refundHash) : s.lastResult ?? s.lastWhy}`);
log(`client balance: ${await c.getXrpBalance(client.classicAddress)} XRP`);

await c.disconnect();
server.close();
console.log(JSON.stringify({ oracle: oracle.address, client: client.classicAddress, freelancer: freelancer.classicAddress, escrow1: e1, escrow2: e2 }, null, 2));
