#!/usr/bin/env node
/**
 * dareskro — the pay statement transmitted to the pension fund (Agirc-Arrco / CNAV), on testnet.
 *
 * What goes on the chain: hashes and a URL, never the statement, never the ciphertext. The sealed
 * file (agent/confidentiel.mjs, three named readers) is deposited in a content-addressed store off
 * the chain (agent/depots/<sealed-sha256>.json, served over HTTPS); the employer then sends the fund
 * a 1-drop Payment whose memos name the statement hash, the sealed file's hash, its URI, the period
 * and the employer. The fund fetches the file, checks the hash, opens it with its own key, and
 * answers with a 1-drop Payment carrying the hash it received: the acknowledgement. Both sit in the
 * fund's account history, readable by anyone, telling anyone nothing.
 *
 * The same act as an NFT (XLS-20 NFTokenMint, burnable only, offered to the fund) is measured too,
 * so the two forms can be compared on cost, reserve, revocability and readability.
 *
 * Usage (from the repository root):
 *   node agent/demo_transmission_retraite.mjs seal        seal for three readers, deposit the sealed file, write agent/sortie/transmission.json
 *   node agent/demo_transmission_retraite.mjs transmit    on-chain transmission, NFT variant, acknowledgement, the fund opens, the public fails
 *   node agent/demo_transmission_retraite.mjs all         both, without waiting for the deposit to be pushed (the URI is then reported as not live)
 *   node agent/demo_transmission_retraite.mjs revocation  the fund's key revoked: later statements closed to it, earlier ones not
 * ENV  XRPL_WSS (wss://testnet.xrpl-labs.com)  SEALED_URI_BASE (raw.githubusercontent.com on this branch)
 *      PAY_ESCROW (the shipped escrow citing the statement; "none" to seal unbound)  NFT=0 to skip the NFT variant
 * Keys: agent/cles/ (X25519 readers, XRPL seeds of the two testnet accounts), 0600, gitignored, created here.
 * xrpl.js is taken from oracle/node_modules; nothing else is needed.
 */
import { createRequire } from "node:module";
import { execFileSync, execSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHIFFRE, CLES, LECTEURS, ROOT, SORTIE, rel, sha256hex } from "./confidentiel.mjs";

const require = createRequire(join(ROOT, "oracle", "package.json"));
const { Client, Wallet, convertStringToHex } = require("xrpl");

const WSS = process.env.XRPL_WSS || "wss://testnet.xrpl-labs.com";
const FAUCET = { faucetHost: "faucet.altnet.rippletest.net", faucetPath: "/accounts" };
const DEPOTS = join(ROOT, "agent", "depots");
const RECORD = join(SORTIE, "transmission.json");
const BRANCH = (() => { try { return execSync("git rev-parse --abbrev-ref HEAD", { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "main"; } })();
const URI_BASE = process.env.SEALED_URI_BASE || `https://raw.githubusercontent.com/LeDenti/dareskro/${BRANCH}/agent/depots`;
// The 14:35 UTC run of 25/10 (README): pay escrow for this very statement, net paid 407.33 in its memos.
const PAY_ESCROW = process.env.PAY_ESCROW ?? "99DBC2B3F8DCB1F50BAC12F12B34B0DD5E85A264FC9FAB8095D5A27A32BD2972";
const EMPLOYER_ID = "SIRET 12345678900012"; // the fictional employer of paie/employeur.exemple.json; a legal person, public in Sirene
const explorer = (h) => `https://testnet.xrpl.org/transactions/${h}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const hex = (s) => convertStringToHex(s).toUpperCase();
const unhex = (h) => Buffer.from(h, "hex").toString("utf8");
const memo = (type, data, format) => ({ Memo: { MemoType: hex(type), MemoData: hex(data), ...(format ? { MemoFormat: hex(format) } : {}) } });
const readMemos = (tx) => (tx.Memos || []).map(({ Memo }) => [unhex(Memo.MemoType), unhex(Memo.MemoData)]);
const drops = (d) => `${d} drop${Number(d) === 1 ? "" : "s"}`;
const xrpOf = (d) => (Number(d) / 1e6).toFixed(6).replace(/\.?0+$/, "") + " XRP";

/** Run one of the repository's scripts, print its words indented, return its exit code (never throws). */
function show(args, env = {}) {
  log(`$ node ${args.join(" ")}`);
  try {
    const out = execFileSync("node", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    for (const l of out.split("\n").filter(Boolean)) console.log("    " + l);
    return 0;
  } catch (e) {
    for (const l of String(e.stdout ?? "").split("\n").filter(Boolean)) console.log("    " + l);
    for (const l of String(e.stderr ?? "").split("\n").filter(Boolean)) console.log("    ! " + l);
    return e.status ?? 1;
  }
}

/** IPFS CIDv1 of the whole file as one raw block (what `ipfs add --cid-version 1 --raw-leaves` gives below 256 KiB). */
function cidV1Raw(bytes) {
  const mh = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), createHash("sha256").update(bytes).digest()]);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "";
  for (const byte of mh) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return "b" + out;
}

async function fetchDeposit(uri) {
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(20_000), headers: { "cache-control": "no-cache" } });
    if (!res.ok) return { live: false, why: `HTTP ${res.status}` };
    const bytes = Buffer.from(await res.arrayBuffer());
    return { live: true, bytes, sha256: sha256hex(bytes) };
  } catch (e) {
    return { live: false, why: e.cause?.code || e.name };
  }
}

const readRecord = () => (existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : null);
const writeRecord = (r) => writeFileSync(RECORD, JSON.stringify(r, null, 2) + "\n");

// ------------------------------------------------------------------ seal

async function seal() {
  log(`node ${process.version}, branch ${BRANCH}, deposit URL base ${URI_BASE}`);
  if (show(["agent/confidentiel.mjs", "--init"]) !== 0) process.exit(1);
  log("sealing the statement for the three named readers (employee, administration, pension fund)…");
  let bound = PAY_ESCROW !== "none";
  let code = show(["agent/confidentiel.mjs", "--chiffre", ...(bound ? ["--escrow", PAY_ESCROW] : [])]);
  if (code !== 0 && bound) {
    log("the pay escrow could not be checked on testnet: sealing unbound (the file then names no escrow)");
    bound = false;
    code = show(["agent/confidentiel.mjs", "--chiffre"]);
  }
  if (code !== 0) process.exit(1);

  const bytes = readFileSync(CHIFFRE);
  const file = JSON.parse(bytes.toString("utf8"));
  const statement = JSON.parse(readFileSync(join(SORTIE, "bulletin.json"), "utf8"));
  const sealedSha = sha256hex(bytes);
  const cid = cidV1Raw(bytes);
  mkdirSync(DEPOTS, { recursive: true });
  const deposit = join(DEPOTS, `${sealedSha}.json`);
  copyFileSync(CHIFFRE, deposit);
  const uri = `${URI_BASE}/${sealedSha}.json`;
  if (Buffer.byteLength(uri) > 256) { log(`the URI is ${Buffer.byteLength(uri)} bytes: an NFT URI is at most 256, shorten SEALED_URI_BASE`); process.exit(1); }
  log(`deposited ${rel(deposit)}: ${bytes.length} bytes, sha256 ${sealedSha}`);
  log(`  IPFS CIDv1 (raw leaf) of the same bytes: ${cid}  (computed, not pinned: pinning is the employer's or the fund's service, with its own key)`);
  log(`  HTTPS URI (${Buffer.byteLength(uri)} bytes): ${uri}`);
  const probe = await fetchDeposit(uri);
  log(`  fetched now: ${probe.live ? (probe.sha256 === sealedSha ? "yes, same bytes" : `yes but sha256 ${probe.sha256} differs`) : `no (${probe.why}) — push the branch, then run: node agent/demo_transmission_retraite.mjs transmit`}`);

  const record = {
    phase: "sealed",
    sealed_at: new Date().toISOString(),
    node: WSS,
    statement: { file: "agent/sortie/bulletin.json", sha256: file.sha256_plain, period: statement.period, employer: EMPLOYER_ID, pay_escrow: file.escrow },
    sealed: { file: rel(deposit), bytes: bytes.length, sha256: sealedSha, cid, uri, uri_live_at_sealing: probe.live && probe.sha256 === sealedSha, version: file.version, readers: Object.fromEntries(Object.entries(file.recipients).map(([r, b]) => [r, b.kid])), zk_opening_readers: Object.keys(file.zk?.recipients ?? {}) },
    directory: rel(LECTEURS),
  };
  writeRecord(record);
  log(`record -> ${rel(RECORD)} (phase sealed)`);
  log("the chain will carry: the statement hash, the sealed file's hash, its URI, the period, the employer. Not the file.");
}

// ------------------------------------------------------------------ transmit

async function walletFor(c, name) {
  const p = join(CLES, `xrpl_${name}.json`);
  let w;
  if (existsSync(p)) {
    w = Wallet.fromSeed(JSON.parse(readFileSync(p, "utf8")).seed);
    try {
      const { result } = await c.request({ command: "account_info", account: w.classicAddress, ledger_index: "validated" });
      const bal = Number(result.account_data.Balance);
      if (bal >= 20e6) { log(`${name}: ${w.classicAddress} (kept, ${xrpOf(bal)})`); return w; }
      log(`${name}: ${w.classicAddress} holds ${xrpOf(bal)}: asking the faucet to top it up…`);
    } catch { log(`${name}: ${w.classicAddress} not on this ledger: asking the faucet…`); }
  }
  for (let i = 0; ; i++) {
    try {
      const r = await c.fundWallet(w ?? null, FAUCET);
      w = r.wallet;
      break;
    } catch (e) {
      if (i >= 6) throw e;
      log(`faucet busy for ${name} (${String(e.message ?? e).split("\n")[0].slice(0, 70)}), waiting 25 s…`);
      await new Promise((r) => setTimeout(r, 25_000));
    }
  }
  mkdirSync(CLES, { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify({ address: w.classicAddress, seed: w.seed, note: "testnet only, demo account" }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  log(`${name}: ${w.classicAddress} (funded by the faucet; seed kept in ${rel(p)}, 0600, gitignored)`);
  return w;
}

async function submit(c, wallet, tx, label) {
  const t0 = performance.now();
  const r = await c.submitAndWait(tx, { autofill: true, wallet });
  const res = r.result;
  const code = res.meta?.TransactionResult;
  const ms = Math.round(performance.now() - t0);
  log(`${label}: ${code} in ${ms} ms, fee ${drops(res.tx_json?.Fee ?? res.Fee)}, ledger ${res.ledger_index}, ${res.close_time_iso ?? ""}`);
  log(`  ${explorer(res.hash)}`);
  if (code !== "tesSUCCESS") throw new Error(`${label}: ${code}`);
  return res;
}

const ownerCount = async (c, address) => Number((await c.request({ command: "account_info", account: address, ledger_index: "validated" })).result.account_data.OwnerCount);
const nftsOf = async (c, address) => (await c.request({ command: "account_nfts", account: address, ledger_index: "validated" })).result.account_nfts;

async function transmit() {
  const record = readRecord();
  if (!record) { log(`${rel(RECORD)} missing: run \`seal\` first`); process.exit(2); }
  if (record.phase !== "sealed" && !process.argv.includes("--again")) { log(`${rel(RECORD)} is already ${record.phase} (${record.transmission?.hash ?? ""}); --again transmits the same sealed file once more`); process.exit(2); }
  const { statement, sealed } = record;
  const deposit = join(ROOT, sealed.file);
  if (!existsSync(deposit) || sha256hex(readFileSync(deposit)) !== sealed.sha256) { log(`${sealed.file} is not the sealed file of the record: run \`seal\` again`); process.exit(1); }

  log(`node ${WSS}`);
  const c = new Client(WSS);
  await c.connect();
  const ss = (await c.request({ command: "server_state" })).result.state.validated_ledger;
  log(`reserves on this network: base ${xrpOf(ss.reserve_base)}, per owned object ${xrpOf(ss.reserve_inc)}`);
  const employer = await walletFor(c, "employeur");
  const caisse = await walletFor(c, "caisse");
  const out = { ...record, phase: "transmitting", transmitted_at: new Date().toISOString(), accounts: { employer: employer.classicAddress, pension_fund: caisse.classicAddress }, reserves: { base_drops: ss.reserve_base, per_object_drops: ss.reserve_inc } };

  // 1. the deposit is reachable at the URI the chain will carry, and it is the file
  const probe = await fetchDeposit(sealed.uri);
  const live = probe.live && probe.sha256 === sealed.sha256;
  log(`deposit ${sealed.uri}: ${live ? `fetched, ${probe.bytes.length} bytes, sha256 = the record's` : probe.live ? `fetched but sha256 ${probe.sha256} ≠ ${sealed.sha256}: NOT the file` : `not reachable (${probe.why}); the memo will still carry the URI, the fund below opens the local deposit`}`);
  out.sealed = { ...sealed, uri_live_at_transmission: live };

  // 2. the act of transmission: 1 drop, hashes and URI in memos, the statement hash as InvoiceID too
  log("— transmission: the employer pays 1 drop to the pension fund, the act is the memos —");
  const tx1 = await submit(c, employer, {
    TransactionType: "Payment",
    Account: employer.classicAddress,
    Destination: caisse.classicAddress,
    Amount: "1",
    InvoiceID: statement.sha256.toUpperCase(),
    Memos: [
      memo("dareskro/payslip-sha256", statement.sha256),
      memo("dareskro/sealed-sha256", sealed.sha256),
      memo("dareskro/sealed-uri", sealed.uri, "text/uri-list"),
      memo("dareskro/sealed-cid", sealed.cid),
      memo("dareskro/period", statement.period),
      memo("dareskro/employer", statement.employer),
    ],
  }, "Payment (transmission)");
  for (const [t, d] of readMemos(tx1.tx_json ?? tx1)) log(`  memo ${t.padEnd(24)} ${d}`);
  out.transmission = { hash: tx1.hash, ledger: tx1.ledger_index, at: tx1.close_time_iso, fee_drops: tx1.tx_json?.Fee, amount_drops: "1", memos: Object.fromEntries(readMemos(tx1.tx_json ?? tx1)), invoice_id: statement.sha256 };

  // 3. the NFT variant: XLS-20 mint, burnable only (not transferable), offered to the fund for 0 (NFTokenMintOffer)
  if (process.env.NFT !== "0") {
    log("— variant: the same act as an NFT (NFTokenMint, tfBurnable only, Destination = the fund) —");
    const nft = {};
    try {
      const before = await ownerCount(c, caisse.classicAddress);
      let mint;
      const mintTx = {
        TransactionType: "NFTokenMint", Account: employer.classicAddress, NFTokenTaxon: 0, Flags: 1, URI: hex(sealed.uri),
        Destination: caisse.classicAddress, Amount: "0",
        Memos: [memo("dareskro/payslip-sha256", statement.sha256), memo("dareskro/sealed-sha256", sealed.sha256), memo("dareskro/period", statement.period)],
      };
      try { mint = await submit(c, employer, mintTx, "NFTokenMint (offer to the fund)"); }
      catch (e) { log(`  mint with Amount 0 refused (${e.message}); retrying with Amount 1 drop`); mint = await submit(c, employer, { ...mintTx, Amount: "1" }, "NFTokenMint (offer to the fund, 1 drop)"); }
      const tokenId = mint.meta.nftoken_id;
      const offerId = mint.meta.offer_id ?? mint.meta.AffectedNodes.find((n) => n.CreatedNode?.LedgerEntryType === "NFTokenOffer")?.CreatedNode.LedgerIndex;
      log(`  NFTokenID ${tokenId}; sell offer ${offerId} to the fund only`);
      nft.mint = { hash: mint.hash, fee_drops: mint.tx_json?.Fee, token_id: tokenId, offer_id: offerId, flags: "tfBurnable (1): not transferable, the issuer may burn it", uri: sealed.uri };
      const accept = await submit(c, caisse, { TransactionType: "NFTokenAcceptOffer", Account: caisse.classicAddress, NFTokenSellOffer: offerId }, "NFTokenAcceptOffer (the fund takes it)");
      const held = (await nftsOf(c, caisse.classicAddress)).find((n) => n.NFTokenID === tokenId);
      const after = await ownerCount(c, caisse.classicAddress);
      log(`  the fund's account_nfts: ${held ? `holds it (Issuer ${held.Issuer}, Flags ${held.Flags}, URI -> ${unhex(held.URI)})` : "does not list it"}`);
      log(`  the fund's OwnerCount ${before} -> ${after}: ${after - before} NFT page(s) = ${xrpOf((after - before) * Number(ss.reserve_inc))} of reserve now locked on the fund's account`);
      nft.accept = { hash: accept.hash, fee_drops: accept.tx_json?.Fee, owner_count_before: before, owner_count_after: after, reserve_locked_drops: String((after - before) * Number(ss.reserve_inc)) };
      log("  revocability: the issuer burns the NFT the fund holds (tfBurnable), without the fund's signature…");
      const burn = await submit(c, employer, { TransactionType: "NFTokenBurn", Account: employer.classicAddress, NFTokenID: tokenId, Owner: caisse.classicAddress }, "NFTokenBurn by the employer");
      const stillHeld = (await nftsOf(c, caisse.classicAddress)).some((n) => n.NFTokenID === tokenId);
      log(`  after the burn the fund's account_nfts ${stillHeld ? "still lists it" : "no longer lists it: the fund's copy of the act is gone from the ledger state (the mint and the burn stay in history)"}`);
      nft.burn = { hash: burn.hash, fee_drops: burn.tx_json?.Fee, fund_still_holds: stillHeld };
    } catch (e) {
      log(`  NFT variant stopped: ${e.message}`);
      nft.error = e.message;
    }
    out.nft_variant = nft;
  }

  // 4. the fund fetches, checks, opens; the public cannot
  log("— the pension fund receives: fetch the URI, check the hash, open with its own key —");
  const received = join(SORTIE, "recu_caisse.json");
  writeFileSync(received, live ? probe.bytes : readFileSync(deposit));
  const receivedSha = sha256hex(readFileSync(received));
  log(`  ${live ? "fetched from the URI" : "local deposit (URI not live)"} -> ${rel(received)}, sha256 ${receivedSha} ${receivedSha === out.transmission.memos["dareskro/sealed-sha256"] ? "= memo dareskro/sealed-sha256" : "≠ the memo: REFUSED"}`);
  if (receivedSha !== out.transmission.memos["dareskro/sealed-sha256"]) throw new Error("the fund would refuse a file whose hash is not the one transmitted");
  const openedByFund = show(["agent/divulgation.mjs", "--role", "retraite", "--file", received, ...(statement.pay_escrow ? [] : ["--offline"])]);
  log(`  the fund opens it: exit ${openedByFund} (${openedByFund === 0 ? "statement read, hash recomputed = memo dareskro/payslip-sha256" : "FAILED"})`);
  const zkByFund = show(["zk/ouvrir.mjs", "--role", "retraite"]);
  log(`  the fund asks for the zk opening: exit ${zkByFund} (${zkByFund === 1 ? "refused: its scope is the statement only" : "unexpected"})`);
  const publicRead = show(["agent/divulgation.mjs", "--role", "public", "--file", received, ...(statement.pay_escrow ? [] : ["--offline"])]);
  log(`  the public reads the same file: exit ${publicRead} (${publicRead === 0 ? "nothing private, no key opens it" : "FAIL"})`);
  const strangerDir = join(tmpdir(), `dareskro-etranger-${process.pid}`);
  mkdirSync(strangerDir, { recursive: true, mode: 0o700 });
  const strangerKey = join(strangerDir, "etranger.key");
  writeFileSync(strangerKey, generateKeyPairSync("x25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const stranger = show(["agent/divulgation.mjs", "--role", "retraite", "--file", received, "--offline", "--key", strangerKey]);
  log(`  a stranger with a fresh X25519 key claims to be the fund: exit ${stranger} (${stranger === 1 ? "GCM refuses" : "unexpected"})`);
  out.opening = { fund_opens_exit: openedByFund, fund_zk_opening_exit: zkByFund, public_exit: publicRead, stranger_key_exit: stranger, received_sha256: receivedSha, fetched_from_uri: live };

  // 5. the acknowledgement: the fund pays 1 drop back with the hash it received
  log("— acknowledgement: the fund pays 1 drop to the employer, memo dareskro/ack = the hash received —");
  const tx2 = await submit(c, caisse, {
    TransactionType: "Payment",
    Account: caisse.classicAddress,
    Destination: employer.classicAddress,
    Amount: "1",
    InvoiceID: statement.sha256.toUpperCase(),
    Memos: [
      memo("dareskro/ack", statement.sha256),
      memo("dareskro/ack-sealed", receivedSha),
      memo("dareskro/ack-of", tx1.hash),
    ],
  }, "Payment (acknowledgement)");
  for (const [t, d] of readMemos(tx2.tx_json ?? tx2)) log(`  memo ${t.padEnd(24)} ${d}`);
  out.acknowledgement = { hash: tx2.hash, ledger: tx2.ledger_index, at: tx2.close_time_iso, fee_drops: tx2.tx_json?.Fee, memos: Object.fromEntries(readMemos(tx2.tx_json ?? tx2)) };

  // 6. what the fund's history shows anyone: transmitted on…, acknowledged on…
  log("— the fund's account history, as anyone reads it (account_tx) —");
  const { result } = await c.request({ command: "account_tx", account: caisse.classicAddress, ledger_index_min: -1, ledger_index_max: -1, limit: 50 });
  const entries = result.transactions.map((t) => ({ tx: t.tx_json ?? t.tx, meta: t.meta, hash: t.hash ?? t.tx?.hash, at: t.close_time_iso }));
  const sent = entries.find((e) => e.hash === tx1.hash);
  const acked = entries.find((e) => e.hash === tx2.hash);
  const when = (e) => e?.at ?? (e?.tx?.date !== undefined ? new Date((e.tx.date + 946684800) * 1000).toISOString().replace(".000Z", "Z") : "?");
  console.log(`    transmitted  ${when(sent)}  ${tx1.hash}`);
  console.log(`                 statement sha256 ${statement.sha256}`);
  console.log(`                 sealed    sha256 ${sealed.sha256}  at ${sealed.uri}`);
  console.log(`    acknowledged ${when(acked)}  ${tx2.hash}`);
  console.log(`                 ack = ${out.acknowledgement.memos["dareskro/ack"]} ${out.acknowledgement.memos["dareskro/ack"] === statement.sha256 ? "(= the statement hash transmitted)" : "(≠ !)"}`);
  console.log(`    what the history does not show: the employee, the hours, the lines, the amount. The 1 drop is the act, not the pay.`);
  out.phase = "acknowledged";
  out.timeline = { transmitted: when(sent), acknowledged: when(acked) };
  writeRecord(out);
  log(`record -> ${rel(RECORD)} (phase acknowledged)`);
  log("the DSN (net-entreprises) remains the legal monthly declaration; this act proves what was transmitted and when, it replaces nothing.");
  await c.disconnect();
}

// ------------------------------------------------------------------ revocation

async function revocation() {
  const dir = join(tmpdir(), `dareskro-revocation-${process.pid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = { DARESKRO_CLES: join(dir, "cles"), DARESKRO_LECTEURS: join(dir, "lecteurs.json") };
  log(`scratch directory ${dir} (keys and directory of this measurement only; agent/cles is untouched)`);
  show(["agent/confidentiel.mjs", "--init"], env);
  const A = join(dir, "A.json"), B = join(dir, "B.json");
  log("statement A sealed while the fund holds key 1");
  show(["agent/confidentiel.mjs", "--chiffre", "--out", A], env);
  const k1 = JSON.parse(readFileSync(env.DARESKRO_LECTEURS, "utf8")).readers.find((r) => r.role === "retraite" && !r.revoked).kid;
  log(`the fund's key 1 (${k1}) is revoked: retired on disk, a key 2 is issued and listed`);
  show(["agent/confidentiel.mjs", "--revoke", "retraite"], env);
  log("statement B sealed afterwards: wrapped for key 2 only");
  show(["agent/confidentiel.mjs", "--chiffre", "--out", B], env);
  const r = {};
  r.b_with_key1 = show(["agent/divulgation.mjs", "--role", "retraite", "--offline", "--file", B, "--key", join(env.DARESKRO_CLES, `retraite.${k1}.key`)], env);
  log(`B opened with the revoked key 1: exit ${r.b_with_key1} (${r.b_with_key1 === 1 ? "refused by the GCM tag" : "unexpected"})`);
  r.b_with_key2 = show(["agent/divulgation.mjs", "--role", "retraite", "--offline", "--file", B], env);
  log(`B opened with key 2: exit ${r.b_with_key2} (${r.b_with_key2 === 0 ? "opens" : "unexpected"})`);
  r.a_with_key1 = show(["agent/divulgation.mjs", "--role", "retraite", "--offline", "--file", A], env);
  log(`A opened again by the fund (the directory points it to the retired key 1): exit ${r.a_with_key1} (${r.a_with_key1 === 0 ? "opens: what was given before revocation stays readable, nothing can be un-sent" : "unexpected"})`);
  r.public_b = show(["agent/divulgation.mjs", "--role", "public", "--offline", "--file", B], env);
  log(`B read by the public: exit ${r.public_b}`);
  const ok = r.b_with_key1 === 1 && r.b_with_key2 === 0 && r.a_with_key1 === 0 && r.public_b === 0;
  console.log(ok ? "RESULT: OK, a revoked key opens nothing sealed after its revocation" : "RESULT: FAIL");
  process.exit(ok ? 0 : 1);
}

const cmd = process.argv[2] ?? "all";
try {
  if (cmd === "seal") await seal();
  else if (cmd === "transmit") await transmit();
  else if (cmd === "all") { await seal(); await transmit(); }
  else if (cmd === "revocation") await revocation();
  else { console.error("usage: node agent/demo_transmission_retraite.mjs seal|transmit|all|revocation"); process.exit(2); }
} catch (e) {
  log(`stopped: ${e.message}`);
  process.exit(1);
}
