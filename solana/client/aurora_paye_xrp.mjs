#!/usr/bin/env node
/**
 * dareskro pays a Solana escrow's USDC with XRP, through Aurora Intents — MAINNET, real funds.
 *
 *   node aurora_paye_xrp.mjs            real quote only: shows where/how much, sends NOTHING
 *   node aurora_paye_xrp.mjs --go       quote, then signs and sends the XRP Payment, then watches
 *                                       Aurora until the USDC land on the Solana recipient
 *
 * Options: --usdc 3           USDC to deliver on Solana (default 3; Aurora's bridge minimum is ≈ 2.25 XRP)
 *          --to <solAddress>  Solana recipient (default: the desk's key, 4ypF64RB…)
 *          --cle <file>       XRPL key file { "seed": "s…" } in mode 0600 (default: the dareskro mainnet
 *                             anchoring account, dareskro-paie/paie/cles/ancre.mainnet.json)
 *
 * Guards, same as paie/ancrer.mjs: the seed never goes through argv or the chat; a key file readable
 * by others is refused; nothing is signed without --go; the payment must leave ≥ 1 XRP (base reserve)
 * plus margin on the account. This script is meant to be run BY JULIEN in his own terminal.
 */
import { readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { quoteExactUsdcOut, status, submitDeposit, USDC_SOL } from "./aurora_intents.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const GO = flag("--go");
const USDC = Number(opt("--usdc", "3"));
const RECIPIENT = opt("--to", "4ypF64RBg6GUszSwcp8d46tUvDkjDdUXDTZbziVRSF2J");
const CLE = opt("--cle", join(homedir(), "dareskro-paie", "paie", "cles", "ancre.mainnet.json"));
const XRP_ASSET = "nep141:xrp.omft.near";
const XRPL_NODE = process.env.XRPL_MAINNET_URL || "wss://xrplcluster.com";
const RESERVE_DROPS = 1_000_000n, MARGIN_DROPS = 100_000n;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_RPC = process.env.SOLANA_MAINNET_RPC || "https://api.mainnet-beta.solana.com";

// xrpl.js lives in the repo's app/ workspace (or in the paie worktree): borrow it from there.
const xrplFrom = [join(here, "..", "..", "app", "package.json"), join(homedir(), "dareskro-paie", "paie", "package.json")].find(existsSync);
if (!xrplFrom) { console.error("xrpl.js introuvable (app/node_modules ou dareskro-paie/paie/node_modules)"); process.exit(2); }
const { Client, Wallet, xrpToDrops, convertStringToHex } = createRequire(xrplFrom)("xrpl");

const die = (m) => { console.error(m); process.exit(1); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function usdcBalance(owner) {
  const r = await fetch(SOL_RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { mint: USDC_MINT }, { encoding: "jsonParsed" }] }) });
  const v = (await r.json()).result?.value ?? [];
  return v.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
}

// 1. The payer's XRPL account (address only here; the seed is read only under --go).
if (!existsSync(CLE)) die(`REFUS: fichier de clé absent: ${CLE}`);
const mode = statSync(CLE).mode & 0o777;
if (mode & 0o077) die(`REFUS: ${CLE} est lisible par d'autres (mode ${mode.toString(8)}): chmod 600 d'abord`);
const cle = JSON.parse(readFileSync(CLE, "utf8"));
if (cle.network && cle.network !== "mainnet") die(`REFUS: la clé ${CLE} est ${cle.network}, pas mainnet`);
const PAYER = cle.address || Wallet.fromSeed(cle.seed).classicAddress;

const client = new Client(XRPL_NODE);
await client.connect();
const info = await client.request({ command: "account_info", account: PAYER, ledger_index: "validated" });
const balanceDrops = BigInt(info.result.account_data.Balance);
log(`payeur XRPL ${PAYER} : ${Number(balanceDrops) / 1e6} XRP sur mainnet`);

// 2. The real quote (dry: false): Aurora issues a deposit address + tag, valid ~15 min. No funds move yet.
const usdcBefore = await usdcBalance(RECIPIENT).catch(() => null);
const q = await quoteExactUsdcOut({ originAsset: XRP_ASSET, usdcOut: Math.round(USDC * 1e6), recipient: RECIPIENT, refundTo: PAYER, dry: false });
const Q = q.quote;
const needDrops = BigInt(Q.amountIn);
mkdirSync(join(here, "sortie"), { recursive: true });
const file = join(here, "sortie", `aurora_xrp_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const rec = { askedAt: new Date().toISOString(), payer: PAYER, recipient: RECIPIENT, originAsset: XRP_ASSET, destinationAsset: USDC_SOL, usdcBefore, quoteResponse: q };
writeFileSync(file, JSON.stringify(rec, null, 2));

console.log("\n=== DEVIS RÉEL AURORA ===");
console.log("livrer           :", Q.amountOutFormatted, "USDC sur Solana à", RECIPIENT);
console.log("payer            :", Q.amountInFormatted, "XRP  (≈", Number(Q.amountInUsd).toFixed(2), "$) depuis", PAYER);
console.log("adresse de dépôt :", Q.depositAddress);
console.log("destination tag  :", Q.depositMemo ?? "(aucun)");
console.log("valable jusqu'à  :", q.quoteRequest.deadline, " livraison ≈", Q.timeEstimate, "s");
console.log("fichier          :", file);

if (balanceDrops - needDrops - 12n < RESERVE_DROPS + MARGIN_DROPS) die(`REFUS: il resterait moins de ${(Number(RESERVE_DROPS + MARGIN_DROPS)) / 1e6} XRP sur le compte`);
if (!GO) { console.log("\nRien n'est parti. Relance avec --go pour signer et envoyer le paiement XRP."); await client.disconnect(); process.exit(0); }

// 3. --go : sign and send the XRP Payment, from the payer's own key, on Julien's own command.
const wallet = Wallet.fromSeed(cle.seed);
if (wallet.classicAddress !== PAYER) die("REFUS: la graine ne correspond pas à l'adresse du fichier");
const tx = { TransactionType: "Payment", Account: PAYER, Destination: Q.depositAddress, Amount: String(needDrops) };
if (Q.depositMemo != null) {
  if (/^\d+$/.test(String(Q.depositMemo))) tx.DestinationTag = Number(Q.depositMemo);
  else tx.Memos = [{ Memo: { MemoData: convertStringToHex(String(Q.depositMemo)) } }];
}
const prepared = await client.autofill(tx);
const signed = wallet.sign(prepared);
log("envoi du Payment XRPL…");
const res = await client.submitAndWait(signed.tx_blob);
const code = res.result.meta?.TransactionResult;
rec.xrplPayment = { hash: res.result.hash, result: code, fee: prepared.Fee, ledger: res.result.ledger_index, explorer: `https://livenet.xrpl.org/transactions/${res.result.hash}` };
writeFileSync(file, JSON.stringify(rec, null, 2));
log(`XRPL ${code} — ${rec.xrplPayment.explorer}`);
await client.disconnect();
if (code !== "tesSUCCESS") die("le paiement XRPL n'a pas abouti, rien à suivre côté Aurora");

// 4. Tell Aurora, then watch until SUCCESS | REFUNDED | FAILED.
try { await submitDeposit(res.result.hash, Q.depositAddress, Q.depositMemo); log("dépôt signalé à Aurora"); } catch (e) { log("signalement ignoré:", e.message); }
const ticks = []; let s;
for (let i = 0; i < 180; i++) {
  s = await status(Q.depositAddress, Q.depositMemo);
  ticks.push({ at: new Date().toISOString(), status: s.status }); log("Aurora:", s.status);
  if (["SUCCESS", "REFUNDED", "FAILED"].includes(s.status)) break;
  await new Promise((r) => setTimeout(r, 10_000));
}
const usdcAfter = await usdcBalance(RECIPIENT).catch(() => null);
rec.watch = { ticks, final: s, usdcAfter };
writeFileSync(file, JSON.stringify(rec, null, 2));
console.log("\n=== RÉSULTAT ===");
console.log("statut Aurora    :", s?.status);
console.log("USDC du receveur :", usdcBefore, "→", usdcAfter);
if (s?.swapDetails) console.log("détails          :", JSON.stringify(s.swapDetails, null, 2));
console.log("fichier          :", file);
