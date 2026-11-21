// EU AI Act Article 12 record for the payroll agent, anchored with register_data.
//
// Each decision (proposal computed, human approval, payment, refusal) becomes one entry.
// The entry stays OFF chain, in journal/prive/, together with a truly random 32-byte nonce.
// Only an anchor goes on chain: "DKA12" | version 1 | SHA-256(nonce || entry bytes).
// Erasing the entry and its nonce makes the anchor meaningless, even by brute force
// (GDPR right to erasure), while a regulator handed the entry can recompute the hash
// and find it on chain. Entries are chained: each one carries the previous entry's hash,
// so an entry cannot be dropped or reordered without breaking the chain.
// Method recommended by Concordium in workshop 4 (11 Nov 2026); same idea as our XRPL
// anchor: anchor the fingerprint, never the document.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Transaction, DataBlob } from '@concordium/web-sdk';
import { ICI, COMPTES } from '../config.mjs';

export const PRIVE = join(ICI, 'journal', 'prive');
export const PREFIXE = Buffer.from('DKA12', 'ascii');
export const VERSION = 1;
export const AGENT = { name: 'dareskro payroll agent', version: '0.1.0',
  model: 'none: amounts computed by deterministic code (officine.garde); no model touches the pay' };

const canon = (o) => Buffer.from(JSON.stringify(trie(o)), 'utf8');
function trie(o) { // stable key order so the bytes, hence the hash, never depend on insertion order
  if (Array.isArray(o)) return o.map(trie);
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map((k) => [k, trie(o[k])]));
  return o;
}
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const empreinte = (nonceHex, entree) => sha256(Buffer.concat([Buffer.from(nonceHex, 'hex'), canon(entree)]));
export const ancre = (h) => Buffer.concat([PREFIXE, Buffer.from([VERSION]), Buffer.from(h, 'hex')]);

function entrees() {
  if (!existsSync(PRIVE)) return [];
  return readdirSync(PRIVE).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ ...JSON.parse(readFileSync(join(PRIVE, f), 'utf8')), fichier: join(PRIVE, f) }));
}

// type: 'proposal' | 'human_approval' | 'payment' | 'refusal' | 'error'
export function ecrire(type, details) {
  mkdirSync(PRIVE, { recursive: true });
  const avant = entrees();
  const precedente = avant.length ? avant[avant.length - 1].hash : null;
  const entree = {
    seq: avant.length + 1, at: new Date().toISOString(), type,
    agent: { ...AGENT, account: COMPTES.agent, owner: COMPTES.proprietaire },
    previous: precedente, ...details,
  };
  const nonce = randomBytes(32).toString('hex');
  const hash = empreinte(nonce, entree);
  const nom = `${String(entree.seq).padStart(4, '0')}-${type}.json`;
  writeFileSync(join(PRIVE, nom), JSON.stringify({ entree, nonce, hash }, null, 2) + '\n');
  return { fichier: join(PRIVE, nom), hash, entree };
}

// The register_data transaction for one entry: sent by the agent, fees sponsored by the employer.
export function transactionAncre(hash) {
  return Transaction.registerData({ data: new DataBlob(ancre(hash)) });
}

// Anchor an entry: register_data, then remember the transaction NEXT TO the entry (outside it,
// so the entry's hash does not change). `par` signs; `sponsor` pays the fee.
export async function ancrer(fichier, { par, sponsor = null }) {
  const { soumettre } = await import('../chaine.mjs');
  const doc = JSON.parse(readFileSync(fichier, 'utf8'));
  const r = await soumettre(transactionAncre(doc.hash), { par, sponsor });
  doc.ancre = { tx: r.hash, lien: r.lien, bloc: r.bloc, par, sponsor };
  writeFileSync(fichier, JSON.stringify(doc, null, 2) + '\n');
  return r;
}

export function lire() { return entrees(); }

// For the auditor: recompute every hash, check the chain links.
export function verifierLocal() {
  const tout = entrees(); let prec = null; const rapport = [];
  for (const { entree, nonce, hash } of tout) {
    const ok = empreinte(nonce, entree) === hash && entree.previous === prec;
    rapport.push({ seq: entree.seq, type: entree.type, hash, ok });
    prec = hash;
  }
  return rapport;
}
