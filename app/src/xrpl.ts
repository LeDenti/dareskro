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
  type EscrowCancel,
  type EscrowCreate,
  type EscrowFinish,
  type Transaction,
  type Wallet,
} from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
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
export async function fundUntil(address: string, minXrp: number, maxRounds = 8): Promise<number | null> {
  let bal = await getBalance(address);
  for (let i = 0; i < maxRounds && (bal === null || bal < minXrp); i++) {
    await fundFromFaucet(address);
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
    ],
    SigningPubKey: d.publicKey.toUpperCase(),
    // autofill() gives about 1 minute. Give 10 minutes to read the device screen.
    LastLedgerSequence: (await c.getLedgerIndex()) + 150,
  }));
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
