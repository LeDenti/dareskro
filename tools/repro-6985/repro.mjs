// Reproduction du 6985 sur Speculos : envoie au Nano émulé (app XRP) les mêmes
// octets que le kit de signature Ledger (device-signer-kit-xrp 0.2.0) :
//   CLA E0, INS 04, P1 00|80|81|01 (premier/suite, dernier), P2 40 (secp256k1),
//   premier bloc = longueur du chemin + chemin BIP32 + début de la transaction.
// Cas : A) Batch (XLS-56)  B) EscrowCreate 4 mémos compacts (dimanche)  C) 3 mémos (samedi).
import { encode } from "xrpl";

const API = "http://127.0.0.1:5000";
const PATH = "44'/144'/0'/0/0";
const CASE = process.argv[2] ?? "all";

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const toHex = (s) => hex(new TextEncoder().encode(s)).toUpperCase();
const pathBytes = () => {
  const parts = PATH.split("/").map((p) => (p.endsWith("'") ? (parseInt(p) | 0x80000000) >>> 0 : parseInt(p)));
  const out = [parts.length];
  for (const p of parts) out.push((p >>> 24) & 255, (p >>> 16) & 255, (p >>> 8) & 255, p & 255);
  return Uint8Array.from(out);
};

async function apdu(dataHex) {
  const r = await fetch(`${API}/apdu`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: dataHex }) });
  const j = await r.json();
  return j.data; // réponse + status word (4 hex)
}
const screen = async () => {
  const r = await fetch(`${API}/events?currentscreenonly=true`);
  const j = await r.json();
  return (j.events ?? []).map((e) => e.text).join(" | ");
};
const button = (b) => fetch(`${API}/button/${b}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "press-and-release" }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPubKey() {
  const d = pathBytes();
  const res = await apdu("e0020040" + hex(Uint8Array.from([d.length])) + hex(d));
  const body = res.slice(0, -4);
  const len = parseInt(body.slice(0, 2), 16);
  const pub = body.slice(2, 2 + len * 2);
  const alen = parseInt(body.slice(2 + len * 2, 4 + len * 2), 16);
  const addr = Buffer.from(body.slice(4 + len * 2, 4 + len * 2 + alen * 2), "hex").toString("ascii");
  return { pub: pub.toUpperCase(), addr };
}

/** Envoie la transaction par blocs de 255 octets et, pendant que l'app attend, feuillette et signe. */
async function sign(txHex, { approve = true, maxPages = 60 } = {}) {
  const data = Uint8Array.from([...pathBytes(), ...Buffer.from(txHex, "hex")]);
  const chunks = [];
  for (let i = 0; i < data.length; i += 255) chunks.push(data.subarray(i, i + 255));
  let last;
  const pages = [];
  for (let i = 0; i < chunks.length; i++) {
    const first = i === 0, isLast = i === chunks.length - 1;
    const p1 = first ? (isLast ? 0x00 : 0x80) : (isLast ? 0x01 : 0x81);
    const cmd = "e004" + p1.toString(16).padStart(2, "0") + "40" + chunks[i].length.toString(16).padStart(2, "0") + hex(chunks[i]);
    if (!isLast) { last = await apdu(cmd); continue; }
    // dernier bloc : l'app affiche la revue, la réponse n'arrive qu'après le choix
    const pending = apdu(cmd);
    let done = false;
    pending.then(() => { done = true; });
    await sleep(700);
    let prev = "";
    for (let k = 0; k < maxPages && !done; k++) {
      const s = await screen();
      if (s !== prev) { pages.push(s); prev = s; }
      if (/Blind signing must/i.test(s)) { await button("both"); break; }
      if (/^Sign transaction\?/.test(s) || /Sign transaction\?/.test(s)) { await button(approve ? "both" : "right"); if (!approve) { await sleep(400); await button("both"); } break; }
      if (/Reject/i.test(s) && !/Sign/i.test(s)) { if (!approve) { await button("both"); break; } }
      await button("right");
      await sleep(350);
    }
    last = await pending;
  }
  return { sw: last.slice(-4), body: last.slice(0, -4), pages };
}

const { pub, addr } = await getPubKey();
console.log("compte Speculos", addr, "clé", pub.slice(0, 12) + "…");
const cfg = await apdu("e006000000");
console.log("app XRP version", cfg.slice(2, 8).match(/../g).map((b) => parseInt(b, 16)).join("."));

const memo = (t, d) => ({ Memo: { MemoType: toHex(t), MemoData: toHex(d) } });
const SHA = "384ec59c1f0b2a7d9e6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const ZK = "0x20613f4b9a8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e";
const escrow = (seq, memos) => ({
  TransactionType: "EscrowCreate", Account: addr, Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  Amount: "405220000", FinishAfter: 846000000, Memos: memos, SigningPubKey: pub, Sequence: seq, Fee: "12", LastLedgerSequence: 99999999,
});
const sunday = [memo("dareskro/sha256", SHA), memo("dareskro/fiat", "407.33 USD @ 2.41"), memo("dareskro/oracle", "rUuvu1XPgd5GtTgrXQKiwrHq3fb2xiHZMW"), memo("dareskro/zk-commitment", ZK)];
const saturday = sunday.slice(0, 3);

const results = {};
if (CASE === "all" || CASE === "C") {
  results.C_escrow_3memos = await sign(encode(escrow(10, saturday)));
  console.log("C EscrowCreate 3 mémos (samedi) →", results.C_escrow_3memos.sw, results.C_escrow_3memos.pages.length, "écrans");
}
if (CASE === "all" || CASE === "B") {
  results.B_escrow_4memos = await sign(encode(escrow(11, sunday)));
  console.log("B EscrowCreate 4 mémos (dimanche) →", results.B_escrow_4memos.sw, results.B_escrow_4memos.pages.length, "écrans");
}
if (CASE === "all" || CASE === "A") {
  const inner = (seq, memos) => ({ ...escrow(seq, memos), Fee: "0", SigningPubKey: "", Flags: 0x40000000, LastLedgerSequence: undefined });
  const i1 = inner(13, sunday), i2 = inner(14, [memo("dareskro/dgfip", "withheld=33.03")]);
  delete i1.LastLedgerSequence; delete i2.LastLedgerSequence;
  const batch = {
    TransactionType: "Batch", Account: addr, Flags: 0x00010000, Sequence: 12, Fee: "36", LastLedgerSequence: 99999999,
    RawTransactions: [{ RawTransaction: i1 }, { RawTransaction: i2 }], SigningPubKey: pub,
  };
  results.A_batch = await sign(encode(batch));
  console.log("A Batch (XLS-56) →", results.A_batch.sw, results.A_batch.pages.length, "écrans");
}
for (const [k, v] of Object.entries(results)) { console.log(`\n== ${k}: status ${v.sw}`); v.pages.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p}`)); }
