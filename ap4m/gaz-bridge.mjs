/**
 * Du gaz pour XRPL EVM testnet sans le robinet web : on prend des XRP de test sur
 * le XRP Ledger testnet (robinet en ligne de commande) et on les passe par le
 * pont Axelar. Un Payment vers la passerelle avec quatre memos ; la destination
 * recoit Amount - gas_fee_amount quelques minutes plus tard.
 * Usage : node gaz-bridge.mjs <adresse EVM> [<adresse EVM> ...]
 */
import { Client, xrpToDrops } from "xrpl";
const GATEWAY = "rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2";   // passerelle Axelar, XRPL testnet
const SEND_XRP = "45";                                    // par destination
const GAS_DROPS = "2000000";                              // 2 XRP de gaz pour le relais
const hex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const dests = process.argv.slice(2);
if (!dests.length) { console.log("usage: node gaz-bridge.mjs <0x...> [<0x...>]"); process.exit(1); }
const c = new Client("wss://s.altnet.rippletest.net:51233");
await c.connect();
const { wallet, balance } = await c.fundWallet();
console.log(`source XRPL testnet ${wallet.classicAddress}, ${balance} XRP`);
for (const d of dests) {
  const tx = {
    TransactionType: "Payment",
    Account: wallet.classicAddress,
    Destination: GATEWAY,
    Amount: xrpToDrops(SEND_XRP),
    Memos: [
      { Memo: { MemoType: hex("type"), MemoData: hex("interchain_transfer") } },
      { Memo: { MemoType: hex("destination_address"), MemoData: hex(d.replace(/^0x/, "")) } },
      { Memo: { MemoType: hex("destination_chain"), MemoData: hex("xrpl-evm") } },
      { Memo: { MemoType: hex("gas_fee_amount"), MemoData: hex(GAS_DROPS) } },
    ],
  };
  const r = await c.submitAndWait(tx, { wallet, autofill: true });
  const code = typeof r.result.meta === "object" ? r.result.meta.TransactionResult : "?";
  console.log(`${d}: ${code} ${SEND_XRP} XRP vers la passerelle (gaz ${Number(GAS_DROPS) / 1e6} XRP) — https://testnet.xrpl.org/transactions/${r.result.hash} — suivi https://testnet.axelarscan.io/gmp/${r.result.hash}`);
}
await c.disconnect();
