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
 *   1b the payslip itself, sealed for four readers (employee, URSSAF, pension fund, tax office), issued to the
 *      employee as a NEP-171 token; the pension fund opens it, a stranger sees bytes, nobody can transfer it
 *   2  a stranger tries to finish before the date → refused by the contract's clock
 *   3  the employer tries to cancel → refused: no cancel_after, nobody can
 *   4  one signature, three escrows (net pay, URSSAF, DGFiP) with create_batch; a short batch is refused whole
 *   5  delivery: condition = sha256(secret held by the oracle), fact = a public file and its hash; wrong secret refused
 *   6  a second delivery nobody will prove, deadline in 90 s → refunded by the oracle at the deadline
 *   7  the oracle's loop: finishes payroll and batch after the date, reveals the secret on the proven delivery, refunds the other
 *   8  finish again → already closed
 *   9  the deposit: the tenant locks 1 NEAR in a vault decided 2 of 3 (tenant, landlord, mediator); a stranger cannot vote;
 *      the landlord alone moves nothing; the tenant disagrees; the mediator sides with the quote → 0.15 to the landlord, 0.85 back
 *  10  a deposit nobody decides, deadline 60 s: timeout refused before, then anyone returns it all to the tenant
 */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { CONTRACT, EXPLORER, NEAR, account, balance, call, near, nowNs, view } from './lib.mjs';
import { ORACLE_ID, makeCondition, tick } from './oracle_near.mjs';
import { READERS, initKeys, open, seal, sha256hex } from './scelle.mjs';

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
// the RPC is load-balanced: a view right after a transaction can hit a node a block behind, so insist
const viewSure = async (method, args) => { for (let i = 0; i < 10; i++) { const v = await view(method, args); if (v != null) return v; await new Promise((r) => setTimeout(r, 1000)); } throw new Error(`${method} ${JSON.stringify(args)}: still null after 10 s`); };

log(`contract ${CONTRACT}, ${await view('count')} escrow(s) before this run, employee ${employee.accountId} has ${near(await balance(employee.accountId))} NEAR`);
// the real statement of the New York run: the pharmacist's Sunday shift, one-day contract, net 440.36 EUR
const bulletin = JSON.parse(readFileSync(new URL('../agent/sortie/bulletin.json', import.meta.url), 'utf8'));
const statement = sha256hex(Buffer.from(JSON.stringify(bulletin), 'utf8'));
initKeys();

// 1 payroll
const t0 = await nowNs();
const payDate = t0 + 75n * S;
const r1 = await call(employer, 'create', { destination: employee.accountId, finish_after: payDate.toString(),
  memos: [`sha256:${statement}`, 'net 440.36 EUR', `dareskro/oracle:${ORACLE_ID}`] }, { deposit: NEAR });
if (!r1.ok) throw new Error(r1.error);
const payrollId = r1.value;
const e1 = await viewSure('get', { id: payrollId });
log(`1 payroll escrow #${payrollId}: ${near(e1.amount)} NEAR to ${e1.destination}, payable at ${new Date(Number(payDate / 1_000_000n)).toISOString()}, memos ${JSON.stringify(e1.memos)}  ${EXPLORER(r1.hash)}`);
step('payroll_create', { id: payrollId, hash: r1.hash, escrow: e1 });

// 1b the payslip, sealed, as a token the employee owns
const sealed = seal(bulletin, { escrow: String(payrollId), period: bulletin.period });
const sealedStr = JSON.stringify(sealed);
const rP = await call(employer, 'issue_payslip', { owner_id: employee.accountId, escrow_id: payrollId, period: bulletin.period,
  sha256: sealed.sha256_plain, readers: READERS, sealed: sealedStr }, { deposit: NEAR * 15n / 100n });
if (!rP.ok) throw new Error(rP.error);
const token = rP.value;
log(`1b payslip ${token.token_id} issued to ${token.owner_id}: ${sealedStr.length} bytes sealed for ${READERS.join(', ')}; sha256 ${sealed.sha256_plain.slice(0, 16)}… = the escrow's memo  ${EXPLORER(rP.hash)}`);
// 1c who reads what
const onChain = await viewSure('payslip', { token_id: token.token_id });
const asRetraite = open(JSON.parse(onChain.sealed), 'retraite');
log(`1c the pension fund opens it with its key: period ${asRetraite.period}, ${asRetraite.employee.label}, total ${JSON.stringify(asRetraite.total)}`);
const asStranger = await viewSure('nft_token', { token_id: token.token_id });
let strangerOpens = 'opened (unexpected)';
try { open(JSON.parse(onChain.sealed), 'stranger'); } catch (e) { strangerOpens = e.message; }
log(`1c a stranger sees: owner ${asStranger.owner_id}, readers ${JSON.parse(asStranger.metadata.extra).readers.join('/')}, reference_hash ${asStranger.metadata.reference_hash}, ${onChain.sealed.length} opaque bytes (${JSON.parse(onChain.sealed).statement.ciphertext.slice(0, 24)}…); opening it: ${strangerOpens}`);
expectRefused('1d the employee gives the payslip away', await call(employee, 'nft_transfer', { receiver_id: stranger.accountId, token_id: token.token_id }, { deposit: 1n }), 'not transferable');
const mine = await view('nft_tokens_for_owner', { account_id: employee.accountId });
log(`1c the employee's wallet lists ${mine.length} payslip(s): ${mine.map((t) => t.metadata.title).join(', ')}`);
step('payslip', { token_id: token.token_id, hash: rP.hash, sealed_bytes: sealedStr.length, readers: READERS, sha256: sealed.sha256_plain,
  pension_fund_reads: { period: asRetraite.period, total: asRetraite.total }, stranger_opening: strangerOpens });

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
report.payslip_token = token.token_id;
log(`7 oracle ${ORACLE_ID} watching #${watched.join(', #')}; pay date in ${Number((payDate - await nowNs()) / S)} s`);
const submitted = [];
for (let i = 0; i < 40; i++) {
  submitted.push(...(await tick(log)));
  const open = (await Promise.all(watched.map((id) => view('get', { id })))).filter((e) => e.status === 'Locked');
  if (!open.length) break;
  await new Promise((r) => setTimeout(r, 8000));
}
const after = await balance(employee.accountId);
const closedAt = (await viewSure('get', { id: payrollId })).closed_at;
const finishedAfter = Number((BigInt(closedAt) - payDate) / S);
const payrollFinish = submitted.find((s) => s.id === payrollId && s.ok);
log(`7 done: employee ${near(before)} → ${near(after)} NEAR (+${near(after - before)}); payroll finished ${finishedAfter} s after the date by ${ORACLE_ID}, nobody clicked`);
step('oracle_loop', { submitted: submitted.map(({ id, action, ok, hash, error }) => ({ id, action, ok, hash, error })), employee_before: before.toString(), employee_after: after.toString() });

// 8
expectRefused('8 finish the payroll escrow twice', await call(stranger, 'finish', { id: payrollId }), 'already closed');

// 9 the deposit, decided 2 of 3
const landlord = employer, tenant = employee, mediator = account(ORACLE_ID);
const memo9 = ['lease:L-2026-11 · 12 rue de la Paix · deposit 1 200 EUR', `inventory_in:sha256:${sha256hex(Buffer.from('entry inventory L-2026-11'))}`,
  `inventory_out:sha256:${sha256hex(Buffer.from('exit inventory L-2026-11: living room wall to repaint'))}`, `quote:sha256:${sha256hex(Buffer.from('repainting quote 180 EUR'))} repainting quote 180 EUR`];
const t9 = await nowNs();
const r9 = await call(tenant, 'vault_create', { beneficiary: landlord.accountId, parties: [tenant.accountId, landlord.accountId, mediator.accountId], threshold: 2,
  deadline: (t9 + 600n * S).toString(), memos: memo9 }, { deposit: NEAR });
if (!r9.ok) throw new Error(r9.error);
const vaultId = r9.value;
const v9 = await viewSure('vault', { id: vaultId });
log(`9 deposit vault #${vaultId}: ${near(v9.amount)} NEAR locked by the tenant ${tenant.accountId} for the landlord ${landlord.accountId}, 2 of 3 with the mediator ${mediator.accountId}, deadline in 600 s  ${EXPLORER(r9.hash)}`);
step('vault_create', { id: vaultId, hash: r9.hash, vault: v9 });
const cut = (NEAR * 15n / 100n).toString(); // 180 / 1 200 of the deposit
const landlordBefore = await balance(landlord.accountId);
const tenantBefore = await balance(tenant.accountId);
expectRefused('9a a stranger votes', await call(stranger, 'vault_vote', { id: vaultId, to_beneficiary: cut }), 'not a party');
const r9b = await call(landlord, 'vault_vote', { id: vaultId, to_beneficiary: cut }, { gas: '100' });
if (!r9b.ok) throw new Error(r9b.error);
log(`9b the landlord alone votes 0.15 NEAR for himself → recorded, ${(await viewSure('vault', { id: vaultId })).status}, nothing moves  ${EXPLORER(r9b.hash)}`);
step('vault_vote_landlord_alone', { hash: r9b.hash, decided: r9b.value, status: (await viewSure('vault', { id: vaultId })).status });
const r9c = await call(tenant, 'vault_vote', { id: vaultId, to_beneficiary: '0' }, { gas: '100' });
if (!r9c.ok) throw new Error(r9c.error);
log(`9c the tenant votes 0 → two different votes, still ${(await viewSure('vault', { id: vaultId })).status}  ${EXPLORER(r9c.hash)}`);
step('vault_vote_tenant_disagrees', { hash: r9c.hash, decided: r9c.value });
const r9d = await call(mediator, 'vault_vote', { id: vaultId, to_beneficiary: cut }, { gas: '100' });
if (!r9d.ok) throw new Error(r9d.error);
const v9d = await viewSure('vault', { id: vaultId });
const landlordAfter = await balance(landlord.accountId);
const tenantAfter = await balance(tenant.accountId);
log(`9d the mediator sides with the quote → ${v9d.status}: ${near(v9d.paid_to_beneficiary)} NEAR to the landlord (${near(landlordBefore)} → ${near(landlordAfter)}), ${near(BigInt(v9d.amount) - BigInt(v9d.paid_to_beneficiary))} back to the tenant (${near(tenantBefore)} → ${near(tenantAfter)}), decided by ${v9d.closed_by}  ${EXPLORER(r9d.hash)}`);
step('vault_decided', { hash: r9d.hash, status: v9d.status, paid_to_beneficiary: v9d.paid_to_beneficiary, landlord_before: landlordBefore.toString(), landlord_after: landlordAfter.toString(), tenant_before: tenantBefore.toString(), tenant_after: tenantAfter.toString(), closed_by: v9d.closed_by });
expectRefused('9e the landlord votes again', await call(landlord, 'vault_vote', { id: vaultId, to_beneficiary: cut }), 'already closed');

// 10 a deposit nobody decides
const r10 = await call(tenant, 'vault_create', { beneficiary: landlord.accountId, parties: [tenant.accountId, landlord.accountId, mediator.accountId], threshold: 2,
  deadline: ((await nowNs()) + 60n * S).toString(), memos: ['lease:L-2026-12, nobody answers'] }, { deposit: NEAR / 2n });
if (!r10.ok) throw new Error(r10.error);
log(`10 deposit vault #${r10.value}: 0.5 NEAR, deadline in 60 s, nobody will vote  ${EXPLORER(r10.hash)}`);
step('vault_never_create', { id: r10.value, hash: r10.hash });
expectRefused('10a a stranger calls the deadline too soon', await call(stranger, 'vault_timeout', { id: r10.value }), 'deadline not reached');
const tenant10 = await balance(tenant.accountId);
await new Promise((r) => setTimeout(r, 62_000));
const r10b = await call(stranger, 'vault_timeout', { id: r10.value }, { gas: '100' });
if (!r10b.ok) throw new Error(r10b.error);
const v10 = await viewSure('vault', { id: r10.value });
log(`10b after the deadline the stranger returns it → ${v10.status}, tenant ${near(tenant10)} → ${near(await balance(tenant.accountId))} NEAR, called by ${v10.closed_by}  ${EXPLORER(r10b.hash)}`);
step('vault_timeout', { hash: r10b.hash, status: v10.status, closed_by: v10.closed_by });
report.deposit = { id: vaultId, decided_hash: r9d.hash, decided_explorer: EXPLORER(r9d.hash), paid_to_landlord_near: near(v9d.paid_to_beneficiary), back_to_tenant_near: near(BigInt(v9d.amount) - BigInt(v9d.paid_to_beneficiary)), timeout_id: r10.value, timeout_hash: r10b.hash };

report.payroll = { id: payrollId, amount_near: near(e1.amount), finish_after: payDate.toString(), destination: e1.destination,
  finish_hash: payrollFinish?.hash, finish_explorer: payrollFinish ? EXPLORER(payrollFinish.hash) : null, finished_after_s: finishedAfter };
report.finished = new Date().toISOString();
const all = await Promise.all(watched.map((id) => view('get', { id })));
report.final = Object.fromEntries(watched.map((id, i) => [id, { status: all[i].status, closed_by: all[i].closed_by, fulfillment: all[i].fulfillment }]));
writeFileSync(CR, JSON.stringify(report, null, 2) + '\n');
log(`report → compte_rendu.json; statuses ${JSON.stringify(report.final)}`);
