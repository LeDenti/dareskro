#!/usr/bin/env node
// dareskro on Casper 2.x: the testnet run. Writes run.log and compte_rendu.json.
//
// Accounts: the deployer key (cles/secret_key.pem, the VPS testnet key) plays the
// employer (payer) and the administrator; `oracle` and `stranger` are keys generated
// here (cles/oracle.pem, cles/stranger.pem, funded with a few CSPR from the deployer);
// `employee` (cles/employee.pem) is only ever paid.
//
// What it shows, in order, each with its transaction hash:
//   1  create: the employer locks 10 CSPR for the employee, payable in 70 s; memo = statement sha256
//   2  release before the date, by the oracle → refused: TooEarly
//   3  release by a stranger after the date → refused: NotAuthorized (wrong key)
//   3b release with a condition and the wrong fulfillment → refused: WrongFulfillment
//   4  release by the oracle after the date → the employee is credited
//   5  refund: a delivery nobody proves (cancel_after = +60 s): refund before → CancelTooEarly;
//      refund after, by a stranger → the employer gets its money back
//   6  the fee per act: set_fee(101) refused by the code (FeeTooHigh), set_fee(100) accepted,
//      a release keeps 1 %, withdraw_fees pays it out, set_fee(0)
//   7  release the released escrow again → AlreadyClosed
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import sdk from 'casper-js-sdk';
import {
  CHAIN, CSPR, EXPLORER, balance, chainNow, cspr, createTx, deployment, explorerAccount, keyPath, loadKey,
  network, packageHash, readCount, readEscrow, readFeeBps, readFeesCollected, readOracle, refundTx, releaseTx,
  send, setFeeTx, setOracleTx, sha256hex, transferTx, withdrawFeesTx, accountHashHex,
} from './dareskro_casper.mjs';

const { PrivateKey, KeyAlgorithm } = sdk;
if (CHAIN === 'casper') throw new Error('mainnet is not a decision this script takes');

const LOG = new URL('./run.log', import.meta.url);
const CR = new URL('./compte_rendu.json', import.meta.url);
writeFileSync(LOG, '');
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const log = (s) => { const line = `${stamp()}  ${s}`; console.log(line); appendFileSync(LOG, line + '\n'); };
const dep = deployment();
const report = { chain: CHAIN, package_hash: packageHash(), package_link: dep?.package_link, started: new Date().toISOString(), accounts: {}, steps: [] };
const step = (name, data) => { report.steps.push({ name, ...data }); writeFileSync(CR, JSON.stringify(report, null, 2) + '\n'); };
const expectRefused = (name, res, reason) => {
  const ok = !res.ok && res.reason === reason;
  log(`${name} → ${res.ok ? 'ACCEPTED (unexpected)' : `refused: ${res.reason ?? res.error}`}  ${res.link}`);
  step(name, { expected: `refused: ${reason}`, got: res.ok ? 'accepted' : `${res.reason ?? ''} (${res.error})`, hash: res.hash, link: res.link, cost_motes: res.cost, as_expected: ok });
  if (!ok) throw new Error(`${name}: expected ${reason}, got ${res.ok ? 'success' : res.error}`);
};
const expectOk = (name, res, extra = {}) => {
  log(`${name} → ${res.ok ? 'executed' : `FAILED: ${res.error}`}  ${res.link}`);
  step(name, { hash: res.hash, link: res.link, cost_motes: res.cost, as_expected: res.ok, ...(res.ok ? {} : { error: res.error }), ...extra });
  if (!res.ok) throw new Error(`${name}: ${res.error}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitChain(untilMs, label) {
  for (;;) {
    const now = await chainNow();
    if (now >= untilMs + 1_000n) return now;
    log(`   waiting for the chain's clock: ${label} in ${(untilMs - now) / 1000n} s`);
    await sleep(15_000);
  }
}

// ---------------------------------------------------------------- accounts
function keyOrNew(name) {
  const p = keyPath(name);
  if (!existsSync(p)) {
    const k = PrivateKey.generate(KeyAlgorithm.ED25519);
    writeFileSync(p, k.toPem(), { mode: 0o600 });
  }
  return loadKey(p);
}
const employer = loadKey(keyPath('secret_key.pem'));
const oracle = keyOrNew('oracle.pem');
const stranger = keyOrNew('stranger.pem');
const employee = keyOrNew('employee.pem');
const who = { employer, oracle, stranger, employee };
const net = await network();
log(`dareskro on Casper — chain ${CHAIN}, node api ${net.apiVersion}, package ${packageHash()}`);
for (const [n, k] of Object.entries(who)) {
  const b = await balance(k.publicKey).catch(() => 0n);
  report.accounts[n] = { public_key: k.publicKey.toHex(), account_hash: k.publicKey.accountHash().toPrefixedString(), link: explorerAccount(k.publicKey), balance_before: b.toString() };
  log(`${n.padEnd(8)} ${k.publicKey.toHex()} ${cspr(b)} CSPR`);
}
log(`employer balance ${cspr(await balance(employer.publicKey))} CSPR; contract count=${await readCount()} fee_bps=${await readFeeBps()} oracle=${await readOracle()}`);

// gas for the oracle and the stranger (they only pay fees), from the employer
for (const [n, k, need] of [['oracle', oracle, 40n], ['stranger', stranger, 60n]]) {
  if ((await balance(k.publicKey).catch(() => 0n)) < 30n * CSPR) {
    const r = await send(transferTx(employer, k.publicKey, need * CSPR), employer);
    expectOk(`0 fund ${n} with ${need} CSPR`, r);
  }
}
// name the oracle, once
const oracleHash = 'account-hash-' + accountHashHex(oracle.publicKey);
if ((await readOracle()) !== oracleHash) {
  expectOk('0 set_oracle (by the administrator)', await send(setOracleTx(employer, oracle.publicKey), employer), { oracle: oracleHash });
}
if ((await readFeeBps()) !== 0) expectOk('0 set_fee(0) (reset)', await send(setFeeTx(employer, 0), employer));

const MEMO = 'sha256:e1537eda93fa56819e53981e0d6343c4602cbb8e8f9fd591048eb0bed6a58835'; // the November statement
const employeeBefore = await balance(employee.publicKey).catch(() => 0n);

// ------------------------------------------------------------ 1  payroll
let now = await chainNow();
const releaseAt = now + 70_000n;
let r = await send(createTx(employer, { beneficiary: employee.publicKey, amount: 10n * CSPR, releaseAfter: releaseAt, cancelAfter: 0n, memo: MEMO }), employer);
expectOk('1 create 10 CSPR → employee, release_after = +70 s, no cancel date, memo = statement sha256', r);
const id1 = await readCount();
const e1 = await readEscrow(id1);
log(`   escrow #${id1}: ${JSON.stringify(e1)}`);
step('1 state', { id: id1.toString(), escrow: e1 });

// ------------------------------------------------------- 2  too early
expectRefused('2 release(#' + id1 + ') by the oracle BEFORE the date', await send(releaseTx(oracle, id1), oracle), 'TooEarly');

// ------------------------------------------------- 5a  the delivery escrow
now = await chainNow();
const cancelAt = now + 60_000n;
const SECRET = 'bon de livraison 2026-11-07 signe';
r = await send(createTx(employer, { beneficiary: employee.publicKey, amount: 5n * CSPR, releaseAfter: 0n, cancelAfter: cancelAt, condition: sha256hex(SECRET), memo: 'sha256:' + sha256hex('preuve de livraison') }), employer);
expectOk('5 create 5 CSPR → employee, condition = sha256(secret), cancel_after = +60 s (a delivery nobody will prove)', r);
const id2 = await readCount();
step('5 state', { id: id2.toString(), escrow: await readEscrow(id2) });
expectRefused('5a refund(#' + id2 + ') by the employer BEFORE cancel_after', await send(refundTx(employer, id2), employer), 'CancelTooEarly');
expectRefused('3b release(#' + id2 + ') by a stranger with the WRONG fulfillment', await send(releaseTx(stranger, id2, 'mauvaise cle'), stranger), 'WrongFulfillment');

// ------------------------------------------------- 3  wrong key, after the date
await waitChain(releaseAt, 'release_after of #' + id1);
expectRefused('3 release(#' + id1 + ') by a stranger AFTER the date (not the oracle, no condition)', await send(releaseTx(stranger, id1), stranger), 'NotAuthorized');
expectRefused('3 release(#' + id1 + ') by the payer itself (the employer)', await send(releaseTx(employer, id1), employer), 'NotAuthorized');

// ------------------------------------------------- 4  the oracle pays
r = await send(releaseTx(oracle, id1), oracle);
const employeeAfter = await balance(employee.publicKey);
expectOk(`4 release(#${id1}) by the oracle after the date → employee ${cspr(employeeBefore)} → ${cspr(employeeAfter)} CSPR`, r, { employee_balance_before: employeeBefore.toString(), employee_balance_after: employeeAfter.toString(), escrow: await readEscrow(id1) });
if (employeeAfter - employeeBefore !== 10n * CSPR) throw new Error('the employee did not receive 10 CSPR');

// ------------------------------------------------- 7  already closed
expectRefused('7 release(#' + id1 + ') again by the oracle', await send(releaseTx(oracle, id1), oracle), 'AlreadyClosed');

// ------------------------------------------------- 5b  refund after the date
await waitChain(cancelAt, 'cancel_after of #' + id2);
const employerBefore = await balance(employer.publicKey);
r = await send(refundTx(stranger, id2), stranger);
const employerAfter = await balance(employer.publicKey);
expectOk(`5b refund(#${id2}) by a stranger after cancel_after → employer ${cspr(employerBefore)} → ${cspr(employerAfter)} CSPR (+5)`, r, { employer_balance_before: employerBefore.toString(), employer_balance_after: employerAfter.toString(), escrow: await readEscrow(id2) });

// ------------------------------------------------- 6  the fee per act
expectRefused('6 set_fee(101 bps) by the administrator', await send(setFeeTx(employer, 101), employer), 'FeeTooHigh');
expectRefused('6 set_fee(10 bps) by a stranger', await send(setFeeTx(stranger, 10), stranger), 'NotAdmin');
expectOk('6 set_fee(100 bps = 1 %) by the administrator', await send(setFeeTx(employer, 100), employer), { fee_bps: await readFeeBps() });
r = await send(createTx(employer, { beneficiary: employee.publicKey, amount: 10n * CSPR, releaseAfter: 0n, cancelAfter: 0n, condition: sha256hex(SECRET), memo: MEMO }), employer);
expectOk('6 create 10 CSPR → employee, condition = sha256(secret), payable at once', r);
const id3 = await readCount();
const b3 = await balance(employee.publicKey);
r = await send(releaseTx(stranger, id3, SECRET), stranger);
const a3 = await balance(employee.publicKey);
expectOk(`6 release(#${id3}) by a stranger WITH the right secret → employee +${cspr(a3 - b3)} CSPR (9.9), fee kept 0.1`, r, { employee_balance_before: b3.toString(), employee_balance_after: a3.toString(), escrow: await readEscrow(id3), fees_collected: (await readFeesCollected()).toString() });
if (a3 - b3 !== 99n * CSPR / 10n) throw new Error('the fee was not 1 %');
expectRefused('6 withdraw_fees by a stranger', await send(withdrawFeesTx(stranger, stranger.publicKey), stranger), 'NotAdmin');
expectOk('6 withdraw_fees to the administrator', await send(withdrawFeesTx(employer, employer.publicKey), employer), { fees_collected_after: (await readFeesCollected()).toString() });
expectOk('6 set_fee(0) back to zero', await send(setFeeTx(employer, 0), employer), { fee_bps: await readFeeBps() });

for (const [n, k] of Object.entries(who)) report.accounts[n].balance_after = (await balance(k.publicKey)).toString();
report.finished = new Date().toISOString();
report.all_as_expected = report.steps.every((s) => s.as_expected !== false);
writeFileSync(CR, JSON.stringify(report, null, 2) + '\n');
log(`done: ${report.steps.length} steps, all as expected: ${report.all_as_expected}; employer ${cspr(report.accounts.employer.balance_before)} → ${cspr(report.accounts.employer.balance_after)} CSPR`);
