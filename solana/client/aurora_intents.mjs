#!/usr/bin/env node
/**
 * Aurora Intents for dareskro — fund the escrow from any chain.
 *
 * The employer or the client rarely holds Solana USDC. Aurora Intents (NEAR
 * Intents under the hood) gives a deposit address on the chain they do hold
 * assets on, and settles USDC on Solana to the recipient we name. The escrow's
 * guarantees stay the program's; the cross-chain leg is Aurora's. The two never
 * mix: Aurora never touches a locked escrow, the program never sees a foreign
 * chain.
 *
 * Two flows, both over plain HTTPS (no SDK is published for them):
 *   quote      POST /api/quote/{apiKey}   → a one-off deposit address + amounts;
 *              the payer sends there; GET /api/status/{apiKey}?depositAddress=…
 *              follows it to SUCCESS / REFUNDED / FAILED. Any API key.
 *   address    POST /api/persistent-deposit-address/{apiKey} → one address per
 *              payer, forever. Restricted: organisations approved by Aurora,
 *              any other key gets 403 (we surface that, we do not fake it).
 *
 * Mainnet only: Aurora has no testnet. Amounts are small on purpose.
 * The key is read from AURORA_API_KEY (generated at https://studio.aurora.dev,
 * documented as "not confidential"; still, keep it in solana/.env, never in git).
 *
 *   node aurora_intents.mjs tokens [sol]                  assets Aurora can deliver on Solana
 *   node aurora_intents.mjs quote <originAssetId> <usdcOut> <solanaRecipient> [refundTo]
 *   node aurora_intents.mjs status <depositAddress>
 *   node aurora_intents.mjs address <depositChain> <solanaRecipient> <senderId>
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
for (const f of [join(here, "..", ".env"), join(here, ".env")]) {
  if (existsSync(f)) for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

export const BASE = process.env.AURORA_INTENTS_API || "https://intents-api.aurora.dev";
/** the only USDC on Solana in Aurora's asset list (bridged id, NEP-141 on the Intents side) */
export const USDC_SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
export const SOL_NATIVE = "nep141:sol.omft.near";

const key = () => {
  const k = process.env.AURORA_API_KEY;
  if (!k) throw new Error("AURORA_API_KEY missing: generate one at https://studio.aurora.dev and put it in solana/.env");
  return k;
};

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Aurora ${method} ${path.split("/").slice(0, 3).join("/")} → ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status; err.body = json;
    throw err;
  }
  return json;
}

/** Assets Aurora can deliver (filter by blockchain, e.g. "sol"). */
export async function tokens(blockchain) {
  const r = await call("GET", `/api/tokens/${key()}`);
  const list = r.tokens ?? r;
  return blockchain ? list.filter((t) => t.blockchain === blockchain) : list;
}

/**
 * A quote that delivers EXACTLY `usdcOut` (6 decimals) of Solana USDC to
 * `recipient`, paid in `originAsset` from any chain. The payer sends
 * `quote.amountIn` of the origin asset to `quote.depositAddress` before
 * `quote.deadline`; anything that fails is refunded to `refundTo`.
 */
export async function quoteExactUsdcOut({ originAsset, usdcOut, recipient, refundTo, dry = false, slippageBps = 100, appFeeBps, appFeeRecipient }) {
  const body = {
    dry,
    swapType: "EXACT_OUTPUT",
    depositType: "ORIGIN_CHAIN",
    amount: String(usdcOut),
    originAsset,
    destinationAsset: USDC_SOL,
    slippageTolerance: slippageBps,
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    referral: "dareskro",
  };
  if (appFeeBps && appFeeRecipient) body.appFees = [{ recipient: appFeeRecipient, fee: appFeeBps }];
  return call("POST", `/api/quote/${key()}`, body);
}

/** Tell Aurora the deposit hash to speed things up (optional). */
export const submitDeposit = (txHash, depositAddress, memo) =>
  call("POST", `/api/deposit/submit/${key()}`, { txHash, depositAddress, ...(memo ? { memo } : {}) });

/** KNOWN_DEPOSIT_TX → PENDING_DEPOSIT → PROCESSING → SUCCESS | REFUNDED | FAILED */
export const status = (depositAddress, depositMemo) =>
  call("GET", `/api/status/${key()}?depositAddress=${encodeURIComponent(depositAddress)}${depositMemo ? `&depositMemo=${encodeURIComponent(depositMemo)}` : ""}`);

export async function waitForSettlement(depositAddress, { everyMs = 10_000, maxMs = 30 * 60_000, onTick } = {}) {
  const t0 = Date.now();
  for (;;) {
    const s = await status(depositAddress);
    onTick?.(s);
    if (["SUCCESS", "REFUNDED", "FAILED"].includes(s.status)) return s;
    if (Date.now() - t0 > maxMs) throw new Error(`Aurora still ${s.status} after ${maxMs / 1000} s`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * One deposit address per payer, forever, settling USDC on Solana to
 * `recipient`. Needs an Aurora-approved organisation: a 403 is returned as
 * { approved: false } so the desk can fall back to a quote.
 */
export async function persistentAddress({ depositChain, recipient, sender }) {
  try {
    const r = await call("POST", `/api/persistent-deposit-address/${key()}`, {
      recipient, sender, depositChain, destinationChain: "sol", destinationAsset: USDC_SOL, recipientType: "DESTINATION_CHAIN",
    });
    return { approved: true, ...r };
  } catch (e) {
    if (e.status === 403) return { approved: false, reason: "persistent addresses are limited to organisations approved by Aurora", body: e.body };
    throw e;
  }
}

export const persistentDeposits = (address, type = "received") =>
  call("GET", `/api/persistent-deposit-status/${key()}?type=${type}&address=${encodeURIComponent(address)}`);

// ---- CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...a] = process.argv.slice(2);
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  try {
    if (cmd === "tokens") out((await tokens(a[0])).map((t) => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals, price: t.price })));
    else if (cmd === "quote") out(await quoteExactUsdcOut({ originAsset: a[0], usdcOut: a[1], recipient: a[2], refundTo: a[3] ?? a[2], dry: process.env.DRY !== "0" }));
    else if (cmd === "status") out(await status(a[0]));
    else if (cmd === "address") out(await persistentAddress({ depositChain: a[0], recipient: a[1], sender: a[2] ?? "dareskro-desk" }));
    else { console.error("usage: tokens [chain] | quote <originAssetId> <usdcOut> <recipient> [refundTo] | status <depositAddress> | address <depositChain> <recipient> <sender>"); process.exit(2); }
  } catch (e) { console.error(String(e.message)); process.exit(1); }
}
