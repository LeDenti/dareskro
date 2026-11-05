#!/usr/bin/env node
/**
 * dareskro on NEAR — the claimable balance, measured on testnet. Writes reclamation.log and
 * compte_rendu_claimable.json.
 *
 * near-sdk-rs#1666: a transfer the chain refuses — the receiving account was deleted between
 * the creation and the date — came back to the contract with nothing recording it. Now the
 * callback reads the legs it paid one by one and credits each refused leg to the receiver's
 * name; the name claims it when it exists again (`claim`); the payer may take it back after
 * 30 days (`claim_for`). Nothing is retried: a deleted name can be re-registered by someone else.
 *
 * What it shows, in order:
 *   1  the employer creates fantome.dareskro-employer.testnet, the receiver, and locks 0.3 NEAR for it
 *   2  the receiver deletes itself (its balance goes to the employer)
 *   3  a stranger finishes the escrow: the transfer is refused, the record is Finished, 0.3 NEAR is
 *      credited to the name; the contract's balance did not move
 *   4  a stranger has nothing to claim; a stranger is not the payer; the payer is 30 days too early
 *   5  the name is registered again (here by the same employer, with a new key) and claims: paid
 *   6  the deposit: the tenant locks 0.5 NEAR for the name as beneficiary, 2 of 3; the name is deleted;
 *      the vote that decides pays two legs: the tenant's lands, the beneficiary's is credited
 *   7  the name comes back and claims the 0.15 NEAR; nothing is left to claim
 *
 *   DARESKRO_CONTRACT=dareskro-v2.testnet node reclamation_near.mjs      # DARESKRO_GHOST=<prefix> for another name
 *
 * The receiver's key is written to cles/<name>.key (0600, never in git) so a rerun can delete the
 * name first; a name whose key is lost keeps its credit until the payer's 30 days are up.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Account, KeyPair } from 'near-api-js';
import { CONTRACT, EXPLORER, NEAR, account, balance, call, near, provider, view } from './lib.mjs';
import { ORACLE_ID } from './oracle_near.mjs';

const LOG = new URL('./reclamation.log', import.meta.url);
const OUT = new URL('./compte_rendu_claimable.json', import.meta.url);
writeFileSync(LOG, '');
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const log = (s) => { const line = `${stamp()}  ${s}`; console.log(line); appendFileSync(LOG, line + '\n'); };
const report = { network: 'testnet', contract: CONTRACT, issue: 'https://github.com/near/near-sdk-rs/issues/1666', started: new Date().toISOString(), steps: [] };
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
const claimable = async (id) => BigInt(await viewSure('claimable_of', { account: id }));
const exists = async (id) => { try { await provider.viewAccount({ accountId: id }); return true; } catch { return false; } };

const employer = account('dareskro-employer.testnet');
const tenant = account('dareskro-employee.testnet');
const mediator = account(ORACLE_ID);
const stranger = account('dareskro-stranger.testnet');
const GHOST = `${process.env.DARESKRO_GHOST || 'fantome'}.${employer.accountId}`;
const KEYFILE = new URL(`./cles/${GHOST}.key`, import.meta.url);

/** The employer registers the name with a fresh key (kept in cles/, 0600); the account signs for itself. */
async function registerGhost(amount) {
  const kp = KeyPair.fromRandom('ed25519');
  const r = await employer.createSubAccount({ accountOrPrefix: GHOST, publicKey: kp.getPublicKey(), nearToTransfer: amount });
  writeFileSync(KEYFILE, kp.toString() + '\n'); chmodSync(KEYFILE, 0o600);
  return { ghost: new Account(GHOST, provider, kp.toString()), hash: r.transaction.hash };
}

log(`contract ${CONTRACT}: ${near(await viewSure('claimable_total'))} NEAR claimable before this run, delay ${Number(BigInt(await viewSure('claim_delay')) / 86_400_000_000_000n)} days; ${GHOST} exists: ${await exists(GHOST)}`);
if (await exists(GHOST)) {
  if (!existsSync(KEYFILE)) throw new Error(`${GHOST} already exists and its key is not in cles/: choose another DARESKRO_GHOST`);
  const d0 = await new Account(GHOST, provider, readFileSync(KEYFILE, 'utf8').trim()).deleteAccount(employer.accountId);
  log(`0 ${GHOST} left over from an earlier run, deleted  ${EXPLORER(d0.transaction.hash)}`);
}

// 1 the receiver, then 0.3 NEAR locked for it
let { ghost, hash } = await registerGhost(NEAR / 5n);
log(`1 ${GHOST} created by the employer with 0.2 NEAR  ${EXPLORER(hash)}`);
step('1 receiver created', { account: GHOST, hash });
let r = must('1b', await call(employer, 'create', { destination: GHOST, memos: ['net 440.36 EUR', 'the receiver will be deleted before the date'] }, { deposit: NEAR * 3n / 10n }));
const escrowId = r.value;
let e = await viewSure('get', { id: escrowId });
log(`1b escrow #${escrowId}: ${near(e.amount)} NEAR to ${e.destination}, no date, payable by anyone  ${EXPLORER(r.hash)}`);
step('1b create', { id: escrowId, escrow: e, hash: r.hash });

// 2 the receiver disappears
let d = await ghost.deleteAccount(employer.accountId);
log(`2 ${GHOST} deleted itself, balance to the employer; exists: ${await exists(GHOST)}  ${EXPLORER(d.transaction.hash)}`);
step('2 receiver deleted', { hash: d.transaction.hash, exists: await exists(GHOST) });

// 3 finish: the leg is refused, credited to the name
const cb = await balance(CONTRACT);
r = must('3', await call(stranger, 'finish', { id: escrowId }));
await sleep(2000);
e = await viewSure('get', { id: escrowId });
let credited = await claimable(GHOST);
const lines = await viewSure('claimable_lines', { account: GHOST });
const ca = await balance(CONTRACT);
log(`3 ${stranger.accountId} finishes → callback ${r.value} (a leg was refused): escrow ${e.status}, ${near(credited)} NEAR claimable by ${GHOST} (payer ${lines[0].payer}, act ${lines[0].act}), contract ${near(cb)} → ${near(ca)} NEAR; logs: ${r.logs.filter((l) => l.includes('transfer_failed') || l.includes('credit_claimable')).length} events  ${EXPLORER(r.hash)}`);
step('3 finish to a deleted account', { callback: r.value, status: e.status, claimable: credited.toString(), lines, contract_before: cb.toString(), contract_after: ca.toString(), events: r.logs.filter((l) => l.includes('EVENT_JSON')), hash: r.hash });
if (e.status !== 'Finished' || credited !== BigInt(e.amount)) throw new Error('3: expected Finished and the whole amount credited');

// 4 who may not claim it
expectRefused('4a a stranger claims', await call(stranger, 'claim'), 'nothing to claim');
expectRefused('4b a stranger claims for the name', await call(stranger, 'claim_for', { account: GHOST }), 'not the payer');
expectRefused('4c the payer, 30 days too early', await call(employer, 'claim_for', { account: GHOST }), 'too early');

// 5 the name again, with another key: it claims
({ ghost, hash } = await registerGhost(NEAR / 10n));
log(`5 ${GHOST} registered again by the employer, new key, 0.1 NEAR for gas  ${EXPLORER(hash)}`);
step('5 receiver registered again', { hash });
let gb = await balance(GHOST);
r = must('5b', await call(ghost, 'claim'));
await sleep(2000);
let ga = await balance(GHOST);
log(`5b ${GHOST} claims → callback ${r.value}: ${near(gb)} → ${near(ga)} NEAR (+${near(ga - gb)}), claimable now ${near(await claimable(GHOST))}, total ${near(await viewSure('claimable_total'))}  ${EXPLORER(r.hash)}`);
step('5b claim', { callback: r.value, before: gb.toString(), after: ga.toString(), claimable: (await claimable(GHOST)).toString(), hash: r.hash });
expectRefused('5c claim twice', await call(ghost, 'claim'), 'nothing to claim');

// 6 the deposit with two legs: beneficiary = the name, which is deleted before the decision
r = must('6', await call(tenant, 'vault_create', { beneficiary: GHOST, parties: [tenant.accountId, mediator.accountId, stranger.accountId], threshold: 2, memos: ['lease:L-fantome', 'the landlord will be deleted before the decision'] }, { deposit: NEAR / 2n }));
const vaultId = r.value;
let v = await viewSure('vault', { id: vaultId });
log(`6 vault #${vaultId}: ${near(v.amount)} NEAR by the tenant ${tenant.accountId} for ${GHOST}, 2 of 3  ${EXPLORER(r.hash)}`);
step('6 vault_create', { id: vaultId, vault: v, hash: r.hash });
d = await ghost.deleteAccount(employer.accountId);
log(`6b ${GHOST} deleted itself again; exists: ${await exists(GHOST)}  ${EXPLORER(d.transaction.hash)}`);
step('6b beneficiary deleted', { hash: d.transaction.hash });
const cut = (NEAR * 15n / 100n).toString();
r = must('6c', await call(mediator, 'vault_vote', { id: vaultId, to_beneficiary: cut }));
log(`6c the mediator votes 0.15 NEAR to the beneficiary → ${r.value} (recorded, nothing moves)  ${EXPLORER(r.hash)}`);
step('6c first vote', { decided: r.value, hash: r.hash });
const tb = await balance(tenant.accountId);
r = must('6d', await call(stranger, 'vault_vote', { id: vaultId, to_beneficiary: cut }));
await sleep(2000);
v = await viewSure('vault', { id: vaultId });
const ta = await balance(tenant.accountId);
credited = await claimable(GHOST);
const vlines = await viewSure('claimable_lines', { account: GHOST });
log(`6d the stranger votes the same → ${v.status}, callback ${r.value}: tenant's leg landed ${near(tb)} → ${near(ta)} NEAR (+${near(ta - tb)}), beneficiary's leg ${near(credited)} NEAR credited to ${GHOST} (payer ${vlines[0].payer}, act ${vlines[0].act})  ${EXPLORER(r.hash)}`);
step('6d decided, one leg refused', { status: v.status, callback: r.value, paid_to_beneficiary: v.paid_to_beneficiary, tenant_before: tb.toString(), tenant_after: ta.toString(), claimable: credited.toString(), lines: vlines, events: r.logs.filter((l) => l.includes('EVENT_JSON')), hash: r.hash });
if (v.status !== 'Finished' || credited !== BigInt(cut)) throw new Error('6d: expected Finished and 0.15 NEAR credited');

// 7 the name comes back and claims
({ ghost, hash } = await registerGhost(NEAR / 10n));
log(`7 ${GHOST} registered a third time  ${EXPLORER(hash)}`);
step('7 receiver registered again', { hash });
gb = await balance(GHOST);
r = must('7b', await call(ghost, 'claim'));
await sleep(2000);
ga = await balance(GHOST);
const total = await viewSure('claimable_total');
log(`7b ${GHOST} claims → callback ${r.value}: ${near(gb)} → ${near(ga)} NEAR (+${near(ga - gb)}); claimable total of the contract: ${near(total)} NEAR  ${EXPLORER(r.hash)}`);
step('7b claim', { callback: r.value, before: gb.toString(), after: ga.toString(), claimable_total: total, hash: r.hash });
d = await ghost.deleteAccount(employer.accountId);
log(`7c ${GHOST} deleted, balance back to the employer  ${EXPLORER(d.transaction.hash)}`);
step('7c receiver deleted', { hash: d.transaction.hash });
report.finished = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
log('done');
