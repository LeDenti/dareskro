// G : feuilleter jusqu'à « Sign transaction? », appuyer UNE fois de trop (right), lire la page, puis both.
import { encode } from "xrpl";
const API = "http://127.0.0.1:5000", PATH = "44'/144'/0'/0/0";
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const toHex = (s) => hex(new TextEncoder().encode(s)).toUpperCase();
const pathBytes = () => { const parts = PATH.split("/").map((p) => (p.endsWith("'") ? (parseInt(p) | 0x80000000) >>> 0 : parseInt(p))); const out = [parts.length]; for (const p of parts) out.push((p >>> 24) & 255, (p >>> 16) & 255, (p >>> 8) & 255, p & 255); return Uint8Array.from(out); };
const apdu = async (d) => (await (await fetch(`${API}/apdu`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: d }) })).json()).data;
const screen = async () => ((await (await fetch(`${API}/events?currentscreenonly=true`)).json()).events ?? []).map((e) => e.text).join(" | ");
const button = (b) => fetch(`${API}/button/${b}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "press-and-release" }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d = pathBytes(); const res = await apdu("e0020040" + hex(Uint8Array.from([d.length])) + hex(d));
const len = parseInt(res.slice(0, 2), 16); const pub = res.slice(2, 2 + len * 2).toUpperCase(); const alen = parseInt(res.slice(2 + len * 2, 4 + len * 2), 16);
const addr = Buffer.from(res.slice(4 + len * 2, 4 + len * 2 + alen * 2), "hex").toString("ascii");
const memo = (t, x) => ({ Memo: { MemoType: toHex(t), MemoData: toHex(x) } });
const tx = { TransactionType: "EscrowCreate", Account: addr, Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", Amount: "405220000", FinishAfter: 846000000, Memos: [memo("dareskro/sha256", "384ec59c")], SigningPubKey: pub, Sequence: 30, Fee: "12", LastLedgerSequence: 99999999 };
const data = Uint8Array.from([...pathBytes(), ...Buffer.from(encode(tx), "hex")]);
const pending = apdu("e0040040" + data.length.toString(16).padStart(2, "0") + hex(data));
await sleep(700);
for (let k = 0; k < 20; k++) { const s = await screen(); if (/Sign transaction\?/.test(s)) { console.log("page:", s); break; } await button("right"); await sleep(250); }
await button("right"); await sleep(400); console.log("un appui de trop →", await screen());
await button("right"); await sleep(400); console.log("encore un →", await screen());

await button("both"); await sleep(600);
const r = await pending; console.log("both sur Reject → réponse:", r.slice(-4), "| écran:", await screen());
