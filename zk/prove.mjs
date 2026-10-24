#!/usr/bin/env node
// prove.mjs: from the statement and the schedule, derive the circuit inputs, compile the Noir
// circuit in wasm, execute it, prove with UltraHonk (bb.js, wasm) and verify once.
// Published: zk/sortie/{proof.json, public_inputs.json, vk.json}. Private: zk/.witness/ only.
//   node prove.mjs [--bulletin agent/sortie/bulletin.json] [--planning agent/preuves/planning_2026-10-25.txt] [--threads 1]
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, UltraHonkVerifierBackend } from '@aztec/bb.js';
import { ZK, ROOT, SORTIE, PUBLIC_ORDER, MAX_HOURS_BEFORE, arg, readJson, toField, shaLimbs, publicInputFields, inputsFromStatement, candidates, hex, openBarretenberg, ms } from './commun.mjs';

const bulletinPath = resolve(ROOT, arg('bulletin', 'agent/sortie/bulletin.json'));
const planningPath = resolve(ROOT, arg('planning', 'agent/preuves/planning_2026-10-25.txt'));
const threads = Number(arg('threads', '1'));

const bulletin = readJson(bulletinPath);
const planning = Object.fromEntries(
  readFileSync(planningPath, 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && l.includes(':'))
    .map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

// The statement determines the inputs (same derivation as the administration's ouvrir.mjs);
// the statement's sha256 is recomputed, not trusted. The schedule must agree with it.
let derived;
try { derived = inputsFromStatement(bulletin); } catch (e) { console.error(e.message); process.exit(1); }
// Values are not printed: a mismatch log would otherwise carry the private inputs.
function same(label, a, b) {
  if (String(a) !== String(b)) throw new Error(`${label}: the schedule and the statement disagree (compare the two files)`);
}
same('coefficient', planning.coefficient, bulletin.parameters.coefficient);
same('seniority', planning.anciennete_annees, bulletin.parameters.seniority_years);
same('hours before', planning.heures_semaine_avant, bulletin.evidence.schedule.week_hours_before);
same('shift type', planning.type, bulletin.evidence.schedule.type);
same('badge', planning.badge, bulletin.employee.badge);

const pub = derived.pub;
if (pub.heures_semaine_avant > MAX_HOURS_BEFORE) {
  // Beyond 43 h the engine counts the +50 % tranche from 43 h, the circuit from the hours worked:
  // the proof would be refused at execution. Prior engine, read-only; said in the README.
  console.error(`${pub.heures_semaine_avant} h already worked that week: the engine and the circuit disagree beyond ${MAX_HOURS_BEFORE} h, not proving`);
  process.exit(1);
}
const nonce = BigInt('0x' + randomBytes(31).toString('hex')); // 248 bits: always below the field prime
const priv = { ...derived.priv, nonce: toField(nonce) };

// 1. compile
let t = performance.now();
const quiet = () => {};
const { program } = await compile_program(createFileManager(resolve(ZK, 'circuit')), undefined, quiet, quiet);
const tCompile = ms(t);

// 2. execute: the circuit's assert fails here if the arithmetic does not reproduce the total
t = performance.now();
const { statement_sha256, ...pubAbi } = pub;
const inputs = { ...priv, ...pubAbi, ...shaLimbs(statement_sha256) }; // the hash enters as two 128-bit fields
let witness, returnValue;
try {
  ({ witness, returnValue } = await new Noir(program).execute(inputs));
} catch (e) {
  console.error(`the circuit does not accept this statement (total ${bulletin.total}): ${e.message}`);
  process.exit(1);
}
const tWitness = ms(t);
pub.commitment = toField(BigInt(returnValue));

// 3. prove, vk, verify
const api = await openBarretenberg(threads);
const backend = new UltraHonkBackend(program.bytecode, api);
t = performance.now();
const proofData = await backend.generateProof(witness);
const tProve = ms(t);
t = performance.now();
const vk = await backend.getVerificationKey();
const tVk = ms(t);
t = performance.now();
const ok = await new UltraHonkVerifierBackend(api).verifyProof({ ...proofData, verificationKey: vk });
const tVerify = ms(t);
await api.destroy();
if (!ok) { console.error('the fresh proof does not verify'); process.exit(1); }

// bb.js returns the public inputs in ABI order; verify.mjs rebuilds that list from the JSON values.
const expected = publicInputFields(pub);
if (JSON.stringify(expected) !== JSON.stringify(proofData.publicInputs)) {
  console.error('public input order differs from PUBLIC_ORDER; refusing to publish');
  process.exit(1);
}

// 4. write: public artefacts in sortie/, the witness in .witness/ (gitignored, 0600)
mkdirSync(SORTIE, { recursive: true });
const generated = new Date().toISOString();
const circuitSource = readFileSync(resolve(ZK, 'circuit/src/main.nr'));
writeFileSync(resolve(SORTIE, 'public_inputs.json'), JSON.stringify({
  version: 'dareskro/zk-public-inputs.v2',
  circuit: 'pay_compliance',
  order: PUBLIC_ORDER,
  note: 'statement_hi/lo are the two halves of statement_sha256, a public input of the proof and the escrow memo',
  ...pub,
  generated,
}, null, 2) + '\n');
writeFileSync(resolve(SORTIE, 'proof.json'), JSON.stringify({
  version: 'dareskro/zk-proof.v1',
  scheme: 'UltraHonk, Barretenberg bb.js 5.2.1 in wasm, poseidon2 oracle hash, zero-knowledge on',
  bytes: proofData.proof.length,
  proof: hex(proofData.proof),
  generated,
}, null, 2) + '\n');
writeFileSync(resolve(SORTIE, 'vk.json'), JSON.stringify({
  version: 'dareskro/zk-vk.v1',
  circuit: 'pay_compliance',
  noir: '1.0.0-rc.6',
  bb: '5.2.1',
  circuit_sha256: createHash('sha256').update(circuitSource).digest('hex'),
  vk_sha256: createHash('sha256').update(vk).digest('hex'),
  bytes: vk.length,
  vk: hex(vk),
}, null, 2) + '\n');
const witnessDir = resolve(ZK, '.witness');
mkdirSync(witnessDir, { recursive: true, mode: 0o700 });
const witnessPath = resolve(witnessDir, 'witness.json');
// confidentiel.mjs --chiffre seals private_inputs + commitment for the administration (the "opening").
writeFileSync(witnessPath, JSON.stringify({ generated, statement_sha256: pub.statement_sha256, commitment: pub.commitment, private_inputs: priv, witness_gz_base64: Buffer.from(witness).toString('base64') }, null, 2) + '\n', { mode: 0o600 });
chmodSync(witnessPath, 0o600);

const n = candidates(pub).length;
console.log('pay_compliance: proof generated and verified');
console.log(`  circuit        ${program.abi.parameters.length} inputs, ${proofData.publicInputs.length} public fields (bytecode ${program.bytecode.length} chars base64)`);
console.log(`  compile        ${tCompile}`);
console.log(`  witness        ${tWitness} (${witness.length} bytes gzipped)`);
console.log(`  prove          ${tProve} (wasm, ${threads} thread${threads > 1 ? 's' : ''})`);
console.log(`  vk             ${tVk}`);
console.log(`  verify         ${tVerify}`);
console.log(`  proof          ${proofData.proof.length} bytes -> zk/sortie/proof.json`);
console.log(`  vk             ${vk.length} bytes -> zk/sortie/vk.json`);
console.log(`  public         total ${pub.total_cents} cents, point ${pub.point_value_milli} milli, sunday ${pub.dimanche}, shutters open ${pub.volets_ouverts}, ${pub.heures_semaine_avant} h before, statement ${pub.statement_sha256.slice(0, 16)}... -> zk/sortie/public_inputs.json`);
console.log(`  commitment     ${pub.commitment}`);
console.log(`  enumeration    ${n} (hours, coefficient, seniority rate) triple${n > 1 ? 's' : ''} give this public total: the proof hides which one, the public amount does not`);
console.log('  private        hours, coefficient, seniority, badge, nonce -> zk/.witness/witness.json only (0600, gitignored, not printed)');
