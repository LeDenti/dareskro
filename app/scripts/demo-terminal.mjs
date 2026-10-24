/**
 * The dareskro demo from a terminal, no browser: the statement in euros, the
 * rate, the escrow built for the device, signed on the Ledger XRP app running
 * in Speculos (every device screen captured), submitted, handed to the oracle,
 * which releases it at the date. Everything printed is real and goes to
 * capture/trace.json for the "terminal manipulation" video.
 *
 * Usage (from app/):  node scripts/demo-terminal.mjs
 * Needs: Speculos on :5000 (Nano X, XRP app), the oracle on :8787,
 *        app/public/bulletin.json (python agent/bulletin_garde.py).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstValueFrom } from "rxjs";
import { Client, encode, xrpToDrops } from "xrpl";

// The DMK's ESM build uses directory imports that plain Node cannot resolve
// (ERR_UNSUPPORTED_DIR_IMPORT); its CommonJS build loads fine. Noted in LEDGER_FEEDBACK.md.
const require = createRequire(import.meta.url);
const { DeviceManagementKitBuilder, DeviceModelId, DeviceActionStatus, hexaStringToBuffer, bufferToHexaString } = require("@ledgerhq/device-management-kit");
const { SignerXrpBuilder } = require("@ledgerhq/device-signer-kit-xrp");
const { speculosIdentifier, speculosTransportFactory } = require("@ledgerhq/device-transport-kit-speculos");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE = path.join(HERE, "..", "..", "presentation", "demo-terminal", "capture");
const SCREENS = path.join(CAPTURE, "screens");
mkdirSync(SCREENS, { recursive: true });
const SPECULOS = "http://127.0.0.1:5000";
const ORACLE = "http://127.0.0.1:8787";
const TESTNET = "wss://s.altnet.rippletest.net:51233";
const FAUCET = "https://faucet.altnet.rippletest.net/accounts";
const PATH_XRP = "44'/144'/0'/0/0";
const PAY_DELAY_S = 90;
const RIPPLE_EPOCH = 946684800;
const explorerTx = (h) => `https://testnet.xrpl.org/transactions/${h}`;
const toHex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const trace = [];
function say(line, kind = "out") {
  const at = ((Date.now() - t0) / 1000).toFixed(1);
  trace.push({ at: Number(at), kind, text: line });
  console.log(line);
}
const cmd = (c) => say(`$ ${c}`, "cmd");

// ---------------------------------------------------------------- speculos
async function screen() {
  const ev = await (await fetch(`${SPECULOS}/events?currentscreenonly=true`)).json();
  return ev.events.map((e) => e.text).join(" | ");
}
async function press(b) {
  await fetch(`${SPECULOS}/button/${b}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "press-and-release" }) });
}
let shot = 0;
async function snap(label) {
  const png = Buffer.from(await (await fetch(`${SPECULOS}/screenshot`)).arrayBuffer());
  const file = path.join(SCREENS, `${String(shot++).padStart(2, "0")}.png`);
  writeFileSync(file, png);
  trace.push({ at: Number(((Date.now() - t0) / 1000).toFixed(1)), kind: "screen", text: label, file: path.basename(file) });
  return file;
}

// ------------------------------------------------------------------ 1. pay
cmd("python agent/bulletin_garde.py --exige-achat");
const statement = JSON.parse(readFileSync(path.join(HERE, "..", "public", "bulletin.json"), "utf8"));
for (const l of statement.lines) say(`  ${l.item.padEnd(26)} ${l.amount.padStart(8)} EUR`);
say(`  ${"TOTAL".padEnd(26)} ${statement.total.padStart(8)} EUR   (+ ${statement.rest_hours_outside_escrow} h of rest, outside the escrow)`);
say(`  rules      ${statement.rules_source.how}`);
say(`  sha256     ${statement.sha256}`);

const CUR = (statement.currency || "USD").toUpperCase();
cmd(`curl https://api.kraken.com/0/public/Ticker?pair=XRP${CUR}`);
const k = await (await fetch(`https://api.kraken.com/0/public/Ticker?pair=XRP${CUR}`)).json();
const rate = Number(Object.values(k.result)[0].c[0]);
const amountXrp = (Number(statement.total) / rate).toFixed(6);
say(`  XRP/${CUR} ${rate}  →  ${statement.total} ${CUR} = ${amountXrp} XRP`);

// --------------------------------------------------------------- 2. device
cmd("node scripts/demo-terminal.mjs   # device: speculos, nanox");
const dmk = new DeviceManagementKitBuilder().addTransport(speculosTransportFactory(SPECULOS, false, DeviceModelId.NANO_X)).build();
const device = await firstValueFrom(dmk.startDiscovering({ transport: speculosIdentifier }));
const sessionId = await dmk.connect({ device });
const signer = new SignerXrpBuilder({ dmk, sessionId }).build();
say(`  connected: ${dmk.getConnectedDevice({ sessionId }).name}`);
await snap("app is ready");

async function runAction(start) {
  return new Promise((resolve, reject) => {
    start().observable.subscribe({
      next: (s) => {
        if (s.status === DeviceActionStatus.Completed) resolve(s.output);
        if (s.status === DeviceActionStatus.Error) reject(s.error);
        if (s.status === DeviceActionStatus.Stopped) reject(new Error("cancelled on device"));
      },
      error: reject,
    });
  });
}
const addr = await runAction(() => signer.getAddress(PATH_XRP, { checkOnDevice: false }));
say(`  employer (device, ${PATH_XRP}): ${addr.address}`);

const client = new Client(TESTNET);
await client.connect();
async function balance(a) {
  try { return await client.getXrpBalance(a); } catch { return 0; }
}
cmd(`curl -X POST ${FAUCET} -d '{"destination":"${addr.address}"}'   # until ${Math.ceil(Number(amountXrp)) + 5} XRP`);
let bal = await balance(addr.address);
for (let i = 0; i < 8 && bal < Number(amountXrp) + 5; i++) {
  await fetch(FAUCET, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destination: addr.address }) });
  await sleep(5000);
  bal = await balance(addr.address);
  say(`  balance ${bal} XRP`);
}
const { wallet: employee } = await client.fundWallet();
say(`  employee (test account): ${employee.classicAddress}`);

// ----------------------------------------------------------- 3. the escrow
const oracle = await (await fetch(`${ORACLE}/identity`)).json();
const finishAfter = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + PAY_DELAY_S;
const now = new Date().toISOString();
const tx = await client.autofill({
  TransactionType: "EscrowCreate",
  Account: addr.address,
  Destination: employee.classicAddress,
  Amount: xrpToDrops(amountXrp),
  FinishAfter: finishAfter,
  Memos: [
    { Memo: { MemoType: toHex("dareskro/statement-sha256"), MemoData: toHex(statement.sha256), MemoFormat: toHex("text/plain") } },
    { Memo: { MemoType: toHex("dareskro/statement-id"), MemoData: toHex(statement.statement_id), MemoFormat: toHex("text/plain") } },
    { Memo: { MemoType: toHex("dareskro/fiat"), MemoData: toHex(`${statement.total} ${CUR} @ ${rate} ${CUR}/XRP Kraken ${now.slice(0, 16)}Z`) } },
    { Memo: { MemoType: toHex("dareskro/oracle"), MemoData: toHex(oracle.address) } },
  ],
  SigningPubKey: addr.publicKey.toUpperCase(),
  LastLedgerSequence: (await client.getLedgerIndex()) + 150,
});
say(`  EscrowCreate: ${amountXrp} XRP → ${employee.classicAddress.slice(0, 10)}…, FinishAfter ${new Date((finishAfter + RIPPLE_EPOCH) * 1000).toISOString().slice(11, 19)} UTC, 4 memos, oracle ${oracle.address.slice(0, 10)}…`);
say("  → review on the device");

// sign: drive the device while the signer waits for approval
const unsigned = encode(tx);
const signing = runAction(() => signer.signTransaction(PATH_XRP, hexaStringToBuffer(unsigned)));
const seen = [];
for (let i = 0; i < 80; i++) {
  await sleep(350);
  const s = await screen();
  if (!s.includes("Review") && seen.length === 0) continue;
  if (seen[seen.length - 1] !== s) {
    seen.push(s);
    say(`  [device] ${s}`, "device");
    await snap(s);
  }
  if (s.includes("Sign transaction")) {
    await press("both");
    await sleep(600);
    say(`  [device] ${await screen()}`, "device");
    await snap("Transaction signed");
    break;
  }
  await press("right");
}
const signature = await signing;
const signed = encode({ ...tx, TxnSignature: bufferToHexaString(signature, false).toUpperCase() });
say(`  signed on the device (${seen.length} screens)`);

cmd("xrpl submit --wait");
const res = await client.submitAndWait(signed);
const code = res.result.meta.TransactionResult;
say(`  ${code}  escrow #${tx.Sequence}  ${explorerTx(res.result.hash)}`);

cmd(`curl -X POST ${ORACLE}/watch`);
await fetch(`${ORACLE}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner: addr.address, sequence: tx.Sequence, finishAfter, destination: employee.classicAddress, amountXrp, amount: statement.total, currency: CUR, payout: "usd", statementSha256: statement.sha256, createHash: res.result.hash }) });
say(`  oracle ${oracle.address} is watching escrow #${tx.Sequence}`);

// ----------------------------------------------------------- 4. the proofs
cmd("node proofs.mjs --early-finish --by third-party");
const { wallet: third } = await client.fundWallet();
const early = await client.submitAndWait({ TransactionType: "EscrowFinish", Account: third.classicAddress, Owner: addr.address, OfferSequence: tx.Sequence }, { wallet: third, autofill: true });
say(`  ${early.result.meta.TransactionResult}  ${explorerTx(early.result.hash)}`);

cmd("tail -f oracle.log");
let watched;
for (let i = 0; i < 60; i++) {
  await sleep(4000);
  const reg = await (await fetch(`${ORACLE}/escrows`)).json();
  watched = reg.escrows.find((e) => e.owner === addr.address && e.sequence === tx.Sequence);
  if (watched?.status === "finished") break;
}
if (watched?.status === "finished") {
  say(`  escrow #${tx.Sequence}: finished by the oracle at ${watched.finishedAt.slice(11, 19)} UTC — ${explorerTx(watched.finishHash)}`);
  say(`  employee balance: ${await balance(employee.classicAddress)} XRP`);
  cmd("tail -f oracle.log   # the employee chose dollars");
  for (let i = 0; i < 60 && !watched.payoutResult; i++) { await sleep(4000); const reg = await (await fetch(`${ORACLE}/escrows`)).json(); watched = reg.escrows.find((x) => x.owner === addr.address && x.sequence === tx.Sequence); }
  if (watched.payoutResult && !watched.payoutResult.error) say(`  ${watched.payoutResult.amount_rlusd} RLUSD settled to the employee through Mastercard AP4M — ${watched.payoutResult.redemption_explorer}${watched.payoutResult.receipt_url ? " — receipt " + watched.payoutResult.receipt_url : ""}`);
  else say(`  payout: ${JSON.stringify(watched.payoutResult ?? "pending")}`);
} else {
  say(`  oracle status: ${watched?.status} ${watched?.lastResult ?? ""}`);
}

await client.disconnect();
await dmk.disconnect({ sessionId });
dmk.close();
writeFileSync(path.join(CAPTURE, "trace.json"), JSON.stringify({ started: new Date(t0).toISOString(), rate, amountXrp, statement: { total: statement.total, sha256: statement.sha256 }, employer: addr.address, employee: employee.classicAddress, oracle: oracle.address, escrow: { sequence: tx.Sequence, createHash: res.result.hash, createResult: code, earlyFinish: { hash: early.result.hash, result: early.result.meta.TransactionResult }, finishHash: watched?.finishHash ?? null }, screens: seen, trace }, null, 2));
say(`  trace written: ${path.relative(process.cwd(), path.join(CAPTURE, "trace.json"))}`);
process.exit(0);
