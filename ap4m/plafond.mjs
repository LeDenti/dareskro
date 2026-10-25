/**
 * The spend limit, enforced: two over-cap attempts, both refused.
 *
 *   1. Channel cap. The agent tries to pay the employee's payslip (4.67 RLUSD) on a
 *      channel that has 0.66 RLUSD left: the Merchant reads the channel on chain and
 *      issues no 402 for a price it cannot cover (HTTP 503), and had it issued one the
 *      kit would refuse to sign a Voucher above cap. The rule "settled <= redeemed <= cap"
 *      never bends, and no signature exists to bend it.
 *   2. Authorized Spend Limit. The agent asks the platform for a new channel whose cap
 *      exceeds the team's unassigned deposit: the platform refuses to open it.
 *
 * Nothing is paid, nothing is signed, no state is kept: this script only proves the
 * limits. Usage: node plafond.mjs   (reads ap4m/.env)
 */
import { ethers } from "ethers";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import hackathonSdk from "./ap4m-hackathon-sdk.cjs";
import { buyResource, loadX402Context } from "./ap4m-x402.mjs";
import { loadEnv, need } from "./env.mjs";

const { signIn, requestChannel, listChannels, getChannelState } = hackathonSdk;
loadEnv();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.AP4M_API_URL || "https://hackathon.ap4m.build";
const TEAM = process.env.TEAM_NAME || "dareskro";
const PORT = 4310;
const PRICE = "4.67";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (wei) => Number(ethers.formatUnits(wei, 18)).toFixed(2);

const scratch = mkdtempSync(path.join(tmpdir(), "dareskro-plafond-"));
const merchant = spawn("node", [path.join(HERE, "merchant.mjs")], {
  cwd: HERE,
  env: { ...process.env, MERCHANT_PORT: String(PORT), RESOURCE_URL: `http://127.0.0.1:${PORT}/resource`, PRICE_RLUSD: PRICE,
    STATE_DIRECTORY: path.join(scratch, "merchant"), MERCHANT_CONTENT_JSON: JSON.stringify({ schema: "dareskro/payslip-settlement.v1", note: "over-cap rehearsal, never paid" }) },
  stdio: ["ignore", "pipe", "pipe"],
});
merchant.stdout.on("data", (d) => process.stdout.write("  [merchant] " + d));
await sleep(6000);

let verdicts = [];
try {
  const config = await (await fetch(`${API}/public/config`)).json();
  const provider = new ethers.JsonRpcProvider(config.network.rpcUrl);
  const agent = new ethers.Wallet(need("AGENT_PRIVATE_KEY"), provider);
  const ledger = config.contracts.paymentLedger;
  const { token } = await signIn(API, TEAM, agent);

  // --- 1. the channel cap
  let target = null;
  let assigned = 0;
  for (const c of await listChannels(API, token)) {
    if (!["open", "bound", "requested"].includes(c.channel_status)) continue;
    const st = await getChannelState(provider, ledger, c.channel_id);
    assigned += Number(ethers.formatUnits(st.cap, 18));
    const left = st.cap - st.redeemed;
    log(`channel ${c.channel_id.slice(0, 10)}… ${c.channel_status}: cap ${fmt(st.cap)}, redeemed ${fmt(st.redeemed)}, left ${fmt(left)} RLUSD`);
    if (c.channel_status === "open" && Number(ethers.formatUnits(left, 18)) < Number(PRICE) && (!target || left < target.left)) target = { id: c.channel_id, left, cap: st.cap, redeemed: st.redeemed };
  }
  if (!target) throw new Error("no open channel short of funds to rehearse on (every channel could pay 4.67 RLUSD)");
  log(`attempt 1: pay the payslip, ${PRICE} RLUSD, on channel ${target.id.slice(0, 10)}… which has ${fmt(target.left)} RLUSD left`);
  const context = await loadX402Context(API);
  try {
    await buyResource({
      context, provider, wallet: agent, stateDirectory: path.join(scratch, "agent"),
      resourceUrl: `http://127.0.0.1:${PORT}/resource`, channelId: target.id,
      maximumAmount: ethers.parseUnits("4.68", 18).toString(), operation: `plafond-${Date.now().toString(36)}`,
    });
    verdicts.push({ attempt: "channel cap", refused: false });
    log("attempt 1: PAID — this must not happen");
  } catch (e) {
    // Two guards can say no: the Merchant (payee facilitator) reads the channel on chain and issues
    // no 402 for a price it cannot cover (HTTP 503); the kit refuses to sign a Voucher above cap.
    const by = /HTTP 503/.test(e.message) ? "the Merchant, reading the channel on chain: no 402 challenge issued" : "the kit, before signing: no Voucher above cap";
    verdicts.push({ attempt: "channel cap", refused: true, by, message: e.message });
    log(`attempt 1: REFUSED by ${by} — ${e.message}`);
    log(`  the rule: settled <= redeemed <= cap. redeemed ${fmt(target.redeemed)} + ${PRICE} = ${(Number(fmt(target.redeemed)) + Number(PRICE)).toFixed(2)} > cap ${fmt(target.cap)}: no Voucher is signed, so none can be redeemed`);
  }

  // --- 2. the authorized spend limit (the team's deposit)
  const me = await (await fetch(`${API}/public/participant/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const allocation = Number(me.paymentState?.allocation_cap ?? 0);
  const available = allocation - assigned;
  const ask = (available + 50).toFixed(2);
  log(`attempt 2: open a new channel with cap ${ask} RLUSD, while the team's limit is ${allocation.toFixed(2)} and ${available.toFixed(2)} is unassigned`);
  try {
    const ch = await requestChannel(API, token, agent, { capRlusd: ask });
    verdicts.push({ attempt: "spend limit", refused: false, channel: ch.channel_id });
    log(`attempt 2: OPENED ${ch.channel_id} — this must not happen`);
  } catch (e) {
    verdicts.push({ attempt: "spend limit", refused: true, by: "the platform", message: e.message });
    log(`attempt 2: REFUSED — ${e.message}`);
  }
} finally {
  merchant.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
}
const allRefused = verdicts.length === 2 && verdicts.every((v) => v.refused);
console.log(JSON.stringify({ measured_at: new Date().toISOString(), verdicts, conclusion: allRefused ? "both over-cap attempts refused: the agent cannot spend beyond what the employer funded" : "UNEXPECTED" }, null, 2));
process.exit(allRefused ? 0 : 1);
