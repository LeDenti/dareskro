#!/usr/bin/env node
/**
 * The real Aurora Intents leg of dareskro — mainnet, real funds, a few dollars.
 *
 *   node aurora_reel.mjs quote <originAssetId> <usdcOut6> <solRecipient> <refundTo>
 *       asks a REAL quote (dry: false). Prints the deposit address, the memo /
 *       destination tag if any, the exact amount to send and the deadline, and
 *       saves everything to sortie/aurora_reel_<ts>.json. Moves no funds: the
 *       payer sends from their own wallet.
 *
 *   node aurora_reel.mjs watch <fichier.json>
 *       polls /api/status until SUCCESS | REFUNDED | FAILED, then reads the
 *       recipient's USDC balance on Solana mainnet and appends both to the file.
 *
 * Nothing here signs anything. The only secret-free credential is the Aurora
 * API key read from solana/.env by aurora_intents.mjs.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteExactUsdcOut, status, USDC_SOL } from "./aurora_intents.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // mainnet USDC
const RPC = process.env.SOLANA_MAINNET_RPC || "https://api.mainnet-beta.solana.com";

async function usdcBalance(owner) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
      params: [owner, { mint: USDC_MINT }, { encoding: "jsonParsed" }] }) });
  const j = await r.json();
  const accs = j.result?.value ?? [];
  return accs.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
}

const [cmd, ...a] = process.argv.slice(2);
const out = (x) => console.log(JSON.stringify(x, null, 2));

if (cmd === "quote") {
  const [originAsset, usdcOut, recipient, refundTo] = a;
  if (!originAsset || !usdcOut || !recipient || !refundTo) { console.error("usage: quote <originAssetId> <usdcOut6> <solRecipient> <refundTo>"); process.exit(2); }
  const before = await usdcBalance(recipient).catch(() => null);
  const q = await quoteExactUsdcOut({ originAsset, usdcOut, recipient, refundTo, dry: false });
  const file = join(here, "sortie", `aurora_reel_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const rec = { askedAt: new Date().toISOString(), recipient, refundTo, originAsset, destinationAsset: USDC_SOL, usdcBefore: before, quoteResponse: q };
  writeFileSync(file, JSON.stringify(rec, null, 2));
  const Q = q.quote;
  console.log("\n=== À ENVOYER PAR LE PAYEUR (depuis son propre portefeuille) ===");
  console.log("adresse de dépôt :", Q.depositAddress);
  if (Q.depositMemo) console.log("memo / destination tag :", Q.depositMemo, "  <-- OBLIGATOIRE");
  console.log("montant exact     :", Q.amountInFormatted, "(minimum accepté", Q.minAmountIn, "unités)");
  console.log("avant le          :", q.quoteRequest.deadline);
  console.log("livraison prévue  :", Q.amountOutFormatted, "USDC sur Solana à", recipient, "en ~" + Q.timeEstimate + " s");
  console.log("fichier           :", file);
} else if (cmd === "watch") {
  const file = a[0];
  const rec = JSON.parse(readFileSync(file, "utf8"));
  const Q = rec.quoteResponse.quote;
  const ticks = [];
  let s;
  for (let i = 0; ; i++) {
    s = await status(Q.depositAddress, Q.depositMemo);
    const line = { at: new Date().toISOString(), status: s.status };
    ticks.push(line); console.log(line.at, s.status);
    if (["SUCCESS", "REFUNDED", "FAILED"].includes(s.status)) break;
    if (i > 240) { console.log("toujours en attente après 40 min, on arrête de regarder"); break; }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  const after = await usdcBalance(rec.recipient).catch(() => null);
  rec.watch = { ticks, final: s, usdcAfter: after };
  writeFileSync(file, JSON.stringify(rec, null, 2));
  out({ status: s.status, swapDetails: s.swapDetails, usdcBefore: rec.usdcBefore, usdcAfter: after });
} else {
  console.error("usage: quote <originAssetId> <usdcOut6> <solRecipient> <refundTo> | watch <fichier.json>"); process.exit(2);
}
