// Shared helpers for prove.mjs, verify.mjs and ouvrir.mjs: paths, arguments, field encoding,
// the circuit inputs derived from a statement, the public enumeration, bb.js in wasm.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Barretenberg, BackendType } from '@aztec/bb.js';
import { empreinte } from '../agent/confidentiel.mjs';

export const ZK = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(ZK, '..');
export const SORTIE = resolve(ZK, 'sortie');

// BN254 scalar field: every Field value in the circuit lives below this prime.
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Public inputs in the circuit's ABI order: public parameters as declared, then the return value.
// statement_hi/lo are the two 16-byte halves of statement_sha256; the JSON carries the hash once.
// prove.mjs checks this order against what bb.js reports, so verify.mjs can rebuild the list.
export const PUBLIC_ORDER = ['total_cents', 'point_value_milli', 'dimanche', 'volets_ouverts', 'heures_semaine_avant', 'statement_hi', 'statement_lo', 'commitment'];

// The engine (officine.garde) and the circuit agree only up to 43 h already worked (see README).
export const MAX_HOURS_BEFORE = 43;

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

export function flag(name) {
  return process.argv.includes(`--${name}`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// "466.57" with 2 decimals -> 46657n, exactly; rejects more decimals than allowed.
export function toScaled(text, decimals) {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(String(text).trim());
  if (!m) throw new Error(`not a decimal number: ${text}`);
  const frac = (m[2] || '');
  if (frac.length > decimals) throw new Error(`${text}: more than ${decimals} decimals`);
  return BigInt(m[1] + frac.padEnd(decimals, '0'));
}

export function toField(value) {
  const v = typeof value === 'boolean' ? (value ? 1n : 0n) : BigInt(value);
  if (v < 0n || v >= FIELD_MODULUS) throw new Error('value outside the field');
  return '0x' + v.toString(16).padStart(64, '0');
}

export function shaLimbs(sha256hex) {
  if (!/^[0-9a-f]{64}$/.test(sha256hex || '')) throw new Error('statement_sha256 must be 64 lowercase hex digits');
  return { statement_hi: toField(BigInt('0x' + sha256hex.slice(0, 32))), statement_lo: toField(BigInt('0x' + sha256hex.slice(32))) };
}

export function publicInputFields(pub) {
  const limbs = shaLimbs(pub.statement_sha256);
  return PUBLIC_ORDER.map((k) => (k in limbs ? limbs[k] : toField(pub[k])));
}

// The circuit inputs a statement determines, as prove.mjs and the administration (ouvrir.mjs)
// both derive them. The nonce is not here: prove.mjs draws it, the sealed opening carries it.
export function inputsFromStatement(bulletin) {
  const sha = empreinte(bulletin);
  if (sha !== bulletin.sha256) throw new Error(`statement: recomputed sha256 ${sha.slice(0, 16)}... differs from its sha256 field`);
  const quarterHours = toScaled(bulletin.evidence.badge.heures_retenues, 2); // hundredths of an hour
  if (quarterHours % 25n !== 0n) throw new Error('retained hours are not whole quarter hours');
  const hsaText = String(bulletin.evidence.schedule.week_hours_before);
  if (!/^\d+$/.test(hsaText)) throw new Error('hours already worked must be whole hours');
  const type = bulletin.evidence.schedule.type;
  const badge = bulletin.employee.badge;
  const badgeId = BigInt('0x' + createHash('sha256').update(badge, 'utf8').digest('hex')) % FIELD_MODULUS;
  return {
    priv: {
      heures_q: Number(quarterHours / 25n),
      coefficient: Number(bulletin.parameters.coefficient),
      anciennete_annees: Number(bulletin.parameters.seniority_years),
      badge_id: toField(badgeId),
    },
    pub: {
      total_cents: Number(toScaled(bulletin.total, 2)),
      point_value_milli: Number(toScaled(bulletin.parameters.point_value_eur, 3)),
      dimanche: /dimanche/i.test(type),
      volets_ouverts: /volets ouverts/i.test(type),
      heures_semaine_avant: Number(hsaText),
      statement_sha256: sha,
    },
  };
}

// What the public can compute from the public inputs alone: every (hours, coefficient,
// seniority rate) triple the circuit's formula maps to total_cents. Same integers as main.nr.
// `coefficient` restricts the search to one value (when a memo already leaks it).
export function candidates(pub, coefficient = null) {
  const DEN = 2426720n, HALF = 1213360n, SUNDAY = 91002n;
  const total = BigInt(pub.total_cents), pvm = BigInt(pub.point_value_milli);
  const lo = total * DEN - HALF, hi = total * DEN + DEN - 1n - HALF; // n with floor((n + HALF) / DEN) == total
  const debut16 = BigInt(pub.heures_semaine_avant) * 16n;
  const out = [];
  for (let hq = 1n; hq <= 96n; hq += 1n) {
    const retenu16 = pub.volets_ouverts ? hq * 4n : hq;
    const fin16 = debut16 + retenu16;
    const lo1 = debut16 > 560n ? debut16 : 560n, hi1 = fin16 < 688n ? fin16 : 688n;
    const t1 = hi1 > lo1 ? hi1 - lo1 : 0n;
    const lo2 = debut16 > 688n ? debut16 : 688n;
    const t2 = fin16 > lo2 ? fin16 - lo2 : 0n;
    const sunday = pub.dimanche ? SUNDAY * hq * pvm : 0n;
    for (let k = 0n; k <= 15n; k += 3n) {
      const m = (100n + k) * retenu16 + 25n * t1 + 50n * t2; // n = coefficient * pvm * m + sunday
      const unit = pvm * m;
      let cMin = (lo - sunday + unit - 1n) / unit, cMax = (hi - sunday) / unit;
      if (cMin < 100n) cMin = 100n;
      if (cMax > 2000n) cMax = 2000n;
      for (let c = cMin; c <= cMax; c += 1n) {
        if (coefficient === null || c === BigInt(coefficient)) out.push({ hours: Number(hq) / 4, coefficient: Number(c), seniority_rate: Number(k) });
      }
    }
  }
  return out;
}

export function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(text) {
  return new Uint8Array(Buffer.from(text, 'hex'));
}

// Wasm only, on purpose: the package also ships native bb binaries that bb.js would pick first.
export async function openBarretenberg(threads) {
  return Barretenberg.new({ threads, backend: BackendType.Wasm });
}

export function ms(from) {
  return `${(performance.now() - from).toFixed(0)} ms`;
}
