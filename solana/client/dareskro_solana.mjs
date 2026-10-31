/**
 * dareskro on Solana — the client side of the escrow program, for the pay desk,
 * the oracle and the demos. Same verbs as the XRPL rail: create, finish, cancel,
 * list. Nothing here holds a key for anyone else: the signer is always passed in.
 *
 *   import { connect, createEscrow, finishEscrow, cancelEscrow, listEscrows } from "./dareskro_solana.mjs";
 *   const { program } = await connect({ cluster: "devnet" });
 */
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
export const IDL = JSON.parse(readFileSync(join(here, "..", "target", "idl", "dareskro_escrow.json"), "utf8"));
export const PROGRAM_ID = new PublicKey(IDL.address);

export const RPC = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

export const explorerTx = (sig, cluster = "devnet") =>
  `https://explorer.solana.com/tx/${sig}${cluster === "mainnet" ? "" : `?cluster=${cluster}`}`;
export const explorerAccount = (addr, cluster = "devnet") =>
  `https://explorer.solana.com/address/${addr}${cluster === "mainnet" ? "" : `?cluster=${cluster}`}`;

export const sha256 = (buf) => createHash("sha256").update(buf).digest();
export const LAMPORTS = 1_000_000_000;

/** A keypair from a Solana CLI JSON file (default: the CLI's own key). */
export function loadKeypair(path = join(homedir(), ".config", "solana", "id.json")) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export async function connect({ cluster = "devnet", rpc, keypair, keypairPath, commitment = "confirmed" } = {}) {
  const connection = new Connection(rpc ?? RPC[cluster], commitment);
  const payer = keypair ?? loadKeypair(keypairPath);
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment });
  const program = new anchor.Program(IDL, provider);
  return { connection, provider, program, payer, cluster };
}

/** PREIMAGE-SHA-256, as on XRPL: the oracle keeps the secret, the ledger keeps its hash. */
export function conditionPair(bytes = 32) {
  const secret = randomBytes(bytes);
  return { secret: secret.toString("hex"), condition: sha256(secret).toString("hex") };
}

export const escrowAddress = (owner, id) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), new PublicKey(owner).toBuffer(), new anchor.BN(id).toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  )[0];
export const vaultAddress = (escrow) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), new PublicKey(escrow).toBuffer()], PROGRAM_ID)[0];

const bnOrNull = (v) => (v == null ? null : new anchor.BN(v));
const hexOrNull = (v) => (v == null ? null : Array.from(Buffer.isBuffer(v) ? v : Buffer.from(v, "hex")));

/**
 * Lock `lamports` for `destination`. Times are Unix seconds. `condition` is a
 * sha256 in hex. Returns the escrow address, the id and the signature.
 */
export async function createEscrow(program, { owner, destination, lamports, finishAfter, cancelAfter, condition, memos = [], id }) {
  const theId = new anchor.BN(id ?? Date.now());
  const escrow = escrowAddress(owner.publicKey, theId);
  const signature = await program.methods
    .create(theId, new PublicKey(destination), new anchor.BN(lamports), bnOrNull(finishAfter), bnOrNull(cancelAfter), hexOrNull(condition), memos)
    .accountsPartial({ owner: owner.publicKey, escrow })
    .signers([owner])
    .rpc();
  return { id: theId.toString(), escrow: escrow.toBase58(), signature };
}

/** The instruction alone, to put several escrows in one transaction (all or nothing). */
export async function createInstruction(program, { owner, destination, lamports, finishAfter, cancelAfter, condition, memos = [], id }) {
  const theId = new anchor.BN(id ?? Date.now());
  const escrow = escrowAddress(owner, theId);
  const ix = await program.methods
    .create(theId, new PublicKey(destination), new anchor.BN(lamports), bnOrNull(finishAfter), bnOrNull(cancelAfter), hexOrNull(condition), memos)
    .accountsPartial({ owner: new PublicKey(owner), escrow })
    .instruction();
  return { id: theId.toString(), escrow: escrow.toBase58(), ix };
}

/** Anyone may call it. `fulfillment` is the secret in hex when the escrow has a condition. */
export async function finishEscrow(program, { caller, escrow, fulfillment }) {
  const e = await program.account.escrow.fetch(new PublicKey(escrow));
  return program.methods
    .finish(fulfillment == null ? null : Buffer.from(fulfillment, "hex"))
    .accountsPartial({ caller: caller.publicKey, escrow: new PublicKey(escrow), destination: e.destination })
    .signers([caller])
    .rpc();
}

/** Anyone may call it; the money can only go back to the owner, and only after cancel_after. */
export async function cancelEscrow(program, { caller, escrow }) {
  const e = await program.account.escrow.fetch(new PublicKey(escrow));
  return program.methods
    .cancel()
    .accountsPartial({ caller: caller.publicKey, escrow: new PublicKey(escrow), ownerAccount: e.owner })
    .signers([caller])
    .rpc();
}

/** The owner deletes a Finished or Cancelled record and takes the rent back. */
export async function closeEscrow(program, { owner, escrow }) {
  return program.methods.close().accountsPartial({ owner: owner.publicKey, escrow: new PublicKey(escrow) }).signers([owner]).rpc();
}

export const statusName = (s) => Object.keys(s)[0];

export function plain(e, address) {
  return {
    address: address?.toBase58?.() ?? address,
    owner: e.owner.toBase58(),
    destination: e.destination.toBase58(),
    mint: e.mint ? e.mint.toBase58() : null,
    amount: e.amount.toString(),
    finishAfter: e.finishAfter ? e.finishAfter.toNumber() : null,
    cancelAfter: e.cancelAfter ? e.cancelAfter.toNumber() : null,
    condition: e.condition ? Buffer.from(e.condition).toString("hex") : null,
    memos: e.memos,
    status: statusName(e.status),
    createdAt: e.createdAt.toNumber(),
    closedAt: e.closedAt ? e.closedAt.toNumber() : null,
    closedBy: e.closedBy ? e.closedBy.toBase58() : null,
    fulfillment: e.fulfillment.length ? Buffer.from(e.fulfillment).toString("hex") : null,
    id: e.id.toString(),
  };
}

export async function getEscrow(program, escrow) {
  const e = await program.account.escrow.fetchNullable(new PublicKey(escrow));
  return e ? plain(e, new PublicKey(escrow)) : null;
}

/** Every escrow of an owner, or towards a destination (memcmp on the record). */
export async function listEscrows(program, { owner, destination } = {}) {
  const filters = [];
  if (owner) filters.push({ memcmp: { offset: 8, bytes: new PublicKey(owner).toBase58() } });
  if (destination) filters.push({ memcmp: { offset: 40, bytes: new PublicKey(destination).toBase58() } });
  const all = await program.account.escrow.all(filters);
  return all.map((a) => plain(a.account, a.publicKey)).sort((a, b) => a.createdAt - b.createdAt);
}

/** The cluster's clock, not the machine's. */
export async function chainNow(connection) {
  const slot = await connection.getSlot("confirmed");
  return connection.getBlockTime(slot);
}

/**
 * Send a transaction WITHOUT preflight so that a refusal is recorded on chain,
 * like a tec code on XRPL: the explorer then shows the refused attempt.
 * Returns { signature, err, code, logs }.
 */
export async function sendRecorded(provider, builder, signers) {
  const tx = await builder.transaction();
  const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const signature = await provider.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await provider.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  const got = await provider.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const logs = got?.meta?.logMessages ?? [];
  const m = logs.join("\n").match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: ([^\n]*)/);
  return { signature, err: conf.value.err ?? null, code: m ? m[1] : null, message: m ? m[3] : null, logs };
}

export { anchor, Keypair, PublicKey, Transaction };
