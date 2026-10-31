/**
 * Read transactions back from the testnet and print their memos in clear — what the chain holds.
 * Usage: node paie/lire_tx.mjs <HASH> [<HASH>…]      (node XRPL_TESTNET_URL, default wss://testnet.xrpl-labs.com)
 */
import { Client, convertHexToString } from "xrpl";
const c = new Client(process.env.XRPL_TESTNET_URL || "wss://testnet.xrpl-labs.com");
await c.connect();
for (const h of process.argv.slice(2)) {
  const r = await c.request({ command: "tx", transaction: h });
  const t = r.result.tx_json ?? r.result;
  const meta = r.result.meta;
  console.log(`${h.slice(0,8)}… ${t.TransactionType} seq ${t.Sequence} ${meta.TransactionResult} validated=${r.result.validated} ledger ${r.result.ledger_index} ${r.result.close_time_iso ?? ""}`);
  console.log(`   Account ${t.Account} -> ${t.Destination ?? ""} Amount ${t.Amount ?? t.SendMax ?? ""} FinishAfter ${t.FinishAfter ?? ""} Expiration ${t.Expiration ?? ""} InvoiceID ${t.InvoiceID ?? ""}`);
  for (const m of t.Memos ?? []) console.log(`   memo ${convertHexToString(m.Memo.MemoType)} = ${convertHexToString(m.Memo.MemoData)}`);
}
await c.disconnect();
