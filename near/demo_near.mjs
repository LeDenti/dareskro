#!/usr/bin/env node
/**
 * dareskro on NEAR — the testnet run. Writes run.log and compte_rendu.json.
 *
 * Accounts (near-cli-rs, faucet): dareskro.testnet (the contract, locked after
 * the run), dareskro-employer.testnet, dareskro-employee.testnet,
 * dareskro-oracle.testnet, dareskro-stranger.testnet.
 *
 * What it shows, in order:
 *   1  payroll: the employer locks 1 NEAR for the employee, payable at the date; memos = statement sha256, fiat line, oracle
 *   2  a stranger tries to finish before the date → refused by the contract's clock
 *   3  the employer tries to cancel → refused: no cancel_after, nobody can
 *   4  one signature, three escrows (net pay, URSSAF, DGFiP) with create_batch; a short batch is refused whole
 *   5  delivery: condition = sha256(secret held by the oracle), fact = a public file and its hash; wrong secret refused
 *   6  a second delivery nobody will prove, deadline in 90 s → refunded by the oracle at the deadline
 *   7  the oracle's loop: finishes payroll and batch after the date, reveals the secret on the proven delivery, refunds the other
 *   8  finish again → already closed
 */
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { CONTRACT, EXPLORER, NEAR, account, balance, call, near, nowNs, view } from './lib.mjs';
import { ORACLE_ID, makeCondition, tick } from './oracle_near.mjs';

const LOG = new URL('./run.log', import.meta.url);
const CR = new URL('./compte_rendu.json', import.meta.url);
writeFileSync(LOG, '');
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const log = (s) => { const line = `${stamp()}  ${s}`; console.log(line); appendFileSync(LOG, line + '\n'); };
const report = { network: 'testnet', contract: CONTRACT, oracle: ORACLE_ID, started: new Date().toISOString(), steps: [] };
const step = (name, data) => { report.steps.push({ name, ...data }); writeFileSync(CR, JSON.stringify(report, null, 2) + '\n'); };
const expectRefused = (name, res, needle) => {
  const ok = !res.ok && res.error.includes(needle);
  log(`${name} → ${res.ok ? 'ACCEPTED (unexpected)' : 'refused: ' + res.error}  ${EXPLORER(res.hash)}`);
  step(name, { expected: `refused: ${needle}`, got: res.ok ? 'accepted' : res.error, hash: res.hash, as_expected: ok });
  if (!ok) throw new Error(`${name}: expected a refusal containing "${needle}"`);
};

const employer = account('dareskro-employer.testnet');
const employee = account('dareskro-employee.testnet');
const stranger = account('dareskro-stranger.testnet');
const URSSAF = 'dareskro-stranger.testnet'; // stands in for the contributions' collector
const DGFIP = ORACLE_ID;                    // stands in for the tax office
const S = 1_000_000_000n;

log(`contract ${CONTRACT}, ${await view('count')} escrow(s) before this run, employee ${employee.accountId} has ${near(await balance(employee.accountId))} NEAR`);
const statement = createHash('sha256').update('statement 2026-11 pharmacist Sunday shift, net 440.36 EUR').digest('hex');

// 1 payroll
const t0 = await nowNs();
const payDate = t0 + 75n * S;
const r1 = await call(employer, 'create', { destination: employee.accountId, finish_after: payDate.toString(),
  memos: [`sha256:${statement}`, 'net 440.36 EUR', `dareskro/oracle:${ORACLE_ID}`] }, { deposit: NEAR });
if (!r1.ok) throw new Error(r1.error);
const payrollId = r1.value;
const e1 = await view('get', { id: payrollId });
log(`1 payroll escrow #${payrollId}: ${near(e1.amount)} NEAR to ${e1.destination}, payable at ${new Date(Number(payDate / 1_000_000n)).toISOString()}, memos ${JSON.stringify(e1.memos)}  ${EXPLORER(r1.hash)}`);
step('payroll_create', { id: payrollId, hash: r1.hash, escrow: e1 });

// 2, 3
expectRefused('2 stranger finishes before the date', await call(stranger, 'finish', { id: payrollId }), 'too early');
expectRefused('3 employer cancels the payroll escrow', await call(employer, 'cancel', { id: payrollId }), 'nobody can cancel');

// 4 batch
const lines = (a, b, c) => ({ items: [
  { destination: employee.accountId, amount: a.toString(), finish_after: payDate.toString(), memos: ['net 440.36 EUR', `sha256:${statement}`] },
  { destination: URSSAF, amount: b.toString(), finish_after: payDate.toString(), memos: ['URSSAF 361.32 EUR, due 2026-12-15'] },
  { destination: DGFIP, amount: c.toString(), finish_after: payDate.toString(), memos: ['DGFiP PAS 33.03 EUR'] },
] });
expectRefused('4a batch with a short deposit', await call(employer, 'create_batch', lines(NEAR, NEAR, NEAR), { deposit: NEAR, gas: '100' }), 'does not cover the batch');
const r4 = await call(employer, 'create_batch', lines(NEAR / 2n, NEAR * 4n / 10n, NEAR / 25n), { deposit: NEAR, gas: '100' });
if (!r4.ok) throw new Error(r4.error);
log(`4b one signature, three escrows #${r4.value.join(', #')}: 0.5 + 0.4 + 0.04 NEAR, surplus returned  ${EXPLORER(r4.hash)}`);
step('batch_create', { ids: r4.value, hash: r4.hash });

// 5 delivery: the fact is a public file and its hash
const url = 'https://raw.githubusercontent.com/LeDenti/dareskro/main/LICENSE';
const file = Buffer.from(await (await fetch(url)).arrayBuffer());
const sha = createHash('sha256').update(file).digest('hex');
const cond = makeCondition({ kind: 'delivery', url, sha256: sha, note: 'demo 5' });
const r5 = await call(employer, 'create', { destination: employee.accountId, cancel_after: (t0 + 900n * S).toString(), condition: cond,
  memos: [`delivery ${url}`, `sha256:${sha}`, `dareskro/oracle:${ORACLE_ID}`] }, { deposit: NEAR / 2n });
if (!r5.ok) throw new Error(r5.error);
log(`5 delivery escrow #${r5.value}: 0.5 NEAR, condition ${cond.slice(0, 16)}…, proof = ${url} sha256 ${sha.slice(0, 16)}…  ${EXPLORER(r5.hash)}`);
step('delivery_create', { id: r5.value, hash: r5.hash, condition: cond, url, sha256: sha });
expectRefused('5a stranger finishes without the secret', await call(stranger, 'finish', { id: r5.value }), 'bring the fulfillment');
expectRefused('5b stranger finishes with a wrong secret', await call(stranger, 'finish', { id: r5.value, fulfillment: '00'.repeat(32) }), 'does not match');
expectRefused('5c employer takes it back before the deadline', await call(employer, 'cancel', { id: r5.value }), 'too early');

// 6 a delivery nobody proves
const cond6 = makeCondition({ kind: 'delivery', url: url + '?never', sha256: '11'.repeat(32), note: 'demo 6, never proven' });
const r6 = await call(employer, 'create', { destination: employee.accountId, cancel_after: (t0 + 90n * S).toString(), condition: cond6,
  memos: ['delivery that never happens', `dareskro/oracle:${ORACLE_ID}`] }, { deposit: NEAR / 4n });
if (!r6.ok) throw new Error(r6.error);
log(`6 delivery escrow #${r6.value}: 0.25 NEAR, deadline in 90 s, will never be proven  ${EXPLORER(r6.hash)}`);
step('delivery_never_create', { id: r6.value, hash: r6.hash });

// 7 the oracle's loop
const before = await balance(employee.accountId);
const watched = [payrollId, ...r4.value, r5.value, r6.value];
log(`7 oracle ${ORACLE_ID} watching #${watched.join(', #')}; pay date in ${Number((payDate - await nowNs()) / S)} s`);
const submitted = [];
for (let i = 0; i < 40; i++) {
  submitted.push(...(await tick(log)));
  const open = (await Promise.all(watched.map((id) => view('get', { id })))).filter((e) => e.status === 'Locked');
  if (!open.length) break;
  await new Promise((r) => setTimeout(r, 8000));
}
const after = await balance(employee.accountId);
const closedAt = (await view('get', { id: payrollId })).closed_at;
const finishedAfter = Number((BigInt(closedAt) - payDate) / S);
const payrollFinish = submitted.find((s) => s.id === payrollId && s.ok);
log(`7 done: employee ${near(before)} → ${near(after)} NEAR (+${near(after - before)}); payroll finished ${finishedAfter} s after the date by ${ORACLE_ID}, nobody clicked`);
step('oracle_loop', { submitted: submitted.map(({ id, action, ok, hash, error }) => ({ id, action, ok, hash, error })), employee_before: before.toString(), employee_after: after.toString() });

// 8
expectRefused('8 finish the payroll escrow twice', await call(stranger, 'finish', { id: payrollId }), 'already closed');

report.payroll = { id: payrollId, amount_near: near(e1.amount), finish_after: payDate.toString(), destination: e1.destination,
  finish_hash: payrollFinish?.hash, finish_explorer: payrollFinish ? EXPLORER(payrollFinish.hash) : null, finished_after_s: finishedAfter };
report.finished = new Date().toISOString();
const all = await Promise.all(watched.map((id) => view('get', { id })));
report.final = Object.fromEntries(watched.map((id, i) => [id, { status: all[i].status, closed_by: all[i].closed_by, fulfillment: all[i].fulfillment }]));
writeFileSync(CR, JSON.stringify(report, null, 2) + '\n');
log(`report → compte_rendu.json; statuses ${JSON.stringify(report.final)}`);
