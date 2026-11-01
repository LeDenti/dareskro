#!/usr/bin/env node
// dareskro — selective disclosure of the pay statement.
// The escrow is public (accounts, XRP amount, statement hash in a memo). The statement
// itself is sealed here: AES-256-GCM under a fresh content key, that key wrapped for each
// named reader with X25519 ECDH + HKDF-SHA256 + AES-256-GCM. node:crypto only, no dependency.
//
// Readers are named in a versioned directory, agent/lecteurs.json: role, name, X25519 public
// key, key id, date, scope, and — when a key is revoked — the revocation date. Three roles today:
// the employee, the tax and social administration, the pension fund. A reader sees only what
// its scope says: the pension fund opens the statement, not the zero-knowledge opening, which is
// sealed under a second key wrapped for the employee and the administration only.
//
// When zk/prove.mjs has run for the same statement, the commitment's opening (the private
// inputs and the nonce) is sealed in the same file (zk/ouvrir.mjs opens it).
//
//   node agent/confidentiel.mjs --init                            keys for every role missing, directory updated
//   node agent/confidentiel.mjs --chiffre [--escrow <hash>] [--out <file>]   seal agent/sortie/bulletin.json
//   node agent/confidentiel.mjs --revoke <role>                   revoke the role's current key, issue a new one
//
// ENV  DARESKRO_CLES (agent/cles)  DARESKRO_LECTEURS (agent/lecteurs.json)  XRPL_RPC (testnet JSON-RPC)
// divulgation.mjs and zk/*.mjs import the helpers exported below; main() runs only when executed directly.

import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
} from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
export const CLES = process.env.DARESKRO_CLES || join(HERE, "cles"); // private keys, 0600, gitignored
export const LECTEURS = process.env.DARESKRO_LECTEURS || join(HERE, "lecteurs.json"); // public keys, committed
export const SORTIE = join(HERE, "sortie");
export const BULLETIN = join(SORTIE, "bulletin.json");
export const CHIFFRE = join(SORTIE, "bulletin.chiffre.json");
export const CHIFFRE_PUBLIC = join(ROOT, "app", "public", "bulletin.chiffre.json");
export const ZK_PUBLIC_INPUTS = join(ROOT, "zk", "sortie", "public_inputs.json");
export const ZK_WITNESS = join(ROOT, "zk", ".witness", "witness.json");
// The named readers. Scope "statement": the sealed statement. Scope "zk-opening": the commitment's
// opening too (private inputs and nonce), which the pension fund has no use for.
export const READERS = {
  employee: { name: "the employee", scope: ["statement", "zk-opening"] },
  administration: { name: "the tax and social administration (DGFiP, URSSAF)", scope: ["statement", "zk-opening"] },
  retraite: { name: "the pension fund (Agirc-Arrco / CNAV)", scope: ["statement"] },
};
export const ROLES = Object.keys(READERS);
export const VERSION = "dareskro/confidential-statement.v2";
export const VERSIONS_READ = ["dareskro/confidential-statement.v1", VERSION];
export const DIRECTORY_VERSION = "dareskro/readers.v1";
export const HKDF_INFO = "dareskro/bulletin/v1";
export const RPC = process.env.XRPL_RPC || "https://s.altnet.rippletest.net:51234";
export const PAD_TO = 1024; // the ciphertext length then tells the public a size class, not the statement's exact size
// Both memo types the pay desk writes: full (4 memos) and compact (3 memos, real device).
export const HASH_MEMO_TYPES = ["dareskro/statement-sha256", "dareskro/sha256"];
const GCM = { authTagLength: 16 }; // pinned: older runtimes accepted shorter tags on decrypt

export class UsageError extends Error {}
export const rel = (p) => relative(ROOT, p);
export const b64 = (b) => Buffer.from(b).toString("base64");
export const unb64 = (s) => Buffer.from(s, "base64");
// undefined = flag absent; "" = flag given without a value (a usage error for the caller, never a silent default)
export const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? "" : v;
};
export const fmtBytes = (n) => n.toLocaleString("fr-FR").replace(/ | /g, " ") + " bytes";
export const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

// --- the statement's fingerprint: the same canonical form as agent/bulletin_garde.py ---
// Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False) over the
// statement without sha256/status/validation. Re-derived here so a reader with the plaintext
// can recompute the hash the escrow memo carries (checked: 7cad8a6d... for the shipped bulletin).
// Scalars must be strings, booleans or null, as bulletin_garde.py writes them: a JS number
// does not serialize like a Python float (1 vs 1.0), so numbers are refused rather than mishashed.
export function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  if (typeof v === "number") throw new Error("canonical form: statement values must be strings, as bulletin_garde.py writes them (got a number)");
  return JSON.stringify(v);
}
export function empreinte(bulletin) {
  const sans = Object.fromEntries(Object.entries(bulletin).filter(([k]) => !["sha256", "status", "validation"].includes(k)));
  return createHash("sha256").update(canon(sans), "utf8").digest("hex");
}

// --- XRPL testnet, JSON-RPC, read-only ---
export function normHash(h) {
  if (h === undefined) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(h || "")) throw new UsageError(`--escrow expects a 64-hex transaction hash, got "${h ?? ""}"`);
  return h.toUpperCase();
}
export async function fetchTx(hash) {
  const t0 = performance.now();
  let res, result;
  try {
    res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "tx", params: [{ transaction: hash, binary: false }] }),
      signal: AbortSignal.timeout(20_000),
    });
    ({ result } = await res.json());
  } catch (e) {
    throw new Error(`testnet unreachable (${e.cause?.code || e.name}): the binding to the escrow was not checked`);
  }
  if (!result || result.status !== "success") {
    throw new Error(`tx ${hash}: ${result?.error_message || result?.error || `HTTP ${res.status}`}`);
  }
  const tx = result.tx_json || result; // rippled api_version 2 nests the transaction under tx_json
  return { tx, meta: result.meta, validated: result.validated === true, ms: Math.round(performance.now() - t0) };
}
const unhex = (h) => (h ? Buffer.from(h, "hex").toString("utf8") : "");
export function decodeMemos(tx) {
  return (tx.Memos || []).map(({ Memo }) => ({ type: unhex(Memo.MemoType), data: unhex(Memo.MemoData) }));
}
export const memoHash = (memos) => memos.find((m) => HASH_MEMO_TYPES.includes(m.type))?.data?.toLowerCase() ?? null;
export const memoFiat = (memos) => memos.find((m) => m.type === "dareskro/fiat")?.data ?? null;
export const xrp = (drops) => (Number(drops) / 1e6).toFixed(6).replace(/\.?0+$/, "") + " XRP";
export const rippleDate = (t) => new Date((t + 946684800) * 1000).toISOString().replace(".000Z", "Z");

// What a memo gives away that the sealed statement and the proof keep private. Measured on the
// shipped escrow: `dareskro/statement-id` = "garde-2026-10-25-coef600" names the coefficient and
// the shift date. The memo is written by the pay desk (app/src/xrpl.ts from bulletin.statement_id),
// not by this layer; it is reported here so no run of this layer can claim privacy it does not have.
export function leaks(memos) {
  const out = [];
  for (const m of memos) {
    if (m.type === "dareskro/fiat" || HASH_MEMO_TYPES.includes(m.type) || m.type === "dareskro/oracle" || m.type === "dareskro/zk-commitment") continue;
    const coef = /coef(?:ficient)?[ -]?(\d{3,4})/i.exec(m.data);
    if (coef) out.push({ memo: m.type, reveals: "the coefficient", value: coef[1] });
    const date = /\d{4}-\d{2}-\d{2}/.exec(m.data);
    if (date) out.push({ memo: m.type, reveals: "the shift date", value: date[0] });
    const badge = /\b[A-Z]-\d{4}\b/.exec(m.data);
    if (badge) out.push({ memo: m.type, reveals: "a badge number", value: badge[0] });
  }
  return out;
}

// --- keys: X25519, raw 32-byte public keys in JSON, PKCS8 PEM private keys on disk ---
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex"); // RFC 8410 prefix for a raw key
export const keyPath = (role) => join(CLES, `${role}.key`);
export const oldKeyPath = (role, kid) => join(CLES, `${role}.${kid}.key`);
export const publicKeyFromRaw = (raw) => createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
export const rawPublic = (keyObject) => keyObject.export({ type: "spki", format: "der" }).subarray(-32);
// key id: the first 16 hex of SHA-256 of the raw public key. Names a key without being one.
export const kidOf = (raw) => sha256hex(raw).slice(0, 16);
export const kidOfPrivate = (privateKey) => kidOf(rawPublic(createPublicKey(privateKey)));
export const readPrivateKey = (p) => createPrivateKey(readFileSync(p, "utf8"));
// The role's current key, or — when the sealed block names another key id — the retired key kept
// under cles/<role>.<kid>.key (the past stays readable to the key that read it; revocation protects
// what is sealed afterwards). An explicit path (--key) bypasses the directory: the GCM tag then decides.
export function resolveKeyPath(role, kid, explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) throw new UsageError(`no private key at ${explicitPath}`);
    return explicitPath;
  }
  const p = keyPath(role);
  if (!existsSync(p)) throw new UsageError(`no private key for "${role}" at ${rel(p)}: run node agent/confidentiel.mjs --init`);
  const current = kidOfPrivate(readPrivateKey(p));
  if (!kid || current === kid) return p;
  const old = oldKeyPath(role, kid);
  if (existsSync(old)) return old;
  throw new UsageError(`role ${role}: this file was sealed for key ${kid}, the key on disk is ${current} and ${rel(old)} is not kept: a key issued after the sealing does not open it`);
}
export const loadPrivateKey = (role, kid, explicitPath) => readPrivateKey(resolveKeyPath(role, kid, explicitPath));

// --- the readers' directory ---
export function loadDirectory() {
  if (!existsSync(LECTEURS)) throw new UsageError(`${rel(LECTEURS)} missing: run node agent/confidentiel.mjs --init`);
  const d = JSON.parse(readFileSync(LECTEURS, "utf8"));
  if (d.version !== DIRECTORY_VERSION || !Array.isArray(d.readers)) throw new Error(`${rel(LECTEURS)}: not a ${DIRECTORY_VERSION} directory`);
  return d;
}
export const activeReaders = (d) => d.readers.filter((r) => !r.revoked);
export const activeReader = (d, role) => activeReaders(d).find((r) => r.role === role);
function saveDirectory(d) {
  writeFileSync(LECTEURS, JSON.stringify(d, null, 2) + "\n");
}
function emptyDirectory() {
  return {
    version: DIRECTORY_VERSION,
    curve: "x25519",
    kdf: `HKDF-SHA256, info "${HKDF_INFO}", salt = ephemeral pk || reader pk`,
    wrap: "AES-256-GCM",
    kid: "first 16 hex of SHA-256 of the raw public key",
    note: "Who can read the statements sealed after `since` and before `revoked`. Public keys only; each reader generates its own key pair and keeps the private half (the pension fund's key is the pension fund's, never ours). Demo: the three private keys sit in agent/cles/ on one machine. A revoked key still opens what it was given before (nothing can be un-sent); it opens nothing sealed afterwards.",
    readers: [],
  };
}

// --- key wrapping: KEK = HKDF-SHA256(ECDH(ephemeral, reader), salt = epk || pk, info) ---
// The salt binds the derived key to both public keys, the info to this protocol version.
// One ephemeral key per reader per statement: two statements never share a KEK.
const kek = (shared, epkRaw, pkRaw) => Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epkRaw, pkRaw]), HKDF_INFO, 32));
export function wrapKey(contentKey, recipientRaw) {
  const eph = generateKeyPairSync("x25519");
  const epkRaw = rawPublic(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyFromRaw(recipientRaw) });
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek(shared, epkRaw, recipientRaw), iv, GCM);
  const wrapped = Buffer.concat([c.update(contentKey), c.final()]);
  return { kid: kidOf(recipientRaw), epk: b64(epkRaw), iv: b64(iv), wrapped: b64(wrapped), tag: b64(c.getAuthTag()) };
}
export function unwrapKey(block, privateKey) {
  const epkRaw = unb64(block.epk);
  const pkRaw = rawPublic(createPublicKey(privateKey));
  const shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(epkRaw) });
  const d = createDecipheriv("aes-256-gcm", kek(shared, epkRaw, pkRaw), unb64(block.iv), GCM);
  d.setAuthTag(unb64(block.tag));
  return Buffer.concat([d.update(unb64(block.wrapped)), d.final()]); // throws when the tag does not authenticate
}
// The content key for a role, from the file's block and the role's key (current, retired by kid, or --key).
export function contentKeyFor(file, role, explicitKeyPath) {
  const block = file.recipients?.[role];
  if (!block) throw new UsageError(`role ${role}: not a reader of this file (readers: ${Object.keys(file.recipients ?? {}).join(", ")})`);
  return unwrapKey(block, loadPrivateKey(role, block.kid, explicitKeyPath));
}
// The opening key for a role: v2 files wrap it separately for the readers whose scope says so;
// v1 files sealed the opening under the content key.
export function openingKeyFor(file, role, explicitKeyPath) {
  if (!file.zk?.opening) throw new UsageError("this file carries no zk opening");
  if (file.version === VERSIONS_READ[0]) return contentKeyFor(file, role, explicitKeyPath);
  const block = file.zk.recipients?.[role];
  if (!block) throw new UsageError(`role ${role}: not a reader of the zk opening (its scope is the statement only; opening readers: ${Object.keys(file.zk.recipients ?? {}).join(", ")})`);
  return unwrapKey(block, loadPrivateKey(role, block.kid, explicitKeyPath));
}

// The header is authenticated as AAD: editing sha256_plain or escrow in the file breaks decryption.
export const aad = (file) => Buffer.from(canon({ version: file.version, sha256_plain: file.sha256_plain, escrow: file.escrow ?? null }), "utf8");
function seal(contentKey, plain, aadBytes) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", contentKey, iv, GCM);
  c.setAAD(aadBytes);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { ciphertext: b64(ct), iv: b64(iv), tag: b64(c.getAuthTag()) };
}
function open(block, contentKey, aadBytes) {
  const d = createDecipheriv("aes-256-gcm", contentKey, unb64(block.iv), GCM);
  d.setAAD(aadBytes);
  d.setAuthTag(unb64(block.tag));
  return Buffer.concat([d.update(unb64(block.ciphertext)), d.final()]);
}
// The plaintext is bulletin.json's bytes padded with spaces to a PAD_TO multiple (JSON ignores them).
export const decryptStatement = (file, contentKey) => open(file, contentKey, aad(file));
// The zk opening is bound to the statement header and to the public commitment.
export const openingAad = (file) => Buffer.from(canon({ version: file.version, sha256_plain: file.sha256_plain, commitment: file.zk.commitment }), "utf8");
export const decryptOpening = (file, openingKey) => open(file.zk.opening, openingKey, openingAad(file));

// ------------------------------------------------------------------ commands

function newKeyFile(p) {
  const { privateKey } = generateKeyPairSync("x25519");
  writeFileSync(p, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  chmodSync(p, 0o600);
  return privateKey;
}
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// Keys for every role that has none; the directory gains the readers it lacks. Nothing is removed.
function init() {
  mkdirSync(CLES, { recursive: true, mode: 0o700 });
  chmodSync(CLES, 0o700);
  const d = existsSync(LECTEURS) ? loadDirectory() : emptyDirectory();
  for (const role of ROLES) {
    const p = keyPath(role);
    let priv;
    if (existsSync(p)) { priv = readPrivateKey(p); console.log(`kept    ${rel(p)}`); }
    else { priv = newKeyFile(p); console.log(`created ${rel(p)} (x25519, 0600, gitignored)`); }
    chmodSync(p, 0o600);
    const raw = rawPublic(createPublicKey(priv));
    const kid = kidOf(raw);
    const active = activeReader(d, role);
    if (active && active.kid !== kid) throw Object.assign(new Error(`${rel(LECTEURS)} names ${active.kid} as the active key of ${role}, the key on disk is ${kid}: revoke it (--revoke ${role}) or restore the key`), { code: 1 });
    if (!active) {
      d.readers.push({ role, name: READERS[role].name, kid, x25519_public_b64: b64(raw), since: now(), scope: READERS[role].scope });
      console.log(`listed  ${role} (${kid}) in ${rel(LECTEURS)}`);
    }
  }
  saveDirectory(d);
  console.log(`directory ${rel(LECTEURS)}: ${activeReaders(d).map((r) => `${r.role} ${r.kid}`).join(", ")}${d.readers.length > activeReaders(d).length ? `; ${d.readers.length - activeReaders(d).length} revoked` : ""}`);
}

// The role's current key is revoked in the directory and retired on disk (cles/<role>.<kid>.key, so
// what it already received stays readable), a new key is issued and listed. Statements sealed from
// now on wrap their key for the new one only.
function revoke(role) {
  if (!ROLES.includes(role)) throw new UsageError(`--revoke expects one of ${ROLES.join("/")}, got "${role}"`);
  const d = loadDirectory();
  const active = activeReader(d, role);
  if (!active) throw Object.assign(new Error(`${role} has no active key in ${rel(LECTEURS)}`), { code: 1 });
  const p = keyPath(role);
  if (!existsSync(p)) throw new UsageError(`no private key for "${role}" at ${rel(p)}`);
  if (kidOfPrivate(readPrivateKey(p)) !== active.kid) throw Object.assign(new Error(`the key on disk is not ${active.kid}: nothing revoked`), { code: 1 });
  active.revoked = now();
  renameSync(p, oldKeyPath(role, active.kid));
  const priv = newKeyFile(p);
  const raw = rawPublic(createPublicKey(priv));
  d.readers.push({ role, name: READERS[role].name, kid: kidOf(raw), x25519_public_b64: b64(raw), since: active.revoked, scope: READERS[role].scope, replaces: active.kid });
  saveDirectory(d);
  console.log(`revoked ${role} ${active.kid} at ${active.revoked}: key retired to ${rel(oldKeyPath(role, active.kid))}`);
  console.log(`issued  ${role} ${kidOf(raw)} -> ${rel(p)}; listed in ${rel(LECTEURS)}`);
}

// The commitment's opening, when zk/prove.mjs ran for this very statement. Nothing is read from
// it but what the administration needs to recompute the commitment: the five private inputs.
function zkOpening(sha) {
  if (!existsSync(ZK_WITNESS) || !existsSync(ZK_PUBLIC_INPUTS)) return null;
  const witness = JSON.parse(readFileSync(ZK_WITNESS, "utf8"));
  const publicInputs = JSON.parse(readFileSync(ZK_PUBLIC_INPUTS, "utf8"));
  if (witness.statement_sha256 !== sha || publicInputs.statement_sha256 !== sha || witness.commitment !== publicInputs.commitment) {
    throw Object.assign(new Error(`zk/.witness and zk/sortie are not for this statement (statement ${sha.slice(0, 16)}...): run node zk/prove.mjs first, then --chiffre`), { code: 1 });
  }
  return { commitment: publicInputs.commitment, plain: Buffer.from(JSON.stringify({ commitment: publicInputs.commitment, statement_sha256: sha, private_inputs: witness.private_inputs }), "utf8") };
}

async function chiffre() {
  const t0 = performance.now();
  const raw = readFileSync(BULLETIN);
  const bulletin = JSON.parse(raw.toString("utf8"));
  const sha = empreinte(bulletin);
  if (sha !== bulletin.sha256) throw Object.assign(new Error(`${rel(BULLETIN)}: recomputed ${sha} differs from its sha256 field ${bulletin.sha256}`), { code: 1 });

  const escrow = normHash(arg("--escrow"));
  if (escrow) {
    const { tx, validated, ms } = await fetchTx(escrow);
    const mh = memoHash(decodeMemos(tx));
    if (tx.TransactionType !== "EscrowCreate" || !validated) throw Object.assign(new Error(`${escrow} is not a validated EscrowCreate`), { code: 1 });
    if (mh !== sha) throw Object.assign(new Error(`escrow ${escrow} cites ${mh}, the statement hashes to ${sha}: not sealing a statement the escrow does not cite`), { code: 1 });
    console.log(`escrow ${escrow.slice(0, 8)}...: memo hash = statement hash (${ms} ms on testnet)`);
  }

  const d = loadDirectory();
  const readers = activeReaders(d);
  const strangers = readers.filter((r) => !ROLES.includes(r.role));
  if (strangers.length) throw Object.assign(new Error(`${rel(LECTEURS)} lists readers outside ${ROLES.join("/")}: ${strangers.map((r) => r.role).join(", ")}; not sealing for them`), { code: 1 });
  const missing = ROLES.filter((role) => !activeReader(d, role));
  if (missing.length) throw Object.assign(new Error(`${rel(LECTEURS)} has no active key for ${missing.join(", ")}: run node agent/confidentiel.mjs --init`), { code: 1 });
  for (const role of ROLES) if (readers.filter((r) => r.role === role).length > 1) throw Object.assign(new Error(`${rel(LECTEURS)}: two active keys for ${role}; revoke one`), { code: 1 });

  const opening = zkOpening(sha);
  const contentKey = randomBytes(32);
  const openingKey = randomBytes(32);
  const plain = Buffer.concat([raw, Buffer.alloc((PAD_TO - (raw.length % PAD_TO)) % PAD_TO, 0x20)]);
  const file = { version: VERSION, sha256_plain: sha, escrow: escrow ?? null };
  Object.assign(file, {
    cipher: "AES-256-GCM",
    aad: "canonical JSON of {escrow, sha256_plain, version}",
    padding: `spaces to a ${PAD_TO}-byte multiple`,
    directory: { file: rel(LECTEURS), version: d.version },
    ...seal(contentKey, plain, aad(file)),
    recipients: {},
  });
  for (const r of readers) file.recipients[r.role] = wrapKey(contentKey, unb64(r.x25519_public_b64));
  if (opening) {
    file.zk = { commitment: opening.commitment, aad: "canonical JSON of {commitment, sha256_plain, version}", opening: null, recipients: {} };
    file.zk.opening = seal(openingKey, opening.plain, openingAad(file));
    for (const r of readers) if ((r.scope ?? []).includes("zk-opening")) file.zk.recipients[r.role] = wrapKey(openingKey, unb64(r.x25519_public_b64));
  }
  contentKey.fill(0); openingKey.fill(0); // nothing else needs them: the wrapped copies are the only ones that remain

  const out = JSON.stringify(file, null, 2) + "\n";
  const outPath = arg("--out") ? resolve(arg("--out")) : CHIFFRE;
  writeFileSync(outPath, out);
  if (outPath === CHIFFRE) copyFileSync(CHIFFRE, CHIFFRE_PUBLIC);
  const ms = (performance.now() - t0).toFixed(1);

  console.log(`sealed ${rel(BULLETIN)}: ${fmtBytes(raw.length)} plain -> ${fmtBytes(out.length)} file, ${readers.length} readers, ${ms} ms`);
  console.log(`       -> ${rel(outPath)}${outPath === CHIFFRE ? `  and  ${rel(CHIFFRE_PUBLIC)}` : ""}`);
  console.log(`       sealed file sha256 ${sha256hex(out)}`);
  console.log("what the public sees in that file:");
  console.log(`  version       ${file.version}`);
  console.log(`  sha256_plain  ${sha}  (= the escrow memo)`);
  console.log(`  escrow        ${escrow ?? "(not bound)"}`);
  console.log(`  ciphertext    ${fmtBytes(plain.length)}, iv 12, tag 16  (statement padded to ${PAD_TO} bytes: a size class, content opaque)`);
  console.log(`  zk opening    ${opening ? `${fmtBytes(opening.plain.length)} sealed under a second key for ${Object.keys(file.zk.recipients).join(", ")}; commitment ${opening.commitment.slice(0, 18)}... in clear (it is public already)` : "none (zk/prove.mjs has not run for this statement)"}`);
  console.log(`  readers       ${readers.map((r) => `${r.role} (kid ${r.kid})`).join(", ")}: ephemeral pk 32, wrapped key 32, tag 16 each`);
  console.log("  nothing else: no name, no hours, no coefficient, no lines, no amount, no nonce.");
}

function usage(code) {
  console.error("usage: node agent/confidentiel.mjs --init | --chiffre [--escrow <EscrowCreate hash>] [--out <file>] | --revoke <role>");
  process.exit(code);
}

async function main() {
  try {
    const flags = ["--init", "--chiffre", "--revoke"].filter((f) => process.argv.includes(f));
    if (flags.length !== 1) usage(2); // none, or several: the caller must say which one
    if (flags[0] === "--init") init();
    else if (flags[0] === "--chiffre") await chiffre();
    else revoke(arg("--revoke") ?? "");
  } catch (e) {
    console.error(e instanceof UsageError ? `usage: ${e.message}` : e.message);
    process.exit(e instanceof UsageError ? 2 : (e.code ?? 1));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
