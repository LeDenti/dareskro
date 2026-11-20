/**
 * x402 with the money locked, not paid — the run measured on devnet on 20 November 2026,
 * re-read from the chain by this page, in the visitor's browser. No wallet needed.
 *
 * What it checks, from the transactions alone:
 *   lock:    one dareskro create_token, fee payer = the facilitator, signed by the agent (owner),
 *            destination = the seller, a refund date, and a 32-byte condition
 *   release: one finish_token on the same escrow, whose fulfillment (the key) hashes to that condition
 *   silent seller: the lock, then a cancel_token by the agent after the refund date
 */
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, explorerTx, explorerAddr } from "./config.js";

const DISC = {
  create_token: [84, 52, 204, 228, 24, 140, 234, 75],
  finish_token: [194, 25, 42, 139, 17, 215, 16, 83],
  cancel_token: [218, 217, 51, 106, 130, 11, 150, 226],
};
export const RUN = {
  sale: {
    lock: "2xaiYqN62KCNaHeS2fEgzzXdJufnb6bfstLYxAxvDbDSbbFZ7VZBEyHMdfYZh73jsULkufbPBFgwjqz969SbEX7k",
    release: "25pSCQzBh3BLvxTcsmM4xojpjTcsEhc4S3hHf9GSPo5UTtT2qddVFqDL7bMwe4rKGV31PzxikFJu3Vy7Agc7zGit",
  },
  silent: {
    lock: "5LBJRyFTaVpmEzpVrVgifku3NAGiGcXCwFQSNb1cyWJMEtS377yqKEAdcAQLpAmtw54wUKoXW6YeJFXy5L4vf3T3",
    refund: "4C9yqh7W7fm17hnoW3YGwqmU3iwpgoi67kod2gNZWHYWmm7q2BKnodeKGWnRJAuhdkL65GFgfYNQaPBD6pWaxkzG",
  },
  facilitator: "4ypF64RBg6GUszSwcp8d46tUvDkjDdUXDTZbziVRSF2J",
  agent: "oiw2HPARwrhewhZA4fYrTpdaozTEphQdaZGMDttgze6",
  seller: "F8nKYnvPfg9UUaQTh91RxFfXbUjpdjaWPzZSVWQgT58b",
  mint: "xWp5R7iLPoEdGVDiJovXAX2BVzVPwZRy495tYUUnVrB",
};

const hex = (b) => Buffer.from(b).toString("hex");
const sha256 = async (b) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
const short = (s, n = 8) => `${s.slice(0, n)}…`;
const link = (sig) => `<a href="${explorerTx(sig)}" target="_blank" rel="noreferrer">${short(sig)}</a>`;
const addr = (a, label) => `<a href="${explorerAddr(a)}" target="_blank" rel="noreferrer">${label ?? short(a)}</a>`;

/** The one dareskro instruction of a transaction, with its accounts and raw data. */
async function ours(connection, sig, name) {
  const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) throw new Error(`transaction ${short(sig)} not found on devnet`);
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys;
  const ix = msg.compiledInstructions.find((i) => keys[i.programIdIndex].toBase58() === PROGRAM_ID);
  const data = Buffer.from(ix.data);
  if (!data.subarray(0, 8).equals(Buffer.from(DISC[name]))) throw new Error(`${short(sig)} is not a ${name}`);
  const accounts = ix.accountKeyIndexes.map((k) => keys[k].toBase58());
  return { data, accounts, feePayer: keys[0].toBase58(), signers: keys.slice(0, tx.transaction.message.header.numRequiredSignatures).map((k) => k.toBase58()), time: tx.blockTime, err: tx.meta.err };
}

/** create_token(id u64, destination, amount u64, finish_after?, cancel_after?, condition?, memos) */
function readLock(d) {
  let o = 8;
  const id = d.readBigUInt64LE(o); o += 8;
  const destination = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32;
  const amount = d.readBigUInt64LE(o); o += 8;
  let finishAfter = null, cancelAfter = null, condition = null;
  if (d[o++] === 1) { finishAfter = Number(d.readBigInt64LE(o)); o += 8; }
  if (d[o++] === 1) { cancelAfter = Number(d.readBigInt64LE(o)); o += 8; }
  if (d[o++] === 1) { condition = hex(d.subarray(o, o + 32)); o += 32; }
  const n = d.readUInt32LE(o); o += 4;
  const memos = [];
  for (let i = 0; i < n; i++) { const l = d.readUInt32LE(o); o += 4; memos.push(d.subarray(o, o + l).toString("utf8")); o += l; }
  return { id, destination, amount, finishAfter, cancelAfter, condition, memos };
}
/** finish_token(fulfillment: Option<Vec<u8>>) */
const readKey = (d) => (d[8] === 1 ? d.subarray(13, 13 + d.readUInt32LE(9)) : null);

const ok = (b, text) => `<li class="${b ? "ok" : "ko"}">${b ? "✓" : "✗"} ${text}</li>`;

export async function checkRun(connection, out) {
  out.innerHTML = "<p class='muted'>Reading four transactions from devnet…</p>";
  const r = [];
  // 1. the sale
  const lock = await ours(connection, RUN.sale.lock, "create_token");
  const L = readLock(lock.data);
  const escrow = lock.accounts[3];
  r.push(`<h3>A sale</h3><ul>`);
  r.push(ok(lock.feePayer === RUN.facilitator, `lock ${link(RUN.sale.lock)}: the network fee is paid by the facilitator ${addr(RUN.facilitator)}, which signs nothing else`));
  r.push(ok(lock.accounts[0] === RUN.agent && lock.signers.includes(RUN.agent), `the money comes from the agent ${addr(RUN.agent)}, who signed`));
  r.push(ok(L.destination === RUN.seller, `it can only ever go to the seller ${addr(RUN.seller)}`));
  r.push(ok(lock.accounts[1] === RUN.mint, `${(Number(L.amount) / 1e6).toFixed(2)} test dollars (${addr(RUN.mint, "our devnet mint")}), locked in escrow ${addr(escrow)}`));
  r.push(ok(L.finishAfter == null && L.cancelAfter != null, `no pay date; refundable to the agent after ${new Date(L.cancelAfter * 1000).toLocaleString()} (${L.cancelAfter - lock.time} s after the lock)`));
  r.push(ok(!!L.condition, `condition: sha256 of the file's key = <code>${short(L.condition, 16)}</code> · memo <code>${L.memos.join(" ")}</code>`));
  const rel = await ours(connection, RUN.sale.release, "finish_token");
  const key = readKey(rel.data);
  const h = key ? await sha256(key) : "";
  r.push(ok(rel.accounts[1] === escrow, `release ${link(RUN.sale.release)} on the same escrow, signed by the seller ${addr(rel.signers[0])}`));
  r.push(ok(h === L.condition, `the key it published, <code>${short(hex(key), 16)}</code>, hashes to the condition: the seller was paid by handing over the key, and the agent read it here, on chain`));
  r.push(`</ul>`);
  // 2. the silent seller
  const lock2 = await ours(connection, RUN.silent.lock, "create_token");
  const L2 = readLock(lock2.data);
  const refund = await ours(connection, RUN.silent.refund, "cancel_token");
  r.push(`<h3>A seller that never publishes the key</h3><ul>`);
  r.push(ok(lock2.feePayer === RUN.facilitator && L2.destination === RUN.seller, `lock ${link(RUN.silent.lock)}: ${(Number(L2.amount) / 1e6).toFixed(2)} for the seller, refundable after ${L2.cancelAfter - lock2.time} s`));
  r.push(ok(refund.accounts[1] === lock2.accounts[3] && refund.time >= L2.cancelAfter && !refund.err, `refund ${link(RUN.silent.refund)} to the agent, ${refund.time - L2.cancelAfter} s after the refund date (before it the program said <code>CancelTooEarly</code>; after it, even the right key got <code>TooLate</code>)`));
  r.push(`</ul>`);
  out.innerHTML = r.join("");
}
