#!/usr/bin/env node
/**
 * Wedding photos sold to the guests, live on the XRP Ledger testnet.
 *
 * THE CASE. An agency shot 2,000 photos of 88 guests and puts them online. A
 * guest picks photos and, for each, either the full-resolution FILE (sent to
 * him) or a PRINT (the file goes to a lab that prints and ships). One price,
 * split by code between the agency, the photographer who took each photo, and
 * the lab (print cost + postage). tarif.mjs holds the price list and the split.
 *
 * TWO WAYS TO BE PAID, ONE SIGNATURE.
 *   files   → KEY REVEAL, no oracle. The agency encrypts the order's files with
 *             a key K and publishes the box and sha256(K). The guest locks the
 *             price behind the condition sha256(K). The only way to collect is
 *             to put K on the ledger (the Fulfillment of EscrowFinish): the
 *             money and the key change hands in the same transaction, and K is
 *             then public for the guest — and for the photographers' escrows,
 *             which share the condition: once the agency has revealed, anyone
 *             can finish them, the payees included.
 *   prints  → PROOF OF SHIPPING, by the oracle ("presence" shape, unchanged):
 *             the lab's share is released at the agreed date if the carrier's
 *             tracking page shows the parcel shipped; never shipped, refunded.
 *   The guest signs ONE Batch (XLS-56, all or nothing): one EscrowCreate per
 *   payee. The agency never touches the guest's money; the lab's share never
 *   passes through the agency.
 *
 * WHAT RUNS (every step a real testnet transaction, hashes printed):
 *   0. guest, agency, two photographers (Léa, Marc) and a lab get accounts
 *   1. order A: 3 files (2 by Léa, 1 by Marc) + 2 prints 20x30 (Marc) = 46.90 €
 *      order B: 1 print 10x15 (Marc) = 7.40 € — the lab will never ship it
 *      the agency boxes each order's files under its key, the guest downloads
 *      the box; the oracle issues the lab's condition for each tracking page
 *   2. the guest signs one Batch per order: A = 4 escrows, B = 3 escrows,
 *      priced in XRP at the Kraken EUR rate, memos = order hash, box hash,
 *      payee, fiat line, proof, oracle
 *   3. a stranger (and the guest himself) tries to finish the agency's escrow
 *      without K → tecCRYPTOCONDITION_ERROR
 *   4. the agency finishes its escrow revealing K → tesSUCCESS; Léa and Marc
 *      read K from that transaction and finish their own escrows (the ledger
 *      does not care who submits once the fulfillment is public)
 *   5. the guest reads K from the ledger, opens the box, checks every file's
 *      hash against the order
 *   6. the lab reads K too, prints, and the tracking page of order A says
 *      EXPEDIE before the date → the oracle releases the lab's share; order B's
 *      page never does → the oracle refunds the guest at the deadline
 *
 * The carrier's tracking pages and the boxes are served by a tiny HTTP server
 * on this machine; the oracle reads them like any URL. No seed is written to
 * disk. The public report goes to compte_rendu.json.
 *
 * Usage: node demo_photos_mariage.mjs      (the oracle must be running: node ../oracle/oracle.mjs watch)
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, xrpToDrops } from "xrpl";
import { beneficiaires, commande, euros } from "./tarif.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, "compte_rendu.json");
const TESTNET = process.env.XRPL_TESTNET || "wss://testnet.xrpl-labs.com";
const ORACLE = process.env.ORACLE_URL || "http://127.0.0.1:8787";
const PORT = Number(process.env.PHOTOS_PORT || 8791);
const BASE = process.env.PHOTOS_URL || `http://127.0.0.1:${PORT}`;
const PERIOD_S = 75;     // the lab's agreed shipping date: in 75 s
const GRACE_S = 60;      // refund 60 s after the date if not shipped
const RIPPLE_EPOCH = 946684800;
const rippleTime = (d) => Math.floor(d.getTime() / 1000) - RIPPLE_EPOCH;
const secondsUntil = (rt) => rt - rippleTime(new Date());
const hex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const explorer = (h) => `https://testnet.xrpl.org/transactions/${h}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const memo = (type, data) => ({ Memo: { MemoType: hex(type), MemoData: hex(data), MemoFormat: hex("text/plain") } });
/** Minimum fee of a conditional EscrowFinish: 330 drops + 10 per 16 bytes of fulfillment, plus a margin. */
const finishFee = (fulfillmentHex) => String(330 + 10 * Math.ceil(fulfillmentHex.length / 2 / 16) + 100);

const report = { network: TESTNET, date: new Date().toISOString(), orders: {}, steps: [] };
const note = (step, extra) => report.steps.push({ step, ...extra });
const problems = [];
const expect = (ok, what) => { if (!ok) problems.push(what); return ok; };

// ───────── the key-reveal condition: PREIMAGE-SHA-256 whose preimage IS the order's key
function conditionFromKey(key) {
  const digest = createHash("sha256").update(key).digest();
  const n = key.length;
  const fulfillment = Buffer.concat([Buffer.from([0xa0, n + 2, 0x80, n]), key]);
  const body = Buffer.concat([Buffer.from([0x80, 0x20]), digest, Buffer.from([0x81, 0x01, n])]);
  const condition = Buffer.concat([Buffer.from([0xa0, body.length]), body]);
  return { condition: condition.toString("hex").toUpperCase(), fulfillment: fulfillment.toString("hex").toUpperCase() };
}
/** Read the key back from a validated EscrowFinish: the Fulfillment field, minus its 4-byte DER prefix. */
const keyFromFulfillment = (fulfillmentHex) => Buffer.from(fulfillmentHex, "hex").subarray(4);

// ───────── the box: the order's files, AES-256-GCM under the order's key
function box(files, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify(files));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}
function unbox(blob, key) {
  const iv = blob.subarray(0, 12), tag = blob.subarray(12, 28), ct = blob.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString());
}

// ───────── the tiny web: the boxes, and the carrier's tracking pages
const served = { boxes: {}, tracking: {} };
const hits = { boxes: 0, tracking: 0 };
const server = createServer((req, res) => {
  let m;
  if ((m = /^\/commandes\/(\w+)\/photos\.enc$/.exec(req.url)) && served.boxes[m[1]]) {
    hits.boxes++;
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
    return res.end(served.boxes[m[1]]);
  }
  if ((m = /^\/suivi\/(\w+)$/.exec(req.url)) && served.tracking[m[1]]) {
    hits.tracking++;
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(served.tracking[m[1]]);
  }
  res.writeHead(404); res.end("not found");
});

const c = new Client(TESTNET);
async function onLedger(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try { if (!c.isConnected()) await c.connect(); return await fn(); }
    catch (err) {
      if (i >= tries - 1) throw err;
      log(`ledger hiccup (${String(err?.message ?? err).split("\n")[0].slice(0, 80)}), retrying in 5 s…`);
      try { await c.disconnect(); } catch { /* already closed */ }
      await sleep(5000);
    }
  }
}
async function fundWalletPatiently(label) {
  for (let i = 0; ; i++) {
    try { return (await onLedger(() => c.fundWallet())).wallet; }
    catch (e) {
      if (i >= 6) throw e;
      log(`faucet busy for ${label}, waiting 25 s…`);
      await sleep(25000);
    }
  }
}
async function oracleGet(p) { return (await fetch(ORACLE + p)).json(); }
async function oraclePost(p, body) {
  const r = await fetch(ORACLE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
async function mine(owner, seq) { return (await oracleGet("/escrows")).escrows.find((e) => e.owner === owner && e.sequence === seq); }
async function follow(owner, seq, pred, maxS, label) {
  const until = Date.now() + maxS * 1000;
  let last = "", e;
  do {
    e = await mine(owner, seq);
    if (e) {
      const v = `status ${e.status}${e.lastSeen ? `, page ${e.lastSeen.live ? "shows shipped" : "does NOT show shipped"}` : ", not looked yet"}${e.lastWhy ? ` — ${e.lastWhy}` : ""}`;
      if (v !== last) { log(`${label}: oracle sees — ${v}`); last = v; }
      if (pred(e)) return e;
    }
    await sleep(3000);
  } while (Date.now() < until);
  return e;
}
/** Single-signed, result printed, tes expected unless told otherwise. */
async function send(wallet, tx, label, expectCode = "tesSUCCESS") {
  const r = await onLedger(async () => {
    const prepared = await c.autofill(tx);
    return c.submitAndWait(wallet.sign(prepared).tx_blob);
  });
  const code = r.result.meta.TransactionResult;
  log(`${label}: ${code}  ${explorer(r.result.hash)}`);
  note(label, { result: code, hash: r.result.hash });
  expect(code === expectCode, `${label} → ${code}, expected ${expectCode}`);
  return r;
}
/** The inner transactions of a Batch get their hashes from the account's history. */
async function hashesBySequence(account, seqs) {
  const hashes = {};
  for (let i = 0; i < 8 && Object.keys(hashes).length < seqs.length; i++) {
    await sleep(1500);
    const h = await onLedger(() => c.request({ command: "account_tx", account, limit: 30 }));
    for (const t of h.result.transactions) { const tj = t.tx_json ?? t.tx; if (tj && seqs.includes(tj.Sequence)) hashes[tj.Sequence] = t.hash ?? tj.hash; }
  }
  return hashes;
}

// ───────────────────────────── run ─────────────────────────────
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
let oracle;
try { oracle = await oracleGet("/identity"); }
catch (err) { console.error(`no oracle at ${ORACLE} (${err.message}) — start it with: node ../oracle/oracle.mjs watch`); process.exit(1); }
await c.connect();
log(`testnet ${TESTNET}, oracle ${oracle.address}`);

// the EUR/XRP rate: Kraken's public ticker, or a fixed fallback when offline
let rate = 1.15;
try {
  const k = await (await fetch("https://api.kraken.com/0/public/Ticker?pair=XRPEUR")).json();
  const p = Number(Object.values(k.result)[0].c[0]);
  if (p > 0) rate = p;
} catch { /* offline: fallback */ }
const xrpOf = (cents) => (cents / 100 / rate).toFixed(6);
log(`rate ${rate} EUR/XRP (Kraken)`);

log("0. guest, agency, Léa, Marc, the lab: five accounts from the faucet…");
const invite = await fundWalletPatiently("the guest");
const agence = await fundWalletPatiently("the agency");
const lea = await fundWalletPatiently("Léa");
const marc = await fundWalletPatiently("Marc");
const labo = await fundWalletPatiently("the lab");
const inconnu = await fundWalletPatiently("a stranger");
const who = { agence, "Léa": lea, "Marc": marc, labo };
report.accounts = Object.fromEntries(Object.entries({ invite, agence, lea, marc, labo, inconnu }).map(([k, w]) => [k, w.classicAddress]));
log(Object.entries(report.accounts).map(([k, a]) => `${k} ${a}`).join("\n"));

// ───────── 1. the two orders
const ORDERS = {
  A: [
    { photo: "IMG_0412", auteur: "Léa", format: "fichier" },
    { photo: "IMG_0587", auteur: "Léa", format: "fichier" },
    { photo: "IMG_1203", auteur: "Marc", format: "fichier" },
    { photo: "IMG_1203", auteur: "Marc", format: "20x30" },
    { photo: "IMG_1377", auteur: "Marc", format: "20x30" },
  ],
  B: [{ photo: "IMG_0099", auteur: "Marc", format: "10x15" }],
};
const orders = {};
for (const [id, lignes] of Object.entries(ORDERS)) {
  const cmd = commande(lignes);
  const payees = beneficiaires(cmd);
  // the files of the order: the full-resolution photos (stand-ins here), hashed one by one
  const photos = [...new Set(lignes.map((l) => l.photo))];
  const files = photos.map((p) => { const bytes = `photo ${p} full resolution — ${randomBytes(48).toString("hex")}`; return { photo: p, sha256: sha256(bytes), bytes }; });
  const key = randomBytes(32);
  const kr = conditionFromKey(key);
  const blob = box(files, key);
  served.boxes[id] = blob;
  served.tracking[id] = `Colis ${id} — EN ATTENTE DE DEPOT\n`;
  const orderDoc = { id, lignes, total: cmd.total, parts: cmd.parts, files: files.map(({ photo, sha256 }) => ({ photo, sha256 })) };
  const orderSha = sha256(JSON.stringify(orderDoc));
  // the lab's condition belongs to the oracle: shipping is a public fact it will read
  const cond = await oraclePost("/condition", { kind: "presence", url: `${BASE}/suivi/${id}`, mustContain: "EXPEDIE", note: `photos order ${id}` });
  orders[id] = { id, cmd, payees, files, key, kr, blob, orderSha, cond, boxUrl: `${BASE}/commandes/${id}/photos.enc` };
  log(`order ${id}: ${lignes.length} line(s), ${euros(cmd.total)} (${cmd.port ? `incl. postage ${euros(cmd.port)}` : "no postage"}) → ${payees.map((p) => `${p.nom} ${euros(p.cents)}`).join(", ")}`);
  log(`  box ${blob.length} bytes at ${orders[id].boxUrl}, sha256 ${sha256(blob).slice(0, 12)}…; key condition ${kr.condition.slice(0, 14)}…; lab condition ${cond.condition.slice(0, 14)}… (deliveryId ${cond.deliveryId})`);
  report.orders[id] = { total: cmd.total, parts: cmd.parts, orderSha256: orderSha, boxSha256: sha256(blob), keyCondition: kr.condition, labDeliveryId: cond.deliveryId };
}
// the guest downloads the boxes now: he holds the locked goods before he pays
for (const o of Object.values(orders)) {
  const got = Buffer.from(await (await fetch(o.boxUrl)).arrayBuffer());
  expect(sha256(got) === sha256(o.blob), `box ${o.id} downloaded differs`);
}
log("the guest has downloaded both boxes (locked); the key comes with the payment");

// ───────── 2. one Batch per order, signed by the guest
async function lockOrder(o) {
  const cancelAfter = rippleTime(new Date(Date.now() + (PERIOD_S + GRACE_S) * 1000));
  const checkAfter = rippleTime(new Date(Date.now() + PERIOD_S * 1000));
  const inner = [];
  for (const p of o.payees) {
    const base = {
      TransactionType: "EscrowCreate", Account: invite.classicAddress, Destination: who[p.nom].classicAddress,
      Amount: xrpToDrops(xrpOf(p.cents)), CancelAfter: cancelAfter,
    };
    const memos = [
      memo("dareskro/case", "photos"), memo("dareskro/order", o.id), memo("dareskro/order-sha256", o.orderSha),
      memo("dareskro/payee", `${p.role}:${p.nom}`), memo("dareskro/fiat", `${(p.cents / 100).toFixed(2)} EUR @ ${rate} EUR/XRP Kraken ${new Date().toISOString().slice(0, 16)}Z`),
    ];
    if (p.role === "labo") {
      // paid on proof of shipping, by the oracle, at the date
      inner.push(await c.autofill({ ...base, Condition: o.cond.condition, FinishAfter: checkAfter,
        Memos: [...memos, memo("dareskro/proof", `url:${BASE}/suivi/${o.id};mustContain:EXPEDIE`), memo("dareskro/oracle", oracle.address)] }));
    } else {
      // paid by revealing the order's key: no oracle
      inner.push(await c.autofill({ ...base, Condition: o.kr.condition,
        Memos: [...memos, memo("dareskro/box", o.boxUrl), memo("dareskro/box-sha256", sha256(o.blob))] }));
    }
  }
  const seq0 = (await onLedger(() => c.request({ command: "account_info", account: invite.classicAddress }))).result.account_data.Sequence;
  const strip = (t, sq) => { const x = { ...t }; delete x.Fee; delete x.LastLedgerSequence; return { ...x, Fee: "0", SigningPubKey: "", Sequence: sq, Flags: (x.Flags ?? 0) | 0x40000000 }; };
  const batch = await onLedger(() => c.autofill({
    TransactionType: "Batch", Account: invite.classicAddress, Flags: 0x00010000, Sequence: seq0,
    RawTransactions: inner.map((t, i) => ({ RawTransaction: strip(t, seq0 + 1 + i) })),
  }));
  const rb = await onLedger(() => c.submitAndWait(invite.sign(batch).tx_blob));
  const code = rb.result.meta.TransactionResult;
  log(`order ${o.id}: Batch ${code} — ONE signature, ${inner.length} escrows (${euros(o.cmd.total)} = ${o.payees.map((p) => xrpOf(p.cents)).reduce((a, b) => (Number(a) + Number(b)).toFixed(6))} XRP), all or nothing — ${explorer(rb.result.hash)}`);
  note(`order ${o.id} Batch`, { result: code, hash: rb.result.hash });
  if (code !== "tesSUCCESS") throw new Error(`Batch ${o.id} → ${code}`);
  const seqs = inner.map((_, i) => seq0 + 1 + i);
  const hashes = await hashesBySequence(invite.classicAddress, seqs);
  o.escrows = o.payees.map((p, i) => ({ ...p, seq: seqs[i], hash: hashes[seqs[i]], checkAfter, cancelAfter }));
  for (const e of o.escrows) log(`  #${e.seq} ${e.role} ${e.nom}: ${xrpOf(e.cents)} XRP (${euros(e.cents)}) — ${e.hash ? explorer(e.hash) : "(hash not found yet)"}`);
  const lab = o.escrows.find((e) => e.role === "labo");
  const w = await oraclePost("/watch", {
    kind: "presence", deliveryId: o.cond.deliveryId, owner: invite.classicAddress, sequence: lab.seq,
    destination: labo.classicAddress, amountXrp: xrpOf(lab.cents), checkAfter, cancelAfter, finishAfter: checkAfter,
    proof: o.cond.proof, createHash: lab.hash,
  });
  log(`  the lab's escrow is handed to the oracle${w.note ? ` (${w.note})` : ""}: paid at the date (in ${PERIOD_S} s) if ${BASE}/suivi/${o.id} says EXPEDIE, refund ${GRACE_S} s later otherwise`);
  report.orders[o.id].escrows = o.escrows.map(({ role, nom, cents, seq, hash }) => ({ role, nom, cents, seq, hash }));
}
const guestBefore = await onLedger(() => c.getXrpBalance(invite.classicAddress));
await lockOrder(orders.A);
await lockOrder(orders.B);

// ───────── 3. without the key, nobody collects — not even the guest who paid
const A = orders.A;
const agEscrow = A.escrows.find((e) => e.role === "agence");
await send(inconnu, { TransactionType: "EscrowFinish", Account: inconnu.classicAddress, Owner: invite.classicAddress, OfferSequence: agEscrow.seq },
  "a stranger tries to finish the agency's escrow without the key", "tecCRYPTOCONDITION_ERROR");
await send(invite, { TransactionType: "EscrowFinish", Account: invite.classicAddress, Owner: invite.classicAddress, OfferSequence: agEscrow.seq },
  "the guest tries to take his money back before the key is revealed", "tecCRYPTOCONDITION_ERROR");

// ───────── 4. the agency collects by revealing K; the photographers follow with the K they read on the ledger
const balBefore = Object.fromEntries(await Promise.all(["agence", "Léa", "Marc"].map(async (n) => [n, await onLedger(() => c.getXrpBalance(who[n].classicAddress))])));
const rA = await send(agence, { TransactionType: "EscrowFinish", Account: agence.classicAddress, Owner: invite.classicAddress, OfferSequence: agEscrow.seq,
  Condition: A.kr.condition, Fulfillment: A.kr.fulfillment, Fee: finishFee(A.kr.fulfillment), Memos: [memo("dareskro/order", A.id), memo("dareskro/key-revealed", "the fulfillment of this transaction is the order's key")] },
  "order A: the agency finishes its escrow, revealing the key");
// what the ledger now shows to anyone: the Fulfillment field of that transaction
const shown = await onLedger(() => c.request({ command: "tx", transaction: rA.result.hash }));
const fulfillmentOnLedger = (shown.result.tx_json ?? shown.result).Fulfillment;
const keyOnLedger = keyFromFulfillment(fulfillmentOnLedger);
expect(keyOnLedger.equals(A.key), "the key read from the ledger differs from the agency's");
log(`the key is public now: Fulfillment ${fulfillmentOnLedger.slice(0, 12)}… → K ${keyOnLedger.toString("hex").slice(0, 12)}… (${keyOnLedger.length} bytes)`);
for (const nom of ["Léa", "Marc"]) {
  const e = A.escrows.find((x) => x.nom === nom);
  await send(who[nom], { TransactionType: "EscrowFinish", Account: who[nom].classicAddress, Owner: invite.classicAddress, OfferSequence: e.seq,
    Condition: A.kr.condition, Fulfillment: fulfillmentOnLedger, Fee: finishFee(fulfillmentOnLedger), Memos: [memo("dareskro/order", A.id)] },
    `order A: ${nom} finishes her/his escrow with the key read on the ledger`);
}
for (const n of ["agence", "Léa", "Marc"]) {
  const after = await onLedger(() => c.getXrpBalance(who[n].classicAddress));
  log(`  ${n}: ${balBefore[n]} → ${after} XRP`);
}

// ───────── 5. the guest opens the box with the key from the ledger
const opened = unbox(A.blob, keyOnLedger);
const allMatch = opened.every((f) => sha256(f.bytes) === A.files.find((x) => x.photo === f.photo)?.sha256);
expect(allMatch, "a decrypted file does not match the order's hash");
log(`the guest opens order A's box with the ledger's key: ${opened.length} files, hashes ${allMatch ? "all match" : "MISMATCH"} the order (${opened.map((f) => f.photo).join(", ")})`);
let wrongKeyFails = false;
try { unbox(A.blob, randomBytes(32)); } catch { wrongKeyFails = true; }
expect(wrongKeyFails, "the box opened with a wrong key");
log(`a wrong key does not open it (AES-GCM authentication): ${wrongKeyFails ? "refused" : "OPENED?!"}`);

// ───────── 6. the lab prints and ships order A; order B never ships
const printed = unbox(A.blob, keyOnLedger).filter((f) => A.cmd.detail.some((l) => l.photo === f.photo && l.format !== "fichier"));
log(`the lab opens the same box with the same public key, prints ${printed.length} photo(s) (${printed.map((f) => f.photo).join(", ")}) and hands the parcel to the carrier`);
served.tracking.A = `Colis A — EXPEDIE le ${new Date().toISOString().slice(0, 10)} — suivi 8N0${randomBytes(4).toString("hex").toUpperCase()}\n`;
log(`${BASE}/suivi/A now says EXPEDIE, ${secondsUntil(A.escrows[0].checkAfter)} s before the date; ${BASE}/suivi/B stays EN ATTENTE`);
// order B: the agency still reveals its key (the lab needs the file to print), the lab just never ships
const B = orders.B;
const agB = B.escrows.find((e) => e.role === "agence");
await send(agence, { TransactionType: "EscrowFinish", Account: agence.classicAddress, Owner: invite.classicAddress, OfferSequence: agB.seq,
  Condition: B.kr.condition, Fulfillment: B.kr.fulfillment, Fee: finishFee(B.kr.fulfillment), Memos: [memo("dareskro/order", B.id)] },
  "order B: the agency reveals its key and collects its share");
const marcB = B.escrows.find((e) => e.nom === "Marc");
await send(marc, { TransactionType: "EscrowFinish", Account: marc.classicAddress, Owner: invite.classicAddress, OfferSequence: marcB.seq,
  Condition: B.kr.condition, Fulfillment: B.kr.fulfillment, Fee: finishFee(B.kr.fulfillment), Memos: [memo("dareskro/order", B.id)] },
  "order B: Marc collects his share");

const labA = A.escrows.find((e) => e.role === "labo");
const labB = B.escrows.find((e) => e.role === "labo");
const labBefore = await onLedger(() => c.getXrpBalance(labo.classicAddress));
log(`waiting for the date (${Math.max(0, secondsUntil(labA.checkAfter))} s): the oracle reads the two tracking pages…`);
const sA = await follow(invite.classicAddress, labA.seq, (e) => e.status !== "waiting", secondsUntil(labA.cancelAfter) + 90, "order A lab");
if (sA?.status === "finished" && sA.finishHash) log(`order A lab: finished — ${sA.lastWhy ?? "shipped at the date"} — ${explorer(sA.finishHash)}`);
else log(`order A lab: ${sA?.status ?? "unknown"} — ${sA?.lastWhy ?? sA?.lastResult ?? "no word from the oracle"}`);
expect(sA?.status === "finished" && !!sA.finishHash, `order A lab ended ${sA?.status ?? "unknown"} instead of finished`);
const sB = await follow(invite.classicAddress, labB.seq, (e) => e.status !== "waiting", secondsUntil(labB.cancelAfter) + 90, "order B lab");
if (sB?.status === "expired-refunded" && sB.refundHash) log(`order B lab: ${sB.status} — never shipped, the guest gets the lab's share back — ${explorer(sB.refundHash)}`);
else log(`order B lab: ${sB?.status ?? "unknown"} — ${sB?.lastWhy ?? sB?.lastResult ?? "no word from the oracle"}`);
expect(sB?.status === "expired-refunded" && !!sB.refundHash, `order B lab ended ${sB?.status ?? "unknown"} instead of expired-refunded`);
const labAfter = await onLedger(() => c.getXrpBalance(labo.classicAddress));
const guestAfter = await onLedger(() => c.getXrpBalance(invite.classicAddress));
log(`the lab: ${labBefore} → ${labAfter} XRP (order A's ${euros(labA.cents)}); the guest: ${guestBefore} → ${guestAfter} XRP (paid A and B, refunded B's lab share)`);
log(`the web served the boxes ${hits.boxes} time(s) and the tracking pages ${hits.tracking} time(s)`);

report.oracle = { A: sA && { status: sA.status, finishHash: sA.finishHash }, B: sB && { status: sB.status, refundHash: sB.refundHash } };
report.problems = problems;
writeFileSync(REPORT, JSON.stringify(report, null, 2));
log(`\n${problems.length ? `PROBLEMS: ${problems.join(" | ")}` : "all steps as expected"}\ncompte rendu public : ${REPORT}`);
server.close();
await c.disconnect();
process.exit(problems.length ? 1 : 0);
