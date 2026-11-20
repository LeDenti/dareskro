/**
 * dareskro on Solana mainnet, paid from an EVM chain through Aurora Intents Connect.
 *
 * The payer's EVM wallet signs ONE message (erc191). Aurora then bridges the deposit
 * to native SOL on the payer's intermediary account on Solana, an account only that
 * wallet can authorise, and runs our step from it: dareskro's `create`, owner = the
 * intermediary, destination = the recipient typed below. The recipient is fixed at
 * creation; anyone may release on the date, only to the recipient; nobody can cancel
 * (no cancel date is set: payroll). The escrow's rent comes back to the intermediary
 * with `close`, which the same EVM wallet authorises as a steps-only execution.
 *
 * Everything below is the official SDK (@aurora-is-near/intents-connect 7.28.0):
 * intermediary resolution, the three-round fee sizing, signing, deposit, polling.
 * Our code is the recipe: the instruction, and how much of what arrives it may lock.
 */
import { Buffer } from "buffer";
window.Buffer = Buffer;
import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import { createIntentsConnectApi, createExecutionRunner, isUserRejection } from "@aurora-is-near/intents-connect";
import { evm } from "@aurora-is-near/intents-connect-wallet/evm";
import { prepareSolanaSteps } from "@aurora-is-near/intents-connect-wallet/solana";
import { PROGRAM_ID, AURORA_KEY } from "./config.js";
import { createIx, finishIx, closeIx, decodeEscrow, fetchFeeConfig, feeFor, escrowAddress, errorCode } from "./program.js";

const q = new URLSearchParams(location.search);
// the public mainnet-beta endpoint answers 403 to browsers; publicnode accepts them (checked 20 Nov 2026)
const RPC = q.get("rpc") || "https://solana-rpc.publicnode.com";
const CONNECT_API = "https://intents-connect-api.aurora.dev";
const SOL = "nep141:sol.omft.near";
/** a system account must stay rent-exempt or empty: the intermediary keeps this much */
const ESCROW_SPACE = 692; // 8 + Escrow::INIT_SPACE, fixed (memos are max_len(3, 128))
const ORIGINS = [
  { id: "usdc-base", label: "USDC on Base", chain: "base", asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", token: { contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }, unit: "USDC" },
  { id: "usdc-arb", label: "USDC on Arbitrum", chain: "arb", asset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", token: { contractAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 }, unit: "USDC" },
  { id: "eth-base", label: "ETH on Base", chain: "base", asset: "nep141:base.omft.near", token: { decimals: 18 }, unit: "ETH" },
  { id: "eth-arb", label: "ETH on Arbitrum", chain: "arb", asset: "nep141:arb.omft.near", token: { decimals: 18 }, unit: "ETH" },
];

const $ = (id) => document.getElementById(id);
const connection = new Connection(RPC, "confirmed");
const sol = (l) => `${(Number(l) / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
const short = (s, n = 6) => (s ? `${s.slice(0, n)}…${s.slice(-4)}` : "—");
const txLink = (sig) => `<a href="https://solscan.io/tx/${sig}" target="_blank" rel="noreferrer">${short(sig, 8)}</a>`;
const addrLink = (a, label) => `<a href="https://solscan.io/account/${a}" target="_blank" rel="noreferrer">${label ?? short(a)}</a>`;
const fmt = (unix) => (unix == null ? "—" : new Date(unix * 1000).toLocaleString());
const now = () => Math.floor(Date.now() / 1000);
function log(html, cls = "") { const li = document.createElement("li"); li.className = cls; li.innerHTML = `<span class="muted">${new Date().toLocaleTimeString()}</span> ${html}`; $("log").prepend(li); }
const SAVE = "dareskro.connect.mainnet";
const saved = () => { try { return JSON.parse(localStorage.getItem(SAVE)) ?? {}; } catch { return {}; } };
const save = (o) => { try { localStorage.setItem(SAVE, JSON.stringify({ ...saved(), ...o })); } catch {} };

$("program-link").href = `https://solscan.io/account/${PROGRAM_ID}`;
$("origin").innerHTML = ORIGINS.map((o) => `<option value="${o.id}">${o.label}</option>`).join("");
$("origin").onchange = () => { $("amount").value = $("origin").value.startsWith("eth") ? "0.002" : "3"; };

// ---------------------------------------------------------------- is the program on mainnet?
let program = { live: false, cfg: null, rent: null, keep: null };
async function checkProgram() {
  try {
    const acc = await connection.getAccountInfo(new PublicKey(PROGRAM_ID));
    if (!acc?.executable) { $("program-state").innerHTML = `<span class="ko">not deployed on mainnet yet</span>: quotes work, payments wait for the deployment`; return; }
    const [cfg, rent, keep] = await Promise.all([fetchFeeConfig(connection), connection.getMinimumBalanceForRentExemption(ESCROW_SPACE), connection.getMinimumBalanceForRentExemption(0)]);
    program = { live: true, cfg, rent, keep };
    $("program-state").innerHTML = `<span class="ok">live on mainnet</span> · fee per act ${cfg ? `${cfg.feeBps} bps, floor ${sol(cfg.feeMinLamports)}` : "none (no schedule)"} · escrow rent ${sol(rent)}`;
  } catch (e) { $("program-state").innerHTML = `<span class="ko">mainnet RPC unreachable</span> (${e.message}); add <code>?rpc=…</code>`; }
}
checkProgram();
// before deployment, size with the figures measured on 16 Nov 2026 so the quote is still meaningful
const rentNow = () => program.rent ?? 4_165_600;
const keepNow = () => program.keep ?? 650_240;

// ---------------------------------------------------------------- the payer's EVM wallet
// ?watch=0x… quotes for that address without any wallet: everything up to the signature, which it refuses
const watch = /^0x[0-9a-fA-F]{40}$/.test(q.get("watch") ?? "") ? q.get("watch") : null;
const eth = watch
  ? { request: async ({ method }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [watch];
      if (method === "eth_chainId") return "0x2105";
      throw new Error(`read-only (?watch=): ${method} refused, nothing is signed or sent`);
    } }
  : window.ethereum;
let account;
const connector = {
  id: "injected", name: "Browser wallet", chains: ["base", "arb"], signingStandard: "erc191",
  connect: async () => { [account] = await eth.request({ method: "eth_requestAccounts" }); },
  disconnect: async () => { account = undefined; },
  getAddress: () => account,
  getProviders: () => ({ evm: eth }),
  getChainId: async () => parseInt(await eth.request({ method: "eth_chainId" }), 16),
};
const api = createIntentsConnectApi({ baseUrl: CONNECT_API, apiKey: AURORA_KEY });
const runner = createExecutionRunner({ api, wallet: () => connector, plugins: { evm }, pluginOptions: { provider: eth }, onEvent });
let intermediary;

$("btn-evm").onclick = async () => {
  if (!eth) { $("evm-info").innerHTML = `<span class="ko">No EVM wallet in this browser.</span> Install MetaMask or Rabby, or use Phantom's Ethereum account.`; return; }
  try {
    await connector.connect();
    const im = await api.getIntermediary(account);
    intermediary = im?.solana ?? im?.result?.solana;
    const bal = intermediary ? await connection.getBalance(new PublicKey(intermediary)).catch(() => null) : null;
    $("evm-info").innerHTML = `Payer ${short(account, 8)} · its Solana intermediary ${intermediary ? addrLink(intermediary) : "<span class='ko'>not returned</span>"}${bal == null ? "" : ` (${sol(bal)} today)`} — only this wallet's signature can make it act.`;
    $("card-pay").classList.remove("disabled");
    log(`wallet ${short(account, 8)} connected; intermediary ${intermediary ? addrLink(intermediary) : "?"}`);
  } catch (e) { $("evm-info").innerHTML = `<span class="ko">${e.message}</span>`; }
};

// ---------------------------------------------------------------- the recipe: what may be locked out of what arrives
/** The most `create` may lock out of `available` lamports: lock + dareskro's fee ≤ available. */
function lockable(available, cfg) {
  if (available <= 0) return 0;
  let lock = cfg ? Math.floor((available * 10_000) / (10_000 + cfg.feeBps)) : available;
  if (cfg && lock + feeFor(cfg, lock) > available) lock = available - cfg.feeMinLamports;
  return Math.max(0, lock);
}
const recipe = {
  id: "dareskro-lock", intent: "dareskro_lock", title: "dareskro: lock pay on Solana",
  flow: "bridge-in", type: "solana", destination: { chain: "sol", assetId: SOL },
  buildSteps: async ({ intermediary: im, amount }, p) => {
    const available = Number(amount) - rentNow() - keepNow();
    const lock = lockable(available, program.cfg);
    if (lock <= 0) throw new Error(`what arrives (${sol(amount)}) does not cover the escrow's rent (${sol(rentNow())}) and the intermediary's minimum (${sol(keepNow())})`);
    const { ix, escrow } = createIx({ owner: im, destination: p.destination, lamports: lock, finishAfter: p.finishAfter, cancelAfter: null, condition: null, memos: p.memos, id: p.id });
    p.built = { amount: String(amount), lock, fee: feeFor(program.cfg, lock), rent: rentNow(), keep: keepNow(), escrow: escrow.toBase58(), intermediary: im };
    return prepareSolanaSteps([ix], { intermediary: im });
  },
};

let preview, params;
function readForm() {
  const o = ORIGINS.find((x) => x.id === $("origin").value);
  const amount = Number($("amount").value);
  if (!(amount > 0)) throw new Error("amount must be positive");
  let destination;
  try { destination = new PublicKey($("dest").value.trim()).toBase58(); } catch { throw new Error("the recipient is not a Solana address"); }
  const atomic = BigInt(Math.round(amount * 10 ** Math.min(o.token.decimals, 9))) * 10n ** BigInt(Math.max(0, o.token.decimals - 9));
  return { o, amount, atomic: atomic.toString(), destination };
}

$("btn-preview").onclick = async () => {
  $("pay-error").textContent = ""; $("btn-run").disabled = true;
  try {
    const { o, amount, atomic, destination } = readForm();
    const delay = Number($("delay").value);
    // the release date is counted from the quote; the bridge takes a minute or two, the hold window is 25 minutes
    params = { destination, id: Date.now(), finishAfter: now() + delay + 180, memos: [$("memo").value.trim().slice(0, 120) || "dareskro via Intents Connect"] };
    const plan = {
      recipe, params,
      quote: { originAsset: o.asset, destinationAsset: SOL, amount: atomic, swapType: "EXACT_INPUT", slippageTolerance: 100, deadline: new Date(Date.now() + 20 * 60_000).toISOString() },
      feeStrategy: { kind: "threeRound", amountReserveBps: 25 },
      originChain: o.chain, originToken: o.token, depositViaWallet: true,
      validateExecution: (ex) => { if (!params.built || params.built.lock <= 0) throw new Error("nothing left to lock"); },
    };
    $("preview").innerHTML = "Asking Aurora (three dry rounds)…";
    preview = await runner.preview(plan);
    const ex = preview.execution, b = params.built;
    $("preview").innerHTML = `<b>You send</b> ${amount} ${o.unit} on ${o.label.split(" on ")[1]} · Aurora delivers at least <b>${sol(ex.quote?.minAmountOut ?? "0")}</b> to your intermediary${ex.details?.networkFee ? `, of which Connect's network fee ${sol(ex.details.networkFee)}` : ""}.<br/>
      <b>Locked for ${short(b ? destination : "", 6)}</b>: ${b ? sol(b.lock) : "?"} · escrow rent ${b ? sol(b.rent) : "?"} (comes back on close) · dareskro fee ${b ? sol(b.fee) : "?"} · left on your intermediary ${b ? sol(Number(preview.spendable ?? b.amount) - b.lock - b.rent - b.fee) : "?"}<br/>
      Released to the recipient after <b>${fmt(params.finishAfter)}</b>, by anyone; never cancellable. Escrow ${b ? addrLink(b.escrow) : "?"}.
      ${program.live ? "" : "<br/><span class='ko'>The program is not on mainnet yet: this quote is real, the payment would fail on Solana and Aurora would refund.</span>"}
      <details><summary class="muted">dry response</summary><pre>${JSON.stringify({ quote: ex.quote, details: ex.details, spendable: preview.spendable }, null, 1).slice(0, 2500)}</pre></details>`;
    $("btn-run").disabled = !program.live;
    log(`quoted: ${amount} ${o.unit} → lock ${b ? sol(b.lock) : "?"} for ${short(destination)}`);
  } catch (e) { $("pay-error").textContent = e.message; $("preview").textContent = ""; }
};

$("btn-run").onclick = async () => {
  $("pay-error").textContent = ""; $("btn-run").disabled = true; $("btn-preview").disabled = true;
  try {
    const b = params.built;
    save({ escrow: b.escrow, wallet: account, intermediary: b.intermediary, finishAfter: params.finishAfter, destination: params.destination, lock: b.lock });
    $("escrow-addr").value = b.escrow;
    const ex = await runner.run(preview.plan);
    const sig = ex.transaction?.solanaTxHash;
    log(`execution ${ex.id}: <b>${ex.status}</b>${sig ? ` · Solana ${txLink(sig)}` : ""}`, ex.status === "OPERATION_SUCCESS" || /SUCCESS/.test(ex.status) ? "ok" : "ko");
    save({ executionId: ex.id, solanaTx: sig, status: ex.status });
    await readEscrow();
  } catch (e) {
    $("pay-error").textContent = isUserRejection?.(e) ? "Signature declined: nothing was sent." : e.message;
    log(`stopped: ${e.message}`, "ko");
  } finally { $("btn-preview").disabled = false; }
};

function onEvent(ev) {
  if (ev.type === "phase") log(`phase: ${ev.phase}`, "muted");
  else if (ev.type === "status") log(`status: ${ev.status}`);
  else if (ev.type === "created") { log(`execution created: ${ev.executionId}`); save({ executionId: ev.executionId }); }
  else if (ev.type === "quoted") log(`exact figures: network fee ${sol(ev.networkFee)}, spendable ${sol(ev.spendable)}`);
  else if (ev.type === "deposit-address") log(`deposit address ${short(ev.address, 8)} (shown only after your signature)`);
  else if (ev.type === "deposit-sent") { log(`deposit sent: ${short(ev.txHash, 10)}`); save({ depositTx: ev.txHash }); }
  else if (ev.type === "error") log(`error: ${ev.error.message}`, "ko");
}

// ---------------------------------------------------------------- the escrow, as the chain has it
let current;
async function readEscrow() {
  const a = $("escrow-addr").value.trim();
  if (!a) return;
  try {
    const acc = await connection.getAccountInfo(new PublicKey(a));
    if (!acc) { $("escrow-out").innerHTML = `No account at ${addrLink(a)} on mainnet${saved().escrow === a ? " yet (the bridge may still be running)" : ""}.`; current = null; refreshButtons(); return; }
    current = decodeEscrow(new PublicKey(a), acc.data);
    $("escrow-out").innerHTML = `<b>${current.status}</b> · ${current.sol.toFixed(6)} SOL for ${addrLink(current.destination)} · owner ${addrLink(current.owner)} (the payer's intermediary) · release after ${fmt(current.finishAfter)} · cancel ${current.cancelAfter ? fmt(current.cancelAfter) : "never"} · memo <code>${current.memos.join(" · ")}</code>${current.closedBy ? ` · closed by ${addrLink(current.closedBy)} at ${fmt(current.closedAt)}` : ""}`;
  } catch (e) { $("escrow-out").innerHTML = `<span class="ko">${e.message}</span>`; }
  refreshButtons();
}
function refreshButtons() {
  $("btn-release").disabled = !(current && current.status === "locked" && (current.finishAfter == null || current.finishAfter <= now()));
  $("btn-close").disabled = !(current && current.status !== "locked" && account && intermediary === current.owner);
}
$("btn-read").onclick = readEscrow;

/** Anyone releases, only to the destination written at creation. Phantom, on mainnet, pays the fee. */
$("btn-release").onclick = async () => {
  const ph = window.phantom?.solana ?? window.solana;
  if (!ph) { log("no Phantom in this browser: release with `node client/intents_connect.mjs release <escrow>`", "ko"); return; }
  try {
    const { publicKey } = await ph.connect();
    const tx = new Transaction().add(finishIx({ caller: publicKey, escrow: current.address, destination: current.destination }));
    tx.feePayer = publicKey; tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const { signature } = await ph.signAndSendTransaction(tx);
    log(`release sent ${txLink(signature)}`);
    const c = await connection.confirmTransaction(signature, "confirmed");
    if (c.value.err) { const t = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 }); log(`release refused: ${errorCode(t?.meta?.logMessages).join(" — ") || JSON.stringify(c.value.err)}`, "ko"); }
    else { log(`released: ${current.sol.toFixed(6)} SOL to ${addrLink(current.destination)}`, "ok"); save({ releaseTx: signature }); }
  } catch (e) { log(`release: ${e.message}`, "ko"); }
  await readEscrow();
};

/** The owner is the intermediary: closing the finished escrow is a steps-only execution the payer's wallet authorises. */
const closeRecipe = {
  id: "dareskro-close", intent: "dareskro_close", title: "dareskro: close a finished escrow, rent back",
  flow: "steps-only", type: "solana", destination: { chain: "sol", assetId: SOL },
  buildSteps: async ({ intermediary: im }, p) => prepareSolanaSteps([closeIx({ owner: im, escrow: p.escrow })], { intermediary: im }),
};
$("btn-close").onclick = async () => {
  try {
    const rent = rentNow();
    const pv = await runner.previewSteps({ recipe: closeRecipe, params: { escrow: current.address }, amount: String(rent), maxNetworkFee: String(Math.floor(rent / 2)) });
    log(`close: Connect's fee ${pv.networkFee ? sol(pv.networkFee) : "not estimated"}, rent back ${sol(rent)}`);
    const ex = await runner.runSteps(pv.plan);
    log(`close ${ex.status}${ex.transaction?.solanaTxHash ? ` · ${txLink(ex.transaction.solanaTxHash)}` : ""}`, /SUCCESS/.test(ex.status) ? "ok" : "ko");
    save({ closeTx: ex.transaction?.solanaTxHash });
  } catch (e) { log(`close: ${e.message}`, "ko"); }
  await readEscrow();
};

// ---------------------------------------------------------------- after a reload
const s = saved();
if (s.escrow) { $("escrow-addr").value = s.escrow; readEscrow(); log(`last payment from this browser: escrow ${addrLink(s.escrow)}${s.executionId ? `, execution ${s.executionId}` : ""}${s.status ? ` (${s.status})` : ""}`); }
setInterval(refreshButtons, 5000);
