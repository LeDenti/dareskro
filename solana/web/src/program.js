/**
 * dareskro_escrow without Anchor's client: the three instructions and the account
 * layout, encoded by hand (Borsh), so the page ships with @solana/web3.js alone.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { PROGRAM_ID } from "./config.js";

export const PROGRAM = new PublicKey(PROGRAM_ID);
const DISC = { create: [24, 30, 200, 40, 5, 28, 7, 119], finish: [67, 74, 170, 132, 125, 233, 182, 37], cancel: [232, 219, 223, 41, 219, 236, 220, 190], close: [98, 165, 201, 177, 108, 65, 206, 96], account: [31, 213, 123, 187, 186, 22, 218, 155] };

class W { constructor() { this.parts = []; } u8(v) { this.parts.push(Buffer.from([v])); return this; } u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(b); return this; }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.parts.push(b); return this; } i64(v) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); this.parts.push(b); return this; }
  pk(p) { this.parts.push(new PublicKey(p).toBuffer()); return this; } bytes(b) { this.parts.push(Buffer.from(b)); return this; }
  opt(v, f) { if (v == null) return this.u8(0); this.u8(1); f(v); return this; } str(s) { const b = Buffer.from(s, "utf8"); return this.u32(b.length).bytes(b); } out() { return Buffer.concat(this.parts); } }

export const escrowAddress = (owner, id) => { const le = Buffer.alloc(8); le.writeBigUInt64LE(BigInt(id)); return PublicKey.findProgramAddressSync([Buffer.from("escrow"), new PublicKey(owner).toBuffer(), le], PROGRAM)[0]; };

/** create(id, destination, lamports, finish_after?, cancel_after?, condition?, memos[]) */
export function createIx({ owner, destination, lamports, finishAfter, cancelAfter, condition, memos = [], id }) {
  const w = new W().bytes(DISC.create).u64(id).pk(destination).u64(lamports);
  w.opt(finishAfter, (v) => w.i64(v)); w.opt(cancelAfter, (v) => w.i64(v)); w.opt(condition, (v) => w.bytes(v)); w.u32(memos.length);
  for (const m of memos) w.str(m);
  const escrow = escrowAddress(owner, id);
  return { escrow, ix: new TransactionInstruction({ programId: PROGRAM, data: w.out(), keys: [
    { pubkey: new PublicKey(owner), isSigner: true, isWritable: true }, { pubkey: escrow, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false } ] }) };
}
export const finishIx = ({ caller, escrow, destination, fulfillment }) => new TransactionInstruction({ programId: PROGRAM, data: buildFinish(fulfillment), keys: [
  { pubkey: new PublicKey(caller), isSigner: true, isWritable: false }, { pubkey: new PublicKey(escrow), isSigner: false, isWritable: true }, { pubkey: new PublicKey(destination), isSigner: false, isWritable: true } ] });
function buildFinish(f) { const w = new W().bytes(DISC.finish); if (f == null) w.u8(0); else { w.u8(1).u32(f.length).bytes(f); } return w.out(); }
export const cancelIx = ({ caller, escrow, owner }) => new TransactionInstruction({ programId: PROGRAM, data: Buffer.from(DISC.cancel), keys: [
  { pubkey: new PublicKey(caller), isSigner: true, isWritable: false }, { pubkey: new PublicKey(escrow), isSigner: false, isWritable: true }, { pubkey: new PublicKey(owner), isSigner: false, isWritable: true } ] });
export const closeIx = ({ owner, escrow }) => new TransactionInstruction({ programId: PROGRAM, data: Buffer.from(DISC.close), keys: [
  { pubkey: new PublicKey(owner), isSigner: true, isWritable: true }, { pubkey: new PublicKey(escrow), isSigner: false, isWritable: true } ] });

/** The Escrow account, field by field, in the order of the program's struct. */
export function decodeEscrow(address, data) {
  const b = Buffer.from(data); let o = 8;
  const pk = () => { const v = new PublicKey(b.subarray(o, o + 32)).toBase58(); o += 32; return v; };
  const u64 = () => { const v = b.readBigUInt64LE(o); o += 8; return v; }; const i64 = () => { const v = Number(b.readBigInt64LE(o)); o += 8; return v; };
  const opt = (f) => { const t = b[o++]; return t ? f() : null; };
  const owner = pk(), destination = pk(), mint = opt(pk), amount = u64(), finishAfter = opt(i64), cancelAfter = opt(i64);
  const condition = opt(() => { const v = b.subarray(o, o + 32).toString("hex"); o += 32; return v; });
  const n = b.readUInt32LE(o); o += 4; const memos = [];
  for (let i = 0; i < n; i++) { const l = b.readUInt32LE(o); o += 4; memos.push(b.subarray(o, o + l).toString("utf8")); o += l; }
  const status = ["locked", "finished", "cancelled"][b[o++]]; const createdAt = i64(); const closedAt = opt(i64); const closedBy = opt(pk);
  const fl = b.readUInt32LE(o); o += 4; const fulfillment = fl ? b.subarray(o, o + fl).toString("hex") : null; o += fl; const id = u64().toString();
  return { address: address.toBase58(), owner, destination, mint, amount: amount.toString(), sol: Number(amount) / 1e9, finishAfter, cancelAfter, condition, memos, status, createdAt, closedAt, closedBy, fulfillment, id };
}
/** Every escrow where `who` is the owner or the destination. */
export async function listEscrows(connection, who) {
  const q = (offset) => connection.getProgramAccounts(PROGRAM, { filters: [{ memcmp: { offset: 0, bytes: Buffer.from(DISC.account).toString("base64"), encoding: "base64" } }, { memcmp: { offset, bytes: new PublicKey(who).toBase58() } }] });
  const [mine, tome] = await Promise.all([q(8), q(40)]);
  const seen = new Map();
  for (const a of [...mine, ...tome]) if (!seen.has(a.pubkey.toBase58())) seen.set(a.pubkey.toBase58(), decodeEscrow(a.pubkey, a.account.data));
  return [...seen.values()].sort((a, b) => b.createdAt - a.createdAt);
}
/** Anchor's error name in the logs of a failed transaction. */
export const errorCode = (logs = []) => (logs.join("\n").match(/Error Code: (\w+)\. Error Number: \d+\. Error Message: ([^\n]*)/) || []).slice(1);
