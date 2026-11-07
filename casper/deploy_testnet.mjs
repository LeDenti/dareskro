// Installs the dareskro escrow on casper-test with the JS SDK (TransactionV1, install-upgrade
// lane), as `casper-client put-transaction session --install-upgrade` would. Idempotent reading:
// if deploiement.json exists, it only prints it. Never mainnet.
//
//   node deploy_testnet.mjs            # uses cles/secret_key.pem (the VPS testnet key)
//   CASPER_PAYMENT_CSPR=400 node deploy_testnet.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sdk from 'casper-js-sdk';
import {
  CHAIN, CSPR, HERE, KEY_NAME, NODE, balance, cspr, deployment, explorerAccount, explorerContract,
  explorerTx, keyPath, loadKey, network, rpc, send,
} from './dareskro_casper.mjs';

const { Args, CLValue, SessionBuilder } = sdk;

if (CHAIN === 'casper') throw new Error('mainnet is not a decision this script takes');

const existing = deployment();
if (existing && !process.env.FORCE_REDEPLOY) {
  console.log('already deployed:', JSON.stringify(existing, null, 2));
  process.exit(0);
}

const deployer = loadKey(keyPath('secret_key.pem'));
const pk = deployer.publicKey;
const net = await network();
console.log(`node ${NODE} api ${net.apiVersion} chain ${CHAIN}`);
console.log(`deployer ${pk.toHex()} (${pk.accountHash().toPrefixedString()}) balance ${cspr(await balance(pk))} CSPR`);

const wasm = new Uint8Array(readFileSync(join(HERE, 'wasm', 'DareskroEscrow.wasm')));
const payment = BigInt(process.env.CASPER_PAYMENT_CSPR || 400) * CSPR;
// The four odra_cfg_* arguments are what Odra's generated `call` entry point reads
// (MissingArg 64658 without them); `init` takes no argument.
const args = Args.fromMap({
  odra_cfg_package_hash_key_name: CLValue.newCLString(KEY_NAME),
  odra_cfg_allow_key_override: CLValue.newCLValueBool(Boolean(process.env.FORCE_REDEPLOY)),
  odra_cfg_is_upgradable: CLValue.newCLValueBool(true),
  odra_cfg_is_upgrade: CLValue.newCLValueBool(false),
});
const tx = new SessionBuilder()
  .from(pk).wasm(wasm).installOrUpgrade().runtimeArgs(args)
  .chainName(CHAIN).payment(Number(payment)).ttl(30 * 60 * 1000)
  .build();
console.log(`installing ${wasm.length} bytes of wasm, payment ${cspr(payment)} CSPR, install-upgrade lane ...`);
const r = await send(tx, deployer, { timeout: 600_000 });
console.log(`transaction ${r.hash} ${r.ok ? 'executed' : 'FAILED: ' + r.error} cost ${r.cost} consumed ${r.consumed}`);
console.log(r.link);
if (!r.ok) process.exit(1);

// The package hash is under the deployer's named key.
const acct = await rpc.queryLatestGlobalState(pk.accountHash().toPrefixedString(), []);
const named = acct.storedValue.account?.namedKeys ?? acct.storedValue.addressableEntity?.namedKeys ?? [];
const nk = named.find((k) => k.name === KEY_NAME);
if (!nk) throw new Error(`named key ${KEY_NAME} not found on the deployer account: ${JSON.stringify(named.map((k) => k.name))}`);
const packageHash = 'hash-' + String(nk.key.toPrefixedString?.() ?? nk.key.toString?.() ?? nk.key).replace(/^(hash-|contract-package-|package-)/, '');
const out = {
  chain: CHAIN,
  node: NODE,
  deployer: pk.toHex(),
  deployer_account: pk.accountHash().toPrefixedString(),
  deployer_link: explorerAccount(pk),
  package_hash: packageHash,
  package_link: explorerContract(packageHash),
  named_key: KEY_NAME,
  install_transaction: r.hash,
  install_link: explorerTx(r.hash),
  install_cost_motes: r.cost,
  wasm_bytes: wasm.length,
  wasm_sha256: (await import('node:crypto')).createHash('sha256').update(wasm).digest('hex'),
  odra: '2.10.0',
  installed_at: new Date().toISOString(),
};
writeFileSync(join(HERE, 'deploiement.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
console.log(`balance after ${cspr(await balance(pk))} CSPR`);
