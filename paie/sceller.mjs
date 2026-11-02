#!/usr/bin/env node
/**
 * The sealed payslip as an NFT in the employee's wallet — invisible to everyone, readable by the
 * named administrations.
 *
 * WHY. The law tells the employee to keep every payslip without time limit; the pension fund, the
 * URSSAF and the tax office may ask for it decades later, when the employer is gone. So the sealed
 * payslip goes to the EMPLOYEE, as a token nobody can take from them, and each administration gets
 * a key to open it, not a copy of it.
 *
 * WHAT GOES WHERE.
 *   off-chain  paie/sortie/bulletin_scelle.json — the payslip (statement JSON + official PDF) sealed
 *              with AES-256-GCM under a fresh content key; that key wrapped once per reader with
 *              X25519 + HKDF-SHA256 + AES-256-GCM (the exact scheme of agent/confidentiel.mjs, whose
 *              helpers are imported). Personal data never goes on an immutable ledger, even encrypted.
 *   on-chain   one NFToken (XLS-20) minted by the employer and offered to the employee for nothing:
 *              URI = dareskro:scelle/sha256/<hash of the sealed file>, memos = the statement's SHA-256
 *              (the same as the pay escrow's memo), the PDF's SHA-256, the sealed file's SHA-256 and
 *              the list of readers. Taxon 1996 = the collective agreement (IDCC). No tfTransferable
 *              flag: the token can move between issuer and holder only, a payslip is not for sale.
 *   readers    employee, urssaf, dgfip, retraite (Agirc-Arrco for an employed pharmacist). On testnet
 *              their X25519 keys are stand-ins generated here; in real life each administration would
 *              publish its key, which none does today.
 *
 * Usage (testnet only — mainnet is a decision this script does not take):
 *   node sceller.mjs init-lecteurs                        x25519 keys for the four readers (paie/cles/lecteurs/, 0600)
 *   node sceller.mjs sceller [--bulletin F] [--pdf F]      -> paie/sortie/bulletin_scelle.json
 *   node sceller.mjs frapper                              mint + offer (employer key) + accept (employee key), -> paie/sortie/nft.json
 *   node sceller.mjs ouvrir --role public|employee|urssaf|dgfip|retraite   what that reader gets from the chain and the file
 * Keys: employer = paie/cles/ancre.testnet.json (ancrer.mjs creer-cle), employee = paie/cles/salarie.testnet.json (made by frapper).
 */
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Wallet, convertStringToHex, convertHexToString, getNFTokenID } from "xrpl";
import { b64, canon, empreinte, rawPublic, unb64, unwrapKey, wrapKey } from "../agent/confidentiel.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const args = process.argv.slice(2);
const cmd = args[0];
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const die = (m, c = 1) => { console.error(m); process.exit(c); };

const NODE = process.env.XRPL_TESTNET_URL || "wss://testnet.xrpl-labs.com";
const EXPLORER = "https://testnet.xrpl.org/transactions/";
const LECTEURS = ["employee", "urssaf", "dgfip", "retraite"];
const CLES = path.join(HERE, "cles");
const CLES_LECTEURS = path.join(CLES, "lecteurs");
const LECTEURS_PUBLICS = path.join(HERE, "sortie", "lecteurs_publics.json");
const SCELLE = path.join(HERE, "sortie", "bulletin_scelle.json");
const NFT = path.join(HERE, "sortie", "nft.json");
const EMPLOYEUR_CLE = arg("--cle-employeur", path.join(CLES, "ancre.testnet.json"));
const SALARIE_CLE = arg("--cle-salarie", path.join(CLES, "salarie.testnet.json"));
const TAXON = 1996; // IDCC of the collective agreement: pharmacie d'officine
const VERSION = "dareskro/sealed-payslip.v1";
const PAD_TO = 4096;
const GCM = { authTagLength: 16 };

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const keyPath = (role) => path.join(CLES_LECTEURS, `${role}.key`);

function lireBulletin(file) {
  const b = JSON.parse(readFileSync(file, "utf8"));
  const h = empreinte(b);
  if (h !== b.sha256) die(`REFUS: ${path.relative(ROOT, file)}: sha256 field ${b.sha256} but canonical hash ${h}`);
  return b;
}
function lireSeed(file) {
  if (!existsSync(file)) die(`REFUS: no key file ${file}`);
  if (statSync(file).mode & 0o077) die(`REFUS: ${file} readable by others, chmod 600`);
  return Wallet.fromSeed(JSON.parse(readFileSync(file, "utf8")).seed);
}
async function withClient(f) {
  const c = new Client(NODE);
  await c.connect();
  try { return await f(c); } finally { await c.disconnect(); }
}
async function submit(c, wallet, tx, label) {
  const prepared = await c.autofill(tx);
  const res = await c.submitAndWait(wallet.sign(prepared).tx_blob);
  const result = res.result.meta?.TransactionResult;
  log(`${label}: ${result} ${res.result.hash} (ledger ${res.result.ledger_index})`);
  if (result !== "tesSUCCESS") die(`REFUS: ${label} ${result}`, 2);
  return res.result;
}
const aadOf = (file) => Buffer.from(canon({ version: file.version, statement_sha256: file.statement_sha256, pdf_sha256: file.pdf_sha256, readers: file.readers_list }), "utf8");

// ------------------------------------------------------------------ init-lecteurs
function initLecteurs() {
  mkdirSync(CLES_LECTEURS, { recursive: true, mode: 0o700 });
  chmodSync(CLES_LECTEURS, 0o700);
  const pub = {};
  for (const role of LECTEURS) {
    const p = keyPath(role);
    if (!existsSync(p)) {
      const { privateKey } = generateKeyPairSync("x25519");
      writeFileSync(p, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      log(`created ${path.relative(ROOT, p)} (x25519, 0600, gitignored)`);
    } else log(`kept    ${path.relative(ROOT, p)}`);
    chmodSync(p, 0o600);
    pub[role] = { x25519_public_b64: b64(rawPublic(createPublicKey(readFileSync(p, "utf8")))) };
  }
  mkdirSync(path.dirname(LECTEURS_PUBLICS), { recursive: true });
  writeFileSync(LECTEURS_PUBLICS, JSON.stringify({
    version: "dareskro/sealed-payslip-readers.v1", curve: "x25519",
    note: "stand-in keys for testnet. In real life each administration publishes its own key; none does today. Whoever is listed here can open every payslip sealed afterwards.",
    readers: pub,
  }, null, 2) + "\n");
  log(`public keys -> ${path.relative(ROOT, LECTEURS_PUBLICS)} (${LECTEURS.join(", ")})`);
}

// ------------------------------------------------------------------ sceller
function sceller() {
  const bulletinFile = arg("--bulletin", path.join(HERE, "sortie", "bulletin_eur.json"));
  const pdfFile = arg("--pdf", path.join(HERE, "sortie", "bulletin_officiel.pdf"));
  const b = lireBulletin(bulletinFile);
  const pdf = readFileSync(pdfFile);
  if (!existsSync(LECTEURS_PUBLICS)) die("REFUS: run init-lecteurs first");
  const pubs = JSON.parse(readFileSync(LECTEURS_PUBLICS, "utf8")).readers;
  const plainRaw = Buffer.from(JSON.stringify({ statement: b, pdf_name: path.basename(pdfFile), pdf_b64: pdf.toString("base64") }), "utf8");
  const plain = Buffer.concat([plainRaw, Buffer.alloc((PAD_TO - (plainRaw.length % PAD_TO)) % PAD_TO, 0x20)]);
  const contentKey = randomBytes(32);
  const file = { version: VERSION, statement_sha256: b.sha256, pdf_sha256: sha256(pdf), readers_list: Object.keys(pubs).sort() };
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", contentKey, iv, GCM);
  c.setAAD(aadOf(file));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  Object.assign(file, {
    cipher: "AES-256-GCM", aad: "canonical JSON of {pdf_sha256, readers, statement_sha256, version}", padding: `spaces to a ${PAD_TO}-byte multiple`,
    iv: b64(iv), tag: b64(c.getAuthTag()), ciphertext: b64(ct), readers: {},
  });
  for (const [role, { x25519_public_b64 }] of Object.entries(pubs)) file.readers[role] = wrapKey(contentKey, unb64(x25519_public_b64));
  contentKey.fill(0);
  const bytes = Buffer.from(JSON.stringify(file, null, 1) + "\n", "utf8");
  writeFileSync(SCELLE, bytes);
  log(`sealed ${path.relative(ROOT, bulletinFile)} + ${path.relative(ROOT, pdfFile)} -> ${path.relative(ROOT, SCELLE)} (${bytes.length} bytes, sha256 ${sha256(bytes)})`);
  log(`readers: ${file.readers_list.join(", ")} — statement ${b.sha256.slice(0, 16)}…, pdf ${file.pdf_sha256.slice(0, 16)}…`);
}

// ------------------------------------------------------------------ frapper
async function frapper() {
  if (!existsSync(SCELLE)) die("REFUS: run sceller first");
  const bytes = readFileSync(SCELLE);
  const file = JSON.parse(bytes.toString("utf8"));
  const sealedSha = sha256(bytes);
  const employer = lireSeed(EMPLOYEUR_CLE);
  const uri = `dareskro:scelle/sha256/${sealedSha}`;
  await withClient(async (c) => {
    let employee;
    if (existsSync(SALARIE_CLE)) employee = lireSeed(SALARIE_CLE);
    else {
      employee = (await c.fundWallet()).wallet;
      mkdirSync(CLES, { recursive: true, mode: 0o700 });
      writeFileSync(SALARIE_CLE, JSON.stringify({ seed: employee.seed, address: employee.classicAddress, network: "testnet", role: "employee (test)" }, null, 2) + "\n", { mode: 0o600 });
      log(`test employee created: ${employee.classicAddress} (key ${path.relative(ROOT, SALARIE_CLE)}, 0600)`);
    }
    log(`employer ${employer.classicAddress} mints for employee ${employee.classicAddress}; uri ${uri}`);
    const memos = [
      ["dareskro/sha256", file.statement_sha256], ["dareskro/pdf-sha256", file.pdf_sha256],
      ["dareskro/sealed-sha256", sealedSha], ["dareskro/readers", file.readers_list.join(",")],
    ].map(([t, d]) => ({ Memo: { MemoType: convertStringToHex(t), MemoData: convertStringToHex(d) } }));
    // 1. mint: no tfTransferable — the token moves between issuer and holder only; no tfBurnable — the issuer cannot destroy it
    const mint = await submit(c, employer, { TransactionType: "NFTokenMint", Account: employer.classicAddress, NFTokenTaxon: TAXON, Flags: 0, URI: convertStringToHex(uri), Memos: memos }, "NFTokenMint");
    const nftId = getNFTokenID(mint.meta);
    // 2. offer it to the employee for nothing: only that account can accept
    const offer = await submit(c, employer, { TransactionType: "NFTokenCreateOffer", Account: employer.classicAddress, NFTokenID: nftId, Amount: "0", Flags: 1, Destination: employee.classicAddress }, "NFTokenCreateOffer");
    const offerIndex = offer.meta.AffectedNodes.find((n) => n.CreatedNode?.LedgerEntryType === "NFTokenOffer")?.CreatedNode.LedgerIndex;
    // 3. the employee accepts with its own key: the payslip is in its wallet
    const accept = await submit(c, employee, { TransactionType: "NFTokenAcceptOffer", Account: employee.classicAddress, NFTokenSellOffer: offerIndex }, "NFTokenAcceptOffer");
    const record = {
      network: "testnet", node: NODE, nft_id: nftId, taxon: TAXON, uri, issuer: employer.classicAddress, holder: employee.classicAddress,
      statement_sha256: file.statement_sha256, pdf_sha256: file.pdf_sha256, sealed_sha256: sealedSha, readers: file.readers_list,
      mint: { hash: mint.hash, ledger: mint.ledger_index, explorer: EXPLORER + mint.hash },
      offer: { hash: offer.hash, index: offerIndex, explorer: EXPLORER + offer.hash },
      accept: { hash: accept.hash, ledger: accept.ledger_index, explorer: EXPLORER + accept.hash },
      at: new Date().toISOString(),
    };
    writeFileSync(NFT, JSON.stringify(record, null, 2) + "\n");
    log(`NFT ${nftId} now held by ${employee.classicAddress}; recorded in ${path.relative(ROOT, NFT)}`);
  });
}

// ------------------------------------------------------------------ ouvrir
async function ouvrir() {
  const role = arg("--role");
  if (!role || !["public", ...LECTEURS].includes(role)) die(`--role public|${LECTEURS.join("|")}`);
  if (!existsSync(NFT)) die("REFUS: run frapper first");
  const rec = JSON.parse(readFileSync(NFT, "utf8"));
  // what the chain says: the token in the employee's account, its URI, the mint's memos
  const chain = await withClient(async (c) => {
    const nfts = (await c.request({ command: "account_nfts", account: rec.holder })).result.account_nfts;
    const tok = nfts.find((n) => n.NFTokenID === rec.nft_id);
    const mint = await c.request({ command: "tx", transaction: rec.mint.hash });
    const t = mint.result.tx_json ?? mint.result;
    const memos = Object.fromEntries((t.Memos ?? []).map((m) => [convertHexToString(m.Memo.MemoType), convertHexToString(m.Memo.MemoData)]));
    return { tok, memos, validated: mint.result.validated, uri: tok ? convertHexToString(tok.URI) : null, issuer: tok?.Issuer, taxon: tok?.NFTokenTaxon, flags: tok?.Flags };
  });
  console.log(`--- as ${role} ---`);
  console.log(`chain: NFT ${rec.nft_id} held by ${rec.holder}, issuer ${chain.issuer}, taxon ${chain.taxon}, flags ${chain.flags}, mint validated=${chain.validated}`);
  console.log(`chain: URI ${chain.uri}`);
  for (const [k, v] of Object.entries(chain.memos)) console.log(`chain: memo ${k} = ${v}`);
  const bytes = readFileSync(SCELLE);
  const fileSha = sha256(bytes);
  const uriSha = chain.uri?.split("/").pop();
  console.log(`file : ${path.relative(ROOT, SCELLE)} ${bytes.length} bytes, sha256 ${fileSha} -> ${fileSha === uriSha && fileSha === chain.memos["dareskro/sealed-sha256"] ? "MATCHES the URI and the memo" : "DOES NOT MATCH"}`);
  const file = JSON.parse(bytes.toString("utf8"));
  if (role === "public") {
    console.log(`public: the file is ciphertext (${file.cipher}, ${unb64(file.ciphertext).length} bytes, padded to ${PAD_TO}); readers ${file.readers_list.join(", ")}; no name, no amount, no date readable`);
    console.log(`public: first bytes of the ciphertext: ${unb64(file.ciphertext).subarray(0, 24).toString("hex")}…`);
    console.log("RESULT: nothing private is readable by the public");
    return;
  }
  // --cle lets anyone try another private key (a stranger's, measured): the envelope must refuse it
  const p = arg("--cle", keyPath(role));
  if (!existsSync(p)) die(`REFUS: no private key for ${role} (${path.relative(ROOT, p)})`);
  const block = file.readers[role];
  if (!block) { console.log(`RESULT: ${role} is not a reader of this payslip`); process.exit(2); }
  let contentKey;
  try { contentKey = unwrapKey(block, createPrivateKey(readFileSync(p, "utf8"))); } catch { console.log(`RESULT: ${role}'s key does not open this envelope`); process.exit(2); }
  const d = createDecipheriv("aes-256-gcm", contentKey, unb64(file.iv), GCM);
  d.setAAD(aadOf(file));
  d.setAuthTag(unb64(file.tag));
  const plain = JSON.parse(Buffer.concat([d.update(unb64(file.ciphertext)), d.final()]).toString("utf8"));
  const s = plain.statement;
  const pdf = Buffer.from(plain.pdf_b64, "base64");
  const okS = empreinte(s) === chain.memos["dareskro/sha256"];
  const okP = sha256(pdf) === chain.memos["dareskro/pdf-sha256"];
  console.log(`${role}: opened — statement ${s.statement_id}, period ${s.period}, ${s.evidence.schedule.date} ${s.evidence.schedule.slot}, gross ${s.gross} ${s.currency}, net paid ${s.net_paid} ${s.currency}, URSSAF ${s.contributions.total_to_urssaf}, DGFiP ${s.withholding.amount}`);
  console.log(`${role}: statement hash recomputed = memo dareskro/sha256 -> ${okS ? "MATCH" : "MISMATCH"}; PDF (${pdf.length} bytes) hash = memo dareskro/pdf-sha256 -> ${okP ? "MATCH" : "MISMATCH"}`);
  const out = path.join(HERE, "sortie", "ouvert", role);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, plain.pdf_name), pdf);
  writeFileSync(path.join(out, "bulletin.json"), JSON.stringify(s, null, 2) + "\n");
  console.log(`${role}: written to ${path.relative(ROOT, out)}/`);
  console.log(okS && okP ? "RESULT: OK" : "RESULT: NOT OK");
  if (!(okS && okP)) process.exit(2);
}

try {
  if (cmd === "init-lecteurs") initLecteurs();
  else if (cmd === "sceller") sceller();
  else if (cmd === "frapper") await frapper();
  else if (cmd === "ouvrir") await ouvrir();
  else die("usage: node sceller.mjs init-lecteurs|sceller|frapper|ouvrir --role R");
} catch (e) {
  die(`error: ${e?.message ?? e}`);
}
