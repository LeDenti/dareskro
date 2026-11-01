#!/usr/bin/env node
// ouvrir.mjs: the administration (or the employee) opens the commitment with the one key layer B
// gave them. Decrypt the sealed file, take the statement and the zk opening (private inputs and
// nonce) out of it, re-derive the circuit inputs from the statement alone, re-execute the circuit
// with the sealed nonce and compare the commitment it returns with the published one.
// Prints MATCH / MISMATCH lines only: no hours, no coefficient, no nonce leave this process.
//   node ouvrir.mjs --role administration|employee [--file agent/sortie/bulletin.chiffre.json]   exit 0 ok, 1 mismatch, 2 usage
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import { Noir } from '@noir-lang/noir_js';
import { ZK, ROOT, SORTIE, arg, readJson, shaLimbs, inputsFromStatement, toField, ms } from './commun.mjs';
import { CHIFFRE, ROLES, UsageError, contentKeyFor, decryptOpening, decryptStatement, openingKeyFor, rel } from '../agent/confidentiel.mjs';

const role = arg('role', null);
if (!ROLES.includes(role)) { console.error(`usage: node zk/ouvrir.mjs --role ${ROLES.join('|')} [--file <sealed statement>]`); process.exit(2); }
const filePath = resolve(ROOT, arg('file', rel(CHIFFRE)));
if (!existsSync(filePath)) { console.error(`${rel(filePath)} missing: run node agent/confidentiel.mjs --chiffre`); process.exit(2); }
const file = readJson(filePath);
if (!file.zk?.opening) { console.error(`${rel(filePath)} carries no zk opening: run node zk/prove.mjs, then node agent/confidentiel.mjs --chiffre`); process.exit(1); }
let failed = false;

// 1. one key opens both: the statement and the commitment's opening share the content key
let statement, opening;
let t = performance.now();
try {
  // v2 files wrap the opening's key separately, for the readers whose scope includes it (not the pension fund)
  const contentKey = contentKeyFor(file, role);
  statement = JSON.parse(decryptStatement(file, contentKey).toString('utf8'));
  contentKey.fill(0);
  const openingKey = openingKeyFor(file, role);
  opening = JSON.parse(decryptOpening(file, openingKey).toString('utf8'));
  openingKey.fill(0);
} catch (e) {
  if (e instanceof UsageError) { console.error(`role ${role}: ${e.message}`); process.exit(1); }
  console.error(`role ${role}: decryption failed, the GCM tag does not authenticate (tampered file or wrong key): ${e.message}`);
  process.exit(1);
}
console.log(`role ${role}: statement and zk opening decrypted in ${ms(t)}`);

// 2. the opening must say what the statement says (the administration reads both)
let derived;
try { derived = inputsFromStatement(statement); } catch (e) { console.error(e.message); process.exit(1); }
const agree = ['heures_q', 'coefficient', 'anciennete_annees', 'badge_id'].every((k) => String(opening.private_inputs?.[k]) === String(derived.priv[k]));
console.log(`  opening ${agree ? 'AGREES with' : 'DIFFERS FROM'} the statement on hours, coefficient, seniority and badge`);
if (!agree) failed = true;
const sameSha = opening.statement_sha256 === derived.pub.statement_sha256 && file.sha256_plain === derived.pub.statement_sha256;
console.log(`  statement sha256 ${derived.pub.statement_sha256.slice(0, 16)}... ${sameSha ? 'MATCHES' : 'DIFFERS FROM'} the sealed header and the opening`);
if (!sameSha) failed = true;

// 3. re-execute the circuit with the sealed nonce: its return value is the commitment
t = performance.now();
const quiet = () => {};
const { program } = await compile_program(createFileManager(resolve(ZK, 'circuit')), undefined, quiet, quiet);
const { statement_sha256, ...pubAbi } = derived.pub;
let returnValue;
try {
  ({ returnValue } = await new Noir(program).execute({ ...derived.priv, nonce: opening.private_inputs.nonce, ...pubAbi, ...shaLimbs(statement_sha256) }));
} catch (e) {
  console.error(`  the circuit refuses the statement's inputs (${e.message.split('\n')[0]})`);
  process.exit(1);
}
const recomputed = toField(BigInt(returnValue));
console.log(`  circuit re-executed in ${ms(t)} (compile + witness)`);
const against = [['sealed file', file.zk.commitment], ['opening', opening.commitment]];
const publicInputsPath = resolve(SORTIE, 'public_inputs.json');
if (existsSync(publicInputsPath)) against.push(['zk/sortie/public_inputs.json', readJson(publicInputsPath).commitment]);
for (const [where, value] of against) {
  const same = BigInt(value) === BigInt(recomputed);
  console.log(`  commitment ${recomputed.slice(0, 18)}... ${same ? 'MATCHES' : 'DIFFERS FROM'} the ${where}`);
  if (!same) failed = true;
}
console.log(failed ? 'RESULT: FAIL' : `RESULT: OK, the proof the public verified was made for this statement and this employee`);
process.exit(failed ? 1 : 0);
