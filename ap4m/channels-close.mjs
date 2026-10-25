/**
 * Sandbox housekeeping: close the agent's open AP4M Channels so the cap they still
 * hold goes back to the team budget. Every payout opens a Channel sized to the pay,
 * and the weekend allocation is 20 RLUSD, so after a few runs the budget is all
 * assigned to Channels that each have less left than one pay. Closing signs a
 * checkpoint at the amount already redeemed: nothing is paid here, the service
 * settles what the merchants are owed, and the unused remainder is unassigned again.
 *
 * Usage: node channels-close.mjs [--keep <channel id prefix>]...
 */
import { ethers } from "ethers";
import hackathonSdk from "./ap4m-hackathon-sdk.cjs";
import { loadEnv, need } from "./env.mjs";

const { signIn, listChannels, getChannelState, closeChannel } = hackathonSdk;
loadEnv();
const API = process.env.AP4M_API_URL || "https://hackathon.ap4m.build";
const TEAM = process.env.TEAM_NAME || "dareskro";
const args = process.argv.slice(2);
const keep = args.flatMap((a, i) => (a === "--keep" ? [args[i + 1]] : []));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const config = await (await fetch(`${API}/public/config`)).json();
const provider = new ethers.JsonRpcProvider(config.network.rpcUrl);
const agent = new ethers.Wallet(need("AGENT_PRIVATE_KEY"), provider);
const ledger = config.contracts.paymentLedger;
const { token } = await signIn(API, TEAM, agent);

// what is redeemed on any Channel, open or closed, is spent; what the open Channels still
// hold is not free either: a new Channel can only take the rest of the allocation
const budget = async () => {
  const me = await (await fetch(`${API}/public/participant/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  let spent = 0, held = 0;
  for (const c of await listChannels(API, token)) {
    const st = await getChannelState(provider, ledger, c.channel_id);
    spent += Number(ethers.formatUnits(st.redeemed, 18));
    if (["open", "bound", "requested"].includes(c.channel_status)) held += Number(ethers.formatUnits(st.cap - st.redeemed, 18));
  }
  const cap = Number(me.paymentState?.allocation_cap ?? 0);
  return { cap, spent, held, free: cap - spent - held };
};

const before = await budget();
log(`budget ${before.cap.toFixed(2)} RLUSD: ${before.spent.toFixed(2)} spent, ${before.held.toFixed(2)} held by open Channels, ${before.free.toFixed(2)} free`);
let freed = 0;
for (const c of await listChannels(API, token)) {
  if (!["open", "bound"].includes(c.channel_status)) continue;
  if (keep.some((k) => c.channel_id.startsWith(k))) { log(`channel ${c.channel_id.slice(0, 10)}… kept`); continue; }
  const st = await getChannelState(provider, ledger, c.channel_id);
  const remaining = Number(ethers.formatUnits(st.cap - st.redeemed, 18));
  try {
    const r = await closeChannel(API, token, agent, c.channel_id);
    freed += remaining;
    log(`channel ${c.channel_id.slice(0, 10)}… closed at ${ethers.formatUnits(BigInt(r.final_cumulative_amount ?? st.redeemed), 18)} RLUSD redeemed, ${remaining.toFixed(2)} RLUSD given back — ${r.tx_hash ?? ""}`);
  } catch (e) {
    log(`channel ${c.channel_id.slice(0, 10)}…: ${e.message}`);
  }
}
const after = await budget();
log(`now ${after.free.toFixed(2)} RLUSD free for a new Channel (${freed.toFixed(2)} given back)`);
