/**
 * dareskro rules service — an x402 Merchant on Mastercard Agent Pay for Machines.
 *
 * WHAT IT SELLS. The parameters of the French pharmacy collective agreement that
 * the payroll engine needs to price a shift: the point value, the seniority
 * tiers, the Sunday allowance, the overtime thresholds. The kind of data a
 * payroll agent must fetch from a provider that keeps it current, and pays for
 * per query. Price: 0.05 RLUSD a query.
 *
 * HOW IT IS PAID. GET /resource without payment answers HTTP 402 with a
 * PAYMENT-REQUIRED header. The Agent signs an EIP-712 Voucher on its Channel
 * (cumulative amount, within the cap the employer approved) and retries with a
 * PAYMENT-SIGNATURE header. This server redeems the Voucher on the PaymentLedger
 * contract (XRPL EVM testnet, gas paid by the submitter wallet), the ledger emits
 * VoucherRedeemed, and the resource is returned. AP4M then settles RLUSD from the
 * escrow vault to the payout wallet.
 *
 * Usage:  node merchant.mjs      (reads ap4m/.env: MERCHANT_ID, MERCHANT_PAYOUT,
 *                                 MERCHANT_SUBMITTER_KEY, PRICE_RLUSD, PORT)
 */
import { ethers } from "ethers";
import hackathonSdk from "./ap4m-hackathon-sdk.cjs";
import { createX402Merchant, loadX402Context } from "./ap4m-x402.mjs";
import { loadEnv, need } from "./env.mjs";

const { signIn } = hackathonSdk;
loadEnv();

/** The team's Merchant ID from the portal, when it is not in .env: sign in as the agent and read the team record. */
async function merchantIdFromPortal(apiUrl) {
  const agent = new ethers.Wallet(need("AGENT_PRIVATE_KEY"));
  const { token } = await signIn(apiUrl, process.env.TEAM_NAME || "dareskro", agent);
  const me = await (await fetch(`${apiUrl}/public/participant/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (!me.team?.merchant_id) {
    throw new Error("no Merchant on the team yet: add the merchant payout wallet in My setup on the portal, then start again");
  }
  if (me.team.merchant_wallet && process.env.MERCHANT_PAYOUT
      && me.team.merchant_wallet.toLowerCase() !== process.env.MERCHANT_PAYOUT.toLowerCase()) {
    console.warn(`WARNING: the portal's merchant wallet is ${me.team.merchant_wallet}, .env says ${process.env.MERCHANT_PAYOUT}`);
  }
  return { merchantId: me.team.merchant_id, payout: me.team.merchant_wallet };
}

const AP4M_API_URL = process.env.AP4M_API_URL || "https://hackathon.ap4m.build";
const PRICE_RLUSD = process.env.PRICE_RLUSD || "0.05";
const PORT = Number(process.env.MERCHANT_PORT || 4308);
const RESOURCE_URL = process.env.RESOURCE_URL || `http://127.0.0.1:${PORT}/resource`;
const STATE_DIRECTORY = process.env.STATE_DIRECTORY || "./merchant-state";
/** Another resource than the rules, e.g. a payslip settlement: JSON in MERCHANT_CONTENT_JSON. */
const CONTENT_OVERRIDE = process.env.MERCHANT_CONTENT_JSON ? JSON.parse(process.env.MERCHANT_CONTENT_JSON) : null;

/** The resource. Static by design: a retry must receive the same content. */
export const RULES = {
  schema: "dareskro/payroll-rules.v1",
  provider: "dareskro rules service",
  agreement: "Pharmacie d'officine, IDCC 1996",
  valid_from: "2026-01-19",
  point_value_eur: "5.277",
  point_value_source: "accord du 19/01/2026, arrêté d'extension du 02/04/2026 — à confirmer",
  monthly_hours: "151.67",
  weekly_threshold_hours: "35",
  overtime_tiers: [
    { up_to_hours: "43", markup: "0.25" },
    { up_to_hours: null, markup: "0.50" },
  ],
  seniority_bonus: [
    { after_years: 3, rate: "0.03" },
    { after_years: 6, rate: "0.06" },
    { after_years: 9, rate: "0.09" },
    { after_years: 12, rate: "0.12" },
    { after_years: 15, rate: "0.15" },
  ],
  seniority_basis: "minimum of the coefficient, prorated to hours worked, overtime markups excluded (art. 11)",
  sunday_allowance_points_per_hour: "1.5",
  sunday_rest: "equal duration, not payable (accord du 23/03/2000 révisé 09/04/2008, art. 4)",
  closed_shutters_full_time_share: "0.25",
  night_markups: "due with shutters open, never with shutters closed",
  sources: [
    "convention collective pharmacie d'officine IDCC 1996, art. 11",
    "art. 7 → accord du 23/03/2000 révisé le 09/04/2008, art. 4",
  ],
};

async function main() {
  let merchantId = process.env.MERCHANT_ID;
  let payout = process.env.MERCHANT_PAYOUT;
  if (!merchantId) {
    const fromPortal = await merchantIdFromPortal(AP4M_API_URL);
    merchantId = fromPortal.merchantId;
    payout = fromPortal.payout || payout;
    console.log(`merchant id from the portal: ${merchantId}`);
  }
  if (!payout) throw new Error("missing MERCHANT_PAYOUT");
  const submitterKey = need("MERCHANT_SUBMITTER_KEY");
  const context = await loadX402Context(AP4M_API_URL);
  const config = await (await fetch(`${AP4M_API_URL}/public/config`)).json();
  const provider = new ethers.JsonRpcProvider(process.env.AP4M_RPC_URL || config.network.rpcUrl);
  const submitter = new ethers.Wallet(submitterKey, provider);
  const gas = await provider.getBalance(submitter.address);
  console.log(`submitter ${submitter.address} holds ${ethers.formatEther(gas)} XRP for gas`);
  if (gas === 0n) console.warn("WARNING: no gas — redemptions will fail. Fund the submitter from the XRPL EVM testnet faucet.");

  const merchant = createX402Merchant({
    context,
    provider,
    submitter,
    stateDirectory: STATE_DIRECTORY,
    resourceUrl: RESOURCE_URL,
    merchantParticipantId: merchantId,
    payout,
    amount: ethers.parseUnits(PRICE_RLUSD, 18).toString(),
    content: CONTENT_OVERRIDE ?? RULES,
  });
  merchant.server.listen(PORT, "127.0.0.1", () =>
    console.log(`dareskro rules service: ${RESOURCE_URL} — ${PRICE_RLUSD} RLUSD a query — payout ${payout}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => merchant.close().finally(() => process.exit(0)));
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
