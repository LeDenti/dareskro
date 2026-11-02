#!/usr/bin/env node
/**
 * dareskro on NEAR — the pool with several payers, measured on testnet. Writes pot.log and pot.json.
 *
 * A rental deposit shared by the tenant and a guarantor, filled by a third payer: the share
 * that fills it is trimmed, the pool locks, the landlord is paid at the date by a stranger.
 * Then a pool nobody fills: at the deadline a stranger returns every share to its payer.
 *
 *   node pot_near.mjs
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { CONTRACT, EXPLORER, NEAR, account, balance, call, near, nowNs, view } from './lib.mjs';
import { ORACLE_ID } from './oracle_near.mjs';

const LOG = new URL('./pot.log', import.meta.url);
const OUT = new URL('./pot.json', import.meta.url);
writeFileSync(LOG, '');
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const log = (s) => { const line = `${stamp()}  ${s}`; console.log(line); appendFileSync(LOG, line + '\n'); };
const report = { network: 'testnet', contract: CONTRACT, started: new Date().toISOString(), steps: [] };
const step = (name, data) => { report.steps.push({ name, ...data }); writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n'); };
const expectRefused = (name, res, needle) => {
  const ok = !res.ok && res.error.includes(needle);
  log(`${name} → ${res.ok ? 'ACCEPTED (unexpected)' : 'refused: ' + res.error}  ${EXPLORER(res.hash)}`);
  step(name, { expected: `refused: ${needle}`, got: res.ok ? 'accepted' : res.error, hash: res.hash, as_expected: ok });
  if (!ok) throw new Error(`${name}: expected a refusal containing "${needle}"`);
};
const must = (name, res) => { if (!res.ok) throw new Error(`${name}: ${res.error} ${EXPLORER(res.hash)}`); return res; };
const viewSure = async (method, args) => { for (let i = 0; i < 10; i++) { const v = await view(method, args); if (v != null) return v; await new Promise((r) => setTimeout(r, 1000)); } throw new Error(`${method}: still null after 10 s`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = 1_000_000_000n;

const tenant = account('dareskro-employee.testnet');
const guarantor = account(ORACLE_ID);
const landlord = account('dareskro-employer.testnet');
const stranger = account('dareskro-stranger.testnet');
const shares = (p) => p.shares.map((s) => `${s.payer} ${near(s.amount)}`).join(', ');

log(`contract ${CONTRACT}: ${await view('pool_count')} pool(s) before this run; landlord ${landlord.accountId} has ${near(await balance(landlord.accountId))} NEAR`);

// 1 the tenant opens a 0.6 NEAR deposit pool for the landlord: paid 20 s after it fills at the earliest, shares back after 10 min
const t0 = await nowNs();
let r = must('1', await call(tenant, 'pool_create', { destination: landlord.accountId, target: (NEAR * 6n / 10n).toString(), deadline: (t0 + 600n * S).toString(), finish_after: (t0 + 25n * S).toString(), memos: ['lease:L-9', 'deposit shared with a guarantor', `dareskro/oracle:${ORACLE_ID}`] }, { deposit: NEAR / 100n }));
const id1 = r.value;
let p = await viewSure('pool', { id: id1 });
log(`1 pool #${id1} opened by the tenant for the landlord: target 0.6 NEAR, deadline +600 s, pay date +25 s; funded ${near(p.funded)} (${p.shares.length} line: the 0.01 attached minus the record's storage)  ${EXPLORER(r.hash)}`);
step('1 pool_create', { id: id1, pool: p, hash: r.hash });

// 2 the guarantor brings 0.3, the tenant 0.2: open
r = must('2a', await call(guarantor, 'pool_fund', { id: id1 }, { deposit: NEAR * 3n / 10n }));
p = await viewSure('pool', { id: id1 });
log(`2a the guarantor ${guarantor.accountId} brings 0.3 → ${p.status}, funded ${near(p.funded)}: ${shares(p)}  ${EXPLORER(r.hash)}`);
step('2a guarantor 0.3', { status: p.status, funded: p.funded, hash: r.hash });
r = must('2b', await call(tenant, 'pool_fund', { id: id1 }, { deposit: NEAR * 2n / 10n }));
p = await viewSure('pool', { id: id1 });
log(`2b the tenant brings 0.2 → ${p.status}, funded ${near(p.funded)}: ${shares(p)}  ${EXPLORER(r.hash)}`);
step('2b tenant 0.2', { status: p.status, funded: p.funded, hash: r.hash });

// 3 not full: nothing to pay, nothing to return yet
expectRefused('3a finish while open', await call(stranger, 'pool_finish', { id: id1 }), 'not full yet');
expectRefused('3b refund before the deadline', await call(stranger, 'pool_refund', { id: id1 }), 'deadline not reached');

// 4 a third payer brings 0.3 for the ≈ 0.1 missing: trimmed, surplus back, locked
const sb = await balance(stranger.accountId);
r = must('4', await call(stranger, 'pool_fund', { id: id1 }, { deposit: NEAR * 3n / 10n }));
await sleep(2000);
const spent = sb - await balance(stranger.accountId);
p = await viewSure('pool', { id: id1 });
log(`4 a third payer ${stranger.accountId} brings 0.3 → ${p.status}, funded ${near(p.funded)} of ${near(p.target)}; the payer actually spent ${near(spent)} NEAR (share trimmed to what was missing, surplus returned): ${shares(p)}  ${EXPLORER(r.hash)}`);
step('4 third payer fills', { status: p.status, funded: p.funded, spent: spent.toString(), shares: p.shares, hash: r.hash });
expectRefused('4b one more share once full', await call(guarantor, 'pool_fund', { id: id1 }, { deposit: NEAR / 10n }), 'already full');
expectRefused('4c finish before the date', await call(stranger, 'pool_finish', { id: id1 }), 'too early');

// 5 at the date, a stranger pays the landlord
const wait = Number((t0 + 25n * S - await nowNs()) / S) + 2;
if (wait > 0) { log(`5 waiting ${wait} s for the pay date`); await sleep(wait * 1000); }
const lb = await balance(landlord.accountId);
r = must('5', await call(stranger, 'pool_finish', { id: id1 }));
await sleep(2000);
const got = await balance(landlord.accountId) - lb;
p = await viewSure('pool', { id: id1 });
log(`5 ${stranger.accountId} finishes → ${p.status}: landlord ${near(lb)} → ${near(lb + got)} NEAR (+${near(got)}), paid ${near(p.funded)} from three payers, closed by ${p.closed_by}  ${EXPLORER(r.hash)}`);
step('5 pool_finish', { status: p.status, got: got.toString(), closed_by: p.closed_by, hash: r.hash });

// 6 a pool nobody fills: 1 NEAR target, deadline 40 s, the guarantor alone brings 0.2
const t1 = await nowNs();
r = must('6', await call(tenant, 'pool_create', { destination: landlord.accountId, target: NEAR.toString(), deadline: (t1 + 40n * S).toString(), memos: ['lease:L-10', 'never filled'] }, { deposit: NEAR / 100n }));
const id2 = r.value;
r = must('6b', await call(guarantor, 'pool_fund', { id: id2 }, { deposit: NEAR * 2n / 10n }));
p = await viewSure('pool', { id: id2 });
log(`6 pool #${id2}: target 1 NEAR, deadline +40 s; the guarantor brings 0.2 → ${p.status}, funded ${near(p.funded)}: ${shares(p)}  ${EXPLORER(r.hash)}`);
step('6 second pool', { id: id2, status: p.status, funded: p.funded, hash: r.hash });
expectRefused('6c refund too soon', await call(stranger, 'pool_refund', { id: id2 }), 'deadline not reached');
const wait2 = Number((t1 + 40n * S - await nowNs()) / S) + 2;
log(`7 waiting ${wait2} s for the deadline`); await sleep(wait2 * 1000);
expectRefused('7a a share after the deadline', await call(tenant, 'pool_fund', { id: id2 }, { deposit: NEAR / 10n }), 'deadline passed');
const gb = await balance(guarantor.accountId), tb = await balance(tenant.accountId);
r = must('7b', await call(stranger, 'pool_refund', { id: id2 }));
await sleep(2000);
p = await viewSure('pool', { id: id2 });
log(`7b ${stranger.accountId} returns the shares → ${p.status}: guarantor ${near(gb)} → ${near(await balance(guarantor.accountId))} NEAR, tenant ${near(tb)} → ${near(await balance(tenant.accountId))} NEAR, closed by ${p.closed_by}  ${EXPLORER(r.hash)}`);
step('7b pool_refund', { status: p.status, closed_by: p.closed_by, hash: r.hash });
expectRefused('7c refund twice', await call(stranger, 'pool_refund', { id: id2 }), 'nothing to return');
report.finished = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
log('done');
