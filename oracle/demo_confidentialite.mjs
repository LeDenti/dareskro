/**
 * The privacy layer end to end, on testnet, without a device: the pay locked in
 * TWO escrows signed together — the net to the employee at the pay date, the
 * contributions (employee + employer) to URSSAF at the due date — whose memos
 * leak nothing (hash, opaque id, fiat at rate, gross/net, oracle, zero-knowledge
 * commitment); the statement sealed for the employee and the administration;
 * then the three readers and the proof; then the oracle releasing both.
 * Usage: node oracle/demo_confidentialite.mjs      (oracle on 127.0.0.1:8787, zk/sortie/ proven; lives here for xrpl.js)
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, xrpToDrops } from "xrpl";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ORACLE = process.env.ORACLE_URL || "http://127.0.0.1:8787";
const PAY_DELAY_S = 90;
const RIPPLE_EPOCH = 946684800;
const hex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const explorer = (h) => `https://testnet.xrpl.org/transactions/${h}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (args) => {
  log(`$ node ${args.join(" ")}`);
  try {
    const out = execFileSync("node", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    for (const l of out.split("\n").filter(Boolean)) console.log("    " + l);
    return 0;
  } catch (e) {
    for (const l of String(e.stdout ?? "").split("\n").filter(Boolean)) console.log("    " + l);
    for (const l of String(e.stderr ?? "").split("\n").filter(Boolean)) console.log("    ! " + l);
    return e.status ?? 1;
  }
};

const statement = JSON.parse(readFileSync(path.join(ROOT, "agent", "sortie", "bulletin.json"), "utf8"));
const zk = JSON.parse(readFileSync(path.join(ROOT, "zk", "sortie", "public_inputs.json"), "utf8"));
if (zk.statement_sha256 !== statement.sha256) {
  log(`the proof in zk/sortie is for another statement (${zk.statement_sha256.slice(0, 8)}… ≠ ${statement.sha256.slice(0, 8)}…): node zk/prove.mjs first`);
  process.exit(1);
}
// Opaque statement id: the readable one told the public the day and the coefficient.
const planning = Object.fromEntries(readFileSync(path.join(ROOT, "agent", "preuves", "planning_2026-10-25.txt"), "utf8").split("\n")
  .filter((l) => l.includes(":") && !l.startsWith("#")).map((l) => l.split(":").map((x) => x.trim())).map(([k, ...v]) => [k, v.join(":")]));
const opaqueId = "stmt-" + createHash("sha256").update(`${planning.badge}|${planning.date}|${planning.coefficient}`).digest("hex").slice(0, 12);

const oracle = await (await fetch(`${ORACLE}/identity`)).json();
log(`oracle ${oracle.address} (${oracle.name})`);
const k = await (await fetch(`https://api.kraken.com/0/public/Ticker?pair=XRP${statement.currency}`)).json();
const rate = Number(Object.values(k.result)[0].c[0]);
const net = statement.net_to_pay ?? statement.total;
const paid = statement.net_paid ?? net;
const contrib = statement.contributions?.total_to_urssaf ?? null;
const tax = statement.withholding?.amount ?? null;
const amountXrp = (Number(paid) / rate).toFixed(6);
const contribXrp = contrib ? (Number(contrib) / rate).toFixed(6) : null;
const taxXrp = tax ? (Number(tax) / rate).toFixed(6) : null;
log(`statement ${statement.sha256.slice(0, 12)}… gross ${statement.total} ${statement.currency}, net ${net}, paid ${paid} = ${amountXrp} XRP at ${rate} (Kraken)${contrib ? `, contributions ${contrib} = ${contribXrp} XRP to ${statement.contributions.recipient}` : ""}${tax ? `, income tax ${tax} = ${taxXrp} XRP to ${statement.withholding.recipient}` : ""}`);

const c = new Client("wss://s.altnet.rippletest.net:51233");
await c.connect();
log("funding the employer, a fresh account for the employee (one per pay period: nobody can name the payee) and a stand-in for URSSAF…");
// the faucet throttles bursts (429 after a few accounts a minute): wait and try again
async function fundWalletPatiently(label) {
  for (let i = 0; ; i++) {
    try { return (await c.fundWallet()).wallet; }
    catch (e) {
      if (i >= 6) throw e;
      log(`faucet busy for ${label} (${String(e.message ?? e).includes("429") ? "429 too many requests" : String(e.message ?? e).split("\n")[0].slice(0, 60)}), waiting 25 s…`);
      await sleep(25000);
    }
  }
}
const employer = await fundWalletPatiently("the employer");
const employee = await fundWalletPatiently("the employee");
const urssaf = await fundWalletPatiently("URSSAF");
const dgfip = await fundWalletPatiently("DGFiP");
const needed = Number(amountXrp) + Number(contribXrp ?? 0) + Number(taxXrp ?? 0) + 15;
for (let i = 0; i < 10; i++) {
  const bal = await c.getXrpBalance(employer.classicAddress);
  if (bal >= needed) break;
  await fetch("https://faucet.altnet.rippletest.net/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destination: employer.classicAddress }) });
  await sleep(5000);
}
const finishAfter = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + PAY_DELAY_S;
const tx = await c.autofill({
  TransactionType: "EscrowCreate",
  Account: employer.classicAddress,
  Destination: employee.classicAddress,
  Amount: xrpToDrops(amountXrp),
  FinishAfter: finishAfter,
  Memos: [
    { Memo: { MemoType: hex("dareskro/statement-sha256"), MemoData: hex(statement.sha256), MemoFormat: hex("text/plain") } },
    { Memo: { MemoType: hex("dareskro/statement-id"), MemoData: hex(opaqueId), MemoFormat: hex("text/plain") } },
    { Memo: { MemoType: hex("dareskro/fiat"), MemoData: hex(`${paid} ${statement.currency} @ ${rate} ${statement.currency}/XRP Kraken ${new Date().toISOString().slice(0, 16)}Z`) } },
    // the escrow holds what is paid: the gross the proof binds, and the public rates that lead to it
    ...(contrib ? [{ Memo: { MemoType: hex("dareskro/gross"), MemoData: hex(`gross=${statement.total};net=${net};employee_rate=${statement.contributions.employee.rate}${tax ? `;tax_rate=${statement.withholding.rate};paid=${paid}` : ""}`) } }] : []),
    { Memo: { MemoType: hex("dareskro/oracle"), MemoData: hex(oracle.address) } },
    { Memo: { MemoType: hex("dareskro/zk-commitment"), MemoData: hex(zk.commitment) } },
  ],
});
const inner = [tx];   // the Batch's inner transactions: the pay escrow first

// --- leg 2: the contributions, as a Check: the employer signs once, URSSAF cashes it itself
// before the due date + grace (the native "pull" of the ledger, a direct-debit mandate).
const dueAfter = finishAfter + 30; // demo: 30 s after the pay date; in real life the 15th of the next month
let tx2 = null, createHash2 = null;
if (contrib) {
  tx2 = await c.autofill({
    TransactionType: "CheckCreate",
    Account: employer.classicAddress,
    Destination: urssaf.classicAddress,
    SendMax: xrpToDrops(contribXrp),
    Expiration: dueAfter + 600,
    InvoiceID: statement.sha256.toUpperCase(),
    Memos: [
      { Memo: { MemoType: hex("dareskro/urssaf"), MemoData: hex(`contributions=${contrib};employee=${statement.contributions.employee.amount};employer=${statement.contributions.employer.amount};period=${statement.period};due=${statement.contributions.due}`) } },
      { Memo: { MemoType: hex("dareskro/fiat"), MemoData: hex(`${contrib} ${statement.currency} @ ${rate} ${statement.currency}/XRP Kraken ${new Date().toISOString().slice(0, 16)}Z`) } },
    ],
  });
  inner.push(tx2);
}

// --- leg 3: the income tax withheld at source, an escrow to DGFiP released by the oracle at the due date
let tx3 = null, createHash3 = null;
if (tax) {
  tx3 = await c.autofill({
    TransactionType: "EscrowCreate",
    Account: employer.classicAddress,
    Destination: dgfip.classicAddress,
    Amount: xrpToDrops(taxXrp),
    FinishAfter: dueAfter,
    Memos: [
      { Memo: { MemoType: hex("dareskro/statement-sha256"), MemoData: hex(statement.sha256), MemoFormat: hex("text/plain") } },
      { Memo: { MemoType: hex("dareskro/dgfip"), MemoData: hex(`withheld=${tax};rate=${statement.withholding.rate};period=${statement.period};due=${statement.withholding.due}`) } },
      { Memo: { MemoType: hex("dareskro/fiat"), MemoData: hex(`${tax} ${statement.currency} @ ${rate} ${statement.currency}/XRP Kraken ${new Date().toISOString().slice(0, 16)}Z`) } },
      { Memo: { MemoType: hex("dareskro/oracle"), MemoData: hex(oracle.address) } },
    ],
  });
  inner.push(tx3);
}

// --- one signature: a Batch (XLS-56), all or nothing. Inner transactions carry no fee, no signature, the inner flag,
// and consecutive sequences; the outer one is signed once by the employer — on the Nano, one approval.
const seq0 = (await c.request({ command: "account_info", account: employer.classicAddress })).result.account_data.Sequence;
const strip = (t, sq) => { const o = { ...t }; delete o.Fee; delete o.LastLedgerSequence; return { ...o, Fee: "0", SigningPubKey: "", Sequence: sq, Flags: (o.Flags ?? 0) | 0x40000000 }; };
const batch = await c.autofill({
  TransactionType: "Batch", Account: employer.classicAddress, Flags: 0x00010000, Sequence: seq0,
  RawTransactions: inner.map((t, i) => ({ RawTransaction: strip(t, seq0 + 1 + i) })),
});
const rb = await c.submitAndWait(employer.sign(batch).tx_blob);
const bcode = rb.result.meta.TransactionResult;
log(`Batch ${bcode} — ONE signature, ${inner.length} inner transactions, all or nothing — ${explorer(rb.result.hash)}`);
if (bcode !== "tesSUCCESS") process.exit(1);
// the inner transactions' own hashes, from the account's history
const seqs = inner.map((_, i) => seq0 + 1 + i);
tx.Sequence = seqs[0]; if (tx2) tx2.Sequence = seqs[1]; if (tx3) tx3.Sequence = seqs[tx2 ? 2 : 1];
let hashes = {};
for (let i = 0; i < 6 && Object.keys(hashes).length < seqs.length; i++) {
  await sleep(1500);
  const h = await c.request({ command: "account_tx", account: employer.classicAddress, limit: 20 });
  for (const t of h.result.transactions) { const tj = t.tx_json ?? t.tx; if (tj && seqs.includes(tj.Sequence)) hashes[tj.Sequence] = t.hash ?? tj.hash; }
}
const createHashHex = hashes[tx.Sequence];
log(`  pay escrow #${tx.Sequence}: ${amountXrp} XRP to the employee — ${explorer(createHashHex)}`);
log(`  memos: statement sha256, opaque id ${opaqueId}, fiat at rate, gross/net/paid, oracle, zk commitment ${zk.commitment.slice(0, 18)}…`);
if (tx2) { createHash2 = hashes[tx2.Sequence]; log(`  check #${tx2.Sequence}: up to ${contribXrp} XRP for ${statement.contributions.recipient} (stand-in ${urssaf.classicAddress}), InvoiceID = the statement hash — ${explorer(createHash2)}`); }
if (tx3) { createHash3 = hashes[tx3.Sequence]; log(`  tax escrow #${tx3.Sequence}: ${taxXrp} XRP to ${statement.withholding.recipient} (stand-in ${dgfip.classicAddress}), due ${statement.withholding.due} — ${explorer(createHash3)}`); }
await fetch(`${ORACLE}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
  owner: employer.classicAddress, sequence: tx.Sequence, finishAfter, destination: employee.classicAddress, amountXrp,
  payout: "crypto", amount: paid, currency: statement.currency, statementSha256: statement.sha256, createHash: createHashHex,
}) });
if (tx3) await fetch(`${ORACLE}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
  owner: employer.classicAddress, sequence: tx3.Sequence, finishAfter: dueAfter, destination: dgfip.classicAddress, amountXrp: taxXrp,
  payout: "crypto", amount: tax, currency: statement.currency, statementSha256: statement.sha256, createHash: createHash3,
}) });
log("handed to the oracle: the pay at the date, the income tax at the due date; URSSAF holds a check it cashes itself");

log("— sealing the statement for the employee and the administration, bound to this escrow");
const r1 = show(["agent/confidentiel.mjs", "--chiffre", "--escrow", createHashHex]);
log("— what the public sees");
const r2 = show(["agent/divulgation.mjs", "--role", "public", "--escrow", createHashHex]);
log("— the proof, verified against the chain as anyone can");
const r3 = show(["zk/verify.mjs", "--escrow", createHashHex]);
log("— what the administration sees");
const r4 = show(["agent/divulgation.mjs", "--role", "administration", "--escrow", createHashHex]);

log(`— waiting for the oracle to release the pay at the date (${PAY_DELAY_S} s)${tx3 ? ", then the income tax 30 s later" : ""}${tx2 ? "; URSSAF cashes its check at the due date" : ""}…`);
let finishHash, finishHash3, cashHash;
for (let i = 0; i < 50 && !(finishHash && (!tx3 || finishHash3) && (!tx2 || cashHash)); i++) {
  await sleep(5000);
  const reg = await (await fetch(`${ORACLE}/escrows`)).json();
  const e = reg.escrows.find((x) => x.owner === employer.classicAddress && x.sequence === tx.Sequence);
  if (e?.status === "finished") finishHash = e.finishHash;
  else if (e && e.status !== "waiting") { log(`oracle: ${e.status} ${e.lastResult ?? ""}`); break; }
  if (tx3) {
    const f = reg.escrows.find((x) => x.owner === employer.classicAddress && x.sequence === tx3.Sequence);
    if (f?.status === "finished") finishHash3 = f.finishHash;
  }
  // at the due date, URSSAF (the stand-in's own key) finds the check made out to it and cashes it
  if (tx2 && !cashHash && Math.floor(Date.now() / 1000) - RIPPLE_EPOCH >= dueAfter) {
    const objs = (await c.request({ command: "account_objects", account: urssaf.classicAddress, type: "check" })).result.account_objects;
    const mine = objs.find((o) => (o.InvoiceID || "").toUpperCase() === statement.sha256.toUpperCase());
    if (mine) {
      const rc = await c.submitAndWait({ TransactionType: "CheckCash", Account: urssaf.classicAddress, CheckID: mine.index, Amount: xrpToDrops(contribXrp) }, { wallet: urssaf, autofill: true });
      cashHash = rc.result.hash;
      log(`${statement.contributions.recipient} cashes its check: CheckCash ${rc.result.meta.TransactionResult} — ${explorer(cashHash)}`);
    }
  }
}
if (finishHash) log(`pay released by the oracle: ${explorer(finishHash)} — employee balance ${await c.getXrpBalance(employee.classicAddress)} XRP`);
if (finishHash3) log(`income tax released by the oracle to ${statement.withholding.recipient}: ${explorer(finishHash3)} — balance ${await c.getXrpBalance(dgfip.classicAddress)} XRP`);
if (cashHash) log(`${statement.contributions.recipient} balance after cashing: ${await c.getXrpBalance(urssaf.classicAddress)} XRP`);
await c.disconnect();
const okAll = r1 === 0 && r2 === 0 && r3 === 0 && r4 === 0 && !!finishHash && (!tx2 || !!cashHash) && (!tx3 || !!finishHash3);
log(`SUMMARY: pay escrow ${createHashHex}${createHash2 ? ` | URSSAF check ${createHash2}` : ""}${createHash3 ? ` | DGFiP escrow ${createHash3}` : ""} | seal ${r1 === 0 ? "ok" : "FAIL"} | public ${r2 === 0 ? "sees nothing extra" : "LEAK"} | proof ${r3 === 0 ? "verified" : "FAIL"} | administration ${r4 === 0 ? "MATCH" : "FAIL"} | pay release ${finishHash ? "ok" : "not seen"}${tx2 ? ` | check cashed ${cashHash ? "ok" : "not seen"}` : ""}${tx3 ? ` | tax release ${finishHash3 ? "ok" : "not seen"}` : ""}`);
process.exit(okAll ? 0 : 1);
