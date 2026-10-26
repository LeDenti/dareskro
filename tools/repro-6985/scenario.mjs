// Enchaînements du stand : Batch refusé (alerte « Blind signing must be enabled ») puis EscrowCreate.
//   D : alerte non acquittée, EscrowCreate envoyé, on feuillette et on signe.
//   E : alerte acquittée (both) AVANT l'EscrowCreate, puis signature normale.
//   F : EscrowCreate envoyé pendant l'alerte, puis un humain acquitte l'alerte (both) : que devient la revue ?
import { encode } from "xrpl";

const API = "http://127.0.0.1:5000";
const PATH = "44'/144'/0'/0/0";
const CASE = process.argv[2] ?? "D";
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
  return (await r.json()).data;
}
const screen = async () => ((await (await fetch(`${API}/events?currentscreenonly=true`)).json()).events ?? []).map((e) => e.text).join(" | ");
const button = (b) => fetch(`${API}/button/${b}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "press-and-release" }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function getPubKey() {
  const d = pathBytes();
  const res = await apdu("e0020040" + hex(Uint8Array.from([d.length])) + hex(d));
  const body = res.slice(0, -4);
  const len = parseInt(body.slice(0, 2), 16);
  const pub = body.slice(2, 2 + len * 2);
  const alen = parseInt(body.slice(2 + len * 2, 4 + len * 2), 16);
  return { pub: pub.toUpperCase(), addr: Buffer.from(body.slice(4 + len * 2, 4 + len * 2 + alen * 2), "hex").toString("ascii") };
}
/** Envoie tous les blocs ; renvoie la promesse de la réponse finale (bloque tant que l'app attend l'humain). */
async function send(txHex) {
  const data = Uint8Array.from([...pathBytes(), ...Buffer.from(txHex, "hex")]);
  const chunks = [];
  for (let i = 0; i < data.length; i += 255) chunks.push(data.subarray(i, i + 255));
  for (let i = 0; i < chunks.length; i++) {
    const first = i === 0, isLast = i === chunks.length - 1;
    const p1 = first ? (isLast ? 0x00 : 0x80) : (isLast ? 0x01 : 0x81);
    const cmd = "e004" + p1.toString(16).padStart(2, "0") + "40" + chunks[i].length.toString(16).padStart(2, "0") + hex(chunks[i]);
    if (!isLast) await apdu(cmd); else return apdu(cmd);
  }
}
/** Feuillette jusqu'à « Sign transaction? » et approuve ; s'arrête dès que la réponse arrive. */
async function drive(pending, maxPages = 40) {
  let done = false, out;
  pending.then((r) => { done = true; out = r; });
  const pages = [];
  let prev = "";
  for (let k = 0; k < maxPages && !done; k++) {
    const s = await screen();
    if (s !== prev) { pages.push(s); prev = s; log("écran:", s); }
    if (/Sign transaction\?/.test(s)) { await button("both"); await sleep(600); break; }
    await button("right"); await sleep(300);
  }
  const r = await Promise.race([pending, sleep(4000).then(() => "TIMEOUT")]);
  return { sw: r === "TIMEOUT" ? "TIMEOUT (l'app ne répond pas)" : r.slice(-4), pages };
}

const { pub, addr } = await getPubKey();
const memo = (t, d) => ({ Memo: { MemoType: toHex(t), MemoData: toHex(d) } });
const escrow = (seq, memos) => ({
  TransactionType: "EscrowCreate", Account: addr, Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  Amount: "405220000", FinishAfter: 846000000, Memos: memos, SigningPubKey: pub, Sequence: seq, Fee: "12", LastLedgerSequence: 99999999,
});
const memos = [memo("dareskro/sha256", "384ec59c1f0b2a7d"), memo("dareskro/fiat", "407.33 USD @ 2.41"), memo("dareskro/oracle", "rUuvu1XPgd5GtTgrXQKiwrHq3fb2xiHZMW")];
const inner = (seq) => { const t = { ...escrow(seq, memos), Fee: "0", SigningPubKey: "", Flags: 0x40000000 }; delete t.LastLedgerSequence; return t; };
const batch = { TransactionType: "Batch", Account: addr, Flags: 0x00010000, Sequence: 20, Fee: "36", LastLedgerSequence: 99999999, RawTransactions: [{ RawTransaction: inner(21) }, { RawTransaction: inner(22) }], SigningPubKey: pub };

log("écran avant:", await screen());
const b = await send(encode(batch));
log("Batch →", b.slice(-4), "| écran:", await screen());

if (CASE === "E") { await button("both"); await sleep(500); log("alerte acquittée, écran:", await screen()); }

const pending = send(encode(escrow(23, memos)));
await sleep(800);
log("EscrowCreate envoyé, écran:", await screen());
if (CASE === "F") { await button("both"); await sleep(600); log("un humain acquitte l'alerte (both), écran:", await screen()); }
const r = await drive(pending);
log("EscrowCreate →", r.sw, "|", r.pages.length, "écrans vus");
log("écran final:", await screen());
