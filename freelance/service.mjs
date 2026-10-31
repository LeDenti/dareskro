#!/usr/bin/env node
/**
 * The freelance desk: a small HTTP service the CLIENT runs (or we host for it),
 * with two screens and an API.
 *
 *   /            the client's desk: create a mission, lock each milestone on the
 *                XRP Ledger, watch the oracle, accept or let expire
 *   /m/<token>   the freelancer's link: what to deliver, where, before when, the
 *                escrow on the explorer, what the address will receive and when.
 *                The freelancer needs an XRPL address, nothing else.
 *
 * Money never passes through here. The desk builds EscrowCreate transactions;
 * the CLIENT signs them — with the key it keeps itself (`.client.json`, 0600,
 * written by the client, never by us; on testnet the desk can ask the faucet
 * for one), or anywhere else: the desk hands out the unsigned transaction and
 * takes back a signed blob. The oracle (oracle/oracle.mjs) holds the secret of
 * the condition and reveals it on proof; the ledger refunds at CancelAfter.
 *
 * Environment: FREELANCE_PORT (8781), ORACLE_URL (http://127.0.0.1:8787),
 * XRPL_WSS (wss://testnet.xrpl-labs.com), PUBLIC_BASE_URL (for share links),
 * FREELANCE_BIND (127.0.0.1), FREELANCE_ALLOW_PRIVATE=1 (verify 127.0.0.1 URLs,
 * demos only).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Wallet, decode, xrpToDrops } from "xrpl";
import { PROOF_MODES, freelancerView, fromRippleTime, memosFor, milestoneView, newMission, totalXrp } from "./mission.mjs";
import { DEFAULTS as VERIFY_DEFAULTS, observe, journal, readJournal } from "./verifier.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FREELANCE_PORT || 8781);
const BIND = process.env.FREELANCE_BIND || "127.0.0.1";
const ORACLE = (process.env.ORACLE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const XRPL_WSS = process.env.XRPL_WSS || "wss://testnet.xrpl-labs.com";
const NETWORK = process.env.XRPL_NETWORK || (XRPL_WSS.includes("altnet") || XRPL_WSS.includes("testnet") ? "testnet" : "mainnet");
const EXPLORER = process.env.XRPL_EXPLORER || (NETWORK === "testnet" ? "https://testnet.xrpl.org" : "https://livenet.xrpl.org");
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const STORE = path.join(HERE, ".missions.json");
const CLIENT_KEY = path.join(HERE, ".client.json");
const PUBLIC_DIR = path.join(HERE, "public");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const explorerTx = (h) => `${EXPLORER}/transactions/${h}`;
const explorerAccount = (a) => `${EXPLORER}/accounts/${a}`;

// ------------------------------------------------------------------ ledger
let client;
async function ledger() {
  if (client && !client.isConnected()) {
    try { await client.disconnect(); } catch { /* gone */ }
    client = undefined;
  }
  if (!client) client = new Client(XRPL_WSS);
  if (!client.isConnected()) await client.connect();
  return client;
}
/** The testnet websocket drops now and then: reconnect and retry once. */
async function onLedger(fn) {
  try {
    return await fn(await ledger());
  } catch (e) {
    if (!/websocket|not connected|NotConnected|closed/i.test(String(e?.message ?? e))) throw e;
    try { await client?.disconnect(); } catch { /* ignore */ }
    client = undefined;
    return fn(await ledger());
  }
}
const txResult = (res) => (typeof res.result.meta === "object" ? res.result.meta.TransactionResult : String(res.result.meta ?? "?"));

// ------------------------------------------------------------------- store
const loadStore = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { missions: [] });
function saveStore(s) {
  const tmp = STORE + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STORE);
}
/** Load, mutate, save: the HTTP handlers are sequential enough for a desk, and the file is rewritten whole. */
function withStore(fn) {
  const s = loadStore();
  const r = fn(s);
  saveStore(s);
  return r;
}
const findMission = (s, id) => s.missions.find((m) => m.id === id);

// -------------------------------------------------------------- client key
/** The client's own signing key, kept by the client in a 0600 file. The API never returns the seed. */
function loadClientKey() {
  if (!existsSync(CLIENT_KEY)) return null;
  try {
    const k = JSON.parse(readFileSync(CLIENT_KEY, "utf8"));
    const w = k.seed ? Wallet.fromSeed(k.seed) : null;
    if (!w) return null;
    return { wallet: w, address: w.classicAddress, network: k.network ?? NETWORK, created: k.created };
  } catch (e) {
    log("client key unreadable:", e.message);
    return null;
  }
}

// ------------------------------------------------------------------ oracle
async function oracleGet(p) {
  const r = await fetch(ORACLE + p, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`oracle ${p}: HTTP ${r.status}`);
  return r.json();
}
async function oraclePost(p, body) {
  const r = await fetch(ORACLE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  let j = {};
  try { j = await r.json(); } catch { /* no body */ }
  return { status: r.status, ok: r.ok, json: j };
}
async function oracleIdentity() {
  try { return await oracleGet("/identity"); } catch { return null; }
}
async function oracleRegistry() {
  try { return (await oracleGet("/escrows")).escrows ?? []; } catch { return []; }
}

// -------------------------------------------------------------------- rate
/** Fiat per XRP (Kraken, CoinGecko as fallback), as the pay desk does. */
async function rate(currency = "EUR") {
  const cur = String(currency).toUpperCase() === "USD" ? "USD" : "EUR";
  try {
    const j = await (await fetch(`https://api.kraken.com/0/public/Ticker?pair=XRP${cur}`, { signal: AbortSignal.timeout(6000) })).json();
    const pair = j.result && Object.values(j.result)[0];
    if (pair?.c?.[0]) return { fiatPerXrp: Number(pair.c[0]), currency: cur, source: `Kraken XRP/${cur}`, at: new Date().toISOString() };
  } catch { /* fall through */ }
  const j = await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=${cur.toLowerCase()}`, { signal: AbortSignal.timeout(6000) })).json();
  const v = j.ripple?.[cur.toLowerCase()];
  if (!v) throw new Error(`no XRP/${cur} rate available`);
  return { fiatPerXrp: v, currency: cur, source: `CoinGecko XRP/${cur}`, at: new Date().toISOString() };
}

// ------------------------------------------------------------------- views
const ledgerCache = new Map();
/** Is the escrow still on the ledger? Cached 15 s: the screens poll every few seconds. */
async function onLedgerStill(owner, sequence) {
  const k = `${owner}#${sequence}`;
  const c = ledgerCache.get(k);
  // a positive answer is kept 15 s; a negative or unknown one only 3 s (a node can lag a ledger behind a fresh lock)
  if (c && Date.now() - c.at < (c.value.exists ? 15000 : 3000)) return c.value;
  let value;
  try {
    const r = await onLedger((c) => c.request({ command: "ledger_entry", escrow: { owner, seq: sequence }, ledger_index: "validated" }));
    value = { exists: true, amountXrp: String(Number(r.result.node.Amount) / 1e6), destination: r.result.node.Destination, cancelAfter: r.result.node.CancelAfter };
  } catch (e) {
    value = e?.data?.error === "entryNotFound" ? { exists: false } : { unknown: true, error: String(e?.message ?? e) };
  }
  ledgerCache.set(k, { at: Date.now(), value });
  return value;
}

async function missionViews(m, registry) {
  const views = [];
  for (const ms of m.milestones) {
    const w = ms.escrow ? registry.find((e) => e.owner === ms.escrow.owner && e.sequence === ms.escrow.sequence) : undefined;
    const v = milestoneView(ms, w); // the client's view keeps the unsigned transactions: what is read is what is signed
    if (ms.escrow) v.ledger = await onLedgerStill(ms.escrow.owner, ms.escrow.sequence);
    if (ms.condition?.deliveryId) v.journal = readJournal(ms.condition.deliveryId, { last: 12 });
    views.push(v);
  }
  return views;
}
async function clientView(m, registry) {
  const views = await missionViews(m, registry);
  return { ...m, milestones: views, totalXrp: totalXrp(m), shareUrl: `${PUBLIC_BASE}/m/${m.shareToken}`, explorer: EXPLORER };
}

// --------------------------------------------------------------- handlers
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const need = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };

function milestoneOf(store, id, mid) {
  const m = findMission(store, id);
  need(m, 404, "unknown mission");
  const ms = m.milestones.find((x) => x.id === mid);
  need(ms, 404, "unknown milestone");
  return { m, ms };
}

/** Ask the oracle for the condition and build the unsigned EscrowCreate. */
async function prepare(id, mid) {
  const { m, ms } = milestoneOf(loadStore(), id, mid);
  need(["draft", "prepared"].includes(ms.status), 409, `milestone is ${ms.status}`);
  need(ms.cancelAfter > Math.floor(Date.now() / 1000) - 946684800 + 60, 409, "the deadline is less than a minute away: edit the mission");
  const oracle = await oracleIdentity();
  need(oracle, 503, `no oracle at ${ORACLE}: a conditional escrow needs one (cd oracle && node oracle.mjs watch)`);
  const note = `freelance desk · ${m.title} · ${ms.title}`;
  const body = ms.proof.mode === "hash"
    ? { kind: "delivery", url: ms.proof.url, sha256: ms.proof.sha256, note }
    : { kind: "acceptance", acceptBy: m.client, url: ms.proof.url, note };
  const cond = await oraclePost("/condition", body);
  need(cond.ok, 502, `oracle /condition: ${cond.status} ${cond.json.error ?? ""}`);
  const tx = await onLedger((c) => c.autofill({
    TransactionType: "EscrowCreate",
    Account: m.client,
    Destination: m.freelancer,
    Amount: xrpToDrops(ms.amountXrp),
    Condition: cond.json.condition,
    CancelAfter: ms.cancelAfter,
    Memos: memosFor(m, ms, oracle.address).map((x) => ({ Memo: { MemoType: Buffer.from(x.type).toString("hex").toUpperCase(), MemoData: Buffer.from(x.data).toString("hex").toUpperCase(), MemoFormat: Buffer.from("text/plain").toString("hex").toUpperCase() } })),
  }));
  // autofill gives about a minute; an external signer needs time to read: ten minutes
  tx.LastLedgerSequence = (await onLedger((c) => c.getLedgerIndex())) + 150;
  return withStore((s) => {
    const { ms: live } = milestoneOf(s, id, mid);
    live.condition = { deliveryId: cond.json.deliveryId, condition: cond.json.condition, proof: cond.json.proof, oracle: oracle.address, issuedAt: new Date().toISOString() };
    live.unsignedTx = tx;
    live.status = "prepared";
    live.lastError = undefined;
    return { milestone: live, unsignedTx: tx };
  });
}

/** Fields the client read before signing must be the fields the ledger will hold. */
function sameEscrow(prepared, signed) {
  for (const k of ["TransactionType", "Account", "Destination", "Amount", "Condition", "CancelAfter"]) {
    if (String(prepared[k]) !== String(signed[k])) return `${k} differs between the prepared transaction and the signed one`;
  }
  return null;
}

/** Sign the prepared tx (locally or with the client's blob), submit, hand the escrow to the oracle. */
async function lock(id, mid, body) {
  const { m, ms } = milestoneOf(loadStore(), id, mid);
  need(ms.status === "prepared" && ms.unsignedTx, 409, `milestone is ${ms.status}: prepare it first`);
  let blob;
  if (body.signedTxHex) {
    let signed;
    try { signed = decode(String(body.signedTxHex).trim()); } catch (e) { throw new HttpError(400, `signed blob does not decode: ${e.message}`); }
    const diff = sameEscrow(ms.unsignedTx, signed);
    need(!diff, 400, diff);
    need(signed.TxnSignature || signed.Signers, 400, "the blob carries no signature");
    blob = String(body.signedTxHex).trim();
  } else {
    const key = loadClientKey();
    need(key, 409, "no signing key on this desk (freelance/.client.json): paste a signed blob instead");
    need(key.address === m.client, 409, `this desk's key is ${key.address}; the mission's client is ${m.client}`);
    blob = key.wallet.sign(ms.unsignedTx).tx_blob;
  }
  let res;
  try {
    res = await onLedger((c) => c.submitAndWait(blob));
  } catch (e) {
    withStore((s) => { milestoneOf(s, id, mid).ms.lastError = `submit: ${e.message}`; });
    throw new HttpError(502, `submit failed: ${e.message}`);
  }
  const code = txResult(res);
  const tx = res.result.tx_json ?? res.result;
  const escrow = {
    owner: tx.Account, sequence: tx.Sequence, hash: res.result.hash, result: code, destination: tx.Destination,
    amountXrp: String(Number(tx.Amount) / 1e6), cancelAfter: tx.CancelAfter, ledgerIndex: res.result.ledger_index, lockedAt: new Date().toISOString(),
    signedBy: body.signedTxHex ? "external signer (blob pasted)" : "this desk's key",
  };
  let handed = { ok: false };
  if (code === "tesSUCCESS") {
    const w = await oraclePost("/watch", {
      kind: ms.proof.mode === "hash" ? "delivery" : "acceptance", deliveryId: ms.condition.deliveryId,
      owner: escrow.owner, sequence: escrow.sequence, cancelAfter: escrow.cancelAfter, destination: escrow.destination,
      amountXrp: escrow.amountXrp, proof: ms.condition.proof, createHash: escrow.hash,
    });
    handed = { ok: w.ok, status: w.status, error: w.json.error };
    if (ms.condition.deliveryId) journal(ms.condition.deliveryId, { kind: "lock", escrow: `${escrow.owner}#${escrow.sequence}`, hash: escrow.hash, result: code, amountXrp: escrow.amountXrp, cancelAfter: escrow.cancelAfter, handedToOracle: handed.ok });
  }
  return withStore((s) => {
    const { ms: live } = milestoneOf(s, id, mid);
    live.escrow = escrow;
    live.handed = handed;
    if (code === "tesSUCCESS") {
      live.status = "locked";
      delete live.unsignedTx;
    } else {
      live.status = "draft";
      live.lastError = `EscrowCreate ${code}: nothing locked`;
      delete live.condition;
      delete live.unsignedTx;
    }
    return { milestone: live, explorer: explorerTx(escrow.hash) };
  });
}

/** The acceptance: an AccountSet from the client's account naming the escrow. Unsigned, for any signer. */
async function prepareAccept(id, mid) {
  const { m, ms } = milestoneOf(loadStore(), id, mid);
  need(ms.proof.mode === "acceptance", 409, "this milestone is paid on a file hash, not on your acceptance");
  need(ms.status === "locked" && ms.escrow, 409, `milestone is ${ms.status}`);
  const ref = `${ms.escrow.owner}#${ms.escrow.sequence}`;
  const tx = await onLedger((c) => c.autofill({
    TransactionType: "AccountSet",
    Account: m.client,
    Memos: [
      { Memo: { MemoType: Buffer.from("dareskro/accept").toString("hex").toUpperCase(), MemoData: Buffer.from(ref).toString("hex").toUpperCase(), MemoFormat: Buffer.from("text/plain").toString("hex").toUpperCase() } },
      { Memo: { MemoType: Buffer.from("dareskro/mission").toString("hex").toUpperCase(), MemoData: Buffer.from(`${m.id}/${ms.id}`).toString("hex").toUpperCase() } },
    ],
  }));
  tx.LastLedgerSequence = (await onLedger((c) => c.getLedgerIndex())) + 150;
  return withStore((s) => {
    milestoneOf(s, id, mid).ms.acceptUnsignedTx = tx;
    return { unsignedTx: tx, ref };
  });
}

async function accept(id, mid, body) {
  const { m, ms } = milestoneOf(loadStore(), id, mid);
  need(ms.proof.mode === "acceptance", 409, "this milestone is paid on a file hash, not on your acceptance");
  need(ms.status === "locked" && ms.escrow, 409, `milestone is ${ms.status}`);
  const ref = `${ms.escrow.owner}#${ms.escrow.sequence}`;
  let unsigned = ms.acceptUnsignedTx;
  if (!unsigned) unsigned = (await prepareAccept(id, mid)).unsignedTx;
  let blob;
  if (body.signedTxHex) {
    let signed;
    try { signed = decode(String(body.signedTxHex).trim()); } catch (e) { throw new HttpError(400, `signed blob does not decode: ${e.message}`); }
    need(signed.Account === m.client, 400, `the blob is signed by ${signed.Account}, not by the client ${m.client}`);
    const memos = (signed.Memos ?? []).map((x) => Buffer.from(x.Memo?.MemoData ?? "", "hex").toString("utf8"));
    need(memos.some((d) => d.includes(ref)), 400, `the blob carries no memo naming ${ref}`);
    blob = String(body.signedTxHex).trim();
  } else {
    const key = loadClientKey();
    need(key, 409, "no signing key on this desk (freelance/.client.json): paste a signed blob instead");
    need(key.address === m.client, 409, `this desk's key is ${key.address}; the mission's client is ${m.client}`);
    blob = key.wallet.sign(unsigned).tx_blob;
  }
  const res = await onLedger((c) => c.submitAndWait(blob));
  const code = txResult(res);
  const acceptance = { hash: res.result.hash, result: code, at: new Date().toISOString(), ledgerIndex: res.result.ledger_index, ref };
  if (code === "tesSUCCESS") {
    const o = await oraclePost("/accept", { deliveryId: ms.condition.deliveryId, txHash: acceptance.hash });
    acceptance.oracle = { status: o.status, ...o.json };
    journal(ms.condition.deliveryId, { kind: "acceptance-signed", by: m.client, hash: acceptance.hash, result: code, oracle: acceptance.oracle });
  }
  return withStore((s) => {
    const { ms: live } = milestoneOf(s, id, mid);
    live.acceptance = acceptance;
    delete live.acceptUnsignedTx;
    return { acceptance, explorer: explorerTx(acceptance.hash) };
  });
}

/** Run the verifier now, from the desk, and keep the observation as evidence. Hash mode only. */
async function checkNow(id, mid, who) {
  const { ms } = milestoneOf(loadStore(), id, mid);
  need(ms.proof.mode === "hash", 409, "nothing to fetch: this milestone is paid on the client's acceptance");
  const obs = await observe(ms.proof.url, { expected: ms.proof.sha256, attempts: 1 });
  if (ms.condition?.deliveryId) journal(ms.condition.deliveryId, { kind: "check", by: who, verdict: obs.verdict, why: obs.why, status: obs.status, bytes: obs.bytes, sha256: obs.sha256, hops: obs.hops, etag: obs.headers?.etag, ms: obs.ms });
  return obs;
}

// -------------------------------------------------------------------- http
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
function serveStatic(res, file) {
  const p = path.join(PUBLIC_DIR, file);
  if (!p.startsWith(PUBLIC_DIR) || !existsSync(p)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(readFileSync(p));
}
const readBody = (req) => new Promise((resolve, reject) => {
  let b = "";
  req.on("data", (d) => { b += d; if (b.length > 1e6) reject(new HttpError(413, "body too large")); });
  req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new HttpError(400, `bad JSON: ${e.message}`)); } });
});

async function api(method, url, req) {
  const u = new URL(url, "http://x");
  const parts = u.pathname.split("/").filter(Boolean); // ["api", ...]
  const body = method === "POST" ? await readBody(req) : {};
  const [, a, b, c, d, e] = parts;

  if (method === "GET" && a === "config") {
    const key = loadClientKey();
    let balance = null;
    if (key) {
      try { balance = await onLedger((c) => c.getXrpBalance(key.address)); } catch (err) { balance = err?.data?.error === "actNotFound" ? null : undefined; }
    }
    return [200, {
      network: NETWORK, node: XRPL_WSS, explorer: EXPLORER, publicBase: PUBLIC_BASE, oracleUrl: ORACLE,
      oracle: await oracleIdentity(),
      client: key ? { address: key.address, balance, explorer: explorerAccount(key.address), network: key.network } : null,
      canCreateTestnetAccount: NETWORK === "testnet" && !key,
      proofModes: PROOF_MODES,
      verifier: { maxHops: VERIFY_DEFAULTS.maxHops, maxBytes: VERIFY_DEFAULTS.maxBytes, attempts: VERIFY_DEFAULTS.attempts, allowPrivate: VERIFY_DEFAULTS.allowPrivate },
    }];
  }
  if (method === "GET" && a === "rate") return [200, await rate(u.searchParams.get("currency") ?? "EUR")];
  if (method === "POST" && a === "client" && b === "create") {
    need(NETWORK === "testnet", 403, "the desk creates accounts on testnet only; on mainnet the client brings its own key");
    need(!existsSync(CLIENT_KEY), 409, "a key already exists in freelance/.client.json");
    const { wallet } = await onLedger((c) => c.fundWallet());
    writeFileSync(CLIENT_KEY, JSON.stringify({ address: wallet.classicAddress, publicKey: wallet.publicKey, seed: wallet.seed, network: NETWORK, created: new Date().toISOString(), note: "testnet rehearsal key created by the freelance desk; 0600, never committed" }, null, 2));
    chmodSync(CLIENT_KEY, 0o600);
    log(`client testnet account created: ${wallet.classicAddress} (seed in ${CLIENT_KEY}, 0600)`);
    return [201, { address: wallet.classicAddress, explorer: explorerAccount(wallet.classicAddress) }];
  }
  if (a === "missions" && !b) {
    if (method === "GET") {
      const reg = await oracleRegistry();
      const s = loadStore();
      const out = [];
      for (const m of [...s.missions].reverse()) out.push(await clientView(m, reg));
      return [200, { missions: out }];
    }
    if (method === "POST") {
      const m = newMission(body);
      if (body.currency) {
        try {
          const r = await rate(body.currency);
          for (const ms of m.milestones) ms.fiat = { amount: (Number(ms.amountXrp) * r.fiatPerXrp).toFixed(2), currency: r.currency, rate: r.fiatPerXrp, source: r.source, at: r.at };
        } catch (err) { log("rate unavailable:", err.message); }
      }
      withStore((s) => s.missions.push(m));
      log(`mission ${m.id} created: "${m.title}", ${m.milestones.length} milestone(s), ${totalXrp(m)} XRP, ${m.client} → ${m.freelancer}`);
      return [201, await clientView(m, [])];
    }
  }
  if (a === "missions" && b && !c) {
    need(method === "GET", 405, "GET only");
    const m = findMission(loadStore(), b);
    need(m, 404, "unknown mission");
    return [200, await clientView(m, await oracleRegistry())];
  }
  if (a === "missions" && b && c === "milestones" && d && e) {
    need(method === "POST", 405, "POST only");
    if (e === "prepare") return [200, await prepare(b, d)];
    if (e === "lock") return [200, await lock(b, d, body)];
    if (e === "accept-prepare") return [200, await prepareAccept(b, d)];
    if (e === "accept") return [200, await accept(b, d, body)];
    if (e === "check") return [200, await checkNow(b, d, body.by ?? "desk")];
  }
  if (method === "GET" && a === "share" && b) {
    const m = loadStore().missions.find((x) => x.shareToken === b);
    need(m, 404, "unknown link");
    const views = await missionViews(m, await oracleRegistry());
    const oracle = await oracleIdentity();
    return [200, { ...freelancerView(m, views), explorer: EXPLORER, network: NETWORK, oracle: oracle ? { name: oracle.name, address: oracle.address, explorer: oracle.explorer } : null, proofModes: PROOF_MODES }];
  }
  if (method === "POST" && a === "share" && b && c === "milestones" && d && e === "check") {
    const m = loadStore().missions.find((x) => x.shareToken === b);
    need(m, 404, "unknown link");
    return [200, await checkNow(m.id, d, "freelancer")];
  }
  if (method === "GET" && a === "journal" && b) return [200, { entries: readJournal(b, { last: Number(u.searchParams.get("last") ?? 100) }) }];
  if (method === "GET" && a === "escrows") return [200, { escrows: await oracleRegistry() }];
  throw new HttpError(404, "no such route");
}

const server = createServer(async (req, res) => {
  const json = (status, bodyObj) => {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Cache-Control": "no-store" });
    res.end(JSON.stringify(bodyObj, null, 2));
  };
  try {
    if (req.method === "OPTIONS") return json(204, {});
    const p = req.url.split("?")[0];
    if (p.startsWith("/api/")) {
      const [status, bodyObj] = await api(req.method, req.url, req);
      return json(status, bodyObj);
    }
    if (req.method !== "GET") return json(405, { error: "GET only" });
    if (p === "/" || p === "/index.html") return serveStatic(res, "client.html");
    if (p.startsWith("/m/")) return serveStatic(res, "mission.html");
    if (p.startsWith("/public/")) return serveStatic(res, p.slice("/public/".length));
    return serveStatic(res, p.slice(1));
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) log(`${req.method} ${req.url}: ${err.stack ?? err}`);
    return json(status, { error: err.message ?? String(err) });
  }
});

mkdirSync(PUBLIC_DIR, { recursive: true });
server.listen(PORT, BIND, () => {
  const key = loadClientKey();
  log(`freelance desk on http://${BIND}:${PORT} — ${NETWORK} via ${XRPL_WSS} — oracle ${ORACLE} — share links at ${PUBLIC_BASE}/m/<token>`);
  log(key ? `client key: ${key.address} (${CLIENT_KEY}, the seed stays there)` : `no client key yet (${CLIENT_KEY}): the desk can create a testnet one, or paste signed blobs`);
});
