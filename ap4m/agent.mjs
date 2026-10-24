/**
 * dareskro payroll agent — buys its evidence over x402 on Mastercard AP4M.
 *
 * Before the payroll engine prices the shift, the agent needs the current
 * collective-agreement parameters. It buys them from the rules service, per
 * query, in RLUSD on the XRPL EVM testnet, inside a Channel whose cap is the
 * budget the employer approved. Nobody clicks: the agent reads the 402, signs
 * the Voucher, retries, verifies the on-chain redemption, and writes what it
 * bought where the payroll engine reads it.
 *
 * Boundaries, same as everywhere in dareskro:
 *   - the agent spends only inside the cap; the cap is set by a human;
 *   - the agent never touches the salary: that is the XRPL escrow, signed on
 *     the Ledger device;
 *   - every purchase leaves an on-chain proof (VoucherRedeemed) and a receipt.
 *
 * Usage:  node agent.mjs [--operation name] [--close]
 *   reads ap4m/.env: AGENT_PRIVATE_KEY, TEAM_NAME, CHANNEL_ID (optional),
 *   CHANNEL_CAP, MAXIMUM_PRICE, RESOURCE_URL
 *   writes agent/sortie/regles_achetees.json and app/public/ap4m.json
 */
import { ethers } from "ethers";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import hackathonSdk from "./ap4m-hackathon-sdk.cjs";
import { buyResource, loadX402Context } from "./ap4m-x402.mjs";
import { explorerTx, loadEnv, need } from "./env.mjs";

const { signIn, requestChannel, settle, closeChannel, getChannelState, listChannels } = hackathonSdk;

loadEnv();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_RULES = path.join(HERE, "..", "agent", "sortie", "regles_achetees.json");
const OUT_PAGE = path.join(HERE, "..", "app", "public", "ap4m.json");

const AP4M_API_URL = process.env.AP4M_API_URL || "https://hackathon.ap4m.build";
const TEAM_NAME = process.env.TEAM_NAME || "dareskro";
const RESOURCE_URL = process.env.RESOURCE_URL || "http://127.0.0.1:4308/resource";
const CHANNEL_CAP = process.env.CHANNEL_CAP || "2";
const MAXIMUM_PRICE = process.env.MAXIMUM_PRICE || "0.1";
const args = process.argv.slice(2);
const OPERATION = args.includes("--operation")
  ? args[args.indexOf("--operation") + 1]
  : `rules-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const agent0 = new ethers.Wallet(need("AGENT_PRIVATE_KEY"));
  const config = await (await fetch(`${AP4M_API_URL}/public/config`)).json();
  const provider = new ethers.JsonRpcProvider(process.env.AP4M_RPC_URL || config.network.rpcUrl);
  const agent = agent0.connect(provider);
  const ledger = config.contracts.paymentLedger;
  log(`agent ${agent.address} on ${config.network.name} (chain ${config.network.chainId})`);
  const gas = await provider.getBalance(agent.address);
  log(`gas: ${ethers.formatEther(gas)} XRP`);

  // 1. sign in: the agent wallet signs a one-time challenge, nothing on-chain
  const { token } = await signIn(AP4M_API_URL, TEAM_NAME, agent);
  log(`signed in as team "${TEAM_NAME}"`);

  // 2. the Channel: the employer's budget for this agent, a cap in RLUSD
  let channelId = process.env.CHANNEL_ID || "";
  if (!channelId) {
    const open = (await listChannels(AP4M_API_URL, token)).find((c) => c.channel_status === "open");
    if (open) {
      channelId = open.channel_id;
      log(`reusing open Channel ${channelId}`);
    } else {
      if (gas === 0n) throw new Error("the agent needs XRP for gas to open a Channel (one vault transaction)");
      log(`requesting a Channel with a ${CHANNEL_CAP} RLUSD cap…`);
      const ch = await requestChannel(AP4M_API_URL, token, agent, { capRlusd: CHANNEL_CAP });
      channelId = ch.channel_id;
      log(`Channel open: ${channelId} → merchant ${ch.merchant_id}, payout ${ch.payout}`);
    }
  }
  const before = await getChannelState(provider, ledger, channelId);
  log(`budget: cap ${ethers.formatUnits(before.cap, 18)} RLUSD, used ${ethers.formatUnits(before.redeemed, 18)}`);

  if (args.includes("--close")) {
    const closed = await closeChannel(AP4M_API_URL, token, agent, channelId);
    log(`Channel closed: ${closed.tx_hash}`);
    return;
  }

  // 3. buy the rules: 402 → signed Voucher → redeemed on-chain → resource
  const context = await loadX402Context(AP4M_API_URL);
  log(`buying ${RESOURCE_URL} (operation ${OPERATION}, max ${MAXIMUM_PRICE} RLUSD)…`);
  const purchase = await buyResource({
    context,
    provider,
    wallet: agent,
    stateDirectory: path.join(HERE, "agent-state"),
    resourceUrl: RESOURCE_URL,
    channelId,
    maximumAmount: ethers.parseUnits(MAXIMUM_PRICE, 18).toString(),
    operation: OPERATION,
  });
  const after = await getChannelState(provider, ledger, channelId);
  const paid = after.redeemed - before.redeemed;
  log(`bought: ${purchase.resource?.schema ?? "resource"} — paid ${ethers.formatUnits(paid, 18)} RLUSD — ${explorerTx(purchase.transactionHash)}`);

  // 4. report and settle: RLUSD moves from the vault to the merchant payout
  const rec = await fetch(`${AP4M_API_URL}/public/participant/record-redemption`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tx_hash: purchase.transactionHash }),
  });
  if (!rec.ok) log(`record-redemption: ${rec.status} ${(await rec.json()).error ?? ""}`);
  let settled;
  try {
    settled = await settle(AP4M_API_URL, token, channelId);
    log(`settled: payout tx ${settled.payout_tx ?? "?"}${settled.receipt_url ? " — receipt " + AP4M_API_URL + settled.receipt_url : ""}`);
  } catch (e) {
    log(`settle: ${e.message} (settlement is also automatic within a few blocks)`);
  }

  // 5. hand the purchase to the payroll engine and to the pay desk
  const record = {
    purchased_at: new Date().toISOString(),
    provider: RESOURCE_URL,
    operation: OPERATION,
    network: { name: config.network.name, chainId: config.network.chainId },
    channel: {
      id: channelId,
      cap_rlusd: ethers.formatUnits(after.cap, 18),
      used_rlusd: ethers.formatUnits(after.redeemed, 18),
      remaining_rlusd: ethers.formatUnits(after.cap - after.redeemed, 18),
    },
    paid_rlusd: ethers.formatUnits(paid, 18),
    claim_id: purchase.claimId,
    redemption_tx: purchase.transactionHash,
    redemption_explorer: explorerTx(purchase.transactionHash),
    settlement_tx: settled?.settlement_tx ?? null,
    payout_tx: settled?.payout_tx ?? null,
    receipt_url: settled?.receipt_url ? AP4M_API_URL + settled.receipt_url : null,
    rules: purchase.resource,
  };
  for (const f of [OUT_RULES, OUT_PAGE]) {
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(record, null, 2));
  }
  log(`written: ${path.relative(process.cwd(), OUT_RULES)}, ${path.relative(process.cwd(), OUT_PAGE)}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
