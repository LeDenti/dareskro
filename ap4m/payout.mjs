/**
 * The payout: the employee is paid in dollars (RLUSD) through Mastercard Agent
 * Pay for Machines, and only once the XRP Ledger has released the escrow.
 *
 * Chain of custody:
 *   1. the oracle sees EscrowFinish validated on XRPL (the hash is given here);
 *   2. this script starts a one-shot "payslip settlement" Merchant whose payout
 *      wallet is the employee's dollar account, priced at the pay in RLUSD;
 *   3. the payroll agent opens (or reuses) a Channel inside the employer's budget,
 *      answers the 402 with a signed Voucher carrying the pay statement, the
 *      Merchant redeems it on the XRPL EVM sidechain (VoucherRedeemed), AP4M
 *      settles RLUSD to the employee's wallet and issues a receipt.
 *
 * Honest limits, printed with the result: the sandbox budget is 20 RLUSD, so
 * the demo settles at 1/100 of the pay (4.67 RLUSD for 466.57 €); RLUSD is a
 * dollar, the euro conversion is the day's rate.
 *
 * Usage: node payout.mjs --escrow <EscrowFinish hash> --eur 466.57 [--scale 100] [--sequence N]
 */
import { ethers } from "ethers";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import hackathonSdk from "./ap4m-hackathon-sdk.cjs";
import { buyResource, loadX402Context } from "./ap4m-x402.mjs";
import { explorerTx, loadEnv, need } from "./env.mjs";

const { signIn, requestChannel, listChannels, getChannelState, settle } = hackathonSdk;
loadEnv();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.AP4M_API_URL || "https://hackathon.ap4m.build";
const TEAM = process.env.TEAM_NAME || "dareskro";
const PORT = 4309;
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const escrowHash = arg("--escrow");
const eur = arg("--amount", arg("--eur"));
const currency = arg("--currency", "USD");
let scale = Number(arg("--scale", "100"));
const sequence = arg("--sequence", "");
if (!escrowHash || !eur) {
  console.error("usage: node payout.mjs --escrow <EscrowFinish hash> --amount 466.57 [--currency USD] [--scale 100]");
  process.exit(1);
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readPending = (dir) => { try { return JSON.parse(readFileSync(path.join(dir, "purchase.json"), "utf8")); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. the XRPL side must be done: check the EscrowFinish on testnet
const xrplRes = await (await fetch("https://s.altnet.rippletest.net:51234", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ method: "tx", params: [{ transaction: escrowHash }] }),
})).json();
const tx = xrplRes.result ?? {};
const txType = tx.TransactionType ?? tx.tx_json?.TransactionType;
const txResult = tx.meta?.TransactionResult;
if (txType !== "EscrowFinish" || txResult !== "tesSUCCESS" || !tx.validated) {
  console.error(`XRPL says no: ${txType ?? "unknown tx"} ${txResult ?? ""} validated=${tx.validated} — no payout without a validated EscrowFinish`);
  process.exit(2);
}
log(`XRPL: EscrowFinish ${escrowHash.slice(0, 8)}… validated, tesSUCCESS — the pay is released, the dollar payout may run`);

// --- 2. the budget, read before anything is priced: the open Channels on chain and
// what the team allocation still has unassigned. In production the scale is 1; the
// sandbox holds 20 RLUSD for the whole weekend, so when the pay at the requested scale
// no longer fits, the payout settles one notch smaller (1/1000, then 1/10000) and
// says so in its record rather than failing the demo.
const config = await (await fetch(`${API}/public/config`)).json();
const provider = new ethers.JsonRpcProvider(config.network.rpcUrl);
const agent = new ethers.Wallet(need("AGENT_PRIVATE_KEY"), provider);
const ledger = config.contracts.paymentLedger;
const { token } = await signIn(API, TEAM, agent);
const agentState = path.join(HERE, "agent-state");
const operation = `payout-${escrowHash.slice(0, 10).toLowerCase()}`;
let spent = 0; // redeemed on every Channel, open or closed: gone from the allocation for good
let held = 0; // still unspent inside the open Channels: not free for a new one
const onChain = {}; // open channel id → { cap, redeemed, open, remaining }
const channels = await listChannels(API, token);
for (const c of channels) {
  const st = await getChannelState(provider, ledger, c.channel_id);
  spent += Number(ethers.formatUnits(st.redeemed, 18));
  if (!["open", "bound", "requested"].includes(c.channel_status)) continue;
  const remaining = Number(ethers.formatUnits(st.cap - st.redeemed, 18));
  held += remaining;
  onChain[c.channel_id] = { cap: st.cap, redeemed: st.redeemed, open: c.channel_status === "open", remaining };
  log(`channel ${c.channel_id.slice(0, 10)}… ${c.channel_status}: ${remaining.toFixed(2)} RLUSD left`);
}
const me = await (await fetch(`${API}/public/participant/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
const available = Number(me.paymentState?.allocation_cap ?? 0) - spent - held; // what a new Channel may still take
log(`budget: ${Number(me.paymentState?.allocation_cap ?? 0).toFixed(2)} RLUSD allocated, ${spent.toFixed(2)} spent, ${held.toFixed(2)} held by open Channels, ${available.toFixed(2)} free`);
const fits = (needed) => available >= needed || Object.values(onChain).some((ch) => ch.open && ch.remaining >= needed);
const requestedScale = scale;
// An earlier attempt of THIS payout may be on disk (voucher signed, outcome lost): it must be
// resumed at the price it was signed for, whatever the budget says now — resuming pays nothing new.
const earlier = readPending(agentState);
const resumable = !!earlier && !earlier.complete && earlier.intent?.operation === operation;
if (resumable) {
  const signedEarlier = JSON.parse(Buffer.from(earlier.header, "base64").toString("utf8"));
  const amt = Number(ethers.formatUnits(BigInt(signedEarlier.accepted.amount), 18));
  const match = [requestedScale, requestedScale * 10, requestedScale * 100].find((s) => (Number(eur) / s).toFixed(2) === amt.toFixed(2));
  if (match) scale = match;
  log(`an earlier attempt of this payout is on disk (${amt.toFixed(2)} RLUSD, channel ${earlier.intent.channelId.slice(0, 10)}…): resuming it at the same price, 1/${scale}`);
} else {
  while (!fits(Number(eur) / scale + 0.01) && scale < requestedScale * 100) scale *= 10;
  if (!fits(Number(eur) / scale + 0.01)) {
    console.error(`payout failed: budget exhausted: ${available.toFixed(2)} RLUSD unassigned, ${(Number(eur) / scale + 0.01).toFixed(2)} needed even at 1/${scale} — ask the organizer to fund the team`);
    process.exit(3);
  }
  if (scale !== requestedScale) log(`sandbox budget: 1/${requestedScale} of the pay no longer fits (${available.toFixed(2)} RLUSD unassigned) — settling at 1/${scale} instead, written in the record`);
}

// --- 3. the one-shot payslip merchant: payout wallet = the employee's dollar account
const amountRlusd = (Number(eur) / scale).toFixed(2);
const content = {
  schema: "dareskro/payslip-settlement.v1",
  pay: `${eur} ${currency}`, amount_rlusd: amountRlusd, scale: `1/${scale} (sandbox budget)`,
  xrpl_escrow_finish: escrowHash, sequence: sequence || null,
  note: "paid in RLUSD through Mastercard Agent Pay for Machines, once the XRP Ledger released the escrow",
};
// one merchant store per payout and per price: the kit refuses a store whose configuration changed
const stateDir = path.join(HERE, "merchant-state-payout", escrowHash.slice(0, 12) + (scale === requestedScale ? "" : `-1_${scale}`));
mkdirSync(stateDir, { recursive: true });
const merchant = spawn("node", [path.join(HERE, "merchant.mjs")], {
  cwd: HERE,
  env: { ...process.env, MERCHANT_PORT: String(PORT), RESOURCE_URL: `http://127.0.0.1:${PORT}/resource`,
    PRICE_RLUSD: amountRlusd, STATE_DIRECTORY: stateDir, MERCHANT_CONTENT_JSON: JSON.stringify(content) },
  stdio: ["ignore", "pipe", "pipe"],
});
merchant.stdout.on("data", (d) => process.stdout.write("  [merchant] " + d));
merchant.stderr.on("data", (d) => process.stdout.write("  [merchant] " + d));
await sleep(7000);

try {
  // --- 4. the agent pays, inside the employer's budget
  const needed = Number(amountRlusd) + 0.01;
  let maximumAmount = ethers.parseUnits(String(needed), 18).toString();
  let channelId = "";
  for (const [id, ch] of Object.entries(onChain)) {
    if (!channelId && ch.open && ch.remaining >= needed) channelId = id;
  }
  // An earlier attempt may have signed a voucher and stopped there (crash, timeout, channel
  // short of funds). The kit insists it be resumed with the same arguments, and that is also
  // the only safe move when the Merchant did redeem it: the chain says so (redeemed ≥ the
  // voucher's cumulative amount), and resuming collects the proof without paying twice.
  // Only a voucher that was not redeemed and can no longer fit in its channel is set aside.
  const pending = readPending(agentState);
  if (pending && !pending.complete) {
    const p = pending.intent;
    const signed = JSON.parse(Buffer.from(pending.header, "base64").toString("utf8"));
    const amount = BigInt(signed.accepted.amount);
    const cumulative = BigInt(signed.payload.voucher.cumulativeAmount);
    const ch = onChain[p.channelId];
    const redeemedAlready = !!ch && ch.redeemed >= cumulative;
    const stillPayable = !!ch && ch.open && ch.cap - ch.redeemed >= amount;
    if (p.operation === operation && (redeemedAlready || stillPayable)) {
      log(`resuming the earlier attempt on channel ${p.channelId.slice(0, 10)}… — ${redeemedAlready
        ? "its voucher is already redeemed on chain: collecting the result, nothing is paid twice"
        : "its channel can still pay it"}`);
      channelId = p.channelId; maximumAmount = p.maximumAmount;
    } else {
      const aside = `abandoned-${p.operation}-${Date.now()}.json`;
      renameSync(path.join(agentState, "purchase.json"), path.join(agentState, aside));
      log(`earlier attempt ${p.operation} on channel ${p.channelId.slice(0, 10)}… set aside (${aside}): not redeemed, and that channel has ${ch ? ethers.formatUnits(ch.cap - ch.redeemed, 18) : "0"} RLUSD left for ${ethers.formatUnits(amount, 18)} needed`);
    }
  }
  if (!channelId) {
    // the team budget minus what the open channels already hold: the cap must fit in it
    const cap = Math.min(available, Math.max(needed + 0.5, 5));
    if (cap < needed) throw new Error(`budget exhausted: ${available.toFixed(2)} RLUSD unassigned, ${needed.toFixed(2)} needed — ask the organizer to fund the team`);
    log(`opening a payout Channel, cap ${cap.toFixed(2)} RLUSD (the employer's budget for this payout; ${available.toFixed(2)} unassigned)…`);
    channelId = (await requestChannel(API, token, agent, { capRlusd: cap.toFixed(2) })).channel_id;
  }
  log(`Channel ${channelId.slice(0, 10)}…`);
  const context = await loadX402Context(API);
  log(`paying ${amountRlusd} RLUSD to the employee's payout wallet over x402 (operation ${operation})…`);
  const purchase = await buyResource({
    context, provider, wallet: agent, stateDirectory: agentState,
    resourceUrl: `http://127.0.0.1:${PORT}/resource`, channelId, maximumAmount, operation,
  });
  log(`VoucherRedeemed ${purchase.transactionHash} — ${explorerTx(purchase.transactionHash)}`);
  await fetch(`${API}/public/participant/record-redemption`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tx_hash: purchase.transactionHash }),
  });
  let settled = null;
  try {
    settled = await settle(API, token, channelId);
    log(`settled: payout tx ${settled.payout_tx} — receipt ${settled.receipt_url ? API + settled.receipt_url : "(pending)"}`);
  } catch (e) {
    log(`settle: ${e.message} (settlement is also automatic)`);
  }
  const record = {
    paid_at: new Date().toISOString(), pay: `${eur} ${currency}`, amount_rlusd: amountRlusd, scale,
    xrpl_escrow_finish: escrowHash, xrpl_explorer: `https://testnet.xrpl.org/transactions/${escrowHash}`,
    channel: channelId, redemption_tx: purchase.transactionHash, redemption_explorer: explorerTx(purchase.transactionHash),
    settlement_tx: settled?.settlement_tx ?? null, payout_tx: settled?.payout_tx ?? null,
    receipt_url: settled?.receipt_url ? API + settled.receipt_url : null,
    payout_wallet: process.env.MERCHANT_PAYOUT, resource: purchase.resource,
  };
  for (const f of [path.join(HERE, "..", "agent", "sortie", "payout.json"), path.join(HERE, "..", "app", "public", "payout.json")]) {
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(record, null, 2));
  }
  console.log(JSON.stringify(record, null, 2));
} catch (e) {
  console.error(`payout failed: ${e?.message ?? e}`);
  process.exitCode = 3;
} finally {
  merchant.kill("SIGTERM");
}
process.exit(process.exitCode ?? 0);
