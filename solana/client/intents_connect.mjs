#!/usr/bin/env node
/**
 * Intents Connect for dareskro — the payer's own wallet, on the chain it lives
 * on, locks the escrow on Solana. No desk holds the money in between.
 *
 * With the quote flow (aurora_intents.mjs), USDC lands on the desk's address and
 * the desk then locks it: for a few seconds the desk holds the payer's money.
 * Intents Connect removes that hop. Aurora derives, for each origin wallet, an
 * "intermediary" Solana account that only that wallet can authorise. A bridge-in
 * execution swaps the payer's asset into native SOL, lands it on the
 * intermediary, and runs our steps from it. Our one step is dareskro's `create`,
 * with the intermediary as the escrow's owner. From then on the program's rules
 * apply: the destination is fixed, nobody can redirect it, a refund goes back to
 * the intermediary, which answers only to the payer's wallet.
 *
 * Constraints read in docs.intents.aurora.dev (16 Nov 2026) and how we meet them:
 *   - only {INTERMEDIARY} may sign            → `create` has a single signer, the owner
 *   - the escrow account must need no new key  → it is a PDA of [escrow, owner, id]
 *   - args are typed and Borsh-encoded         → Options as a u8 tag + value,
 *                                                the 32-byte condition as a pubkey,
 *                                                Vec<String> as a u32 count + strings
 *   - SPL destinations pay gas through a relayer → the intermediary then holds no SOL,
 *     so `create_token` (two PDAs whose rent the owner pays) cannot run there;
 *     this file covers the native-SOL escrow only
 *   - mainnet only, 200 000 compute units, 1 232 bytes, 25-minute hold window
 *
 *   node intents_connect.mjs intermediary <originWallet>       Aurora's Solana intermediary for that wallet
 *   node intents_connect.mjs step <intermediary> <destination> <lamports> [finishInSec] [cancelInSec]
 *   node intents_connect.mjs check                             bytes equal Anchor's, tx size, compute units on devnet
 *   node intents_connect.mjs dry <originWallet> <originAsset> <destination> <lamports> [finishInSec] [cancelInSec]
 *                                                              ask Aurora to price and validate it (mainnet, nothing signed)
 *   node intents_connect.mjs release <escrow>                  mainnet: release after the date, to the destination only
 *                                                              (DARESKRO_MAINNET_KEY pays the fee; web/connect.html does the payment)
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { connect, loadKeypair, IDL, PROGRAM_ID, getFeeConfig, feeFor, explorerTx, anchor } from "./dareskro_solana.mjs";
import { SOL_NATIVE } from "./aurora_intents.mjs"; // also loads solana/.env

export const CONNECT_API = process.env.AURORA_CONNECT_API || "https://intents-connect-api.aurora.dev";
export const INTERMEDIARY = "{INTERMEDIARY}";
export const MIN_AMOUNT_OUT = "{MIN_AMOUNT_OUT}";
const here = dirname(fileURLToPath(import.meta.url));
const SYSTEM = "11111111111111111111111111111111";
/** rent of one escrow account, measured on devnet on 16 Nov 2026 (a protocol constant, same on mainnet) */
export const ESCROW_RENT = 4_165_600;
/** rent-exempt minimum of a plain system account (0 bytes), 5 080 lamports a byte on 16 Nov 2026 */
export const SYSTEM_RENT_MIN = 650_240;

const createDisc = Buffer.from(IDL.instructions.find((i) => i.name === "create").discriminator).toString("hex");

const optI64 = (name, v) =>
  v == null ? [{ name: `${name}.none`, type: "u8", value: 0 }]
            : [{ name: `${name}.some`, type: "u8", value: 1 }, { name, type: "i64", value: String(v) }];

/**
 * dareskro `create` as one Intents Connect Solana step.
 * `intermediary` is the resolved address: the escrow PDA is derived from it.
 * The owner account stays the {INTERMEDIARY} placeholder, as Aurora asks.
 * `lamports` may be the {MIN_AMOUNT_OUT} placeholder on a bridge-in.
 */
export function createStep({ intermediary, id, destination, lamports, finishAfter = null, cancelAfter = null, condition = null, memos = [], programId = PROGRAM_ID }) {
  const escrow = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), new PublicKey(intermediary).toBuffer(), new anchor.BN(id).toArrayLike(Buffer, "le", 8)],
    new PublicKey(programId),
  )[0];
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], new PublicKey(programId))[0];
  const args = [
    { name: "id", type: "u64", value: String(id) },
    { name: "destination", type: "pubkey", value: new PublicKey(destination).toBase58() },
    { name: "amount", type: "u64", value: String(lamports) },
    ...optI64("finish_after", finishAfter),
    ...optI64("cancel_after", cancelAfter),
    ...(condition == null
      ? [{ name: "condition.none", type: "u8", value: 0 }]
      : [{ name: "condition.some", type: "u8", value: 1 }, { name: "condition", type: "pubkey", value: new PublicKey(Buffer.from(condition, "hex")).toBase58() }]),
    { name: "memos.len", type: "u32", value: memos.length },
    ...memos.map((m, i) => ({ name: `memos[${i}]`, type: "string", value: m })),
  ];
  return {
    escrow: escrow.toBase58(),
    step: {
      metadata: { name: "dareskro: lock", description: `Lock for ${new PublicKey(destination).toBase58()}, released only to it` },
      programId: new PublicKey(programId).toBase58(),
      discriminator: createDisc,
      args,
      accounts: [
        { pubkey: INTERMEDIARY, isSigner: true, isWritable: true },   // owner and rent payer, the only signer
        { pubkey: escrow.toBase58(), isSigner: false, isWritable: true },
        { pubkey: config.toBase58(), isSigner: false, isWritable: true },
        { pubkey: SYSTEM, isSigner: false, isWritable: false },
      ],
    },
  };
}

/** Aurora's encoding as documented: discriminator bytes, then each arg in Borsh, in order. */
export function encodeStepData(step, subst = {}) {
  const parts = [Buffer.from(step.discriminator ?? "", "hex")];
  for (const a of step.args) {
    const v = typeof a.value === "string" && a.value in subst ? subst[a.value] : a.value;
    const int = (bytes, signed) => {
      const b = Buffer.alloc(bytes); const n = BigInt(v);
      if (bytes === 1) signed ? b.writeInt8(Number(n)) : b.writeUInt8(Number(n));
      else if (bytes === 2) signed ? b.writeInt16LE(Number(n)) : b.writeUInt16LE(Number(n));
      else if (bytes === 4) signed ? b.writeInt32LE(Number(n)) : b.writeUInt32LE(Number(n));
      else if (bytes === 8) signed ? b.writeBigInt64LE(n) : b.writeBigUInt64LE(n);
      else throw new Error(`width ${bytes}`);
      return b;
    };
    switch (a.type) {
      case "u8": parts.push(int(1, false)); break; case "i8": parts.push(int(1, true)); break;
      case "u16": parts.push(int(2, false)); break; case "i16": parts.push(int(2, true)); break;
      case "u32": parts.push(int(4, false)); break; case "i32": parts.push(int(4, true)); break;
      case "u64": parts.push(int(8, false)); break; case "i64": parts.push(int(8, true)); break;
      case "bool": parts.push(Buffer.from([v ? 1 : 0])); break;
      case "pubkey": parts.push(new PublicKey(v).toBuffer()); break;
      case "string": { const s = Buffer.from(v, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(s.length); parts.push(l, s); break; }
      default: throw new Error(`type ${a.type} not used here`);
    }
  }
  return Buffer.concat(parts);
}

/** The step as a real instruction, the placeholder replaced by `intermediary`. */
export function stepToInstruction(step, intermediary, subst = {}) {
  return new TransactionInstruction({
    programId: new PublicKey(step.programId),
    keys: step.accounts.map((k) => ({ pubkey: new PublicKey(k.pubkey === INTERMEDIARY ? intermediary : k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: encodeStepData(step, subst),
  });
}

async function api(method, path, body, withKey = false) {
  const headers = { accept: "application/json", "content-type": "application/json" };
  if (withKey) {
    if (!process.env.AURORA_API_KEY) throw new Error("AURORA_API_KEY missing in solana/.env");
    headers["x-api-key"] = process.env.AURORA_API_KEY;
  }
  const res = await fetch(`${CONNECT_API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

export const fetchIntermediary = (wallet) => api("GET", `/api/v1/executions/${encodeURIComponent(wallet)}/intermediary`);

function save(name, obj) {
  const dir = join(here, "sortie"); mkdirSync(dir, { recursive: true });
  const f = join(dir, `${name}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(f, JSON.stringify(obj, null, 2)); return f;
}

/** Local proof, then a devnet run that mimics Aurora's two-signer model. */
async function check() {
  const out = { at: new Date().toISOString(), program: PROGRAM_ID.toBase58() };
  // 1. same bytes as Anchor, for every shape of the optional args
  const someKey = Keypair.generate().publicKey;
  const cases = [
    { finishAfter: 1_800_000_000, cancelAfter: null, condition: null, memos: [] },
    { finishAfter: 1_800_000_000, cancelAfter: 1_800_086_400, condition: null, memos: ["shift 2026-11-14 night", "SHA256:ab12"] },
    { finishAfter: null, cancelAfter: 1_800_086_400, condition: createHash("sha256").update("x").digest("hex"), memos: ["é ü — utf-8"] },
  ];
  const { program } = await connect({ cluster: "devnet" });
  out.bytes = cases.map((c, i) => {
    const { step } = createStep({ intermediary: someKey, id: 42 + i, destination: someKey, lamports: 123_456_789, ...c });
    const ours = encodeStepData(step);
    const anchors = program.coder.instruction.encode("create", {
      id: new anchor.BN(42 + i), destination: someKey, amount: new anchor.BN(123_456_789),
      finishAfter: c.finishAfter == null ? null : new anchor.BN(c.finishAfter),
      cancelAfter: c.cancelAfter == null ? null : new anchor.BN(c.cancelAfter),
      condition: c.condition == null ? null : Array.from(Buffer.from(c.condition, "hex")),
      memos: c.memos,
    });
    return { case: i, length: ours.length, identical: Buffer.compare(ours, anchors) === 0 };
  });
  console.log("bytes vs Anchor:", out.bytes.map((b) => `${b.case}:${b.identical ? "identical" : "DIFFERENT"} (${b.length} B)`).join("  "));
  if (out.bytes.some((b) => !b.identical)) { console.log("stop: the encodings differ"); save("intents_connect_check", out); process.exit(1); }

  // 2. devnet: a fresh key plays the intermediary (owner, only signer, pays the rent);
  //    the Mac key plays Aurora's fee payer. Nothing else signs.
  const { connection } = await connect({ cluster: "devnet" });
  const feePayer = loadKeypair();
  const intermediary = Keypair.generate();
  const destination = loadKeypair(join(here, "..", "desk", "cles", "employee.devnet.json")).publicKey;
  const cfg = await getFeeConfig(program);
  const lamports = Math.round(0.01 * LAMPORTS_PER_SOL);
  const fee = feeFor(cfg, lamports);
  const seed = Math.round(0.03 * LAMPORTS_PER_SOL);
  const fund = await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: intermediary.publicKey, lamports: seed })), [feePayer]);
  const now = Math.floor(Date.now() / 1000);
  const id = now;
  const { step, escrow } = createStep({ intermediary: intermediary.publicKey, id, destination, lamports: MIN_AMOUNT_OUT, finishAfter: now + 20, cancelAfter: now + 7 * 86400, memos: ["intents-connect replay", "payer: origin wallet via Aurora intermediary"] });
  const ix = stepToInstruction(step, intermediary.publicKey, { [MIN_AMOUNT_OUT]: String(lamports) });
  const before = await connection.getBalance(intermediary.publicKey);
  const tx = new Transaction().add(ix); tx.feePayer = feePayer.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [feePayer, intermediary]);
  const meta = (await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).meta;
  const after = await connection.getBalance(intermediary.publicKey);
  const acct = await connection.getAccountInfo(new PublicKey(escrow));
  const rent = acct.lamports - lamports;
  const e = await program.account.escrow.fetch(new PublicKey(escrow));
  out.devnet = {
    fund, create: sig, escrow, intermediary: intermediary.publicKey.toBase58(), destination: destination.toBase58(),
    computeUnits: meta.computeUnitsConsumed, txFeePaidBy: "fee payer (Aurora's role)",
    intermediarySpent: before - after, split: { locked: lamports, escrowRent: rent, dareskroFee: fee },
    onChain: { owner: e.owner.toBase58(), destination: e.destination.toBase58(), amount: e.amount.toString(), status: Object.keys(e.status)[0] },
  };
  console.log(`devnet create ${sig}  CU ${meta.computeUnitsConsumed}  intermediary spent ${(before - after) / LAMPORTS_PER_SOL} SOL = locked ${lamports / LAMPORTS_PER_SOL} + rent ${rent / LAMPORTS_PER_SOL} + fee ${fee / LAMPORTS_PER_SOL}`);
  console.log(`  ${explorerTx(sig)}`);

  // 3. the transaction Aurora would assemble: nonce advance + compute budget + our step + fee transfer, two signers
  const nonce = Keypair.generate().publicKey, auroraFee = Keypair.generate().publicKey;
  const full = new Transaction();
  full.add(SystemProgram.nonceAdvance({ noncePubkey: nonce, authorizedPubkey: feePayer.publicKey }));
  full.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
  full.add(ix, SystemProgram.transfer({ fromPubkey: intermediary.publicKey, toPubkey: auroraFee, lamports: 15_000 }));
  full.feePayer = feePayer.publicKey; full.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const size = full.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  out.assembled = { bytes: size, limit: 1232, instructions: full.instructions.length, signatures: 2 };
  console.log(`assembled like Aurora: ${size} bytes of 1232 (${full.instructions.length} instructions, 2 signers)`);

  // 4. released to the destination by anyone after the date, then the owner gets the rent back
  await new Promise((r) => setTimeout(r, 25_000));
  const fin = await program.methods.finish(null).accountsPartial({ caller: feePayer.publicKey, escrow: new PublicKey(escrow), destination }).signers([feePayer]).rpc();
  const closeIx = await program.methods.close().accountsPartial({ owner: intermediary.publicKey, escrow: new PublicKey(escrow) }).instruction();
  const closeTx = new Transaction().add(closeIx); closeTx.feePayer = feePayer.publicKey;
  const close = await sendAndConfirmTransaction(connection, closeTx, [feePayer, intermediary]);
  // housekeeping: what the stand-in intermediary holds goes back to the Mac key
  const rest = await connection.getBalance(intermediary.publicKey);
  const back = rest > 0 ? await sendAndConfirmTransaction(connection, Object.assign(new Transaction().add(SystemProgram.transfer({ fromPubkey: intermediary.publicKey, toPubkey: feePayer.publicKey, lamports: rest })), { feePayer: feePayer.publicKey }), [feePayer, intermediary]) : null;
  out.devnet.finish = fin; out.devnet.close = close; out.devnet.housekeeping = back;
  console.log(`finish ${fin}\nclose  ${close}\nreturned ${rest / LAMPORTS_PER_SOL} SOL to the Mac key`);
  console.log(`saved ${save("intents_connect_check", out)}`);
}

async function dry(wallet, originAsset, destination, lamports, finishIn, cancelIn) {
  const im = await fetchIntermediary(wallet);
  console.log(`intermediary for ${wallet}: HTTP ${im.status}`, JSON.stringify(im.json));
  const sol = im.json?.result?.solana;
  if (!sol) { save("intents_connect_dry", { wallet, intermediary: im }); return; }
  const now = Math.floor(Date.now() / 1000);
  const { step, escrow } = createStep({ intermediary: sol, id: now, destination, lamports, finishAfter: finishIn ? now + Number(finishIn) : null, cancelAfter: cancelIn ? now + Number(cancelIn) : null, memos: ["dareskro via Intents Connect"] });
  // EXACT_OUTPUT sized so the intermediary can pay everything `create` takes from it:
  // the locked amount, the escrow's rent, dareskro's fee (zero on the funded deployment),
  // and it keeps its own rent-exempt minimum (a system account may not sit in the dust band).
  const need = Number(lamports) + ESCROW_RENT + Number(process.env.DARESKRO_FEE_LAMPORTS ?? 0) + SYSTEM_RENT_MIN;
  const body = {
    version: "1.0", type: "solana", dry: true,
    quote: { originAsset, destinationAsset: SOL_NATIVE, amount: String(need), swapType: "EXACT_OUTPUT", slippageTolerance: 100, deadline: new Date(Date.now() + 20 * 60_000).toISOString() },
    steps: [step],
  };
  const r = await api("POST", `/api/v1/executions/${encodeURIComponent(wallet)}`, body, true);
  console.log(`dry bridge-in: HTTP ${r.status}`); console.log(JSON.stringify(r.json, null, 2).slice(0, 3000));
  console.log(`saved ${save("intents_connect_dry", { wallet, intermediary: im.json, escrow, request: body, response: r })}`);
}

/** Mainnet: anyone may release after the date, only to the destination; the key here only pays the network fee. */
async function release(escrowAddr) {
  const { Connection } = await import("@solana/web3.js");
  const rpc = process.env.SOLANA_MAINNET_RPC || "https://solana-rpc.publicnode.com";
  const keyPath = process.env.DARESKRO_MAINNET_KEY || join(process.env.HOME, ".config", "solana", "dareskro-mainnet.json");
  const caller = loadKeypair(keyPath);
  const connection = new Connection(rpc, "confirmed");
  const program = new anchor.Program(IDL, new anchor.AnchorProvider(connection, new anchor.Wallet(caller), { commitment: "confirmed" }));
  const e = await program.account.escrow.fetch(new PublicKey(escrowAddr));
  const st = Object.keys(e.status)[0];
  console.log(`escrow ${escrowAddr}: ${st}, ${Number(e.amount) / LAMPORTS_PER_SOL} SOL for ${e.destination.toBase58()}, owner ${e.owner.toBase58()}, release after ${e.finishAfter ? new Date(e.finishAfter.toNumber() * 1000).toISOString() : "—"}`);
  if (st !== "locked") return;
  const sig = await program.methods.finish(null).accountsPartial({ caller: caller.publicKey, escrow: new PublicKey(escrowAddr), destination: e.destination }).signers([caller]).rpc();
  console.log(`released by ${caller.publicKey.toBase58()} (fee only): https://solscan.io/tx/${sig}`);
  console.log(`saved ${save("intents_connect_release", { escrow: escrowAddr, destination: e.destination.toBase58(), lamports: e.amount.toString(), tx: sig })}`);
}

const [cmd, ...a] = process.argv.slice(2);
if (cmd === "intermediary") { const r = await fetchIntermediary(a[0]); console.log(r.status, JSON.stringify(r.json, null, 2)); }
else if (cmd === "step") {
  const now = Math.floor(Date.now() / 1000);
  console.log(JSON.stringify(createStep({ intermediary: a[0], id: now, destination: a[1], lamports: a[2] ?? MIN_AMOUNT_OUT, finishAfter: a[3] ? now + Number(a[3]) : null, cancelAfter: a[4] ? now + Number(a[4]) : null }), null, 2));
}
else if (cmd === "check") await check();
else if (cmd === "dry") await dry(...a);
else if (cmd === "release") await release(a[0]);
else if (import.meta.url === `file://${process.argv[1]}`) console.log("usage: intermediary | step | check | dry (see the header of this file)");
