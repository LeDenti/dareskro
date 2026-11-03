/**
 * The fee per act on XRPL, measured live on testnet: the oracle's gate.
 *
 *   1. client and freelancer get testnet accounts
 *   2. the oracle issues a condition for an agreed proof (URL + SHA-256); /watch answers with the fee due
 *   3. the client locks 20 XRP behind the condition; the freelancer publishes the RIGHT file at once
 *   4. the oracle sees the proof match — and does NOT sign: the fee is not paid
 *   5. the client pays the fee: a Payment of `drops` to the oracle with memo dareskro/fee "<owner>:<sequence>"
 *   6. next tick, the oracle reveals the secret: the freelancer is paid the full 20 XRP
 *
 * Needs oracle/tarif.json with "drops" > 0 BEFORE this runs (the drops are fixed at /watch time), and the
 * oracle running: node oracle.mjs watch. Writes sortie/frais_<stamp>.json.
 *
 * Usage: node demo_frais.mjs
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, xrpToDrops } from "xrpl";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORACLE = process.env.ORACLE_URL || "http://127.0.0.1:8787";
const PORT = Number(process.env.PROOF_PORT || 8798);
const PROOF_URL = process.env.PROOF_URL || `http://127.0.0.1:${PORT}/livrable.txt`;
const AMOUNT_XRP = "20";
const DEADLINE = 420; // seconds before the refund branch
const RIPPLE_EPOCH = 946684800;
const rippleTime = (d) => Math.floor(d.getTime() / 1000) - RIPPLE_EPOCH;
const hex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const explorer = (h) => `https://testnet.xrpl.org/transactions/${h}`;
const rows = [];
const log = (step, text, hash) => { const r = { at: new Date().toISOString().slice(11, 19), step, text, tx: hash ? explorer(hash) : null }; rows.push(r); console.log(`${r.at} | ${step} ${text}${hash ? ` | ${r.tx}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const deliverable = `dareskro deliverable — fee per act, measured — ${new Date().toISOString()}\n`;
let published = null;
const server = createServer((req, res) => {
  if (req.url === "/livrable.txt" && published !== null) { res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); return res.end(published); }
  res.writeHead(404); res.end("not published");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const oracleGet = async (p) => (await fetch(ORACLE + p)).json();
async function oraclePost(p, body) { const r = await fetch(ORACLE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${j.error}`); return j; }
const mine = async (owner, seq) => (await oracleGet("/escrows")).escrows.find((e) => e.owner === owner && e.sequence === seq);
async function waitFor(owner, seq, pred, maxS) { for (let i = 0; i < maxS / 3; i++) { const e = await mine(owner, seq); if (e && pred(e)) return e; await sleep(3000); } return mine(owner, seq); }

const oracle = await oracleGet("/identity");
const schedule = await oracleGet("/fee");
log("0", `oracle ${oracle.address}; schedule in force: ${schedule.drops} drops per conditioned escrow, memo ${schedule.memoType} "${schedule.memoData}"`);
if (!(schedule.drops > 0)) { console.error("set oracle/tarif.json drops > 0 first"); process.exit(2); }

const c = new Client(process.env.XRPL_WSS || "wss://s.altnet.rippletest.net:51233");
await c.connect();
async function fund() { for (let i = 0; ; i++) { try { return (await c.fundWallet()).wallet; } catch (e) { if (i >= 4) throw e; await sleep(5000); } } }
const client = await fund();
const freelancer = await fund();
log("1", `client ${client.classicAddress}, freelancer ${freelancer.classicAddress} (testnet faucet)`);
const oracleBefore = Number(await c.getXrpBalance(oracle.address));

// 2-3. the condition, the lock, the watch — /watch answers with the fee due
const proof = { url: PROOF_URL, sha256: sha256(deliverable) };
const cond = await oraclePost("/delivery/condition", { url: proof.url, sha256: proof.sha256, note: "fee per act, measured" });
const cancelAfter = rippleTime(new Date(Date.now() + DEADLINE * 1000));
const cr = await c.submitAndWait({ TransactionType: "EscrowCreate", Account: client.classicAddress, Destination: freelancer.classicAddress, Amount: xrpToDrops(AMOUNT_XRP), Condition: cond.condition, CancelAfter: cancelAfter,
  Memos: [{ Memo: { MemoType: hex("dareskro/delivery-proof"), MemoData: hex(`sha256:${proof.sha256};url:${proof.url}`), MemoFormat: hex("text/plain") } }, { Memo: { MemoType: hex("dareskro/oracle"), MemoData: hex(oracle.address) } }] }, { wallet: client, autofill: true });
const seq = cr.result.tx_json.Sequence;
if (cr.result.meta.TransactionResult !== "tesSUCCESS") throw new Error(`EscrowCreate ${cr.result.meta.TransactionResult}`);
log("2", `EscrowCreate #${seq}: ${AMOUNT_XRP} XRP locked behind the condition, refund after ${DEADLINE} s`, cr.result.hash);
const w = await oraclePost("/watch", { kind: "delivery", deliveryId: cond.deliveryId, owner: client.classicAddress, sequence: seq, cancelAfter, destination: freelancer.classicAddress, amountXrp: AMOUNT_XRP, proof: cond.proof, createHash: cr.result.hash });
log("3", `/watch → fee due: ${w.fee.drops} drops to ${w.fee.payTo}, memo ${w.fee.memoType} "${w.fee.memoData}"`);

// 4. the right file, at once — the proof matches, the oracle does not sign
published = deliverable;
let s = await waitFor(client.classicAddress, seq, (e) => /fee is not paid/.test(e.lastWhy ?? ""), 60);
log("4", `RIGHT file published; oracle: ${s?.lastWhy ?? "?"} — status ${s?.status}, ${s?.checks ?? 0} check(s)`);
await sleep(9000);
s = await mine(client.classicAddress, seq);
log("4b", `9 s later, still ${s.status}: the proof alone does not open the escrow (freelancer ${await c.getXrpBalance(freelancer.classicAddress)} XRP)`);

// 5. the fee: a Payment with the memo the oracle asked for
const pr = await c.submitAndWait({ TransactionType: "Payment", Account: client.classicAddress, Destination: w.fee.payTo, Amount: String(w.fee.drops),
  Memos: [{ Memo: { MemoType: hex(w.fee.memoType), MemoData: hex(w.fee.memoData), MemoFormat: hex("text/plain") } }] }, { wallet: client, autofill: true });
log("5", `client pays the fee: ${w.fee.drops} drops to the oracle, memo "${w.fee.memoData}" — ${pr.result.meta.TransactionResult}`, pr.result.hash);

// 6. next tick: the secret is revealed
s = await waitFor(client.classicAddress, seq, (e) => e.status !== "waiting", 90);
log("6", `oracle: ${s.status} — fee seen ${s.feePaid ? `(${s.feePaid.drops} drops, ${s.feePaid.hash.slice(0, 8)}…)` : "no"} — ${s.lastWhy}`, s.finishHash);
const fb = await c.getXrpBalance(freelancer.classicAddress);
const ob = Number(await c.getXrpBalance(oracle.address));
log("7", `freelancer ${fb} XRP (the full ${AMOUNT_XRP} XRP: the fee came on top, from the client); oracle ${oracleBefore} → ${ob} XRP (+${(ob - oracleBefore).toFixed(6)}, the fee minus its own EscrowFinish fee)`);

await c.disconnect();
server.close();
const OUT = path.join(HERE, "sortie"); if (!existsSync(OUT)) mkdirSync(OUT);
const f = path.join(OUT, `frais_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(f, JSON.stringify({ oracle: oracle.address, schedule, client: client.classicAddress, freelancer: freelancer.classicAddress, sequence: seq, createHash: cr.result.hash, feeHash: pr.result.hash, finishHash: s.finishHash ?? null, rows }, null, 2));
console.log(`→ ${f}`);
