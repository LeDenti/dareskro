#!/usr/bin/env node
/**
 * dareskro x402 on Solana devnet: an AI agent buys a file over HTTP, and its
 * money is locked in a dareskro escrow that only the file's key can open.
 *
 *   node x402.mjs setup          keys (client/cles/x402/), a test mint, SOL and test dollars for the agent
 *   node x402.mjs facilitator    the fee payer, http://localhost:4031  (GET /supported, POST /verify, /settle)
 *   node x402.mjs seller         the seller, http://localhost:4032  (GET /files/<name> answers 402)
 *   node x402.mjs buy <name>     the agent buys one file (facilitator and seller running)
 *   node x402.mjs measure        all of it in one process, with the refusals, written to client/sortie/
 *
 * Roles and keys (throwaway devnet keys, gitignored):
 *   facilitator  the Mac's CLI key: pays the network fee, signs nothing else
 *   seller       client/cles/x402/vendeur.json: is paid only by publishing the file's key
 *   agent        client/cles/x402/agent.json: holds test dollars and a little SOL for rent
 * The test dollars are a mint we created on devnet (6 decimals), not Circle's USDC.
 */
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, mintTo, getAccount, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  HTTPFacilitatorClient, encodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentResponseHeader,
  decodePaymentResponseHeader, encodePaymentSignatureHeader,
} from "@x402/core/http";
import { deepEqual } from "@x402/core/utils";
import { connect, loadKeypair, explorerTx, explorerAccount, vaultAddress, anchor, PROGRAM_ID } from "./dareskro_solana.mjs";
import { SCHEME, NETWORK, DareskroEscrowClient, DareskroEscrowFacilitator, seal, open, sha256hex, chainNow } from "./x402_sequestre.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const KEYS = join(here, "cles", "x402");
const OUT = join(here, "sortie");
const F_PORT = 4031, S_PORT = 4032;
const DECIMALS = 6;
const unit = (n) => String(Math.round(n * 10 ** DECIMALS));
const dollars = (base) => (Number(base) / 10 ** DECIMALS).toFixed(DECIMALS);

function keyFile(name) {
  const f = join(KEYS, `${name}.json`);
  if (!existsSync(f)) { mkdirSync(KEYS, { recursive: true }); writeFileSync(f, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 }); }
  return loadKeypair(f);
}
const state = () => JSON.parse(readFileSync(join(KEYS, "etat.json"), "utf8"));
const log = [];
const say = (...a) => { const l = a.join(" "); console.log(l); log.push(l); };

// ------------------------------------------------------------------ setup

async function setup() {
  const fac = loadKeypair();
  const { connection } = await connect({ keypair: fac });
  const agent = keyFile("agent"), seller = keyFile("vendeur");
  let st = existsSync(join(KEYS, "etat.json")) ? state() : {};
  if (!st.mint) {
    const mint = await createMint(connection, fac, fac.publicKey, null, DECIMALS);
    st = { mint: mint.toBase58(), note: "dareskro test dollars on devnet, 6 decimals, mint authority = the Mac's CLI key" };
    writeFileSync(join(KEYS, "etat.json"), JSON.stringify(st, null, 2));
  }
  const mint = new PublicKey(st.mint);
  for (const [k, sol] of [[agent, 0.06], [seller, 0.02]]) {
    const have = await connection.getBalance(k.publicKey);
    if (have < sol * LAMPORTS_PER_SOL / 2)
      await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: fac.publicKey, toPubkey: k.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [fac]);
  }
  const aAta = await getOrCreateAssociatedTokenAccount(connection, fac, mint, agent.publicKey);
  await getOrCreateAssociatedTokenAccount(connection, fac, mint, seller.publicKey);
  if (aAta.amount < 5_000_000n) await mintTo(connection, fac, mint, aAta.address, fac, 10_000_000);
  console.log(JSON.stringify({ facilitator: fac.publicKey.toBase58(), agent: agent.publicKey.toBase58(), seller: seller.publicKey.toBase58(), mint: st.mint }, null, 2));
}

// ------------------------------------------------------------------ facilitator

function json(req) {
  return new Promise((ok, ko) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch (e) { ko(e); } }); });
}
const reply = (res, code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };

export function startFacilitator(port = F_PORT) {
  const scheme = new DareskroEscrowFacilitator({ feePayer: loadKeypair() });
  const core = new x402Facilitator().register(NETWORK, scheme);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/supported") return reply(res, 200, core.getSupported());
      if (req.method !== "POST" || !["/verify", "/settle"].includes(req.url)) return reply(res, 404, { error: "not found" });
      const { paymentPayload, paymentRequirements } = await json(req);
      const r = req.url === "/verify" ? await core.verify(paymentPayload, paymentRequirements) : await core.settle(paymentPayload, paymentRequirements);
      const ok = req.url === "/verify" ? r.isValid : r.success;
      say(`  [facilitator] ${req.url.slice(1)} ${ok ? "OK" : "REFUSED"}${ok ? "" : ` ${r.invalidReason ?? r.errorReason}: ${r.invalidMessage ?? r.errorMessage}`}`);
      return reply(res, 200, r);
    } catch (e) {
      // the core throws on an invalid verify/settle in some versions: answer it as a refusal
      const reason = e.invalidReason ?? e.errorReason ?? "error";
      const msg = e.invalidMessage ?? e.errorMessage ?? e.message;
      say(`  [facilitator] REFUSED ${reason}: ${msg}`);
      return reply(res, 200, req.url === "/verify" ? { isValid: false, invalidReason: reason, invalidMessage: msg } : { success: false, errorReason: reason, errorMessage: msg, transaction: "", network: NETWORK });
    }
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

// ------------------------------------------------------------------ seller

const CATALOG = {
  "sunday-shift.json": { price: 0.25, body: () => Buffer.from(JSON.stringify({ shift: "Sunday 16 November 2026, on-call pharmacy", hours: 9.5, rate_eur: 49.11, net_eur: 466.57, computed_by: "dareskro code, line by line" }, null, 2)) },
  "invoice-dossier.json": { price: 0.4, body: () => Buffer.from(JSON.stringify({ invoice: "F-001", debtor: "d1", face: 50, checks: ["registry", "delivery note", "no duplicate"], verdict: "eligible" }, null, 2)) },
};

/**
 * `reveal`: "honest" publishes the key right after the lock; "silent" never does;
 * "wrong" tries a wrong key first (the program refuses it), then stays silent.
 */
export function startSeller({ port = S_PORT, reveal = "honest", refundAfterSeconds = 600 } = {}) {
  const settings = { reveal, refundAfterSeconds }; // changeable while running, for the measurement
  const seller = keyFile("vendeur");
  const mint = new PublicKey(state().mint);
  const facilitator = new HTTPFacilitatorClient({ url: `http://localhost:${F_PORT}` });
  const offers = new Map(); // nonce -> { key, blob, requirements }
  const blobs = new Map();  // nonce -> encrypted file, served to anyone, before and after the sale
  const releases = [];
  let feePayer = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    try {
      const sealed = url.pathname.match(/^\/sealed\/([0-9a-f]{32})$/);
      if (sealed) { const b = blobs.get(sealed[1]); if (!b) return reply(res, 404, {}); res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(b); }
      const m = url.pathname.match(/^\/files\/([\w.-]+)$/);
      const item = m && CATALOG[m[1]];
      if (!item) return reply(res, 404, { error: "no such file" });
      const header = req.headers["payment-signature"];
      if (!header) {
        if (!feePayer) { const sup = await facilitator.getSupported(); feePayer = sup.kinds.find((k) => k.scheme === SCHEME)?.extra?.feePayer; }
        const nonce = randomBytes(16).toString("hex");
        const { key, condition, blob, blobSha256 } = seal(item.body());
        const requirements = {
          scheme: SCHEME, network: NETWORK, asset: mint.toBase58(), amount: unit(item.price), payTo: seller.publicKey.toBase58(), maxTimeoutSeconds: 120,
          extra: { program: PROGRAM_ID.toBase58(), feePayer, condition, refundAfterSeconds: settings.refundAfterSeconds, nonce, ciphertext: `http://localhost:${port}/sealed/${nonce}`, ciphertextSha256: blobSha256, memo: `x402 ${m[1]}` },
        };
        offers.set(nonce, { key, blob, requirements, name: m[1] });
        blobs.set(nonce, blob);
        const body = { x402Version: 2, error: "payment required", resource: { url: url.href, description: `${m[1]}, encrypted; paid by locking the price in a dareskro escrow that only its key can release`, mimeType: "application/json" }, accepts: [requirements] };
        return reply(res, 402, body, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body) });
      }
      const payload = decodePaymentSignatureHeader(header);
      const offer = offers.get(payload?.accepted?.extra?.nonce);
      if (!offer || !deepEqual(payload.accepted, offer.requirements)) return reply(res, 402, { x402Version: 2, error: "these are not the terms offered" });
      const v = await facilitator.verify(payload, offer.requirements);
      if (!v.isValid) return reply(res, 402, { x402Version: 2, error: `${v.invalidReason}: ${v.invalidMessage}` });
      const s = await facilitator.settle(payload, offer.requirements);
      if (!s.success) return reply(res, 402, { x402Version: 2, error: `${s.errorReason}: ${s.errorMessage}` });
      offers.delete(payload.accepted.extra.nonce);
      // the money is locked; now the seller is paid only by publishing the key
      const escrow = s.extra?.escrow ?? payload.payload.escrow;
      const out = { escrow, locked: s.transaction };
      Object.defineProperty(out, "key", { value: offer.key, enumerable: false }); // kept by the seller, never sent
      if (settings.reveal === "wrong") {
        out.wrongKey = await release(escrow, randomBytes(32)).catch((e) => `refused: ${anchorError(e)}`);
      }
      if (settings.reveal === "honest") out.released = await release(escrow, offer.key);
      releases.push(out);
      const body = settings.reveal === "honest"
        ? { file: offer.name, escrow, locked: s.transaction, released: out.released, key: offer.key.toString("hex"), note: "the same key is now in the escrow account on chain" }
        : { file: offer.name, escrow, locked: s.transaction, note: "locked; the key will follow" };
      return reply(res, 200, body, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(s) });
    } catch (e) {
      console.error(e);
      return reply(res, 500, { error: e.message });
    }
  });

  async function release(escrow, key) {
    const { program } = await connect({ keypair: seller });
    return program.methods
      .finishToken(key)
      .accountsPartial({
        caller: seller.publicKey, escrow: new PublicKey(escrow), mint, vault: vaultAddress(new PublicKey(escrow)),
        destinationToken: getAssociatedTokenAddressSync(mint, seller.publicKey),
        ownerAccount: (await program.account.escrow.fetch(new PublicKey(escrow))).owner, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }
  server.releases = releases;
  server.settings = settings;
  server.release = release;
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

export const anchorError = (e) => e?.error?.errorCode?.code ?? (e?.logs ?? e?.transactionLogs ?? []).find?.((l) => /Error Code/.test(l))?.match(/Error Code: (\w+)/)?.[1] ?? String(e?.message ?? e).split("\n")[0];

// ------------------------------------------------------------------ agent (the buyer)

export async function buy(name, { limits = {}, tamper = null, signer = keyFile("agent"), replayOf = null } = {}) {
  const scheme = new DareskroEscrowClient({ signer, limits, tamper });
  // x402's own spend controls, before ours: this asset only, at most 1 test dollar a payment
  const client = new x402HTTPClient(x402Client.fromConfig({
    schemes: [{ network: NETWORK, client: scheme }],
    spendControls: { allowedAssets: [{ network: NETWORK, asset: state().mint, maxAmountPerPayment: limits.maxAmount ?? unit(1) }] },
  }));
  const url = `http://localhost:${S_PORT}/files/${name}`;
  const r1 = await fetch(url);
  if (r1.status !== 402) return { status: r1.status, step: "no 402" };
  const required = client.getPaymentRequiredResponse((n) => r1.headers.get(n), await r1.json());
  const req = required.accepts[0];
  // the encrypted file first, free: the key the agent pays for must open exactly this
  const blob = Buffer.from(await (await fetch(req.extra.ciphertext)).arrayBuffer());
  if (sha256hex(blob) !== req.extra.ciphertextSha256) return { status: "not paid", step: "agent rails", reason: "the encrypted file is not the one in the terms", requirements: req };
  let payload;
  if (replayOf) payload = replayOf;
  else {
    try { payload = await client.createPaymentPayload(required); }
    catch (e) { return { status: "not paid", step: "agent rails", reason: e.message, requirements: req }; }
  }
  const r2 = await fetch(url, { headers: client.encodePaymentSignatureHeader(payload) });
  const body = await r2.json();
  const out = { status: r2.status, body, requirements: req, payload, blob, escrow: scheme.last?.escrow, cancelAfter: scheme.last?.cancelAfter };
  if (r2.status === 200) out.paymentResponse = decodePaymentResponseHeader(r2.headers.get("payment-response"));
  return out;
}

/** The buyer never needs the seller's word: it reads the key from the escrow account. */
export async function collect(escrow, blob, condition) {
  const { program } = await connect({ keypair: keyFile("agent") });
  const e = await program.account.escrow.fetch(new PublicKey(escrow));
  const status = Object.keys(e.status)[0];
  if (status !== "finished") return { status };
  const key = Buffer.from(e.fulfillment);
  if (sha256hex(key) !== condition) return { status, error: "key does not match the condition" };
  return { status, key: key.toString("hex"), file: JSON.parse(open(blob, key).toString("utf8")) };
}

export async function refund(escrow) {
  const agent = keyFile("agent");
  const { program } = await connect({ keypair: agent });
  const e = await program.account.escrow.fetch(new PublicKey(escrow));
  return program.methods
    .cancelToken()
    .accountsPartial({ caller: agent.publicKey, escrow: new PublicKey(escrow), mint: e.mint, vault: vaultAddress(new PublicKey(escrow)),
      ownerToken: getAssociatedTokenAddressSync(e.mint, agent.publicKey), ownerAccount: agent.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();
}

// ------------------------------------------------------------------ measure

async function balances() {
  const { connection } = await connect({ keypair: loadKeypair() });
  const mint = new PublicKey(state().mint);
  const tok = async (k) => dollars((await getAccount(connection, getAssociatedTokenAddressSync(mint, k.publicKey))).amount);
  const fac = loadKeypair();
  return {
    agent: await tok(keyFile("agent")), seller: await tok(keyFile("vendeur")),
    agentSol: (await connection.getBalance(keyFile("agent").publicKey)) / LAMPORTS_PER_SOL,
    facilitatorSol: (await connection.getBalance(fac.publicKey)) / LAMPORTS_PER_SOL,
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure() {
  const fac = await startFacilitator();
  const cases = [];
  const rec = (name, data) => { cases.push({ name, ...data }); };
  const seller = await startSeller({ reveal: "honest" });
  const t0 = await balances();
  say(`balances before: ${JSON.stringify(t0)}`);

  say("\n1. honest sale: 402, lock, the seller publishes the key, the agent reads it on chain");
  const a = await buy("sunday-shift.json", { limits: { maxAmount: unit(1) } });
  say(`  HTTP ${a.status}; escrow ${a.body.escrow}; lock ${a.body.locked}; release ${a.body.released}`);
  const got = await collect(a.body.escrow, a.blob, a.requirements.extra.condition);
  say(`  read from chain: status ${got.status}, key ${got.key?.slice(0, 16)}…, file net_eur = ${got.file?.net_eur}`);
  rec("honest sale", { http: a.status, escrow: a.body.escrow, lock: a.body.locked, release: a.body.released, keyFromChain: got.key, keyFromSeller: a.body.key, file: got.file, paymentResponse: a.paymentResponse });
  const t1 = await balances();
  say(`  balances: ${JSON.stringify(t1)}`);

  say("\n2. the agent's own rails: the seller wants the money locked 2 hours, the agent accepts 1 hour at most");
  Object.assign(seller.settings, { refundAfterSeconds: 7200 });
  const b = await buy("sunday-shift.json");
  say(`  ${b.status}: ${b.reason}`);
  rec("agent refuses a long lock", { result: b.status, reason: b.reason });
  Object.assign(seller.settings, { refundAfterSeconds: 600 });

  const tampers = [
    ["lock for someone else", { destination: Keypair.generate().publicKey.toBase58() }],
    ["lock less than the price", { amount: unit(0.1) }],
    ["lock under a condition the seller did not set", { condition: sha256hex(randomBytes(32)) }],
    ["slip in a transfer from the facilitator's key", { extraInstruction: (feePayer, owner) => SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: owner, lamports: 1_000_000 }) }],
  ];
  let n = 3;
  for (const [label, tamper] of tampers) {
    say(`\n${n++}. a modified payment: ${label}`);
    const r = await buy("invoice-dossier.json", { tamper });
    say(`  HTTP ${r.status}: ${r.body?.error}`);
    rec(label, { http: r.status, error: r.body?.error });
    await sleep(1500);
  }

  say(`\n${n++}. replay: the payment of case 1 sent again, to the seller, then straight to the facilitator`);
  const rp = await buy("sunday-shift.json", { replayOf: a.payload });
  say(`  seller: HTTP ${rp.status}: ${rp.body?.error}`);
  const direct = await (await fetch(`http://localhost:${F_PORT}/settle`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: a.payload, paymentRequirements: a.requirements }) })).json();
  say(`  facilitator: ${direct.success ? "SETTLED" : `${direct.errorReason}: ${direct.errorMessage}`}`);
  rec("replay", { seller: `${rp.status} ${rp.body?.error}`, facilitator: direct.success ? "settled" : `${direct.errorReason}: ${direct.errorMessage}` });

  say(`\n${n++}. a seller that takes the lock, tries a wrong key, then stays silent: refund after 45 s`);
  Object.assign(seller.settings, { reveal: "wrong", refundAfterSeconds: 45 });
  const c = await buy("invoice-dossier.json");
  say(`  HTTP ${c.status}; escrow ${c.body.escrow}; lock ${c.body.locked}`);
  const wrong = seller.releases.at(-1)?.wrongKey;
  say(`  the seller's wrong key: ${wrong}`);
  const early = await refund(c.body.escrow).catch((e) => `refused: ${anchorError(e)}`);
  say(`  the agent asks for its money back at once: ${early}`);
  const wait = c.cancelAfter - (await chainNow((await connect({ keypair: loadKeypair() })).connection)) + 3;
  say(`  waiting ${wait} s for the refund date`);
  await sleep(Math.max(wait, 0) * 1000);
  const lateKey = await seller.release(c.body.escrow, seller.releases.at(-1).key).catch((e) => `refused: ${anchorError(e)}`);
  say(`  after the date, the seller sends the RIGHT key: ${lateKey}`);
  const back = await refund(c.body.escrow).catch((e) => `refused: ${anchorError(e)}`);
  say(`  refund: ${back}`);
  rec("silent seller, refund", { http: c.status, escrow: c.body.escrow, lock: c.body.locked, wrongKey: wrong, earlyRefund: early, rightKeyAfterDate: lateKey, refund: back });

  say(`\n${n++}. the agent closes both escrow records and takes their rent back`);
  const agentKey = keyFile("agent");
  const { program: agentProgram } = await connect({ keypair: agentKey });
  const closed = [];
  for (const e of [a.body.escrow, c.body.escrow]) {
    const sig = await agentProgram.methods.close().accountsPartial({ owner: agentKey.publicKey, escrow: new PublicKey(e) }).rpc().catch((x) => `refused: ${anchorError(x)}`);
    say(`  close ${e}: ${sig}`);
    closed.push({ escrow: e, close: sig });
  }
  rec("close", { closed });

  const t2 = await balances();
  say(`\nbalances after: ${JSON.stringify(t2)}`);
  seller.closeAllConnections(); seller.close(); fac.closeAllConnections(); fac.close();
  mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(OUT, `x402_${stamp}.json`);
  writeFileSync(file, JSON.stringify({ when: new Date().toISOString(), network: NETWORK, program: PROGRAM_ID.toBase58(), mint: state().mint, before: t0, afterSale: t1, after: t2, cases }, null, 2));
  appendFileSync(join(OUT, "x402.log"), log.join("\n") + "\n\n");
  say(`\nwritten ${file}`);
}

// ------------------------------------------------------------------ cli

const [cmd, arg] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === "setup") await setup();
  else if (cmd === "facilitator") { await startFacilitator(); console.log(`facilitator on http://localhost:${F_PORT}`); }
  else if (cmd === "seller") { await startSeller(); console.log(`seller on http://localhost:${S_PORT}/files/sunday-shift.json`); }
  else if (cmd === "buy") console.log(JSON.stringify(await buy(arg ?? "sunday-shift.json"), null, 2));
  else if (cmd === "measure") { await measure(); process.exit(0); }
  else console.log("usage: node x402.mjs setup | facilitator | seller | buy <name> | measure");
}
