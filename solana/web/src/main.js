/** dareskro on Solana — the page. Wallet (Phantom or a devnet burner), create, release, cancel, close, with explorer links; the payer chooses SOL, XRP or NEAR. */
import { Buffer } from "buffer";
window.Buffer = Buffer;
import { Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CLUSTER, RPC, PROGRAM_ID, PAY_WITH, explorerTx, explorerAddr } from "./config.js";
import { createIx, finishIx, cancelIx, closeIx, listEscrows, errorCode } from "./program.js";
import { solPrice, quote as auroraQuote } from "./aurora.js";

const $ = (id) => document.getElementById(id);
const connection = new Connection(RPC, "confirmed");
const short = (s, n = 6) => `${s.slice(0, n)}…${s.slice(-4)}`;
const fmt = (unix) => (unix == null ? "—" : new Date(unix * 1000).toLocaleString());
const now = () => Math.floor(Date.now() / 1000);
$("program-link").href = explorerAddr(PROGRAM_ID);

// ---------------------------------------------------------------- wallet
let wallet; // { kind: "phantom"|"burner", publicKey, signTransaction }
const BURNER_KEY = "dareskro.burner.devnet";
function setWallet(w) {
  wallet = w;
  $("btn-phantom").hidden = !!w; $("btn-burner").hidden = !!w; $("btn-disconnect").hidden = !w; $("btn-airdrop").hidden = !(w && w.kind === "burner");
  $("card-create").classList.toggle("disabled", !w); $("card-list").classList.toggle("disabled", !w);
  if (!w) { $("wallet-info").textContent = "No wallet."; return; }
  refreshBalance(); refreshList();
}
async function refreshBalance() {
  if (!wallet) return;
  const b = await connection.getBalance(wallet.publicKey).catch(() => null);
  $("wallet-info").innerHTML = `${wallet.kind === "phantom" ? "Phantom" : "Burner key"} · <a href="${explorerAddr(wallet.publicKey.toBase58())}" target="_blank" rel="noreferrer">${wallet.publicKey.toBase58()}</a> · ${b == null ? "?" : (b / LAMPORTS_PER_SOL).toFixed(4)} SOL on ${CLUSTER}`
    + (b != null && b < 0.01 * LAMPORTS_PER_SOL ? ` <span class="ko">· empty: use Airdrop or <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">faucet.solana.com</a></span>` : "");
}
$("btn-phantom").onclick = async () => {
  $("wallet-error").hidden = true;
  const p = window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null);
  if (!p) { $("wallet-error").textContent = "Phantom is not installed in this browser (phantom.com). The burner key works without it."; $("wallet-error").hidden = false; return; }
  try { const r = await p.connect(); setWallet({ kind: "phantom", publicKey: new PublicKey(r.publicKey.toString()), signTransaction: (tx) => p.signTransaction(tx) }); }
  catch (e) { $("wallet-error").textContent = e.message; $("wallet-error").hidden = false; }
};
$("btn-burner").onclick = () => {
  let kp; const saved = localStorage.getItem(BURNER_KEY);
  if (saved) kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved))); else { kp = Keypair.generate(); localStorage.setItem(BURNER_KEY, JSON.stringify(Array.from(kp.secretKey))); }
  setWallet({ kind: "burner", publicKey: kp.publicKey, signTransaction: async (tx) => { tx.partialSign(kp); return tx; } });
};
$("btn-disconnect").onclick = () => setWallet(undefined);
$("btn-airdrop").onclick = async () => {
  $("wallet-error").hidden = true;
  try { const sig = await connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL); await connection.confirmTransaction(sig, "confirmed"); log(`airdrop 1 SOL`, sig); refreshBalance(); }
  catch (e) { $("wallet-error").textContent = `The devnet faucet refused (rate limit). Send devnet SOL to ${wallet.publicKey.toBase58()} from faucet.solana.com.`; $("wallet-error").hidden = false; }
};

// ---------------------------------------------------------------- sending
async function send(ix, label, { record = $("f-record").checked } = {}) {
  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash; tx.feePayer = wallet.publicKey;
  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: record });
  const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  const got = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const [code, message] = errorCode(got?.meta?.logMessages);
  const refused = !!conf.value.err;
  log(`${label}: ${refused ? `refused — ${code ?? "error"}${message ? ` (${message})` : ""}` : "ok"}`, signature, refused);
  return { signature, refused, code, message };
}
function log(text, signature, ko = false) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="${ko ? "ko" : "ok"}">${text}</span> · <a href="${explorerTx(signature)}" target="_blank" rel="noreferrer">${short(signature, 8)}</a> <span class="muted">${new Date().toLocaleTimeString()}</span>`;
  $("log").prepend(li);
}

// ---------------------------------------------------------------- create
let rate;
(async () => { try { rate = await solPrice(); $("rate-line").textContent = `Rate: 1 SOL = ${rate.usdPerSol} USD (${rate.source}). On devnet the escrow holds SOL for the USD amount; on mainnet it would hold the USDC Aurora delivers.`; } catch { $("rate-line").textContent = "Rate unavailable: the amount will be locked as SOL at 1 SOL = 100 USD."; rate = { usdPerSol: 100, source: "fallback" }; } })();
const inTwoMinutes = new Date(Date.now() + 2 * 60000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
$("f-date").value = inTwoMinutes;
$("f-cancellable").onchange = () => { $("f-cancel").disabled = !$("f-cancellable").checked; if ($("f-cancellable").checked && !$("f-cancel").value) $("f-cancel").value = new Date(Date.now() + 60 * 60000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
for (const p of PAY_WITH) { const o = document.createElement("option"); o.value = p.id; o.textContent = p.label; $("f-pay").append(o); }
let lastQuote;
const payWith = () => PAY_WITH.find((p) => p.id === $("f-pay").value);
$("f-pay").onchange = () => { const p = payWith(); $("refund-wrap").hidden = !p.asset; $("btn-quote").hidden = !p.asset; $("quote-box").hidden = true; lastQuote = undefined; if (p.asset) $("f-refund").placeholder = p.refundHint; };
$("btn-quote").onclick = async () => {
  const p = payWith(); const usd = Number($("f-usd").value); const refundTo = $("f-refund").value.trim();
  $("quote-box").hidden = false; $("quote-box").textContent = "Asking Aurora…";
  if (!refundTo) { $("quote-box").innerHTML = `<span class="ko">Aurora validates the refund address before anything else: give your ${p.chain} address.</span>`; return; }
  try {
    const q = await auroraQuote({ originAsset: p.asset, usdc: usd, recipient: wallet.publicKey.toBase58(), refundTo, dry: true });
    lastQuote = { asset: p.id, amountIn: q.quote.amountInFormatted, usd: q.quote.amountInUsd, seconds: q.quote.timeEstimate };
    $("quote-box").innerHTML = `<b>${q.quote.amountInFormatted} ${p.id.toUpperCase()}</b> (≈ ${Number(q.quote.amountInUsd).toFixed(2)} $) for exactly <b>${q.quote.amountOutFormatted} USDC on Solana</b>, delivered in ≈ ${q.quote.timeEstimate} s to ${short(wallet.publicKey.toBase58())}.
      Withdraw fee ${(Number(q.quote.withdrawFee) / 1e6).toFixed(3)} USDC. <span class="muted">Dry quote, mainnet: no deposit address, no funds moved. The real run of 1 Nov 2026 (2.63 XRP → 3 USDC in 37 s) is in the README.</span>`;
  } catch (e) { $("quote-box").innerHTML = `<span class="ko">Aurora refused: ${e.message}</span>`; }
};
$("btn-lock").onclick = async () => {
  $("lock-error").hidden = true; $("lock-status").textContent = "";
  try {
    const destination = new PublicKey($("f-dest").value.trim());
    const usd = Number($("f-usd").value); if (!(usd > 0)) throw new Error("amount must be > 0");
    const finishAfter = Math.floor(new Date($("f-date").value).getTime() / 1000); if (!(finishAfter > 0)) throw new Error("pick a pay date");
    const cancelAfter = $("f-cancellable").checked ? Math.floor(new Date($("f-cancel").value).getTime() / 1000) : null;
    const lamports = Math.round((usd / rate.usdPerSol) * LAMPORTS_PER_SOL);
    const p = payWith();
    const memos = [`${usd.toFixed(2)} USD @ ${rate.usdPerSol} USD/SOL`, `paid with ${p.id.toUpperCase()}${lastQuote && lastQuote.asset === p.id ? ` · Aurora quote ${lastQuote.amountIn} ${p.id.toUpperCase()}` : p.asset ? " · no quote taken" : ""}`];
    if ($("f-memo").value.trim()) memos.push($("f-memo").value.trim().slice(0, 128));
    const id = Date.now();
    const { escrow, ix } = createIx({ owner: wallet.publicKey, destination, lamports, finishAfter, cancelAfter, condition: null, memos, id });
    $("lock-status").textContent = `Signing… ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL for ${usd} USD, payable ${fmt(finishAfter)}`;
    const r = await send(ix, `create ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL → ${short(destination.toBase58())}`);
    if (r.refused) throw new Error(`${r.code ?? "refused"}: ${r.message ?? ""}`);
    $("lock-status").innerHTML = `<span class="ok">Locked.</span> Escrow <a href="${explorerAddr(escrow.toBase58())}" target="_blank" rel="noreferrer">${escrow.toBase58()}</a> · transaction <a href="${explorerTx(r.signature)}" target="_blank" rel="noreferrer">${short(r.signature, 8)}</a>`;
    lastKey = undefined; refreshBalance(); refreshList();
  } catch (e) { $("lock-error").textContent = e.message; $("lock-error").hidden = false; }
};

// ---------------------------------------------------------------- list
let busy = false, lastKey;
async function refreshList() {
  if (!wallet) return;
  try {
    const es = await listEscrows(connection, wallet.publicKey);
    $("list-error").hidden = true;
    // redraw only when something changed (every 30 s at least, for the countdowns): no flicker, no button moving under the mouse
    const key = JSON.stringify(es) + Math.floor(Date.now() / 30000);
    if (key === lastKey) return; lastKey = key;
    if (!es.length) { $("list").innerHTML = `<p class="muted">No escrow yet for ${short(wallet.publicKey.toBase58())}.</p>`; return; }
    const me = wallet.publicKey.toBase58(); const t = now();
    $("list").innerHTML = `<table><thead><tr><th>escrow</th><th>role</th><th class="num">SOL</th><th>status</th><th>payable</th><th>refundable</th><th>memos</th><th>actions</th></tr></thead><tbody>` + es.map((e) => {
      const role = e.owner === me ? "payer" : "recipient";
      const canRelease = e.status === "locked"; const early = e.finishAfter != null && t < e.finishAfter;
      const canCancel = e.status === "locked" && e.cancelAfter != null; const cancelEarly = canCancel && t < e.cancelAfter;
      const canClose = e.status !== "locked" && e.owner === me;
      return `<tr><td><a href="${explorerAddr(e.address)}" target="_blank" rel="noreferrer">${short(e.address)}</a></td><td>${role}</td><td class="num">${e.sol.toFixed(4)}</td>
        <td class="${e.status === "locked" ? "pending" : e.status === "finished" ? "ok" : "muted"}">${e.status}${e.closedBy ? `<br><span class="muted">by ${short(e.closedBy)}</span>` : ""}</td>
        <td>${fmt(e.finishAfter)}${early ? `<br><span class="muted">in ${e.finishAfter - t} s</span>` : ""}</td><td>${e.cancelAfter == null ? "never" : fmt(e.cancelAfter)}</td>
        <td class="muted">${e.memos.map((m) => m.length > 40 ? m.slice(0, 40) + "…" : m).join("<br>")}</td>
        <td><div class="acts">${canRelease ? `<button data-act="finish" data-e="${e.address}" title="${early ? "the program will answer TooEarly, recorded on chain" : "anyone may release now"}">Release${early ? " (early)" : ""}</button>` : ""}
          ${canCancel ? `<button data-act="cancel" data-e="${e.address}" title="${cancelEarly ? "the program will answer CancelTooEarly" : "refund the payer"}">Cancel${cancelEarly ? " (early)" : ""}</button>` : e.status === "locked" ? `<button data-act="cancel" data-e="${e.address}" title="no cancel date was written: NotCancellable">Cancel (impossible)</button>` : ""}
          ${canClose ? `<button data-act="close" data-e="${e.address}">Close</button>` : ""}</div></td></tr>`;
    }).join("") + `</tbody></table>`;
    for (const b of $("list").querySelectorAll("button[data-act]")) b.onclick = () => act(b.dataset.act, es.find((x) => x.address === b.dataset.e));
  } catch (e) { $("list-error").textContent = e.message; $("list-error").hidden = false; }
}
async function act(what, e) {
  if (busy) return; busy = true;
  try {
    const me = wallet.publicKey;
    const ix = what === "finish" ? finishIx({ caller: me, escrow: e.address, destination: e.destination, fulfillment: null })
      : what === "cancel" ? cancelIx({ caller: me, escrow: e.address, owner: e.owner })
      : closeIx({ owner: me, escrow: e.address });
    await send(ix, `${what} ${short(e.address)}`);
  } catch (err) { log(`${what} ${short(e.address)}: ${err.message}`, "", true); }
  finally { busy = false; lastKey = undefined; refreshBalance(); refreshList(); }
}
setInterval(() => { refreshList(); refreshBalance(); }, 8000);
