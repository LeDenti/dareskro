#!/usr/bin/env node
/**
 * dareskro oracle, NEAR edition — the named third party that executes what the
 * contract already decided. Same job as ../oracle/oracle.mjs on XRPL.
 *
 * It never holds the funds: they sit in the escrow contract and go to the
 * destination written at creation, whoever calls `finish`. It cannot pay early
 * (the contract's clock refuses), cannot redirect (no such parameter), cannot
 * cancel a payroll escrow (no cancel_after). On a payroll escrow its whole power
 * is punctuality; on a conditional one it decides *whether*, by reading a public
 * fact and revealing the secret whose sha256 is the condition.
 *
 *   node oracle_near.mjs condition --kind delivery --url U --sha256 H   → prints the condition (hex)
 *   node oracle_near.mjs condition --kind presence --url U --contains T
 *   node oracle_near.mjs watch [--every 10]                              → loop: finish / cancel what the clock and the facts allow
 *   node oracle_near.mjs tick                                            → one pass
 *   node oracle_near.mjs status
 *
 * Secrets live in .oracle_near.json (0600, never committed). The oracle signs
 * with dareskro-oracle.testnet (DARESKRO_ORACLE to change).
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTRACT, EXPLORER, account, call, nowNs, view } from './lib.mjs';

const REG = new URL('./.oracle_near.json', import.meta.url);
export const ORACLE_ID = process.env.DARESKRO_ORACLE || 'dareskro-oracle.testnet';
const sha256hex = (b) => createHash('sha256').update(b).digest('hex');

export const registry = () => (existsSync(REG) ? JSON.parse(readFileSync(REG, 'utf8')) : { conditions: {} });
function save(r) { writeFileSync(REG, JSON.stringify(r, null, 2)); chmodSync(REG, 0o600); }

/** A fresh secret; only its sha256 leaves this file. */
export function makeCondition({ kind, url, sha256, contains, note }) {
  const secret = randomBytes(32).toString('hex');
  const condition = sha256hex(Buffer.from(secret, 'hex'));
  const r = registry();
  r.conditions[condition] = { kind, url, sha256, contains, note, secret, createdAt: new Date().toISOString() };
  save(r);
  return condition;
}

/** The public fact, read online. */
export async function proven(c) {
  let res;
  try { res = await fetch(c.url, { redirect: 'follow' }); } catch (e) { return { ok: false, why: e.message }; }
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
  const body = Buffer.from(await res.arrayBuffer());
  if (c.kind === 'delivery') {
    const h = sha256hex(body);
    return h === c.sha256 ? { ok: true, why: 'sha256 matches' } : { ok: false, why: `sha256 ${h.slice(0, 8)}… ≠ ${c.sha256.slice(0, 8)}…` };
  }
  if (c.kind === 'presence') {
    const ok = !c.contains || body.toString('utf8').includes(c.contains);
    return { ok, why: ok ? 'the text is there' : 'the text is not there' };
  }
  return { ok: false, why: `unknown kind ${c.kind}` };
}

/** One pass over every escrow of the contract. Returns what it submitted. */
export async function tick(log = console.log) {
  const oracle = account(ORACLE_ID);
  const now = await nowNs();
  const r = registry();
  const done = [];
  for (let from = 1; ;) {
    const page = await view('list', { from_index: String(from), limit: 50 });
    if (!page.length) break;
    for (const [id, e] of page) {
      from = Number(id) + 1;
      if (e.status !== 'Locked') continue;
      const fa = e.finish_after ? BigInt(e.finish_after) : null;
      const ca = e.cancel_after ? BigInt(e.cancel_after) : null;
      if (ca !== null && now >= ca) {
        const res = await call(oracle, 'cancel', { id });
        log(`escrow #${id}: past cancel_after, refund to ${e.owner} → ${res.ok ? 'done' : 'refused: ' + res.error} ${EXPLORER(res.hash)}`);
        done.push({ id, action: 'cancel', ...res });
        continue;
      }
      if (fa !== null && now < fa) continue; // the clock says no; nothing to try
      if (!e.condition) {
        const res = await call(oracle, 'finish', { id });
        log(`escrow #${id}: date passed, finish → ${res.ok ? `done, ${e.destination} credited` : 'refused: ' + res.error} ${EXPLORER(res.hash)}`);
        done.push({ id, action: 'finish', ...res });
        continue;
      }
      const c = r.conditions[e.condition];
      if (!c) continue; // not one of ours
      const p = await proven(c);
      if (!p.ok) { log(`escrow #${id}: ${c.kind} not proven (${p.why}), waiting`); continue; }
      const res = await call(oracle, 'finish', { id, fulfillment: c.secret });
      log(`escrow #${id}: ${c.kind} proven (${p.why}), secret revealed → ${res.ok ? `done, ${e.destination} credited` : 'refused: ' + res.error} ${EXPLORER(res.hash)}`);
      done.push({ id, action: 'finish', ...res });
    }
    if (page.length < 50) break;
  }
  return done;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
  const stamp = () => new Date().toISOString().slice(11, 19);
  const log = (s) => console.log(`${stamp()} ${s}`);
  switch (argv[0]) {
    case 'condition': console.log(makeCondition({ kind: opt('kind') || 'delivery', url: opt('url'), sha256: opt('sha256'), contains: opt('contains'), note: opt('note') })); break;
    case 'tick': await tick(log); break;
    case 'watch': {
      const every = Number(opt('every') || 10) * 1000;
      log(`oracle ${ORACLE_ID} watching ${CONTRACT} every ${every / 1000} s`);
      for (;;) { try { await tick(log); } catch (e) { log(`error: ${e.message}`); } await new Promise((r) => setTimeout(r, every)); }
    }
    case 'status': {
      const r = registry();
      console.log(JSON.stringify({ oracle: ORACLE_ID, contract: CONTRACT, conditions: Object.fromEntries(Object.entries(r.conditions).map(([k, v]) => [k, { ...v, secret: '(kept)' }])) }, null, 2));
      break;
    }
    default: console.error('usage: node oracle_near.mjs condition|tick|watch|status'); process.exit(2);
  }
}
