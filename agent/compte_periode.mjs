#!/usr/bin/env node
// dareskro — one fresh payee account per pay period, derived on the employee's own Ledger.
// Prints the BIP44 path for a period (coin type 144 = XRP): no key, no address, no secret
// leaves the device. The employer learns one address per period, so two escrows of the
// same employee are not linkable by destination. Honest limit: the employer's account and
// the XRP amount stay public on every escrow (XLS-96 hides amounts for MPTs, not escrows).
//
//   node agent/compte_periode.mjs --periode 2026-10        -> 44'/144'/321'/0/0
//
// index = months since 2000-01 (0 for 2000-01), well below the hardened limit 2^31 - 1.

const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? undefined : process.argv[i + 1]; };
const periode = arg("--periode");
const m = /^(\d{4})-(\d{2})$/.exec(periode ?? "");
if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
  console.error("usage: node agent/compte_periode.mjs --periode YYYY-MM");
  process.exit(2);
}
const index = (Number(m[1]) - 2000) * 12 + (Number(m[2]) - 1);
if (index < 0) { console.error("period before 2000-01"); process.exit(2); }
console.log(`period ${periode} -> account index ${index} -> path 44'/144'/${index}'/0/0`);
console.log("the employee shows this account's address on the device; the pay desk writes it as Destination.");
