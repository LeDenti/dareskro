#!/usr/bin/env node
/**
 * The pay desk's NEAR rail — a local service the React desk (app/) talks to, the way it
 * talks to the Solana desk (solana/desk). It holds the TESTNET keys of the demo accounts
 * (~/.near-credentials/testnet, written by near-cli-rs) and signs what the operator clicks:
 *
 *   GET  /identity        contract, clock, the roles and their balances, counts
 *   GET  /escrows         every escrow of the contract (the chain is the registry)
 *   GET  /vaults          every shared deposit, with its votes
 *   GET  /payslips?owner= the sealed payslips of an account (NEP-171 tokens)
 *   POST /lock            payroll escrow: the employer locks the statement's net pay for the employee
 *   POST /attempt         a forbidden action, sent for real so the refusal is on chain
 *   POST /vault/create    the tenant locks the deposit: beneficiary, parties, threshold, deadline, memos
 *   POST /vault/vote      one party's vote (amount to the beneficiary); the vote that reaches the threshold pays
 *   POST /vault/timeout   past the deadline, anyone returns everything to the owner
 *
 * Roles → testnet accounts: tenant & employee = dareskro-employee, landlord & employer =
 * dareskro-employer, mediator = dareskro-oracle, stranger = dareskro-stranger. Nothing
 * here is a hardware wallet: on NEAR the parties sign with keys on the desk machine.
 * Everything signed is appended to sortie/desk.log and sortie/{locks,vaults}.json.
 */
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT, EXPLORER, NEAR, NETWORK, account, balance, call, near, nowNs, view } from '../lib.mjs';
import { ORACLE_ID } from '../oracle_near.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DESK_NEAR_PORT || 8794);
const OUT = join(HERE, 'sortie');
const LOG = join(OUT, 'desk.log');
const LOCKS = join(OUT, 'locks.json');
const VAULTS = join(OUT, 'vaults.json');
const ACCOUNT_URL = (id) => `https://testnet.nearblocks.io/address/${id}`;
const log = (s) => { const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC  ${s}`; console.log(line); appendFileSync(LOG, line + '\n'); };
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
const push = (f, rec) => { const l = readJson(f, []); l.push(rec); writeFileSync(f, JSON.stringify(l, null, 2) + '\n'); };

const ROLES = {
  tenant: 'dareskro-employee.testnet', employee: 'dareskro-employee.testnet',
  landlord: 'dareskro-employer.testnet', employer: 'dareskro-employer.testnet',
  mediator: ORACLE_ID, stranger: 'dareskro-stranger.testnet',
};
const signer = (role) => { const id = ROLES[role]; if (!id) throw new Error(`unknown role ${role}`); return account(id); };
const toYocto = (n) => { const s = String(n); const [i, f = ''] = s.split('.'); return BigInt(i || '0') * NEAR + BigInt((f + '0'.repeat(24)).slice(0, 24)); };
const S = 1_000_000_000n;
const outcome = (r) => ({ ok: r.ok, hash: r.hash, explorer: EXPLORER(r.hash), error: r.ok ? null : r.error, logs: r.logs });

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  res.end(JSON.stringify(body, null, 2));
};
const withBody = (req, res, handler) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => { try { await handler(JSON.parse(body || '{}')); } catch (err) { log(`400: ${err.message}`); json(res, 400, { error: String(err.message ?? err) }); } });
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return json(res, 204, {});
  try {
    if (req.method === 'GET' && url.pathname === '/identity') {
      const ids = [...new Set(Object.values(ROLES))];
      const bal = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, near(await balance(id))])));
      const [count, vaults, payslips, now] = await Promise.all([view('count'), view('vault_count'), view('nft_total_supply'), nowNs()]);
      return json(res, 200, { network: NETWORK, contract: CONTRACT, contractExplorer: ACCOUNT_URL(CONTRACT), chainNowMs: Number(now / 1_000_000n),
        roles: Object.fromEntries(Object.entries(ROLES).map(([r, id]) => [r, { account: id, balanceNear: bal[id], explorer: ACCOUNT_URL(id) }])),
        counts: { escrows: Number(count), vaults: Number(vaults), payslips: Number(payslips) } });
    }
    if (req.method === 'GET' && url.pathname === '/escrows') {
      const list = await view('list', { from_index: '1', limit: 200 });
      const locks = readJson(LOCKS, []);
      return json(res, 200, { escrows: list.map(([id, e]) => ({ id, ...e, amountNear: near(e.amount), lock: locks.find((l) => l.id === id) ?? null })) });
    }
    if (req.method === 'GET' && url.pathname === '/vaults') {
      const list = await view('vaults', { from_index: '1', limit: 200 });
      const recs = readJson(VAULTS, []);
      return json(res, 200, { vaults: list.map(([id, v]) => ({ id, ...v, amountNear: near(v.amount), paidToBeneficiaryNear: near(v.paid_to_beneficiary),
        votes: v.votes.map((x) => ({ ...x, toBeneficiaryNear: near(x.to_beneficiary) })), history: recs.filter((r) => r.id === id) })) });
    }
    if (req.method === 'GET' && url.pathname === '/payslips') {
      const owner = url.searchParams.get('owner') || ROLES.employee;
      const tokens = await view('nft_tokens_for_owner', { account_id: owner });
      return json(res, 200, { owner, payslips: tokens.map((t) => ({ ...t, extra: JSON.parse(t.metadata.extra || '{}') })) });
    }
    if (req.method === 'POST' && url.pathname === '/lock') {
      return withBody(req, res, async (p) => {
        // p: { statementSha256, fiat: {amount, currency}, destination?, finishAfterS?, nearAmount?, validatedBy? }
        if (!/^[0-9a-f]{64}$/i.test(p.statementSha256 ?? '')) throw new Error('statementSha256 must be 64 hex chars');
        const employer = signer('employer');
        const destination = p.destination || ROLES.employee;
        const finishAfter = (await nowNs()) + BigInt(Math.max(5, Number(p.finishAfterS ?? 90))) * S;
        const memos = [`sha256:${p.statementSha256.toLowerCase()}`, `net ${Number(p.fiat?.amount).toFixed(2)} ${p.fiat?.currency ?? 'EUR'}${p.validatedBy ? ` validated by ${p.validatedBy}` : ''}`, `dareskro/oracle:${ORACLE_ID}`];
        const r = await call(employer, 'create', { destination, finish_after: finishAfter.toString(), memos }, { deposit: toYocto(p.nearAmount ?? 1) });
        if (!r.ok) throw new Error(r.error);
        const e = await view('get', { id: r.value });
        const rec = { id: r.value, ...outcome(r), destination, finishAfter: finishAfter.toString(), finishAfterMs: Number(finishAfter / 1_000_000n), memos, amountNear: near(e.amount), lockedAt: new Date().toISOString() };
        push(LOCKS, rec);
        log(`lock escrow #${rec.id}: ${rec.amountNear} NEAR to ${destination}, payable in ${p.finishAfterS ?? 90} s  ${rec.explorer}`);
        json(res, 201, rec);
      });
    }
    if (req.method === 'POST' && url.pathname === '/attempt') {
      return withBody(req, res, async (p) => {
        // p: { id, what: 'early-finish' | 'cancel' | 'finish' }
        const what = p.what;
        const who = what === 'cancel' ? 'employer' : 'stranger';
        const r = what === 'cancel' ? await call(signer('employer'), 'cancel', { id: p.id }) : await call(signer('stranger'), 'finish', { id: p.id });
        const rec = { id: p.id, what, who: ROLES[who], ...outcome(r), refused: !r.ok, at: new Date().toISOString() };
        log(`attempt ${what} on #${p.id} by ${rec.who}: ${r.ok ? 'accepted' : 'refused: ' + r.error}  ${rec.explorer}`);
        json(res, 200, rec);
      });
    }
    if (req.method === 'POST' && url.pathname === '/vault/create') {
      return withBody(req, res, async (p) => {
        // p: { owner: role, beneficiary: role, parties: role[], threshold, deadlineS?, nearAmount, memos? }
        const owner = signer(p.owner ?? 'tenant');
        const parties = [...new Set((p.parties ?? ['tenant', 'landlord', 'mediator']).map((r) => ROLES[r] ?? r))];
        const deadline = p.deadlineS ? ((await nowNs()) + BigInt(Math.max(5, Number(p.deadlineS))) * S).toString() : null;
        const r = await call(owner, 'vault_create', { beneficiary: ROLES[p.beneficiary ?? 'landlord'], parties, threshold: Number(p.threshold ?? 2), deadline, memos: p.memos ?? [] }, { deposit: toYocto(p.nearAmount ?? 1) });
        if (!r.ok) throw new Error(r.error);
        const v = await view('vault', { id: r.value });
        const rec = { id: r.value, action: 'create', by: owner.accountId, ...outcome(r), amountNear: near(v.amount), parties, threshold: v.threshold, deadline, at: new Date().toISOString() };
        push(VAULTS, rec);
        log(`vault #${rec.id} created by ${owner.accountId}: ${rec.amountNear} NEAR for ${v.beneficiary}, ${v.threshold} of ${parties.length}${deadline ? ', deadline in ' + p.deadlineS + ' s' : ''}  ${rec.explorer}`);
        json(res, 201, rec);
      });
    }
    if (req.method === 'POST' && url.pathname === '/vault/vote') {
      return withBody(req, res, async (p) => {
        // p: { id, as: role, toBeneficiaryNear }
        const who = signer(p.as);
        const r = await call(who, 'vault_vote', { id: p.id, to_beneficiary: toYocto(p.toBeneficiaryNear ?? 0).toString() }, { gas: '100' });
        const v = await view('vault', { id: p.id });
        const rec = { id: p.id, action: 'vote', by: who.accountId, toBeneficiaryNear: String(p.toBeneficiaryNear ?? 0), ...outcome(r), decided: r.ok && r.value !== false, status: v?.status ?? null, refused: !r.ok, at: new Date().toISOString() };
        push(VAULTS, rec);
        log(`vault #${p.id} vote by ${who.accountId}: ${p.toBeneficiaryNear} NEAR to the beneficiary → ${r.ok ? (rec.decided ? 'DECIDED, paid' : 'recorded, ' + v.votes.length + ' vote(s)') : 'refused: ' + r.error}  ${rec.explorer}`);
        json(res, 200, rec);
      });
    }
    if (req.method === 'POST' && url.pathname === '/vault/timeout') {
      return withBody(req, res, async (p) => {
        const who = signer(p.as ?? 'stranger');
        const r = await call(who, 'vault_timeout', { id: p.id });
        const v = await view('vault', { id: p.id });
        const rec = { id: p.id, action: 'timeout', by: who.accountId, ...outcome(r), status: v?.status ?? null, refused: !r.ok, at: new Date().toISOString() };
        push(VAULTS, rec);
        log(`vault #${p.id} timeout by ${who.accountId}: ${r.ok ? 'returned to the owner' : 'refused: ' + r.error}  ${rec.explorer}`);
        json(res, 200, rec);
      });
    }
    json(res, 404, { error: 'not found' });
  } catch (err) { log(`500: ${err.message}`); json(res, 500, { error: String(err.message ?? err) }); }
}).listen(PORT, '127.0.0.1', () => log(`desk NEAR (${CONTRACT}, ${NETWORK}) listening on http://127.0.0.1:${PORT}`));
