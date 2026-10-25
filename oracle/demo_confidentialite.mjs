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
const contrib = statement.contributions?.total_to_urssaf ?? null;
const amountXrp = (Number(net) / rate).toFixed(6);
const contribXrp = contrib ? (Number(contrib) / rate).toFixed(6) : null;
log(`statement ${statement.sha256.slice(0, 12)}… gross ${statement.total} ${statement.currency}, net ${net} = ${amountXrp} XRP at ${rate} (Kraken)${contrib ? `, contributions ${contrib} = ${contribXrp} XRP to ${statement.contributions.recipient}` : ""}`);

const c = new Client("wss://s.altnet.rippletest.net:51233");
await c.connect();
log("funding the employer, a fresh account for the employee (one per pay period: nobody can name the payee) and a stand-in for URSSAF…");
const { wallet: employer } = await c.fundWallet();
const { wallet: employee } = await c.fundWallet();
const { wallet: urssaf } = await c.fundWallet();
const needed = Number(amountXrp) + Number(contribXrp ?? 0) + 15;
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
    { Memo: { MemoType: hex("dareskro/fiat"), MemoData: hex(`${net} ${statement.currency} @ ${rate} ${statement.currency}/XRP Kraken ${new Date().toISOString().slice(0, 16)}Z`) } },
    // the escrow holds the net: the gross the proof binds, and the public rate that links them
    ...(contrib ? [{ Memo: { MemoType: hex("dareskro/gross"), MemoData: hex(`gross=${statement.total};net=${net};employee_rate=${statement.contributions.employee.rate}`) } }] : []),
    { Memo: { MemoType: hex("dareskro/oracle"), MemoData: hex(oracle.address) } },
    { Memo: { MemoType: hex("dareskro/zk-commitment"), MemoData: hex(zk.commitment) } },
  ],
});
const res = await c.submitAndWait(employer.sign(tx).tx_blob);
const code = res.result.meta.TransactionResult;
const createHashHex = res.result.hash;
log(`EscrowCreate ${code} #${tx.Sequence} — ${explorer(createHashHex)}`);
log(`  memos: statement sha256, opaque id ${opaqueId}, fiat at rate, oracle, zk commitment ${zk.commitment.slice(0, 18)}…`);
if (code !== "tesSUCCESS") process.exit(1);
await fetch(`${ORACLE}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
  owner: employer.classicAddress, sequence: tx.Sequence, finishAfter, destination: employee.classicAddress, amountXrp,
  payout: "crypto", amount: statement.total, currency: statement.currency, statementSha256: statement.sha256, createHash: createHashHex,
}) });
log("handed to the oracle (payout: crypto — the employee keeps the XRP)");

// --- escrow 2: the contributions, locked at the same time, released at the due date
let tx2 = null, createHash2 = null;
if (contrib) {
  const dueAfter = finishAfter + 30; // demo: 30 s after the pay date; in real life the 15th of the next month
  tx2 = await c.autofill({
    TransactionType: "EscrowCreate",
    Account: employer.classicAddress,
    Destination: urssaf.classicAddress,
    Amount: xrpToDrops(contribXrp),
    FinishAfter: dueAfter,
    Memos: [
      { Memo: { MemoType: hex("dareskro/statement-sha256"), MemoData: hex(statement.sha256), MemoFormat: hex("text/plain") } },
      { Memo: { MemoType: hex("dareskro/urssaf"), MemoData: hex(`contributions=${contrib};employee=${statement.contributions.employee.amount};employer=${statement.contributions.employer.amount};period=${statement.period};due=${statement.contributions.due}`) } },
      { Memo: { MemoType: hex("dareskro/fiat"), MemoData: hex(`${contrib} ${statement.currency} @ ${rate} ${statement.currency}/XRP Kraken ${new Date().toISOString().slice(0, 16)}Z`) } },
      { Memo: { MemoType: hex("dareskro/oracle"), MemoData: hex(oracle.address) } },
    ],
  });
  const res2 = await c.submitAndWait(employer.sign(tx2).tx_blob);
  createHash2 = res2.result.hash;
  log(`EscrowCreate ${res2.result.meta.TransactionResult} #${tx2.Sequence} — ${contribXrp} XRP to ${statement.contributions.recipient} (stand-in ${urssaf.classicAddress}), due ${statement.contributions.due} — ${explorer(createHash2)}`);
  if (res2.result.meta.TransactionResult !== "tesSUCCESS") process.exit(1);
  await fetch(`${ORACLE}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    owner: employer.classicAddress, sequence: tx2.Sequence, finishAfter: dueAfter, destination: urssaf.classicAddress, amountXrp: contribXrp,
    payout: "crypto", amount: contrib, currency: statement.currency, statementSha256: statement.sha256, createHash: createHash2,
  }) });
  log("handed to the oracle: the same account releases the contributions at the due date — nobody can forget or divert them");
}

log("— sealing the statement for the employee and the administration, bound to this escrow");
const r1 = show(["agent/confidentiel.mjs", "--chiffre", "--escrow", createHashHex]);
log("— what the public sees");
const r2 = show(["agent/divulgation.mjs", "--role", "public", "--escrow", createHashHex]);
log("— the proof, verified against the chain as anyone can");
const r3 = show(["zk/verify.mjs", "--escrow", createHashHex]);
log("— what the administration sees");
const r4 = show(["agent/divulgation.mjs", "--role", "administration", "--escrow", createHashHex]);

log(`— waiting for the oracle to release the pay at the date (${PAY_DELAY_S} s)${tx2 ? ", then the contributions 30 s later" : ""}…`);
let finishHash, finishHash2;
for (let i = 0; i < 50 && !(finishHash && (!tx2 || finishHash2)); i++) {
  await sleep(5000);
  const reg = await (await fetch(`${ORACLE}/escrows`)).json();
  const e = reg.escrows.find((x) => x.owner === employer.classicAddress && x.sequence === tx.Sequence);
  if (e?.status === "finished") finishHash = e.finishHash;
  else if (e && e.status !== "waiting") { log(`oracle: ${e.status} ${e.lastResult ?? ""}`); break; }
  if (tx2) {
    const f = reg.escrows.find((x) => x.owner === employer.classicAddress && x.sequence === tx2.Sequence);
    if (f?.status === "finished") finishHash2 = f.finishHash;
  }
}
if (finishHash) log(`pay released by the oracle: ${explorer(finishHash)} — employee balance ${await c.getXrpBalance(employee.classicAddress)} XRP`);
if (finishHash2) log(`contributions released by the oracle: ${explorer(finishHash2)} — ${statement.contributions.recipient} balance ${await c.getXrpBalance(urssaf.classicAddress)} XRP`);
await c.disconnect();
const okAll = r1 === 0 && r2 === 0 && r3 === 0 && r4 === 0 && !!finishHash && (!tx2 || !!finishHash2);
log(`SUMMARY: pay escrow ${createHashHex}${createHash2 ? ` | contributions escrow ${createHash2}` : ""} | seal ${r1 === 0 ? "ok" : "FAIL"} | public ${r2 === 0 ? "sees nothing extra" : "LEAK"} | proof ${r3 === 0 ? "verified" : "FAIL"} | administration ${r4 === 0 ? "MATCH" : "FAIL"} | pay release ${finishHash ? "ok" : "not seen"}${tx2 ? ` | contributions release ${finishHash2 ? "ok" : "not seen"}` : ""}`);
process.exit(okAll ? 0 : 1);
