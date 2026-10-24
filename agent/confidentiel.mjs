#!/usr/bin/env node
// dareskro — selective disclosure of the pay statement.
// The escrow is public (accounts, XRP amount, statement hash in a memo). The statement
// itself is sealed here: AES-256-GCM under a fresh content key, that key wrapped for each
// recipient with X25519 ECDH + HKDF-SHA256 + AES-256-GCM. node:crypto only, no dependency.
// When zk/prove.mjs has run for the same statement, the commitment's opening (the private
// inputs and the nonce) is sealed in the same file under the same content key, so the
// administration opens statement and proof with one key (zk/ouvrir.mjs).
//
//   node agent/confidentiel.mjs --init                        demo keys for employee and administration
//   node agent/confidentiel.mjs --chiffre [--escrow <hash>]   seal agent/sortie/bulletin.json
//
// divulgation.mjs and zk/*.mjs import the helpers exported below; main() runs only when executed directly.

import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
} from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
export const CLES = join(HERE, "cles"); // private keys, 0600, gitignored
export const SORTIE = join(HERE, "sortie");
export const BULLETIN = join(SORTIE, "bulletin.json");
export const CHIFFRE = join(SORTIE, "bulletin.chiffre.json");
export const CHIFFRE_PUBLIC = join(ROOT, "app", "public", "bulletin.chiffre.json");
export const CLES_PUBLIQUES = join(SORTIE, "cles_publiques.json");
export const ZK_PUBLIC_INPUTS = join(ROOT, "zk", "sortie", "public_inputs.json");
export const ZK_WITNESS = join(ROOT, "zk", ".witness", "witness.json");
export const ROLES = ["employee", "administration"];
export const VERSION = "dareskro/confidential-statement.v1";
export const HKDF_INFO = "dareskro/bulletin/v1";
export const RPC = "https://s.altnet.rippletest.net:51234";
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
export const publicKeyFromRaw = (raw) => createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
export const rawPublic = (keyObject) => keyObject.export({ type: "spki", format: "der" }).subarray(-32);
export function loadPrivateKey(role) {
  const p = keyPath(role);
  if (!existsSync(p)) throw new UsageError(`no private key for "${role}" at ${rel(p)}: run node agent/confidentiel.mjs --init`);
  return createPrivateKey(readFileSync(p, "utf8"));
}

// --- key wrapping: KEK = HKDF-SHA256(ECDH(ephemeral, recipient), salt = epk || pk, info) ---
// The salt binds the derived key to both public keys, the info to this protocol version.
// One ephemeral key per recipient per statement: two statements never share a KEK.
const kek = (shared, epkRaw, pkRaw) => Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epkRaw, pkRaw]), HKDF_INFO, 32));
export function wrapKey(contentKey, recipientRaw) {
  const eph = generateKeyPairSync("x25519");
  const epkRaw = rawPublic(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyFromRaw(recipientRaw) });
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek(shared, epkRaw, recipientRaw), iv, GCM);
  const wrapped = Buffer.concat([c.update(contentKey), c.final()]);
  return { epk: b64(epkRaw), iv: b64(iv), wrapped: b64(wrapped), tag: b64(c.getAuthTag()) };
}
export function unwrapKey(block, privateKey) {
  const epkRaw = unb64(block.epk);
  const pkRaw = rawPublic(createPublicKey(privateKey));
  const shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(epkRaw) });
  const d = createDecipheriv("aes-256-gcm", kek(shared, epkRaw, pkRaw), unb64(block.iv), GCM);
  d.setAuthTag(unb64(block.tag));
  return Buffer.concat([d.update(unb64(block.wrapped)), d.final()]); // throws when the tag does not authenticate
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
export const decryptOpening = (file, contentKey) => open(file.zk.opening, contentKey, openingAad(file));

// ------------------------------------------------------------------ commands

function init() {
  mkdirSync(CLES, { recursive: true, mode: 0o700 });
  chmodSync(CLES, 0o700);
  const recipients = {};
  for (const role of ROLES) {
    const p = keyPath(role);
    if (existsSync(p)) {
      console.log(`kept    ${rel(p)}`);
    } else {
      const { privateKey } = generateKeyPairSync("x25519");
      writeFileSync(p, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      console.log(`created ${rel(p)} (x25519, 0600, gitignored)`);
    }
    chmodSync(p, 0o600);
    recipients[role] = { x25519_public_b64: b64(rawPublic(createPublicKey(readFileSync(p, "utf8")))) };
  }
  const pub = {
    version: "dareskro/confidential-keys.v1",
    curve: "x25519",
    kdf: `HKDF-SHA256, info "${HKDF_INFO}", salt = ephemeral pk || recipient pk`,
    wrap: "AES-256-GCM",
    note: "demo keys. Whoever is listed here reads every statement sealed afterwards. In production the administration's key is pinned (its fingerprint in the pay desk) or signed, the employee's stays on their device, and --chiffre refuses recipients outside employee/administration (it already does).",
    recipients,
  };
  writeFileSync(CLES_PUBLIQUES, JSON.stringify(pub, null, 2) + "\n");
  console.log(`public keys -> ${rel(CLES_PUBLIQUES)} (${Object.keys(recipients).join(", ")})`);
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

  if (!existsSync(CLES_PUBLIQUES)) throw new UsageError(`${rel(CLES_PUBLIQUES)} missing: run node agent/confidentiel.mjs --init`);
  const pubs = JSON.parse(readFileSync(CLES_PUBLIQUES, "utf8")).recipients;
  const strangers = Object.keys(pubs).filter((r) => !ROLES.includes(r));
  if (strangers.length) throw Object.assign(new Error(`${rel(CLES_PUBLIQUES)} lists recipients outside ${ROLES.join("/")}: ${strangers.join(", ")}; not sealing for them`), { code: 1 });

  const opening = zkOpening(sha);
  const contentKey = randomBytes(32);
  const plain = Buffer.concat([raw, Buffer.alloc((PAD_TO - (raw.length % PAD_TO)) % PAD_TO, 0x20)]);
  const file = { version: VERSION, sha256_plain: sha, escrow: escrow ?? null };
  Object.assign(file, {
    cipher: "AES-256-GCM",
    aad: "canonical JSON of {escrow, sha256_plain, version}",
    padding: `spaces to a ${PAD_TO}-byte multiple`,
    ...seal(contentKey, plain, aad(file)),
    recipients: {},
  });
  if (opening) {
    file.zk = { commitment: opening.commitment, aad: "canonical JSON of {commitment, sha256_plain, version}", opening: null };
    file.zk.opening = seal(contentKey, opening.plain, openingAad(file));
  }
  for (const [role, { x25519_public_b64 }] of Object.entries(pubs)) file.recipients[role] = wrapKey(contentKey, unb64(x25519_public_b64));
  contentKey.fill(0); // nothing else needs it: the wrapped copies are the only ones that remain

  const out = JSON.stringify(file, null, 2) + "\n";
  writeFileSync(CHIFFRE, out);
  copyFileSync(CHIFFRE, CHIFFRE_PUBLIC);
  const ms = (performance.now() - t0).toFixed(1);

  console.log(`sealed ${rel(BULLETIN)}: ${fmtBytes(raw.length)} plain -> ${fmtBytes(out.length)} file, ${Object.keys(pubs).length} recipients, ${ms} ms`);
  console.log(`       -> ${rel(CHIFFRE)}  and  ${rel(CHIFFRE_PUBLIC)}`);
  console.log("what the public sees in that file:");
  console.log(`  version       ${file.version}`);
  console.log(`  sha256_plain  ${sha}  (= the escrow memo)`);
  console.log(`  escrow        ${escrow ?? "(not bound)"}`);
  console.log(`  ciphertext    ${fmtBytes(plain.length)}, iv 12, tag 16  (statement padded to ${PAD_TO} bytes: a size class, content opaque)`);
  console.log(`  zk opening    ${opening ? `${fmtBytes(opening.plain.length)} sealed under the same key, commitment ${opening.commitment.slice(0, 18)}... in clear (it is public already)` : "none (zk/prove.mjs has not run for this statement)"}`);
  console.log(`  recipients    ${Object.keys(file.recipients).join(", ")}: ephemeral pk 32, wrapped key 32, tag 16 each`);
  console.log("  nothing else: no name, no hours, no coefficient, no lines, no amount, no nonce.");
}

function usage(code) {
  console.error("usage: node agent/confidentiel.mjs --init | --chiffre [--escrow <EscrowCreate hash>]");
  process.exit(code);
}

async function main() {
  try {
    const [doInit, doChiffre] = ["--init", "--chiffre"].map((f) => process.argv.includes(f));
    if (doInit && !doChiffre) init();
    else if (doChiffre && !doInit) await chiffre();
    else usage(2); // none, or both: the caller must say which one
  } catch (e) {
    console.error(e instanceof UsageError ? `usage: ${e.message}` : e.message);
    process.exit(e instanceof UsageError ? 2 : (e.code ?? 1));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
