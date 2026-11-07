// dareskro on Casper 2.x: the Node client of the Odra escrow contract (./contract).
// Testnet only. Signs with PEM keys from ./cles (never committed); never prints a key.
//
// The Casper JS SDK (v5) detects whether the node speaks 1.x or 2.0 (CasperNetwork) and
// sends the matching format; the testnet runs casper-node 2.2.2, so everything below
// goes out as TransactionV1.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sdk from 'casper-js-sdk';

const {
  Args, CLValue, CLTypeUInt8, CLTypeString, CLValueParser, CasperNetwork, ContractCallBuilder,
  HttpHandler, Key, KeyAlgorithm, NativeTransferBuilder, PrivateKey, PublicKey, PurseIdentifier,
  RpcClient, SessionBuilder, ParamDictionaryIdentifier, ParamDictionaryIdentifierContractNamedKey,
  CLTypeUInt64, CLTypeKey, CLTypeUInt512, CLTypeOption, CLTypeList,
} = sdk;

export const HERE = dirname(fileURLToPath(import.meta.url));
export const NODE = process.env.CASPER_NODE || 'https://node.testnet.casper.network/rpc';
export const CHAIN = process.env.CASPER_CHAIN || 'casper-test';
export const EXPLORER = process.env.CASPER_EXPLORER || 'https://testnet.cspr.live';
export const CSPR = 1_000_000_000n;
export const KEY_NAME = 'dareskro_escrow'; // named key of the deployer that holds the package hash

const DEPLOYMENT_FILE = join(HERE, 'deploiement.json');
export const deployment = () => (existsSync(DEPLOYMENT_FILE) ? JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8')) : null);
/** `hash-<hex>` of the contract package: CASPER_ESCROW_HASH first, then deploiement.json. */
export function packageHash() {
  const h = process.env.CASPER_ESCROW_HASH || deployment()?.package_hash;
  if (!h) throw new Error('CASPER_ESCROW_HASH is empty and casper/deploiement.json is missing: the contract is not deployed');
  return h.startsWith('hash-') ? h : `hash-${h}`;
}

export const rpc = new RpcClient(new HttpHandler(NODE));
let _network;
/** Version-aware client (1.x or 2.0 detected from the node's status). */
export async function network() {
  if (!_network) _network = await CasperNetwork.create(rpc);
  return _network;
}

export const explorerTx = (hash) => `${EXPLORER}/transaction/${hash}`;
export const explorerAccount = (pk) => `${EXPLORER}/account/${pk.toHex()}`;
export const explorerContract = (pkg) => `${EXPLORER}/contract-package/${pkg.replace(/^hash-/, '')}`;

/** Loads an Ed25519 secret key PEM (casper-client keygen format). */
export function loadKey(path) {
  return PrivateKey.fromPem(readFileSync(path, 'utf8'), KeyAlgorithm.ED25519);
}
export const keyPath = (name) => join(HERE, 'cles', name);
export const accountKey = (pk) => Key.newKey(pk.accountHash().toPrefixedString());
export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
export const cspr = (motes) => (Number(BigInt(motes) / 1_000_000n) / 1000).toFixed(3);

export async function balance(pk) {
  const r = await rpc.queryLatestBalance(PurseIdentifier.fromPublicKey(pk));
  return BigInt(r.balance.toString());
}

/** Lowercase hex of the account hash, as the contract stores an `Address`. */
export const accountHashHex = (pk) => pk.accountHash().toHex().replace(/^account-hash-/, '');

// ------------------------------------------------------------------ sending

/** Signs, sends and waits for a transaction; never throws on a revert.
 *  Returns {ok, hash, error, code, cost, link}. `code` is the Odra user error number. */
export async function send(tx, signer, { timeout = 240_000 } = {}) {
  tx.sign(signer);
  const net = await network();
  const put = await net.putTransaction(tx);
  const hash = (put.transactionHash ?? put.deployHash).toHex ? (put.transactionHash ?? put.deployHash).toHex() : String(put.transactionHash ?? put.deployHash);
  const res = await rpc.waitForTransaction(tx, timeout);
  const ex = res.executionInfo?.executionResult;
  const error = ex?.errorMessage || null;
  const m = error && error.match(/User error: (\d+)/);
  return {
    ok: !error,
    hash,
    error,
    code: m ? Number(m[1]) : null,
    reason: m ? ERRORS[Number(m[1])] || null : null,
    cost: ex?.cost != null ? String(ex.cost) : null,
    consumed: ex?.consumed != null ? String(ex.consumed) : null,
    link: explorerTx(hash),
    raw: res,
  };
}

/** The contract's errors, as numbered in contract/src/escrow.rs. */
export const ERRORS = {
  1: 'NotAdmin', 2: 'NotAuthorized', 3: 'TooEarly', 4: 'NotCancellable', 5: 'CancelTooEarly',
  6: 'NotFound', 7: 'AlreadyClosed', 8: 'ZeroAmount', 9: 'BadDates', 10: 'BadCondition',
  11: 'WrongFulfillment', 12: 'FeeTooHigh', 13: 'NothingToWithdraw',
};

/** A call to an entry point of the package (no CSPR attached). */
export function callTx(sender, entryPoint, args, paymentMotes = 5n * CSPR) {
  return new ContractCallBuilder()
    .from(sender.publicKey)
    .byPackageHash(packageHash().replace(/^hash-/, ''))
    .entryPoint(entryPoint)
    .runtimeArgs(args)
    .chainName(CHAIN)
    .payment(Number(paymentMotes))
    .ttl(30 * 60 * 1000)
    .build();
}

/** A payable call: Odra contracts receive CSPR through a `cargo_purse` that session code
 *  fills from the caller's main purse, so the call goes through Odra's proxy_caller.wasm
 *  (contract/wasm/proxy_caller.wasm, from the odra crate of the same version). */
export function payableCallTx(sender, entryPoint, args, attachedMotes, paymentMotes = 10n * CSPR) {
  const inner = args.toBytes();
  const outer = Args.fromMap({
    package_hash: CLValue.newCLByteArray(Buffer.from(packageHash().replace(/^hash-/, ''), 'hex')),
    entry_point: CLValue.newCLString(entryPoint),
    args: CLValue.newCLList(CLTypeUInt8, Array.from(inner).map((b) => CLValue.newCLUint8(b))),
    attached_value: CLValue.newCLUInt512(attachedMotes.toString()),
    amount: CLValue.newCLUInt512(attachedMotes.toString()),
  });
  return new SessionBuilder()
    .from(sender.publicKey)
    .wasm(new Uint8Array(readFileSync(join(HERE, 'wasm', 'proxy_caller.wasm'))))
    .runtimeArgs(outer)
    .chainName(CHAIN)
    .payment(Number(paymentMotes))
    .ttl(30 * 60 * 1000)
    .build();
}

// --------------------------------------------------------------- the escrow

/** create(beneficiary, release_after, cancel_after, condition?, memo) with `amount` motes attached. */
export function createTx(payer, { beneficiary, amount, releaseAfter = 0n, cancelAfter = 0n, condition = null, memo }) {
  const args = Args.fromMap({
    beneficiary: CLValue.newCLKey(accountKey(beneficiary)),
    release_after: CLValue.newCLUint64(releaseAfter.toString()),
    cancel_after: CLValue.newCLUint64(cancelAfter.toString()),
    condition: CLValue.newCLOption(condition ? CLValue.newCLString(condition) : null, CLTypeString),
    memo: CLValue.newCLString(memo),
  });
  return payableCallTx(payer, 'create', args, BigInt(amount));
}
export const releaseTx = (signer, id, fulfillment = null) =>
  callTx(signer, 'release', Args.fromMap({
    id: CLValue.newCLUint64(String(id)),
    fulfillment: CLValue.newCLOption(fulfillment ? CLValue.newCLString(fulfillment) : null, CLTypeString),
  }));
export const refundTx = (signer, id) => callTx(signer, 'refund', Args.fromMap({ id: CLValue.newCLUint64(String(id)) }));
export const setFeeTx = (admin, bps) => callTx(admin, 'set_fee', Args.fromMap({ fee_bps: CLValue.newCLUInt32(bps) }));
export const setOracleTx = (admin, oraclePk) => callTx(admin, 'set_oracle', Args.fromMap({ oracle: CLValue.newCLKey(accountKey(oraclePk)) }));
export const withdrawFeesTx = (admin, toPk) => callTx(admin, 'withdraw_fees', Args.fromMap({ to: CLValue.newCLKey(accountKey(toPk)) }));

/** Native CSPR transfer (funds a demo account). */
export function transferTx(sender, toPk, motes) {
  return new NativeTransferBuilder()
    .from(sender.publicKey).target(toPk).amount(motes.toString()).id(Date.now() % 1_000_000)
    .chainName(CHAIN).payment(100_000_000).build();
}

// ---------------------------------------------------------------- reading
// Odra keeps every field in the contract's `state` dictionary under
// blake2b(index_bytes ++ mapping_key_bytes) in hex, where index_bytes is the field index
// (1-based, nibble-packed into a big-endian u32) and the mapping key is the key's bytesrepr.
// Reading is free: no transaction, a state query on the current contract version.

const FIELD = { admin: 1, oracle: 2, fee_bps: 3, fees_collected: 4, count: 5, escrows: 6 };

let _blake;
async function blake2b(bytes) {
  if (!_blake) _blake = (await import('@noble/hashes/blake2b')).blake2b;
  return _blake(bytes, { dkLen: 32 });
}
export async function storageKey(field, mappingKeyBytes = new Uint8Array()) {
  const idx = Buffer.alloc(4); idx.writeUInt32BE(FIELD[field]);
  const h = await blake2b(Buffer.concat([idx, Buffer.from(mappingKeyBytes)]));
  return Buffer.from(h).toString('hex');
}

let _contractHash;
/** `hash-<hex>` of the current contract version inside the package (where `state` lives). */
export async function contractHash() {
  if (_contractHash) return _contractHash;
  const r = await rpc.queryLatestGlobalState(packageHash(), []);
  const pkg = r.storedValue.contractPackage ?? r.storedValue.package;
  const versions = pkg.versions ?? pkg.entityVersions;
  const last = versions[versions.length - 1];
  const h = (last.contractHash ?? last.entityAddr ?? last.addressableEntityHash);
  _contractHash = 'hash-' + String(h.toPrefixedString?.() ?? h.toHex?.() ?? h).replace(/^(contract-|hash-|entity-contract-)/, '');
  return _contractHash;
}

/** Raw bytes of one state entry, or null. */
export async function readState(field, mappingKeyBytes) {
  const key = await storageKey(field, mappingKeyBytes);
  const id = new ParamDictionaryIdentifier(undefined, new ParamDictionaryIdentifierContractNamedKey(await contractHash(), 'state', key));
  try {
    const r = await rpc.getDictionaryItemByIdentifier(null, id);
    const cl = r.storedValue.clValue;
    // Odra wraps the bytesrepr of the value in Casper `Bytes` (List<U8>): unwrap it.
    const json = CLValueParser.toJSON(cl);
    return Buffer.from(json.bytes, 'hex').subarray(4);
  } catch (e) {
    if (/ValueNotFound|not found|-32003/i.test(String(e.message))) return null;
    throw e;
  }
}

const u64le = (b) => Buffer.alloc(8, Buffer.from(new BigUint64Array([BigInt(b)]).buffer));
export const readCount = async () => { const b = await readState('count'); return b ? Buffer.from(b).readBigUInt64LE() : 0n; };
export const readFeeBps = async () => { const b = await readState('fee_bps'); return b ? Buffer.from(b).readUInt32LE() : 0; };
export const readOracle = async () => { const b = await readState('oracle'); return b ? 'account-hash-' + Buffer.from(b).subarray(1).toString('hex') : null; };
export async function readFeesCollected() { const b = await readState('fees_collected'); return b ? u512(Buffer.from(b)).value : 0n; }

function u512(buf, off = 0) { const n = buf[off]; let v = 0n; for (let i = n; i >= 1; i--) v = (v << 8n) | BigInt(buf[off + i]); return { value: v, off: off + 1 + n }; }
function str(buf, off) { const n = buf.readUInt32LE(off); return { value: buf.subarray(off + 4, off + 4 + n).toString('utf8'), off: off + 4 + n }; }
function key(buf, off) { const tag = buf[off]; const hex = buf.subarray(off + 1, off + 33).toString('hex'); return { value: (tag === 0 ? 'account-hash-' : 'hash-') + hex, off: off + 33 }; }
function opt(buf, off, inner) { if (buf[off] === 0) return { value: null, off: off + 1 }; const r = inner(buf, off + 1); return r; }
const STATUS = ['open', 'released', 'refunded'];

/** The escrow record `id`, decoded from the contract state, or null. */
export async function readEscrow(id) {
  const b = await readState('escrows', u64le(id));
  if (!b) return null;
  const buf = Buffer.from(b); let o = 0, r;
  const e = {};
  e.id = buf.readBigUInt64LE(o).toString(); o += 8;
  r = key(buf, o); e.payer = r.value; o = r.off;
  r = key(buf, o); e.beneficiary = r.value; o = r.off;
  r = u512(buf, o); e.amount = r.value.toString(); o = r.off;
  e.release_after = buf.readBigUInt64LE(o).toString(); o += 8;
  e.cancel_after = buf.readBigUInt64LE(o).toString(); o += 8;
  r = opt(buf, o, str); e.condition = r.value; o = r.off;
  r = str(buf, o); e.memo = r.value; o = r.off;
  e.status = STATUS[buf[o]] ?? buf[o]; o += 1;
  e.created_at = buf.readBigUInt64LE(o).toString(); o += 8;
  e.closed_at = buf.readBigUInt64LE(o).toString(); o += 8;
  r = opt(buf, o, key); e.closed_by = r.value; o = r.off;
  r = opt(buf, o, str); e.fulfillment = r.value; o = r.off;
  r = u512(buf, o); e.fee_paid = r.value.toString(); o = r.off;
  return e;
}

/** Block time of the node, ms (the contract compares its dates to this). */
export async function chainNow() {
  const b = await rpc.getLatestBlock();
  const ts = b.block?.timestamp;
  const d = ts?.toJSON?.() ?? ts?.date ?? ts ?? b.rawJSON?.block_with_signatures?.block?.Version2?.header?.timestamp;
  return BigInt(new Date(d).getTime());
}
