#!/usr/bin/env node
// verify.mjs: check the published proof against the vk and the public inputs, without the circuit.
// With --escrow <EscrowCreate hash>: fetch the transaction on testnet and bind the proof to it by
// hash (the statement sha256 is a public input of the proof and a memo of the escrow) and by amount
// (the `dareskro/fiat` memo). With --recompile: rebuild the vk from the circuit source and compare,
// so a reader knows the vk is the one of circuit/src/main.nr. Always: count what the public can
// enumerate from the public total, so the "hidden" column is measured, not asserted.
//   node verify.mjs [--escrow <hash>] [--recompile] [--threads 1]      exit 0 ok, 1 failure, 2 usage
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import { UltraHonkBackend, UltraHonkVerifierBackend } from '@aztec/bb.js';
import { ZK, SORTIE, arg, flag, readJson, publicInputFields, candidates, fromHex, hex, openBarretenberg, ms } from './commun.mjs';
import { fetchTx, decodeMemos, memoHash, memoFiat, leaks } from '../agent/confidentiel.mjs';

const escrowHash = arg('escrow', null);
if (process.argv.includes('--escrow') && !/^[0-9a-fA-F]{64}$/.test(escrowHash || '')) { console.error('usage: node verify.mjs [--escrow <64-hex EscrowCreate hash>] [--recompile]'); process.exit(2); }
const threads = Number(arg('threads', '1'));

const pub = readJson(resolve(SORTIE, 'public_inputs.json'));
const proof = readJson(resolve(SORTIE, 'proof.json'));
const vkFile = readJson(resolve(SORTIE, 'vk.json'));
const vk = fromHex(vkFile.vk);
let failed = false;
const fail = (msg) => { console.log(msg); failed = true; };

// 1. the proof. Malformed bytes make bb's wasm assert, so the files are checked against their own
// digests first and the call is caught: a tampered vk is a REJECTED line, not a stack trace.
const vkSha = createHash('sha256').update(vk).digest('hex');
if (vk.length !== vkFile.bytes || vkSha !== vkFile.vk_sha256) fail(`vk REJECTED: vk.json's key (${vk.length} bytes, sha256 ${vkSha.slice(0, 16)}...) does not match its own vk_sha256/bytes fields`);
const proofBytes = fromHex(proof.proof);
if (proofBytes.length !== proof.bytes || proof.proof.length !== 2 * proof.bytes) fail(`proof REJECTED: proof.json's hex (${proofBytes.length} bytes) does not match its bytes field`);
let publicFields;
try { publicFields = publicInputFields(pub); } catch (e) { fail(`public inputs REJECTED: ${e.message}`); }
const api = await openBarretenberg(threads);
let t = performance.now();
if (!failed) {
  try {
    const ok = await new UltraHonkVerifierBackend(api).verifyProof({ proof: proofBytes, publicInputs: publicFields, verificationKey: vk });
    console.log(`proof ${ok ? 'VERIFIED' : 'REJECTED'} in ${ms(t)} (${proof.bytes} bytes, vk ${vkFile.bytes} bytes, ${publicFields.length} public fields)`);
    if (!ok) failed = true;
  } catch (e) {
    fail(`proof REJECTED (malformed proof or vk: ${String(e.message || e).split('\n')[0].slice(0, 80)})`);
  }
}

// 2. optional: the vk really is the one of the circuit source
if (flag('recompile')) {
  t = performance.now();
  const quiet = () => {};
  const { program } = await compile_program(createFileManager(resolve(ZK, 'circuit')), undefined, quiet, quiet);
  const fresh = await new UltraHonkBackend(program.bytecode, api).getVerificationKey();
  const same = hex(fresh) === vkFile.vk;
  const source = createHash('sha256').update(readFileSync(resolve(ZK, 'circuit/src/main.nr'))).digest('hex');
  console.log(`vk ${same ? 'MATCHES' : 'DIFFERS FROM'} circuit/src/main.nr (recompiled in ${ms(t)}, source sha256 ${source.slice(0, 16)}..., vk.json says ${String(vkFile.circuit_sha256).slice(0, 16)}...)`);
  if (!same) failed = true;
}
await api.destroy();

// 3. optional: bind to the escrow on the ledger, by hash and by amount
let binding = null;
let leaked = [];
if (escrowHash) {
  let fetched;
  try { fetched = await fetchTx(escrowHash.toUpperCase()); } catch (e) { console.error(`escrow ${escrowHash.slice(0, 8)}...: ${e.message}`); process.exit(1); }
  const { tx, validated } = fetched;
  if (tx.TransactionType !== 'EscrowCreate' || !validated) { console.error(`escrow ${escrowHash}: not a validated EscrowCreate`); process.exit(1); }
  if (typeof tx.Amount !== 'string') { console.error('escrow amount is not XRP; this binding reads drops only'); process.exit(1); }
  const memos = decodeMemos(tx);
  const byType = Object.fromEntries(memos.map((m) => [m.type, m.data]));
  // By hash: the statement sha256 the escrow cites is a public input, so the proof is for that
  // statement and no other escrow (of the same amount or not) can borrow it.
  const memoSha = memoHash(memos);
  if (!memoSha) fail(`escrow ${escrowHash.slice(0, 8)}...: no statement hash memo, the proof cannot be bound by hash`);
  else {
    const hashOk = memoSha === pub.statement_sha256;
    console.log(`escrow ${escrowHash.slice(0, 8)}...: statement memo ${memoSha.slice(0, 16)}... ${hashOk ? 'MATCHES' : 'DIFFERS FROM'} the proof's public statement hash`);
    if (!hashOk) failed = true;
  }
  // By amount: the rate is self-declared in the payer's own fiat memo, so this only shows the memo
  // and the proof agree on the total; the XRP value of that total rests on the pay desk's rate.
  const fiat = /^(\d+(?:\.\d+)?) ([A-Z]{3}) @ (\d+(?:\.\d+)?)/.exec(byType['dareskro/fiat'] || '');
  if (!fiat) fail('no dareskro/fiat memo on this escrow: the total is not bound to the XRP amount');
  else {
    const xrp = Number(tx.Amount) / 1e6;
    const rate = Number(fiat[3]);
    const proven = pub.total_cents / 100;
    // With contributions, the employee's escrow holds the NET: the gross memo says so, and the
    // net must be the proven gross minus the employee contributions at the public rate (half up).
    const gross = /gross=(\d+\.\d\d);net=(\d+\.\d\d);employee_rate=(\d+\.\d+)(?:;tax_rate=(\d+\.\d+);paid=(\d+\.\d\d))?/.exec(byType['dareskro/gross'] || '');
    let expected = proven;
    if (gross) {
      const g = Math.round(Number(gross[1]) * 100), net = Math.round(Number(gross[2]) * 100), r = Number(gross[3]);
      const contribution = Math.floor(g * r + 0.5);
      const grossOk = g === pub.total_cents;
      const netOk = net === g - contribution;
      console.log(`escrow ${escrowHash.slice(0, 8)}...: gross memo ${(g / 100).toFixed(2)} ${grossOk ? 'MATCHES' : 'DIFFERS FROM'} the proven total; net ${(net / 100).toFixed(2)} = gross - ${Math.round(r * 100)} % employee contributions: ${netOk ? 'MATCHES' : 'DIFFERS'}`);
      if (!grossOk || !netOk) failed = true;
      expected = net / 100;
      if (gross[4] !== undefined) {
        // income tax withheld at source, at the employee's personalised rate: the escrow holds what is paid
        const tr = Number(gross[4]), paid = Math.round(Number(gross[5]) * 100);
        const tax = Math.floor(net * tr + 0.5);
        const paidOk = paid === net - tax;
        console.log(`escrow ${escrowHash.slice(0, 8)}...: paid ${(paid / 100).toFixed(2)} = net - ${(tr * 100).toFixed(1)} % income tax withheld at source (${(tax / 100).toFixed(2)}): ${paidOk ? 'MATCHES' : 'DIFFERS'}`);
        if (!paidOk) failed = true;
        expected = paid / 100;
      }
    }
    const diff = Math.abs(xrp * rate - expected);
    const amountOk = diff <= 0.01;
    const memoOk = Number(fiat[1]) === expected;
    binding = { xrp, rate, currency: fiat[2], amountOk, account: tx.Account, destination: tx.Destination };
    console.log(`escrow ${escrowHash.slice(0, 8)}...: ${xrp} XRP x ${rate} ${fiat[2]}/XRP (rate declared by the payer) = ${(xrp * rate).toFixed(4)} ${fiat[2]} vs ${gross ? 'net' : 'proven'} ${expected.toFixed(2)} -> ${amountOk ? 'MATCH' : 'MISMATCH'} (|diff| ${diff.toFixed(4)}), fiat memo ${memoOk ? 'MATCHES' : 'DIFFERS'}`);
    if (!amountOk || !memoOk) failed = true;
  }
  // Optional memo written by a pay desk that cites the commitment itself: compared as field values.
  if (byType['dareskro/zk-commitment'] !== undefined) {
    try {
      const m = byType['dareskro/zk-commitment'].trim();
      const sameCommitment = BigInt(m.startsWith('0x') ? m : '0x' + m) === BigInt(pub.commitment);
      console.log(`escrow ${escrowHash.slice(0, 8)}...: zk-commitment memo ${sameCommitment ? 'MATCHES' : 'DIFFERS FROM'} the public commitment`);
      if (!sameCommitment) failed = true;
    } catch { fail('escrow: zk-commitment memo is not a hex field value'); }
  }
  leaked = leaks(memos);
}

// 4. what the public can enumerate: the amount and the rules are public, so every (hours,
// coefficient, seniority rate) triple that gives this total is computable by anyone, in a millisecond.
const all = candidates(pub);
const leakedCoef = leaked.find((l) => l.reveals === 'the coefficient');
const narrowed = leakedCoef ? candidates(pub, Number(leakedCoef.value)) : null;

// 5. the two columns
const left = [
  `total ${(pub.total_cents / 100).toFixed(2)} equals the IDCC 1996 formula for some`,
  `admissible hours, coefficient (100..2000) and seniority`,
  `Sunday shift: ${pub.dimanche}; shutters open: ${pub.volets_ouverts}`,
  `${pub.heures_semaine_avant} h already worked that week`,
  ...(pub.cdd ? ['fixed-term contract of one day: +10 % end-of-contract, +10 % paid leave'] : []),
  `point value ${(pub.point_value_milli / 1000).toFixed(3)}`,
  `commitment ${pub.commitment.slice(0, 14)}... (badge, inputs, nonce, statement)`,
  `statement ${String(pub.statement_sha256).slice(0, 16)}... (public input${escrowHash ? ' = escrow memo' : ', no memo checked'})`,
];
if (binding) {
  left.push(`escrow ${binding.account.slice(0, 10)}... -> ${binding.destination.slice(0, 10)}...`);
  left.push(`${binding.xrp} XRP, ${binding.amountOk ? 'bound to' : 'NOT bound to'} this total and statement`);
}
const hidden = narrowed
  ? `hours, coefficient, seniority: NOT hidden here, memo ${leakedCoef.memo} gives the coefficient, ${narrowed.length} candidate${narrowed.length > 1 ? 's' : ''} left`
  : `hours, coefficient, seniority: hidden by the proof, but ${all.length} triples fit the public total`;
const right = ['who (badge, name): the commitment opens on nothing without the nonce', 'the nonce', hidden, ...leaked.filter((l) => l.reveals !== 'the coefficient').map((l) => `${l.reveals}: NOT hidden, memo ${l.memo} names it`)];
console.log('');
console.log(`  ${'WHAT THE PUBLIC LEARNS'.padEnd(66)}| WHAT STAYS HIDDEN (measured)`);
console.log(`  ${'-'.repeat(66)}+${'-'.repeat(30)}`);
for (let i = 0; i < Math.max(left.length, right.length); i += 1) console.log(`  ${(left[i] || '').padEnd(66)}| ${right[i] || ''}`);
console.log('');
console.log(`enumeration: ${all.length} (hours, coefficient, seniority rate) triples give ${(pub.total_cents / 100).toFixed(2)} under the public context;`
  + ` the proof hides which one, the public amount does not. Hiding the amount needs XLS-96 (no escrow in v1) or pooled periods.`);
if (leaked.length) console.log(`privacy: the escrow's memos name ${[...new Set(leaked.map((l) => l.reveals))].join(' and ')} (written by the pay desk, not by this layer): fix = an opaque statement id in app/src/xrpl.ts`);
console.log(failed ? 'RESULT: FAIL' : 'RESULT: OK');
process.exit(failed ? 1 : 0);
