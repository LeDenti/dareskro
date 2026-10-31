// Shared by the oracle, the deploy script and the demo. Testnet only.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, JsonRpcProvider, actions, teraToGas } from 'near-api-js';

export const NETWORK = 'testnet';
export const RPC = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com';
export const CONTRACT = process.env.DARESKRO_CONTRACT || 'dareskro.testnet';
export const provider = new JsonRpcProvider({ url: RPC });
export const EXPLORER = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;

/** Keys as near-cli-rs `save-to-legacy-keychain` writes them: ~/.near-credentials/testnet/<id>.json */
export function credentials(id) {
  const f = join(homedir(), '.near-credentials', NETWORK, `${id}.json`);
  const d = JSON.parse(readFileSync(f, 'utf8'));
  return { publicKey: d.public_key, privateKey: d.private_key };
}
export const account = (id) => new Account(id, provider, credentials(id).privateKey);

export const view = (method, args = {}, contractId = CONTRACT) => provider.callFunction({ contractId, method, args });
export const nowNs = async () => BigInt(await view('now'));
export const balance = async (id) => BigInt((await provider.viewAccount({ accountId: id })).amount);
export const NEAR = 10n ** 24n;
export const near = (yocto) => (Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4);

/** One function call; never throws on a contract panic, returns {ok, hash, value|error, logs}. */
export async function call(acct, method, args = {}, { deposit = 0n, gas = '60', contractId = CONTRACT } = {}) {
  const r = await acct.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(method, args, teraToGas(gas), BigInt(deposit))],
    throwOnFailure: false,
  });
  const hash = r.transaction.hash;
  const logs = (r.receipts_outcome || []).flatMap((o) => o.outcome?.logs || []);
  const st = r.status;
  if (st && typeof st === 'object' && 'SuccessValue' in st) {
    const raw = Buffer.from(st.SuccessValue, 'base64').toString();
    return { ok: true, hash, value: raw ? JSON.parse(raw) : null, logs };
  }
  const s = JSON.stringify(st);
  const m = s.match(/Smart contract panicked: ([^"\\]*)/);
  return { ok: false, hash, error: m ? m[1] : s, logs };
}
