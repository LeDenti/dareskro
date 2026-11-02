#!/usr/bin/env node
/**
 *   node deploy_near.mjs deploy --admin <id>   deploy contract/target/near/dareskro_escrow.wasm on dareskro.testnet
 *                                              and call new(admin): the account that sets the fee per act
 *   node deploy_near.mjs deploy --migrate --admin <id>   redeploy on an initialised account and call migrate(admin)
 *                                              (state layout changed; every record is kept, the fee starts at zero)
 *   node deploy_near.mjs keys       list the contract account's access keys
 *   node deploy_near.mjs lock --yes delete every full-access key: from then on nobody can change the code or
 *                                   take the balance; the administrator can only set the fee and withdraw it.
 *                                   Irreversible.
 */
import { readFileSync } from 'node:fs';
import { PublicKey, actions, teraToGas } from 'near-api-js';
import { CONTRACT, EXPLORER, account, view } from './lib.mjs';

const WASM = new URL('./contract/target/near/dareskro_escrow.wasm', import.meta.url);
const cmd = process.argv[2];
const owner = account(CONTRACT);

if (cmd === 'deploy') {
  const code = new Uint8Array(readFileSync(WASM));
  let initialised = true;
  try { await view('count'); } catch { initialised = false; }
  const acts = [actions.deployContract(code)];
  const migrate = process.argv.includes('--migrate');
  const admin = process.argv[process.argv.indexOf('--admin') + 1];
  if ((!initialised || migrate) && (process.argv.indexOf('--admin') < 0 || !admin)) {
    console.error('new() and migrate() need --admin <account>: the account that will set the fee per act'); process.exit(2);
  }
  if (!initialised) acts.push(actions.functionCall('new', { admin }, teraToGas('30'), 0n));
  else if (migrate) acts.push(actions.functionCall('migrate', { admin }, teraToGas('30'), 0n));
  const r = await owner.signAndSendTransaction({ receiverId: CONTRACT, actions: acts });
  console.log(`${initialised ? (process.argv.includes('--migrate') ? 'code replaced and state migrated' : 'code replaced') : 'deployed and initialised'} on ${CONTRACT}: ${EXPLORER(r.transaction.hash)}`);
  console.log(`count = ${await view('count')}, vaults = ${await view('vault_count')}, fees = ${JSON.stringify(await view('fees'))}`);
} else if (cmd === 'keys') {
  const l = await owner.getAccessKeyList();
  for (const k of l.keys) console.log(k.public_key, JSON.stringify(k.access_key.permission));
} else if (cmd === 'lock') {
  if (process.argv[3] !== '--yes') { console.error('this deletes every key of the contract account for ever; add --yes'); process.exit(2); }
  const l = await owner.getAccessKeyList();
  const full = l.keys.filter((k) => k.access_key.permission === 'FullAccess');
  const r = await owner.signAndSendTransaction({ receiverId: CONTRACT, actions: full.map((k) => actions.deleteKey(PublicKey.fromString(k.public_key))) });
  console.log(`${full.length} full-access key(s) deleted: ${EXPLORER(r.transaction.hash)}`);
  console.log(`keys left: ${(await owner.getAccessKeyList()).keys.length}`);
} else {
  console.error('usage: node deploy_near.mjs deploy [--migrate] --admin <id> | keys | lock --yes'); process.exit(2);
}
