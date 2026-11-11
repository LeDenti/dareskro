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

/**
 * One function call; never throws on a contract panic, returns {ok, hash, value|error, logs}.
 * near-api-js >= 7.5.3 throws a typed error for a refused call: a contract panic is a
 * HostGuestPanicError whose `panicMessage` is the contract's own text, and the error carries
 * `transactionResult`, so the hash and the logs come without a second RPC call
 * (near/near-api-js#2026; before 7.5.3 the text had to be cut out of a string).
 * Anything that is not a failed execution (bad key, no network) is still thrown.
 */
export async function call(acct, method, args = {}, { deposit = 0n, gas = '60', contractId = CONTRACT } = {}) {
  const logsOf = (r) => (r?.receipts_outcome || []).flatMap((o) => o.outcome?.logs || []);
  let r;
  try {
    r = await acct.signAndSendTransaction({
      receiverId: contractId,
      actions: [actions.functionCall(method, args, teraToGas(gas), BigInt(deposit))],
    });
  } catch (e) {
    const t = e.transactionResult;
    if (!t) throw e;
    return { ok: false, hash: t.transaction.hash, error: e.panicMessage ?? e.message, logs: logsOf(t) };
  }
  const hash = r.transaction.hash;
  const st = r.status;
  if (st && typeof st === 'object' && 'SuccessValue' in st) {
    const raw = Buffer.from(st.SuccessValue, 'base64').toString();
    return { ok: true, hash, value: raw ? JSON.parse(raw) : null, logs: logsOf(r) };
  }
  return { ok: false, hash, error: JSON.stringify(st), logs: logsOf(r) };
}
