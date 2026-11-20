/**
 * x402 with the money locked, not paid: the "dareskro-escrow" scheme on Solana.
 *
 * With x402's "exact" scheme the buyer pays the seller up front and trusts the
 * seller to deliver. Here the buyer's payment is a dareskro `create_token`: the
 * amount goes into a vault only the program controls, for one destination (the
 * seller), with a condition (the sha256 of the key that decrypts the goods) and
 * a refund date. To be paid, the seller must call `finish_token` with that key,
 * and that call writes the key on the chain, where the buyer reads it. If the
 * key never comes, the buyer takes the money back after the refund date. No
 * oracle, no desk, no trust in the seller: the delivery and the payment are the
 * same transaction.
 *
 * Wire format: x402 v2 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE).
 *   requirements.scheme      "dareskro-escrow"
 *   requirements.asset       the SPL mint, requirements.amount its base units
 *   requirements.payTo       the seller, the only possible destination
 *   requirements.extra       { program, feePayer, condition (hex sha256 of the key),
 *                              refundAfterSeconds, nonce, ciphertext (url),
 *                              ciphertextSha256, memo }
 *   payload.payload          { transaction (base64, signed by the buyer, fee payer
 *                              = the facilitator, not yet signed by it), escrow, id }
 *
 * The facilitator only pays the network fee. It co-signs a transaction that
 * contains a compute budget and exactly one dareskro `create_token` whose
 * arguments are the requirements, and in which its own key appears nowhere but
 * as fee payer. The rent of the escrow and its vault is paid by the buyer and
 * comes back when the escrow is closed.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  ComputeBudgetProgram, Connection, PublicKey, Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { anchor, IDL, PROGRAM_ID, RPC, escrowAddress, vaultAddress, feeConfigAddress } from "./dareskro_solana.mjs";

export const SCHEME = "dareskro-escrow";
export const NETWORK = SOLANA_DEVNET_CAIP2;
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
const CU_LIMIT = 120_000;
const DRIFT = 90; // seconds of tolerance between the buyer's clock and the facilitator's

export const sha256hex = (b) => createHash("sha256").update(b).digest("hex");

// ------------------------------------------------------------------ the goods

/** AES-256-GCM: the key IS the escrow's fulfillment, its sha256 the condition. */
export function seal(plaintext) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  const blob = Buffer.concat([iv, c.getAuthTag(), body]); // iv | tag | ciphertext
  return { key, condition: sha256hex(key), blob, blobSha256: sha256hex(blob) };
}
export function open(blob, key) {
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

// ------------------------------------------------------------------ helpers

const coder = new anchor.BorshInstructionCoder(IDL);
const readOnlyProgram = (connection) =>
  new anchor.Program(IDL, new anchor.AnchorProvider(connection, { publicKey: PublicKey.default }, {}));

export async function chainNow(connection) {
  const slot = await connection.getSlot("confirmed");
  return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

/** The order of create_token's accounts in the IDL, read once. */
const CREATE_TOKEN = IDL.instructions.find((i) => i.name === "create_token");
const ACC = Object.fromEntries(CREATE_TOKEN.accounts.map((a, i) => [a.name, i]));

// ------------------------------------------------------------------ client (the buyer's agent)

/**
 * The buyer's side. `limits` are the agent's own rails, checked before it signs
 * anything: which sellers, how much, how long the money may stay locked.
 * `tamper` exists only for the measurement script (to show the facilitator's refusals).
 */
export class DareskroEscrowClient {
  constructor({ signer, rpc = RPC.devnet, limits = {}, tamper = null }) {
    this.scheme = SCHEME;
    this.signer = signer;
    this.connection = new Connection(rpc, "confirmed");
    this.program = readOnlyProgram(this.connection);
    this.limits = { maxAmount: null, maxRefundAfterSeconds: 3600, sellers: null, ...limits };
    this.tamper = tamper;
    this.last = null;
  }

  async createPaymentPayload(x402Version, req) {
    const x = req.extra ?? {};
    const L = this.limits;
    if (req.scheme !== SCHEME) throw new Error(`scheme ${req.scheme} is not ${SCHEME}`);
    if (x.program !== PROGRAM_ID.toBase58()) throw new Error(`program ${x.program} is not dareskro's`);
    if (!/^[0-9a-f]{64}$/.test(x.condition ?? "")) throw new Error("no 32-byte condition: the seller could be paid without delivering");
    if (L.sellers && !L.sellers.includes(req.payTo)) throw new Error(`seller ${req.payTo} not on the agent's list`);
    if (L.maxAmount != null && BigInt(req.amount) > BigInt(L.maxAmount)) throw new Error(`amount ${req.amount} above the agent's cap ${L.maxAmount}`);
    const refundAfter = Number(x.refundAfterSeconds);
    if (!(refundAfter > 0 && refundAfter <= L.maxRefundAfterSeconds))
      throw new Error(`refund after ${x.refundAfterSeconds} s: the agent accepts at most ${L.maxRefundAfterSeconds} s of lock`);

    const t = this.tamper ?? {};
    const owner = this.signer.publicKey;
    const mint = new PublicKey(req.asset);
    const id = new anchor.BN(Date.now()).muln(1000).addn(Math.floor(Math.random() * 1000));
    const escrow = escrowAddress(owner, id);
    const cancelAfter = (await chainNow(this.connection)) + refundAfter;
    const ix = await this.program.methods
      .createToken(
        id,
        new PublicKey(t.destination ?? req.payTo),
        new anchor.BN(t.amount ?? req.amount),
        null,
        new anchor.BN(cancelAfter),
        Array.from(Buffer.from(t.condition ?? x.condition, "hex")),
        [String(x.memo ?? "x402").slice(0, 120)],
      )
      .accountsPartial({
        owner, mint,
        ownerToken: getAssociatedTokenAddressSync(mint, owner),
        escrow, vault: vaultAddress(escrow),
        tokenProgram: TOKEN_PROGRAM_ID, config: feeConfigAddress(),
      })
      .instruction();
    const tx = new Transaction();
    tx.feePayer = new PublicKey(x.feePayer);
    tx.recentBlockhash = (await this.connection.getLatestBlockhash("confirmed")).blockhash;
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }));
    if (t.extraInstruction) tx.add(t.extraInstruction(tx.feePayer, owner));
    tx.add(ix);
    tx.partialSign(this.signer);
    const transaction = tx.serialize({ requireAllSignatures: false }).toString("base64");
    this.last = { escrow: escrow.toBase58(), id: id.toString(), cancelAfter, transaction };
    return { x402Version, payload: { transaction, escrow: escrow.toBase58(), id: id.toString() } };
  }
}

// ------------------------------------------------------------------ facilitator (pays the fee, nothing else)

export class DareskroEscrowFacilitator {
  constructor({ feePayer, rpc = RPC.devnet }) {
    this.scheme = SCHEME;
    this.caipFamily = "solana:*";
    this.feePayer = feePayer;
    this.connection = new Connection(rpc, "confirmed");
    this.settled = new Set();
  }
  getExtra() {
    return { feePayer: this.feePayer.publicKey.toBase58(), program: PROGRAM_ID.toBase58() };
  }
  getSigners() {
    return [this.feePayer.publicKey.toBase58()];
  }

  /** Every rule, in order; the first broken one is the answer. */
  async check(payload, req) {
    const no = (invalidReason, invalidMessage) => ({ isValid: false, invalidReason, invalidMessage });
    const x = req.extra ?? {};
    const p = payload?.payload ?? {};
    if (req.scheme !== SCHEME || req.network !== NETWORK) return no("unsupported_scheme", `${req.scheme} on ${req.network}`);
    let tx;
    try { tx = Transaction.from(Buffer.from(String(p.transaction), "base64")); } catch { return no("invalid_payload", "transaction does not decode"); }
    const me = this.feePayer.publicKey;
    if (!tx.feePayer?.equals(me)) return no("fee_payer_mismatch", `fee payer ${tx.feePayer?.toBase58()} is not this facilitator`);
    // the facilitator's key may pay the fee and nothing else: no transfer, no rent, no authority
    for (const ix of tx.instructions)
      if (ix.keys.some((k) => k.pubkey.equals(me))) return no("fee_payer_in_instruction", `the facilitator's key is an account of a ${ix.programId.toBase58()} instruction`);
    const ours = tx.instructions.filter((ix) => ix.programId.equals(PROGRAM_ID));
    const others = tx.instructions.filter((ix) => !ix.programId.equals(PROGRAM_ID) && ix.programId.toBase58() !== COMPUTE_BUDGET);
    if (others.length) return no("unexpected_instruction", `program ${others[0].programId.toBase58()} is not allowed`);
    if (ours.length !== 1) return no("unexpected_instruction", `${ours.length} dareskro instructions, exactly 1 expected`);
    const ix = ours[0];
    const dec = coder.decode(ix.data);
    if (dec?.name !== "create_token") return no("unexpected_instruction", `dareskro ${dec?.name ?? "?"}, create_token expected`);
    // the coder keeps the IDL's snake_case names
    const a = { ...dec.data, finishAfter: dec.data.finish_after ?? dec.data.finishAfter, cancelAfter: dec.data.cancel_after ?? dec.data.cancelAfter };
    const key = (name) => ix.keys[ACC[name]]?.pubkey;
    const owner = key("owner");
    if (!a.destination.equals(new PublicKey(req.payTo))) return no("wrong_destination", `locks for ${a.destination.toBase58()}, the seller is ${req.payTo}`);
    if (a.amount.toString() !== String(req.amount)) return no("wrong_amount", `locks ${a.amount.toString()}, the price is ${req.amount}`);
    if (!key("mint")?.equals(new PublicKey(req.asset))) return no("wrong_asset", `mint ${key("mint")?.toBase58()} is not ${req.asset}`);
    if (!a.condition || Buffer.from(a.condition).toString("hex") !== x.condition) return no("wrong_condition", "the condition is not the sha256 of the seller's key");
    if (a.finishAfter != null) return no("finish_after_set", "a release date would delay the seller's payment");
    const now = await chainNow(this.connection);
    const ca = a.cancelAfter?.toNumber();
    const want = now + Number(x.refundAfterSeconds);
    if (ca == null || ca < want - DRIFT || ca > want + DRIFT) return no("wrong_refund_date", `refund at ${ca}, expected about ${want}`);
    if (!key("escrow")?.equals(escrowAddress(owner, a.id))) return no("wrong_escrow", "escrow is not the PDA of the owner and id");
    if (p.escrow !== key("escrow").toBase58()) return no("wrong_escrow", "payload and transaction name different escrows");
    if (this.settled.has(p.escrow)) return no("replay", `escrow ${p.escrow} already settled by this facilitator`);
    if (!tx.verifySignatures(false)) return no("invalid_signature", "a present signature does not verify");
    const sig = tx.signatures.find((s) => s.publicKey.equals(owner));
    if (!sig?.signature) return no("missing_signature", "the buyer has not signed");
    // dry run, signed by us, before anything is sent
    const probe = Transaction.from(tx.serialize({ requireAllSignatures: false }));
    probe.partialSign(this.feePayer);
    const sim = await this.connection.simulateTransaction(probe);
    if (sim.value.err) {
      const line = (sim.value.logs ?? []).find((l) => /Error Code|Error Message|failed/.test(l)) ?? JSON.stringify(sim.value.err);
      return no("simulation_failed", line);
    }
    return { isValid: true, payer: owner.toBase58(), extra: { escrow: p.escrow, units: sim.value.unitsConsumed }, tx };
  }

  async verify(payload, req) {
    const r = await this.check(payload, req);
    delete r.tx;
    return r;
  }

  async settle(payload, req) {
    const r = await this.check(payload, req);
    const base = { network: req.network, transaction: "" };
    if (!r.isValid) return { ...base, success: false, errorReason: r.invalidReason, errorMessage: r.invalidMessage };
    r.tx.partialSign(this.feePayer);
    try {
      const signature = await this.connection.sendRawTransaction(r.tx.serialize());
      const conf = await this.connection.confirmTransaction(signature, "confirmed");
      if (conf.value.err) return { ...base, success: false, errorReason: "transaction_failed", errorMessage: JSON.stringify(conf.value.err), transaction: signature };
      this.settled.add(payload.payload.escrow);
      return { ...base, success: true, transaction: signature, payer: r.payer, extra: { escrow: payload.payload.escrow } };
    } catch (e) {
      return { ...base, success: false, errorReason: "send_failed", errorMessage: e.message.split("\n")[0] };
    }
  }
}
