/**
 * XRPL side of dareskro's pay desk, with xrpl.js on testnet.
 * getBalance, fundFromFaucet, encodeUnsigned, encodeSigned and submit come from Ledger's
 * workshop (Apache-2.0, see THIRD_PARTY_NOTICES.md); the rest is dareskro's.
 *
 * The Ledger device only signs bytes. Building the escrow, serializing it,
 * adding the signature and submitting it is this file's job.
 *
 * The payroll escrow has ONE shape, measured on testnet in September (prior study, not in this repository):
 *   FinishAfter at the pay date, NO Condition, NO CancelAfter.
 *   -> EscrowFinish before the date      tecNO_PERMISSION
 *   -> EscrowCancel by the employer      tecNO_PERMISSION (no CancelAfter, ever)
 *   -> EscrowFinish after the date, by anyone   tesSUCCESS
 * The employer has no transaction that takes the money back. One outcome.
 */
import { bufferToHexaString } from "@ledgerhq/device-management-kit";
import {
  Client,
  encode,
  xrpToDrops,
  type CheckCash,
  type CheckCreate,
  type EscrowCancel,
  type EscrowCreate,
  type EscrowFinish,
  type SubmittableTransaction,
  type Transaction,
  type Wallet,
} from "xrpl";

const TESTNET_URL = "wss://testnet.xrpl-labs.com";
const FAUCET_URL = "https://faucet.altnet.rippletest.net/accounts";
/** XRPL counts seconds since 2000-01-01, not 1970. */
const RIPPLE_EPOCH = 946684800;

export const explorerAccountUrl = (address: string) =>
  `https://testnet.xrpl.org/accounts/${address}`;
export const explorerTxUrl = (hash: string) =>
  `https://testnet.xrpl.org/transactions/${hash}`;

export const rippleTime = (date: Date) =>
  Math.floor(date.getTime() / 1000) - RIPPLE_EPOCH;
export const fromRippleTime = (t: number) => new Date((t + RIPPLE_EPOCH) * 1000);

/** Text to hex, uppercase, for Memo fields. */
export const toHex = (s: string) =>
  Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

const client = new Client(TESTNET_URL);

async function connected(): Promise<Client> {
  if (!client.isConnected()) await client.connect();
  return client;
}

/**
 * The testnet websocket drops now and then ("websocket was closed", seen
 * 24/10/2026 on venue Wi-Fi). xrpl.js does not reconnect by itself: reconnect
 * and retry once. Safe for reads and for autofill; submits are retried too
 * because a dropped socket before the answer leaves the result unknown anyway.
 */
async function withRetry<T>(f: (c: Client) => Promise<T>): Promise<T> {
  try {
    return await f(await connected());
  } catch (e) {
    const msg = String((e as { message?: string }).message ?? e);
    if (!/websocket was closed|not connected|NotConnectedError/i.test(msg)) throw e;
    try {
      await client.disconnect();
    } catch {
      /* already closed */
    }
    return f(await connected());
  }
}

/** XRP balance, or null if the account doesn't exist yet. */
export async function getBalance(address: string): Promise<number | null> {
  return withRetry(async (c) => {
    try {
      return await c.getXrpBalance(address);
    } catch (e) {
      if ((e as { data?: { error?: string } }).data?.error === "actNotFound")
        return null;
      throw e;
    }
  });
}

/** Free test XRP for the employer's Ledger address. */
export async function fundFromFaucet(address: string): Promise<void> {
  const res = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destination: address }),
  });
  if (!res.ok) throw new Error(`Faucet: ${res.status} ${await res.text()}`);
}

/**
 * Ask the faucet until the balance reaches `minXrp`. The testnet faucet gives
 * about 100 XRP per call and the demo locks 466.57 XRP: one call is not enough
 * (tecUNFUNDED, measured 24/10/2026).
 */
export async function fundUntil(address: string, minXrp: number, maxRounds = 10): Promise<number | null> {
  let bal = await getBalance(address);
  let failures = 0;
  for (let i = 0; i < maxRounds && (bal === null || bal < minXrp); i++) {
    try {
      await fundFromFaucet(address);
      failures = 0;
    } catch (e) {
      // the faucet throttles bursts (a browser then sees "Failed to fetch"): pause and try again, give up after three in a row
      if (++failures >= 3) throw e;
      await new Promise((r) => setTimeout(r, 8000));
    }
    await new Promise((r) => setTimeout(r, 5000));
    bal = await getBalance(address);
  }
  return bal;
}

/** A brand-new funded testnet account: the employee, or the third party who releases. */
export async function newFundedWallet(): Promise<Wallet> {
  return withRetry(async (c) => (await c.fundWallet()).wallet);
}

/**
 * The pay is in euros; the escrow is in XRP. The statement's total is converted
 * at the rate of the moment, and the memo carries the euro amount and the rate,
 * so the device shows both. With a euro stablecoin whose issuer allows
 * trustline locking, the escrow would hold euros directly.
 */
export type Rate = { eurPerXrp: number; currency: string; source: string; at: string };

/** Fiat per XRP for the statement's currency (USD or EUR): Kraken, CoinGecko as fallback. */
export async function xrpEurRate(currency = "USD"): Promise<Rate> {
  const cur = currency.toUpperCase() === "EUR" ? "EUR" : "USD";
  try {
    const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=XRP${cur}`, { cache: "no-store" });
    const j = (await r.json()) as { result?: Record<string, { c: string[] }> };
    const pair = j.result && Object.values(j.result)[0];
    if (pair?.c?.[0]) return { eurPerXrp: Number(pair.c[0]), currency: cur, source: `Kraken XRP/${cur}`, at: new Date().toISOString() };
  } catch {
    /* fall through */
  }
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=${cur.toLowerCase()}`, { cache: "no-store" });
  const j = (await r.json()) as { ripple?: Record<string, number> };
  const v = j.ripple?.[cur.toLowerCase()];
  if (!v) throw new Error(`no XRP/${cur} rate available`);
  return { eurPerXrp: v, currency: cur, source: `CoinGecko XRP/${cur}`, at: new Date().toISOString() };
}

/** Euros to XRP at a rate, 6 decimals (a drop). */
export const eurToXrp = (eur: string, eurPerXrp: number) => (Number(eur) / eurPerXrp).toFixed(6);

/** Drops (the Amount field of an XRP escrow) back to XRP, for display. */
export const dropsToXrpString = (drops: string) => (Number(drops) / 1e6).toFixed(6);

export type EscrowDraft = {
  account: string;
  publicKey: string;
  destination: string;
  amountXrp: string;
  /** The euro amount and the rate behind amountXrp, written in a memo for the device to show. */
  eur?: string;
  rate?: Rate;
  finishAfter: Date;
  statementSha256: string;
  statementId: string;
  /** The oracle cited in the escrow: the named third party expected to finish it at the date. */
  oracle?: string;
  /** The zero-knowledge commitment of the statement's hidden inputs (zk/prove.mjs), so the proof binds to this escrow and not to any escrow of the same amount. */
  zkCommitment?: string;
  /** When the escrow holds the net: the gross the proof binds and the employee contribution rate that links them (memo dareskro/gross). */
  gross?: string;
  employeeRate?: string;
  /** Income tax withheld at source: the employee's personalised rate and what is finally paid (memo dareskro/gross). */
  taxRate?: string;
  paid?: string;
  /** Free memos (type, data), full mode only: e.g. the contributions leg's dareskro/urssaf memo. */
  extraMemos?: { type: string; data: string }[];
  /** Explicit sequence, for a second escrow prepared right after a first one (autofill would reuse the same number). */
  sequence?: number;
  /**
   * Shorter memos for a real device: the XRP app 2.2.2 on a Nano S Plus answered
   * "Missing critical parameter (6800)" to the four long memos the 2.8.1 emulator
   * accepted (measured 24/10/2026). Three memos, no MemoFormat, short rate line.
   */
  compact?: boolean;
};

/**
 * The payroll escrow, ready for the device.
 * xrpl.js fills Fee and Sequence. SigningPubKey must be the device's public
 * key in uppercase hex. The memo carries the SHA-256 of the pay statement —
 * never the statement itself (personal data on an immutable ledger).
 */
export async function prepareEscrowCreate(d: EscrowDraft): Promise<EscrowCreate> {
  const cur = d.rate?.currency ?? "USD";
  const compactMemos = [
    { Memo: { MemoType: toHex("dareskro/sha256"), MemoData: toHex(d.statementSha256) } },
    ...(d.eur && d.rate ? [{ Memo: { MemoType: toHex("dareskro/fiat"), MemoData: toHex(`${d.eur} ${cur} @ ${d.rate.eurPerXrp}`) } }] : []),
    ...(d.oracle ? [{ Memo: { MemoType: toHex("dareskro/oracle"), MemoData: toHex(d.oracle) } }] : []),
    ...(d.zkCommitment ? [{ Memo: { MemoType: toHex("dareskro/zk-commitment"), MemoData: toHex(d.zkCommitment) } }] : []),
  ];
  return withRetry(async (c) => c.autofill<EscrowCreate>({
    TransactionType: "EscrowCreate",
    Account: d.account,
    Destination: d.destination,
    Amount: xrpToDrops(d.amountXrp),
    FinishAfter: rippleTime(d.finishAfter),
    // Deliberately absent: Condition, CancelAfter. See the header comment.
    Memos: d.compact ? compactMemos : [
      {
        Memo: {
          MemoType: toHex("dareskro/statement-sha256"),
          MemoData: toHex(d.statementSha256),
          MemoFormat: toHex("text/plain"),
        },
      },
      {
        Memo: {
          MemoType: toHex("dareskro/statement-id"),
          MemoData: toHex(d.statementId),
          MemoFormat: toHex("text/plain"),
        },
      },
      // The fiat amount and the rate: the device shows "466.57 USD @ 2.61 USD/XRP".
      ...(d.eur && d.rate
        ? [{ Memo: { MemoType: toHex("dareskro/fiat"), MemoData: toHex(`${d.eur} ${cur} @ ${d.rate.eurPerXrp} ${cur}/XRP ${d.rate.source} ${d.rate.at.slice(0, 16)}Z`) } }]
        : []),
      // The oracle is cited on-chain, so the employer reads it on the device
      // before signing. Citing it gives it no power: anyone can finish after the date.
      ...(d.oracle
        ? [{ Memo: { MemoType: toHex("dareskro/oracle"), MemoData: toHex(d.oracle) } }]
        : []),
      // The escrow holds the net: say what gross the proof binds, and at which public rate.
      ...(d.gross && d.eur && d.employeeRate
        ? [{ Memo: { MemoType: toHex("dareskro/gross"), MemoData: toHex(`gross=${d.gross};net=${d.eur};employee_rate=${d.employeeRate}${d.taxRate && d.paid ? `;tax_rate=${d.taxRate};paid=${d.paid}` : ""}`) } }]
        : []),
      ...(d.extraMemos ?? []).map((m) => ({ Memo: { MemoType: toHex(m.type), MemoData: toHex(m.data) } })),
      // The ZK commitment: the compliance proof is bound to this escrow, not to any escrow of the same amount.
      ...(d.zkCommitment
        ? [{ Memo: { MemoType: toHex("dareskro/zk-commitment"), MemoData: toHex(d.zkCommitment) } }]
        : []),
    ],
    SigningPubKey: d.publicKey.toUpperCase(),
    ...(d.sequence !== undefined ? { Sequence: d.sequence } : {}),
    // autofill() gives about 1 minute. Give 10 minutes to read the device screen.
    LastLedgerSequence: (await c.getLedgerIndex()) + 150,
  }));
}

export type ConditionalEscrowDraft = {
  account: string;
  publicKey: string;
  destination: string;
  amountXrp: string;
  /** PREIMAGE-SHA-256 condition issued by the oracle (uppercase DER hex). The oracle keeps the secret. */
  condition: string;
  /** Past this date the payer is refunded: the oracle's power to block ends here. */
  cancelAfter: Date;
  /** Optional floor on the release (influencer: the post must still be there at the date). */
  finishAfter?: Date;
  /** Text memos: the case, the agreed proof, the oracle. Never the deliverable itself. */
  memos: { type: string; data: string }[];
  /** No MemoFormat on a real device: see EscrowDraft.compact. */
  compact?: boolean;
  /** Explicit sequence, when prepared right behind another escrow of the same account. */
  sequence?: number;
};

/**
 * The conditional escrow (freelance, influencer, affiliate), ready for the device.
 * Condition + CancelAfter is the shape that gives the oracle power to decide
 * *whether*, bounded by the refund date. Same signing path as the payroll escrow.
 */
export async function prepareConditionalEscrowCreate(d: ConditionalEscrowDraft): Promise<EscrowCreate> {
  return withRetry(async (c) => c.autofill<EscrowCreate>({
    TransactionType: "EscrowCreate",
    Account: d.account,
    Destination: d.destination,
    Amount: xrpToDrops(d.amountXrp),
    Condition: d.condition,
    CancelAfter: rippleTime(d.cancelAfter),
    ...(d.finishAfter ? { FinishAfter: rippleTime(d.finishAfter) } : {}),
    Memos: d.memos.map((m) => ({
      Memo: {
        MemoType: toHex(m.type),
        MemoData: toHex(m.data),
        ...(d.compact ? {} : { MemoFormat: toHex("text/plain") }),
      },
    })),
    SigningPubKey: d.publicKey.toUpperCase(),
    ...(d.sequence !== undefined ? { Sequence: d.sequence } : {}),
    // autofill() gives about 1 minute. Give 10 minutes to read the device screen.
    LastLedgerSequence: (await c.getLedgerIndex()) + 150,
  }));
}

/**
 * A Check: the payer signs once, the payee cashes when it wants, up to SendMax,
 * before Expiration. The native "pull" of the XRP Ledger — a direct-debit
 * mandate for URSSAF, signed on the device, with the statement hash as InvoiceID.
 */
export type CheckDraft = {
  account: string;
  publicKey: string;
  destination: string;
  amountXrp: string;
  expiration: Date;
  /** The statement's SHA-256: the check is for that pay and no other. */
  invoiceSha256: string;
  memos?: { type: string; data: string }[];
  sequence?: number;
  compact?: boolean;
};

export async function prepareCheckCreate(d: CheckDraft): Promise<CheckCreate> {
  return withRetry(async (c) => c.autofill<CheckCreate>({
    TransactionType: "CheckCreate",
    Account: d.account,
    Destination: d.destination,
    SendMax: xrpToDrops(d.amountXrp),
    Expiration: rippleTime(d.expiration),
    InvoiceID: d.invoiceSha256.toUpperCase(),
    ...(d.memos && d.memos.length && !d.compact
      ? { Memos: d.memos.map((m) => ({ Memo: { MemoType: toHex(m.type), MemoData: toHex(m.data) } })) }
      : {}),
    SigningPubKey: d.publicKey.toUpperCase(),
    ...(d.sequence !== undefined ? { Sequence: d.sequence } : {}),
    LastLedgerSequence: (await c.getLedgerIndex()) + 150,
  }));
}

/** The checks waiting on an account (the payee's), with their InvoiceID, so the payee finds the one for this pay. */
export async function pendingChecks(destination: string): Promise<{ index: string; sendMaxXrp: string; invoiceId?: string; account: string }[]> {
  return withRetry(async (c) => {
    const r = await c.request({ command: "account_objects", account: destination, type: "check" });
    return (r.result.account_objects as unknown as Array<Record<string, unknown>>).map((o) => ({
      index: o.index as string,
      sendMaxXrp: dropsToXrpString(o.SendMax as string),
      invoiceId: o.InvoiceID as string | undefined,
      account: o.Account as string,
    }));
  });
}

/** The payee cashes the check for its full amount: that is the pull. Signed by the payee's own key. */
export async function cashCheck(args: { payee: Wallet; checkId: string; amountXrp: string }): Promise<Outcome> {
  return withRetry(async (c) => {
    const tx: CheckCash = { TransactionType: "CheckCash", Account: args.payee.classicAddress, CheckID: args.checkId, Amount: xrpToDrops(args.amountXrp) };
    const res = await c.submitAndWait(tx, { wallet: args.payee, autofill: true });
    const meta = res.result.meta;
    return { hash: res.result.hash, result: typeof meta === "object" ? meta.TransactionResult : "unknown" };
  });
}

/**
 * One signature, several transactions: Batch (XLS-56). The inner transactions carry
 * no fee, no signature and the inner flag; the outer one is signed once on the device
 * and applied all or nothing (tfAllOrNothing). Measured on testnet 25/10/2026: one
 * signature, two inner payments, tesSUCCESS.
 */
export const TF_INNER_BATCH_TXN = 0x40000000;
export const TF_ALL_OR_NOTHING = 0x00010000;

export function innerForBatch(tx: Transaction, sequence: number): Transaction {
  const inner = { ...tx } as Record<string, unknown>;
  delete inner.Fee;
  delete inner.LastLedgerSequence;
  delete inner.TxnSignature;
  inner.Fee = "0";
  inner.SigningPubKey = "";
  inner.Sequence = sequence;
  inner.Flags = ((inner.Flags as number) ?? 0) | TF_INNER_BATCH_TXN;
  return inner as unknown as Transaction;
}

export async function prepareBatch(args: { account: string; publicKey: string; inner: Transaction[] }): Promise<Transaction> {
  return withRetry(async (c) => {
    const seq = (await c.request({ command: "account_info", account: args.account })).result.account_data.Sequence;
    const raw = args.inner.map((t, i) => ({ RawTransaction: innerForBatch(t, seq + 1 + i) }));
    const tx = await c.autofill({
      TransactionType: "Batch",
      Account: args.account,
      Flags: TF_ALL_OR_NOTHING,
      RawTransactions: raw,
      Sequence: seq,
      SigningPubKey: args.publicKey.toUpperCase(),
      LastLedgerSequence: (await c.getLedgerIndex()) + 150,
    } as unknown as SubmittableTransaction);
    return tx as unknown as Transaction;
  });
}

/** After a Batch is validated: the hash of each inner transaction, by its sequence (from the account's history). */
export async function hashesBySequence(account: string, sequences: number[]): Promise<Record<number, string>> {
  return withRetry(async (c) => {
    const r = await c.request({ command: "account_tx", account: account, limit: 20 });
    const out: Record<number, string> = {};
    for (const t of r.result.transactions as unknown as Array<Record<string, unknown>>) {
      const tx = (t.tx_json ?? t.tx) as Record<string, unknown> | undefined;
      const h = (t.hash ?? tx?.hash) as string | undefined;
      const sq = tx?.Sequence as number | undefined;
      if (sq !== undefined && h && sequences.includes(sq)) out[sq] = h;
    }
    return out;
  });
}

/** The employer trying to take the money back. Must fail: tecNO_PERMISSION. */
export async function prepareEscrowCancel(args: {
  account: string;
  publicKey: string;
  offerSequence: number;
}): Promise<EscrowCancel> {
  return withRetry(async (c) => c.autofill<EscrowCancel>({
    TransactionType: "EscrowCancel",
    Account: args.account,
    Owner: args.account,
    OfferSequence: args.offerSequence,
    SigningPubKey: args.publicKey.toUpperCase(),
    LastLedgerSequence: (await c.getLedgerIndex()) + 150,
  }));
}

/** Bytes for the device, as hex. encode(), NOT encodeForSigning(): the XRP app adds the prefix. */
export const encodeUnsigned = (tx: Transaction): string => encode(tx);

/** Put the device's DER signature in the transaction and serialize again. */
export const encodeSigned = (tx: Transaction, signature: Uint8Array): string =>
  encode({
    ...tx,
    TxnSignature: bufferToHexaString(signature, false).toUpperCase(),
  });

export type Outcome = { hash: string; result: string };

/** Submit a device-signed transaction and wait for a ledger to include it. */
export async function submit(signedTxHex: string): Promise<Outcome> {
  return withRetry(async (c) => {
    const res = await c.submitAndWait(signedTxHex);
    const meta = res.result.meta;
    return {
      hash: res.result.hash,
      result: typeof meta === "object" ? meta.TransactionResult : "unknown",
    };
  });
}

/**
 * Anyone can finish after the date. The signer only pays the fee: the funds go
 * to the Destination written in the escrow. Neither the employer nor the
 * employee needs to be there — that is the "paid even if absent" promise.
 */
export async function finishAsThirdParty(args: {
  owner: string;
  offerSequence: number;
  third: Wallet;
}): Promise<Outcome> {
  return withRetry(async (c) => {
    const tx: EscrowFinish = {
      TransactionType: "EscrowFinish",
      Account: args.third.classicAddress,
      Owner: args.owner,
      OfferSequence: args.offerSequence,
    };
    const res = await c.submitAndWait(tx, { wallet: args.third, autofill: true });
    const meta = res.result.meta;
    return {
      hash: res.result.hash,
      result: typeof meta === "object" ? meta.TransactionResult : "unknown",
    };
  });
}

/** The escrows still locked on an account (to show what is held). */
export async function openEscrows(address: string) {
  return withRetry(async (c) => {
    const r = await c.request({
      command: "account_objects",
      account: address,
      type: "escrow",
    });
    return r.result.account_objects;
  });
}
