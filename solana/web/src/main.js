/** dareskro on Solana — the page. Wallet (Phantom or a devnet burner), create, release, cancel, close, with explorer links; the payer chooses SOL, XRP or NEAR. */
import { Buffer } from "buffer";
window.Buffer = Buffer;
import { Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CLUSTER, RPC, PROGRAM_ID, PAY_WITH, explorerTx, explorerAddr } from "./config.js";
import { createIx, finishIx, cancelIx, closeIx, listEscrows, errorCode, vaultCreateIx, vaultVoteIx, vaultTimeoutIx, vaultCloseIx, listVaults, fetchFeeConfig, feeFor, CONFIG } from "./program.js";
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
  $("card-create").classList.toggle("disabled", !w); $("card-list").classList.toggle("disabled", !w); $("card-vault").classList.toggle("disabled", !w);
  if (!w) { $("wallet-info").textContent = "No wallet."; return; }
  refreshBalance(); refreshList(); refreshVaults();
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
/** A blockhash lives ~60 s: if the wallet's confirmation takes longer, the page asks for a fresh signature (twice at most). */
async function send(ix, label, { record = $("f-record").checked, note } = {}) {
  let signature, conf;
  for (let attempt = 1; ; attempt++) {
    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash; tx.feePayer = wallet.publicKey;
    note?.(attempt === 1 ? "Confirm in your wallet within a minute…" : `The first signature expired (the wallet took more than a minute): asking again, attempt ${attempt}…`);
    const signed = await wallet.signTransaction(tx);
    try {
      signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: record });
      conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      break;
    } catch (e) {
      // the wallet took longer than the blockhash lives: ask for a fresh signature
      if (attempt >= 3 || !/expired|block height|Blockhash not found/i.test(e.message)) throw e;
    }
  }
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
// the fee per act, read from the program's schedule account (zero unless the administrator set it; capped by the code at 1 % / 0.01 SOL)
let feeCfg = null;
const feeLine = (lamports) => { const f = feeFor(feeCfg, lamports); return f ? `dareskro fee ${(f / LAMPORTS_PER_SOL).toFixed(4)} SOL on top (${feeCfg.feeBps} bps, floor ${(feeCfg.feeMinLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL)` : "no dareskro fee on this act"; };
(async () => { try { feeCfg = await fetchFeeConfig(connection); const t = feeCfg ? (feeCfg.feeBps || feeCfg.feeMinLamports ? `Fee per act: ${feeCfg.feeBps} bps of the SOL locked, floor ${(feeCfg.feeMinLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, paid by the payer on top — never out of what the recipient gets. Capped by the program at 1 % / 0.01 SOL; ${feeCfg.actsCharged} act(s) charged so far.` : "Fee per act: zero (the schedule exists, the administrator has not set one). The program caps it at 1 % / 0.01 SOL.") : "Fee per act: no schedule account yet — acts cost nothing beyond rent and gas."; for (const id of ["fee-line", "fee-line-vault"]) { const el = $(id); if (el) { el.innerHTML = `${t} <a href="${explorerAddr(CONFIG.toBase58())}" target="_blank" rel="noreferrer">schedule</a>`; } } } catch {} })();
(async () => { try { rate = await solPrice(); $("rate-line").textContent = `Rate: 1 SOL = ${rate.usdPerSol} USD (${rate.source}). On devnet the escrow holds SOL for the USD amount; on mainnet it would hold the USDC Aurora delivers.`; } catch { $("rate-line").textContent = "Rate unavailable: the amount will be locked as SOL at 1 SOL = 100 USD."; rate = { usdPerSol: 100, source: "fallback" }; } })();
const inTwoMinutes = new Date(Date.now() + 2 * 60000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
$("f-date").value = inTwoMinutes;
$("f-record").onchange = () => { lastKey = undefined; refreshList(); };
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
      Withdraw fee ${(Number(q.quote.withdrawFee) / 1e6).toFixed(3)} USDC. App fee on the bridge: Aurora applied ${(q.quoteRequest?.appFees ?? []).map((f) => `${f.fee} bps to ${short(f.recipient)}`).join(", ") || "none"} (its own, whatever is asked: no dareskro cut on this leg). <span class="muted">Dry quote, mainnet: no deposit address, no funds moved. The real run of 1 Nov 2026 (2.63 XRP → 3 USDC in 37 s) is in the README.</span>`;
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
    const r = await send(ix, `create ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL → ${short(destination.toBase58())} (${feeLine(lamports)})`, { note: (m) => { $("lock-status").textContent = `${m} ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL for ${usd} USD, payable ${fmt(finishAfter)}; ${feeLine(lamports)}`; } });
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
      const demo = $("f-record").checked;
      return `<tr><td><a href="${explorerAddr(e.address)}" target="_blank" rel="noreferrer">${short(e.address)}</a></td><td>${role}</td><td class="num">${e.sol.toFixed(4)}</td>
        <td class="${e.status === "locked" ? "pending" : e.status === "finished" ? "ok" : "muted"}">${e.status}${e.closedBy ? `<br><span class="muted">by ${short(e.closedBy)}</span>` : ""}</td>
        <td>${fmt(e.finishAfter)}${early ? `<br><span class="muted">in ${e.finishAfter - t} s</span>` : ""}</td><td>${e.cancelAfter == null ? "never" : fmt(e.cancelAfter)}</td>
        <td class="muted">${e.memos.map((m) => m.length > 40 ? m.slice(0, 40) + "…" : m).join("<br>")}</td>
        <td><div class="acts">${canRelease ? `<button data-act="finish" data-e="${e.address}" ${early && !demo ? "disabled" : ""} title="${early ? (demo ? "the program will answer TooEarly, recorded on chain" : `payable in ${e.finishAfter - t} s`) : "anyone may release now"}">Release${early ? " (early)" : ""}</button>` : ""}
          ${canCancel ? `<button data-act="cancel" data-e="${e.address}" ${cancelEarly && !demo ? "disabled" : ""} title="${cancelEarly ? (demo ? "the program will answer CancelTooEarly" : `refundable after ${fmt(e.cancelAfter)}`) : "refund the payer"}">Cancel${cancelEarly ? " (early)" : ""}</button>` : e.status === "locked" && demo ? `<button data-act="cancel" data-e="${e.address}" title="no cancel date was written: NotCancellable">Cancel (impossible)</button>` : ""}
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
    await send(ix, `${what} ${short(e.address)}`, { note: (m) => { $("list-error").textContent = m; $("list-error").hidden = false; $("list-error").className = "pending"; } });
    $("list-error").hidden = true; $("list-error").className = "ko";
  } catch (err) { $("list-error").hidden = true; $("list-error").className = "ko"; log(`${what} ${short(e.address)}: ${err.message.split("\n")[0]}`, "", true); }
  finally { busy = false; lastKey = undefined; refreshBalance(); refreshList(); }
}
setInterval(() => { refreshList(); refreshVaults(); refreshBalance(); }, 8000);


// ---------------------------------------------------------------- the shared vault
let vaultKey;
$("btn-vault").onclick = async () => {
  $("vault-error").hidden = true; $("vault-status").textContent = "";
  try {
    const beneficiary = new PublicKey($("v-ben").value.trim());
    const third = new PublicKey($("v-p3").value.trim());
    const usd = Number($("v-usd").value); if (!(usd > 0)) throw new Error("amount must be > 0");
    const lamports = Math.round((usd / rate.usdPerSol) * LAMPORTS_PER_SOL);
    const threshold = Number($("v-thr").value);
    const deadline = $("v-deadline").value ? Math.floor(new Date($("v-deadline").value).getTime() / 1000) : null;
    const memos = [`${usd.toFixed(2)} USD @ ${rate.usdPerSol} USD/SOL`];
    if ($("v-memo").value.trim()) memos.push($("v-memo").value.trim().slice(0, 128));
    const id = Date.now();
    const { vault, ix } = vaultCreateIx({ owner: wallet.publicKey, beneficiary, lamports, parties: [wallet.publicKey, beneficiary, third], threshold, deadline, memos, id });
    const r = await send(ix, `vault ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, ${threshold} of 3 (${feeLine(lamports)})`, { note: (m) => { $("vault-status").textContent = `${m}; ${feeLine(lamports)}`; } });
    if (r.refused) throw new Error(`${r.code ?? "refused"}: ${r.message ?? ""}`);
    $("vault-status").innerHTML = `<span class="ok">Funded.</span> Vault <a href="${explorerAddr(vault.toBase58())}" target="_blank" rel="noreferrer">${vault.toBase58()}</a> · <a href="${explorerTx(r.signature)}" target="_blank" rel="noreferrer">${short(r.signature, 8)}</a>`;
    vaultKey = undefined; refreshBalance(); refreshVaults();
  } catch (e) { $("vault-error").textContent = e.message; $("vault-error").hidden = false; }
};
async function refreshVaults() {
  if (!wallet) return;
  try {
    const vs = await listVaults(connection, wallet.publicKey);
    const key = JSON.stringify(vs) + Math.floor(Date.now() / 30000);
    if (key === vaultKey) return; vaultKey = key;
    const me = wallet.publicKey.toBase58(); const t = now();
    if (!vs.length) { $("vlist").innerHTML = `<p class="muted">No shared vault yet where ${short(me)} is a party.</p>`; return; }
    $("vlist").innerHTML = `<table><thead><tr><th>vault</th><th>me</th><th class="num">SOL</th><th>status</th><th>votes</th><th>deadline</th><th>actions</th></tr></thead><tbody>` + vs.map((v) => {
      const roles = [v.owner === me && "owner", v.beneficiary === me && "beneficiary", v.parties.includes(me) && "party"].filter(Boolean).join(" · ");
      const votes = v.votes.map((x) => `${short(x.party)} → ${(Number(x.toBeneficiary) / 1e9).toFixed(4)} SOL to beneficiary`).join("<br>") || "<span class='muted'>none yet</span>";
      const amParty = v.parties.includes(me), locked = v.status === "locked";
      const late = v.deadline != null && t >= v.deadline;
      const acts = [];
      if (locked && amParty) {
        // rally to a vote already cast by another party: one click, no amount to retype
        for (const x of v.votes.filter((x) => x.party !== me)) {
          const alreadyMine = v.votes.some((y) => y.party === me && y.toBeneficiary === x.toBeneficiary);
          if (!alreadyMine) acts.push(`<button class="primary" data-vact="vote" data-v="${v.address}" data-amt="${x.toBeneficiary}" title="agree with ${short(x.party)}: ${(Number(x.toBeneficiary) / 1e9).toFixed(4)} SOL to the beneficiary, the rest back to the owner">Agree with ${short(x.party, 4)}: ${(Number(x.toBeneficiary) / 1e9).toFixed(3)} SOL</button>`);
        }
        acts.push(`<button data-vact="vote" data-v="${v.address}" data-amt="${v.amount}" title="all of it to the beneficiary">Pay beneficiary</button>`);
        acts.push(`<button data-vact="vote" data-v="${v.address}" data-amt="0" title="all of it back to the owner">Refund owner</button>`);
        acts.push(`<button data-vact="split" data-v="${v.address}" title="a split: X SOL to the beneficiary, the rest to the owner">Split…</button>`);
      }
      if (locked && v.deadline != null) acts.push(`<button data-vact="timeout" data-v="${v.address}" ${late ? "" : "disabled"} title="${late ? "deadline passed: anyone may return the deposit to the owner" : `after ${fmt(v.deadline)}`}">Deadline refund</button>`);
      if (!locked && v.owner === me) acts.push(`<button data-vact="close" data-v="${v.address}">Close</button>`);
      const outcome = v.status === "finished" ? `${(Number(v.paidToBeneficiary) / 1e9).toFixed(4)} SOL to beneficiary, ${((Number(v.amount) - Number(v.paidToBeneficiary)) / 1e9).toFixed(4)} back` : v.status === "cancelled" ? "returned to the owner (deadline)" : `${v.threshold} of ${v.parties.length} needed`;
      return `<tr><td><a href="${explorerAddr(v.address)}" target="_blank" rel="noreferrer">${short(v.address)}</a><br><span class="muted">${v.memos[1] ?? v.memos[0] ?? ""}</span></td><td>${roles}</td><td class="num">${v.sol.toFixed(4)}</td>
        <td class="${locked ? "pending" : v.status === "finished" ? "ok" : "muted"}">${v.status}<br><span class="muted">${outcome}</span></td><td>${votes}</td><td class="muted">${v.deadline == null ? "none" : fmt(v.deadline)}</td><td><div class="acts">${acts.join("")}</div></td></tr>`;
    }).join("") + `</tbody></table>`;
    for (const b of $("vlist").querySelectorAll("button[data-vact]")) b.onclick = () => vaultAct(b.dataset.vact, vs.find((x) => x.address === b.dataset.v), b.dataset.amt);
  } catch (e) { $("vault-error").textContent = e.message; $("vault-error").hidden = false; }
}
async function vaultAct(what, v, amt) {
  if (busy) return;
  let toBeneficiary = amt == null ? null : BigInt(amt);
  if (what === "split") {
    const sol = prompt(`How many SOL to the beneficiary (out of ${v.sol})? The rest goes back to the owner.`);
    if (sol == null) return; toBeneficiary = BigInt(Math.round(Number(sol) * 1e9)); what = "vote";
  }
  busy = true;
  try {
    const me = wallet.publicKey;
    const ix = what === "vote" ? vaultVoteIx({ party: me, vault: v.address, beneficiary: v.beneficiary, owner: v.owner, toBeneficiary })
      : what === "timeout" ? vaultTimeoutIx({ caller: me, vault: v.address, owner: v.owner })
      : vaultCloseIx({ owner: me, vault: v.address });
    const label = what === "vote" ? `vote ${short(v.address)}: ${(Number(toBeneficiary) / 1e9).toFixed(4)} SOL to the beneficiary` : `${what} ${short(v.address)}`;
    await send(ix, label, { note: (m) => { $("vault-status").textContent = m; } });
    $("vault-status").textContent = "";
  } catch (err) { log(`${what} ${short(v.address)}: ${err.message.split("\n")[0]}`, "", true); }
  finally { busy = false; vaultKey = undefined; refreshBalance(); refreshVaults(); }
}
