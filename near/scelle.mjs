#!/usr/bin/env node
/**
 * The sealed payslip — the same scheme as ../agent/confidentiel.mjs on XRPL, with four readers.
 *
 * The clear statement (JSON) is encrypted with AES-256-GCM under a fresh content key; that key
 * is wrapped once per reader with X25519 ECDH + HKDF-SHA256 + AES-256-GCM (wrapKey/unwrapKey are
 * imported from the XRPL module, unchanged). The header (version, sha256 of the clear statement,
 * period, escrow) is authenticated as AAD: edit it and nothing decrypts. The plaintext is padded
 * to a 1 KiB multiple so the ciphertext's length gives a size class, not the statement's size.
 *
 * Readers: employee, urssaf (contributions), retraite (the pension fund), dgfip (the tax office).
 * Demo keys: ./cles/<reader>.key (x25519, 0600, gitignored); public keys in ./cles_publiques.json.
 * In production the administrations' keys are pinned, the employee's stays on their device.
 *
 *   node scelle.mjs init                              demo keys for the four readers
 *   node scelle.mjs seal <bulletin.json> [--escrow 1] [--period 2026-10]   → sealed JSON on stdout
 *   node scelle.mjs open <sealed.json> --as retraite  → the clear statement, or an error
 */
import { createCipheriv, createDecipheriv, createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { b64, rawPublic, unb64, unwrapKey, wrapKey } from '../agent/confidentiel.mjs';

export const READERS = ['employee', 'urssaf', 'retraite', 'dgfip'];
export const VERSION = 'dareskro/sealed-payslip.v1';
const CLES = new URL('./cles/', import.meta.url);
const PUBS = new URL('./cles_publiques.json', import.meta.url);
const PAD_TO = 1024;
const GCM = { authTagLength: 16 };
const canon = (v) => JSON.stringify(v, Object.keys(v).sort());
export const sha256hex = (b) => createHash('sha256').update(b).digest('hex');

export function initKeys() {
  mkdirSync(CLES, { recursive: true });
  const pubs = { curve: 'x25519', note: 'demo keys; whoever is listed here can open every payslip sealed afterwards', readers: {} };
  for (const r of READERS) {
    const f = new URL(`${r}.key`, CLES);
    if (!existsSync(f)) {
      const { privateKey } = generateKeyPairSync('x25519');
      writeFileSync(f, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      chmodSync(f, 0o600);
    }
    const priv = readFileSync(f, 'utf8');
    pubs.readers[r] = b64(rawPublic(createPublicKey(priv)));
  }
  writeFileSync(PUBS, JSON.stringify(pubs, null, 2) + '\n');
  return pubs;
}
const publicKeys = () => JSON.parse(readFileSync(PUBS, 'utf8')).readers;
const privateKey = (r) => {
  const f = new URL(`${r}.key`, CLES);
  if (!existsSync(f)) throw new Error(`no private key for ${r} (${f.pathname})`);
  return readFileSync(f, 'utf8');
};
const aad = (h) => Buffer.from(canon({ version: h.version, sha256_plain: h.sha256_plain, period: h.period, escrow: h.escrow ?? null }), 'utf8');

/** bulletin: the clear statement (object). Returns the sealed file (object), ready to store. */
export function seal(bulletin, { escrow = null, period = bulletin.period ?? null, readers = READERS } = {}) {
  const plain = Buffer.from(JSON.stringify(bulletin), 'utf8');
  const header = { version: VERSION, sha256_plain: sha256hex(plain), period, escrow };
  const padded = Buffer.concat([plain, Buffer.alloc(PAD_TO - (plain.length % PAD_TO || PAD_TO), 0x20)]);
  const contentKey = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', contentKey, iv, GCM);
  c.setAAD(aad(header));
  const ct = Buffer.concat([c.update(padded), c.final()]);
  const pubs = publicKeys();
  const recipients = {};
  for (const r of readers) {
    if (!pubs[r]) throw new Error(`no public key for reader ${r}`);
    recipients[r] = wrapKey(contentKey, unb64(pubs[r]));
  }
  return { ...header, readers, recipients, statement: { ciphertext: b64(ct), iv: b64(iv), tag: b64(c.getAuthTag()) } };
}

/** Open as one reader. Throws if the reader has no capsule or the wrong key. */
export function open(file, reader) {
  const block = file.recipients?.[reader];
  if (!block) throw new Error(`${reader} is not a reader of this payslip`);
  const contentKey = unwrapKey(block, privateKey(reader));
  const d = createDecipheriv('aes-256-gcm', contentKey, unb64(file.statement.iv), GCM);
  d.setAAD(aad(file));
  d.setAuthTag(unb64(file.statement.tag));
  const plain = Buffer.concat([d.update(unb64(file.statement.ciphertext)), d.final()]).toString('utf8').trimEnd();
  if (sha256hex(Buffer.from(plain, 'utf8')) !== file.sha256_plain) throw new Error('sha256 mismatch');
  return JSON.parse(plain);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2);
  const opt = (k) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : undefined; };
  if (cmd === 'init') console.log(JSON.stringify(initKeys(), null, 2));
  else if (cmd === 'seal') console.log(JSON.stringify(seal(JSON.parse(readFileSync(file, 'utf8')), { escrow: opt('escrow') ?? null, period: opt('period') })));
  else if (cmd === 'open') console.log(JSON.stringify(open(JSON.parse(readFileSync(file, 'utf8')), opt('as') || 'employee'), null, 2));
  else { console.error('usage: node scelle.mjs init | seal <bulletin.json> | open <sealed.json> --as <reader>'); process.exit(2); }
}
