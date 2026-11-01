/** Aurora Intents from the browser: the API allows any origin; the key is public by design. */
import { AURORA_API, AURORA_KEY, USDC_SOL } from "./config.js";
export async function tokens() { const r = await fetch(`${AURORA_API}/api/tokens/${AURORA_KEY}`); if (!r.ok) throw new Error(`Aurora tokens ${r.status}`); const j = await r.json(); return j.tokens ?? j; }
export async function solPrice() { try { const t = (await tokens()).find((x) => x.blockchain === "sol" && x.symbol === "SOL"); return { usdPerSol: t.price, source: "Aurora Intents" }; } catch { const j = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd")).json(); return { usdPerSol: j.solana.usd, source: "CoinGecko" }; } }
/** Exactly `usdc` USDC delivered on Solana to `recipient`, paid in `originAsset`; dry = no deposit address, no funds. */
export async function quote({ originAsset, usdc, recipient, refundTo, dry = true }) {
  const body = { dry, swapType: "EXACT_OUTPUT", depositType: "ORIGIN_CHAIN", amount: String(Math.round(usdc * 1e6)), originAsset, destinationAsset: USDC_SOL, slippageTolerance: 100, refundTo, refundType: "ORIGIN_CHAIN", recipient, recipientType: "DESTINATION_CHAIN", referral: "dareskro" };
  const r = await fetch(`${AURORA_API}/api/quote/${AURORA_KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message ?? `Aurora quote ${r.status}`);
  return j;
}
export const status = async (depositAddress) => (await fetch(`${AURORA_API}/api/status/${AURORA_KEY}?depositAddress=${encodeURIComponent(depositAddress)}`)).json();
