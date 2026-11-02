#!/usr/bin/env node
/**
 * Anchor the statement's SHA-256 on the XRP Ledger — the fingerprint, never the document.
 *
 * What goes on the chain: an AccountSet with no setting changed and three memos:
 *   dareskro/sha256       the statement's SHA-256 (the same value the pay escrow's memo carries)
 *   dareskro/pdf-sha256   the official payslip PDF's SHA-256 (paie/bulletin_officiel.py), if given
 *   dareskro/doc          "bulletin de paie <opaque statement id>"
 * No amount moves: the account pays the network fee only. Anyone with the PDF or the JSON
 * can hash it and find that hash in a validated ledger, dated by the ledger's close time;
 * nobody can read the pay, the name or the day from the chain.
 *
 * Networks. testnet by default (node XRPL_TESTNET_URL, else wss://testnet.xrpl-labs.com — the
 * Ripple node answered 503 on 25/10/2026). mainnet only with --mainnet-je-confirme, written
 * out in full, on Julien's explicit decision; node XRPL_MAINNET_URL, else wss://xrplcluster.com.
 *
 * Keys. Never in this file, never in a chat: a JSON file { "seed": "s…" } with mode 0600 (the
 * script refuses anything group- or world-readable), by default paie/cles/ancre.<network>.json
 * (gitignored). `creer-cle` writes such a file: on testnet it asks the faucet to fund it; on
 * mainnet it generates the key offline, prints the address only, and the account must be funded
 * with the base reserve (1 XRP) plus a few fees before it can anchor anything.
 *
 * Usage:
 *   node ancrer.mjs creer-cle  [--reseau testnet|mainnet] [--cle FILE]
 *   node ancrer.mjs ancrer     [--bulletin FILE] [--pdf FILE] [--reseau testnet|mainnet] [--noeud wss://…] [--cle FILE] [--mainnet-je-confirme]
 *   node ancrer.mjs verifier   --tx HASH [--bulletin FILE] [--pdf FILE] [--reseau testnet|mainnet] [--noeud wss://…]
 * Every anchoring is appended to paie/sortie/ancrages.json (no secret in it).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Wallet, convertStringToHex, convertHexToString } from "xrpl";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const args = process.argv.slice(2);
const cmd = args[0];
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const has = (k) => args.includes(k);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const NETWORKS = {
  testnet: { node: process.env.XRPL_TESTNET_URL || "wss://testnet.xrpl-labs.com", explorer: "https://testnet.xrpl.org/transactions/", faucet: true },
  mainnet: { node: process.env.XRPL_MAINNET_URL || "wss://xrplcluster.com", explorer: "https://livenet.xrpl.org/transactions/", faucet: false },
};
const reseau = arg("--reseau", "testnet");
if (!NETWORKS[reseau]) die(`--reseau ${reseau}: testnet or mainnet`);
const net = NETWORKS[reseau];
const noeud = arg("--noeud", net.node);
const cleFile = arg("--cle", path.join(HERE, "cles", `ancre.${reseau}.json`));
const bulletinFile = arg("--bulletin", existsSync(path.join(HERE, "sortie", "bulletin_eur.json")) ? path.join(HERE, "sortie", "bulletin_eur.json") : path.join(ROOT, "agent", "sortie", "bulletin.json"));
const pdfFile = arg("--pdf", existsSync(path.join(HERE, "sortie", "bulletin_officiel.pdf")) ? path.join(HERE, "sortie", "bulletin_officiel.pdf") : undefined);
const ANCRAGES = path.join(HERE, "sortie", "ancrages.json");

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

/** The statement's hash, recomputed with the rule of agent/bulletin_garde.py, and checked against the file's own sha256. */
function lireBulletin(file) {
  const b = JSON.parse(readFileSync(file, "utf8"));
  const sans = Object.fromEntries(Object.entries(b).filter(([k]) => !["sha256", "status", "validation"].includes(k)));
  const canon = JSON.stringify(sortKeys(sans));
  const h = createHash("sha256").update(canon, "utf8").digest("hex");
  if (h !== b.sha256) die(`REFUS: the statement's sha256 (${b.sha256}) is not the hash of its canonical form (${h})`);
  return b;
}

/** JSON.stringify with sorted keys and no spaces — the same bytes as Python's json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False). */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function lireCle(file) {
  if (!existsSync(file)) die(`REFUS: no key file at ${file} — write { "seed": "s…" } there yourself, chmod 600 (or: node ancrer.mjs creer-cle --reseau ${reseau})`);
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) die(`REFUS: ${file} is readable by others (mode ${mode.toString(8)}): chmod 600 first`);
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (!j.seed) die(`REFUS: ${file} has no "seed" field`);
  return Wallet.fromSeed(j.seed);
}

function ecrireCle(file, wallet) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) die(`REFUS: ${file} already exists — not overwriting a key`);
  writeFileSync(file, JSON.stringify({ seed: wallet.seed, address: wallet.classicAddress, network: reseau, created: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
}

function memoText(memos, type) {
  const m = (memos || []).map((x) => x.Memo).find((x) => convertHexToString(x.MemoType) === type);
  return m ? convertHexToString(m.MemoData) : undefined;
}

async function withClient(f) {
  const c = new Client(noeud);
  await c.connect();
  try {
    return await f(c);
  } finally {
    await c.disconnect();
  }
}

async function creerCle() {
  if (reseau === "testnet") {
    await withClient(async (c) => {
      const { wallet, balance } = await c.fundWallet();
      ecrireCle(cleFile, wallet);
      log(`testnet key written to ${cleFile} (0600) — address ${wallet.classicAddress}, ${balance} XRP from the faucet`);
    });
    return;
  }
  // mainnet: offline, nothing leaves this process but the address
  const wallet = Wallet.generate();
  ecrireCle(cleFile, wallet);
  log(`mainnet key generated OFFLINE and written to ${cleFile} (0600). Address: ${wallet.classicAddress}`);
  log(`fund it with the base reserve (1 XRP) plus a few fees (about 1.2 XRP) before anchoring; the seed stays in that file, show it to nobody`);
}

async function ancrer() {
  const b = lireBulletin(bulletinFile);
  const pdfSha = pdfFile ? sha256File(pdfFile) : undefined;
  const wallet = lireCle(cleFile);
  if (reseau === "mainnet" && !has("--mainnet-je-confirme")) {
    die(`REFUS: mainnet needs --mainnet-je-confirme, written in full. This would write on the public ledger, from ${wallet.classicAddress}, the memo sha256=${b.sha256}${pdfSha ? ` and pdf-sha256=${pdfSha}` : ""}, for the network fee. Nothing was sent.`);
  }
  log(`network ${reseau} (${noeud}) — account ${wallet.classicAddress}`);
  log(`statement ${path.relative(ROOT, bulletinFile)}  sha256 ${b.sha256}`);
  if (pdfSha) log(`pdf       ${path.relative(ROOT, pdfFile)}  sha256 ${pdfSha}`);
  await withClient(async (c) => {
    const info = await c.request({ command: "server_info" });
    const reserve = Number(info.result.info.validated_ledger?.reserve_base_xrp ?? 1);
    const fee = Number(info.result.info.validated_ledger?.base_fee_xrp ?? 0.00001);
    let balance;
    try {
      balance = await c.getXrpBalance(wallet.classicAddress);
    } catch (e) {
      if (e?.data?.error === "actNotFound") die(`REFUS: ${wallet.classicAddress} does not exist on ${reseau} yet: fund it with at least the base reserve (${reserve} XRP) first`);
      throw e;
    }
    if (balance < reserve + fee * 10) die(`REFUS: balance ${balance} XRP, below the base reserve ${reserve} XRP plus fees — fund the account first`);
    log(`balance ${balance} XRP, base reserve ${reserve} XRP, fee about ${fee} XRP: enough, the anchoring costs the fee only`);
    const memos = [
      { Memo: { MemoType: convertStringToHex("dareskro/sha256"), MemoData: convertStringToHex(b.sha256) } },
      ...(pdfSha ? [{ Memo: { MemoType: convertStringToHex("dareskro/pdf-sha256"), MemoData: convertStringToHex(pdfSha) } }] : []),
      { Memo: { MemoType: convertStringToHex("dareskro/doc"), MemoData: convertStringToHex(`bulletin de paie ${b.statement_id}`) } },
    ];
    const tx = await c.autofill({ TransactionType: "AccountSet", Account: wallet.classicAddress, Memos: memos });
    const signed = wallet.sign(tx);
    const res = await c.submitAndWait(signed.tx_blob);
    const result = typeof res.result.meta === "object" ? res.result.meta.TransactionResult : "unknown";
    const record = {
      network: reseau, node: noeud, account: wallet.classicAddress, tx: res.result.hash, result, validated: res.result.validated,
      ledger_index: res.result.ledger_index, close_time_iso: res.result.close_time_iso,
      statement: path.relative(ROOT, bulletinFile), statement_sha256: b.sha256, statement_id: b.statement_id,
      pdf: pdfFile ? path.relative(ROOT, pdfFile) : null, pdf_sha256: pdfSha ?? null,
      fee_drops: tx.Fee, explorer: net.explorer + res.result.hash, at: new Date().toISOString(),
    };
    const all = existsSync(ANCRAGES) ? JSON.parse(readFileSync(ANCRAGES, "utf8")) : [];
    all.push(record);
    mkdirSync(path.dirname(ANCRAGES), { recursive: true });
    writeFileSync(ANCRAGES, JSON.stringify(all, null, 2) + "\n");
    log(`${result} — ${res.result.hash} — ledger ${res.result.ledger_index} ${res.result.close_time_iso ?? ""}`);
    log(record.explorer);
    log(`recorded in ${path.relative(ROOT, ANCRAGES)}`);
    if (result !== "tesSUCCESS") process.exit(2);
  });
}

async function verifier() {
  const hash = arg("--tx");
  if (!hash) die("verifier needs --tx HASH");
  const b = lireBulletin(bulletinFile);
  const pdfSha = pdfFile ? sha256File(pdfFile) : undefined;
  await withClient(async (c) => {
    const r = await c.request({ command: "tx", transaction: hash });
    const t = r.result.tx_json ?? r.result;
    const memos = t.Memos;
    const onChain = memoText(memos, "dareskro/sha256");
    const onChainPdf = memoText(memos, "dareskro/pdf-sha256");
    const result = typeof r.result.meta === "object" ? r.result.meta.TransactionResult : "unknown";
    log(`${hash}: ${t.TransactionType} by ${t.Account}, ${result}, validated=${r.result.validated}, ledger ${r.result.ledger_index}, closed ${r.result.close_time_iso ?? "?"}`);
    log(`memo dareskro/sha256     ${onChain}`);
    log(`statement sha256         ${b.sha256}  -> ${onChain === b.sha256 ? "MATCH" : "MISMATCH"}`);
    if (onChainPdf) log(`memo dareskro/pdf-sha256 ${onChainPdf}`);
    if (pdfSha) log(`pdf sha256               ${pdfSha}  -> ${onChainPdf === pdfSha ? "MATCH" : onChainPdf ? "MISMATCH" : "not anchored"}`);
    const ok = r.result.validated && result === "tesSUCCESS" && onChain === b.sha256 && (!pdfSha || !onChainPdf || onChainPdf === pdfSha);
    log(ok ? "RESULT: OK — the statement is anchored in a validated ledger" : "RESULT: NOT OK");
    if (!ok) process.exit(2);
  });
}

try {
  if (cmd === "creer-cle") await creerCle();
  else if (cmd === "ancrer") await ancrer();
  else if (cmd === "verifier") await verifier();
  else die("usage: node ancrer.mjs creer-cle|ancrer|verifier [options] (see the header)");
} catch (e) {
  die(`error: ${e?.message ?? e}`);
}
