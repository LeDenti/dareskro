#!/usr/bin/env node
/**
 * dareskro on NEAR — the fee per act, measured on testnet. Writes frais.log and frais.json.
 *
 * The administrator (dareskro-oracle.testnet here, dareskro.near on mainnet) sets a schedule,
 * one escrow and one payslip pay it from their deposit, the administrator withdraws what is
 * held, then sets the schedule back to zero so the demo and the desk stay free.
 *
 *   node frais_near.mjs
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CONTRACT, EXPLORER, NEAR, account, balance, call, near, nowNs, view } from './lib.mjs';
import { ORACLE_ID } from './oracle_near.mjs';

const LOG = new URL('./frais.log', import.meta.url);
const OUT = new URL('./frais.json', import.meta.url);
writeFileSync(LOG, '');
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const log = (s) => { const line = `${stamp()}  ${s}`; console.log(line); appendFileSync(LOG, line + '\n'); };
const report = { network: 'testnet', contract: CONTRACT, admin: ORACLE_ID, started: new Date().toISOString(), steps: [] };
const step = (name, data) => { report.steps.push({ name, ...data }); writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n'); };
const expectRefused = (name, res, needle) => {
  const ok = !res.ok && res.error.includes(needle);
  log(`${name} → ${res.ok ? 'ACCEPTED (unexpected)' : 'refused: ' + res.error}  ${EXPLORER(res.hash)}`);
  step(name, { expected: `refused: ${needle}`, got: res.ok ? 'accepted' : res.error, hash: res.hash, as_expected: ok });
  if (!ok) throw new Error(`${name}: expected a refusal containing "${needle}"`);
};
const must = (name, res) => { if (!res.ok) throw new Error(`${name}: ${res.error} ${EXPLORER(res.hash)}`); return res; };
const viewSure = async (method, args) => { for (let i = 0; i < 10; i++) { const v = await view(method, args); if (v != null) return v; await new Promise((r) => setTimeout(r, 1000)); } throw new Error(`${method}: still null after 10 s`); };
const fees = async () => { const f = await view('fees'); return { ...f, held_near: near(f.held), total_near: near(f.total) }; };

const admin = account(ORACLE_ID);
const employer = account('dareskro-employer.testnet');
const employee = account('dareskro-employee.testnet');
const stranger = account('dareskro-stranger.testnet');
const FLOOR = NEAR / 100n; // 0.01 NEAR
const sha = (s) => createHash('sha256').update(s).digest('hex');

let f = await fees();
log(`contract ${CONTRACT}: administrator ${f.admin}, fee ${f.fee.bps} bps / floor ${near(f.fee.min)} NEAR, held ${f.held_near}, total ${f.total_near}, ${f.acts} act(s) charged; ceiling ${f.max_bps} bps / ${near(f.max_min)} NEAR`);
step('0 before', f);

// 1 at zero: 1 NEAR locked, nothing charged
const far = (await nowNs() + 3600n * 1_000_000_000n).toString();
let r = must('1', await call(employer, 'create', { destination: employee.accountId, cancel_after: far, memos: ['fee measure: schedule at zero'] }, { deposit: NEAR }));
const id1 = r.value;
const e1 = await viewSure('get', { id: id1 });
log(`1 escrow #${id1} at zero: 1 NEAR in, ${near(e1.amount)} NEAR locked (storage only)  ${EXPLORER(r.hash)}`);
step('1 escrow at zero', { id: id1, amount: e1.amount, hash: r.hash });

// 2 the schedule: a stranger is refused, the ceiling holds, the administrator sets 0.5 % with a 0.01 NEAR floor
expectRefused('2a stranger set_fee', await call(stranger, 'set_fee', { bps: 50, min: FLOOR.toString() }), 'only the administrator');
expectRefused('2b administrator above the ceiling', await call(admin, 'set_fee', { bps: 101, min: '0' }), 'at most');
r = must('2c', await call(admin, 'set_fee', { bps: 50, min: FLOOR.toString() }));
log(`2c administrator ${ORACLE_ID} sets 50 bps (0.5 %) with a floor of 0.01 NEAR  ${EXPLORER(r.hash)}`);
step('2c set_fee', { fee: r.value, hash: r.hash });

// 3 the same escrow: the floor is taken from the deposit
r = must('3', await call(employer, 'create', { destination: employee.accountId, cancel_after: far, memos: ['fee measure: 0.5 % floor 0.01'] }, { deposit: NEAR }));
const id2 = r.value;
const e2 = await viewSure('get', { id: id2 });
const fee2 = BigInt(e1.amount) - BigInt(e2.amount);
f = await fees();
log(`3 escrow #${id2} with the schedule: 1 NEAR in, ${near(e2.amount)} NEAR locked, fee ${near(fee2)} NEAR (0.5 % of 1 NEAR is under the floor), held ${f.held_near}  ${EXPLORER(r.hash)}`);
step('3 escrow charged', { id: id2, amount: e2.amount, fee: fee2.toString(), held: f.held, hash: r.hash });

// 4 the payslip locks nothing: the floor
r = must('4', await call(employer, 'issue_payslip', { owner_id: employee.accountId, escrow_id: id2, period: '2026-11', sha256: sha('fee measure'), readers: ['employee'], sealed: 'fee-measure-not-a-real-payslip' }, { deposit: NEAR / 20n }));
f = await fees();
log(`4 payslip ${r.value.token_id} issued: the floor 0.01 NEAR charged, held ${f.held_near}, ${f.acts} acts  ${EXPLORER(r.hash)}`);
step('4 payslip charged', { token_id: r.value.token_id, held: f.held, acts: f.acts, hash: r.hash });

// 5 a stranger cannot withdraw; the administrator withdraws to itself
expectRefused('5a stranger withdraw_fees', await call(stranger, 'withdraw_fees', {}), 'only the administrator');
const before = await balance(ORACLE_ID);
r = must('5b', await call(admin, 'withdraw_fees', {}));
await new Promise((x) => setTimeout(x, 3000));
const after = await balance(ORACLE_ID);
f = await fees();
log(`5b administrator withdraws: ${near(before)} → ${near(after)} NEAR (+${near(after - before)} after gas), held ${f.held_near}, total ${f.total_near}  ${EXPLORER(r.hash)}`);
step('5b withdrawn', { before: before.toString(), after: after.toString(), held: f.held, total: f.total, hash: r.hash });
expectRefused('5c withdraw again', await call(admin, 'withdraw_fees', {}), 'nothing to withdraw');

// 6 back to zero: the desk and the demo stay free
r = must('6', await call(admin, 'set_fee', { bps: 0, min: '0' }));
f = await fees();
log(`6 schedule back to zero (${f.fee.bps} bps / ${near(f.fee.min)} NEAR); total charged since deployment ${f.total_near} NEAR over ${f.acts} act(s)  ${EXPLORER(r.hash)}`);
step('6 set_fee zero', { fee: f.fee, total: f.total, acts: f.acts, hash: r.hash });
report.finished = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
log('done');
