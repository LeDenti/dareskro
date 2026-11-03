#!/usr/bin/env node
/**
 * The pay desk's Solana rail — a local service the React desk (app/) talks to,
 * the way it talks to the XRPL oracle. It holds the EMPLOYER's devnet key and
 * does, on the employer's click, what the XRPL desk does on the Ledger:
 *
 *   POST /lock        lock the validated statement's net pay in an escrow
 *                     (payroll: finish_after; delivery: condition from the oracle + cancel_after),
 *                     memos = statement sha256 · fiat line · oracle address, then tell the oracle
 *   POST /attempt     send a forbidden action WITHOUT preflight so the refusal is on chain
 *                     (early finish by a passer-by, cancel by the employer, finish to the wrong account)
 *   GET  /escrows     the employer's escrows, read from the chain (the chain is the registry),
 *                     merged with what the oracle says about them
 *   GET  /identity    employer, cluster, program, balances, the oracle if it answers, SOL/USD rate
 *   POST /fund/quote  Aurora Intents: what the employer pays, in the asset they hold on any chain,
 *                     to get exactly the escrow's USDC on Solana (dry by default; the real run of
 *                     1 Nov 2026 is served at GET /fund/proof)
 *   GET  /fund/status?depositAddress=…
 *   GET  /fund/tokens the origin assets Aurora accepts (a short list, with prices)
 *
 * The employer's key: SOLANA_KEYPAIR or ~/.config/solana/id.json. The employee's
 * demo wallet: cles/employee.<cluster>.json, generated on first start, the default
 * destination (the desk accepts any other address). Nothing here is a hardware
 * wallet: on Solana the employer signs with a key on the desk machine. Said in the README.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SystemProgram } from "@solana/web3.js";
import { connect, loadKeypair, Keypair, PublicKey, Transaction, createEscrow, listEscrows, getEscrow, chainNow, sendRecorded, explorerTx, explorerAccount, PROGRAM_ID, LAMPORTS, getFeeConfig, feeFor } from "../client/dareskro_solana.mjs";
import { tokens as auroraTokens, quoteExactUsdcOut, status as auroraStatus, USDC_SOL } from "../client/aurora_intents.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLUSTER = process.env.SOLANA_CLUSTER || "devnet";
const PORT = Number(process.env.DESK_SOLANA_PORT || 8790);
const ORACLE_URL = process.env.ORACLE_SOLANA_URL || "http://127.0.0.1:8791";
const EMPLOYEE_KEY = join(HERE, "cles", `employee.${CLUSTER}.json`);
const LOCKS = join(HERE, "sortie", "locks.json");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);

const ctx = await connect({ cluster: CLUSTER, keypair: process.env.SOLANA_KEYPAIR ? loadKeypair(process.env.SOLANA_KEYPAIR) : undefined });
const { program, connection, provider, payer: employer } = ctx;
let employee;
if (existsSync(EMPLOYEE_KEY)) employee = Keypair.fromSecretKey(Uint8Array.from(readJson(EMPLOYEE_KEY)));
else { employee = Keypair.generate(); writeFileSync(EMPLOYEE_KEY, JSON.stringify(Array.from(employee.secretKey))); chmodSync(EMPLOYEE_KEY, 0o600); log("employee demo wallet created:", employee.publicKey.toBase58()); }

const oracle = async () => { try { const r = await fetch(`${ORACLE_URL}/identity`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; } };
const oracleRegistry = async () => { try { const r = await fetch(`${ORACLE_URL}/escrows`, { signal: AbortSignal.timeout(1500) }); return r.ok ? (await r.json()).escrows : []; } catch { return []; } };
const balance = async (pk) => (await connection.getBalance(pk).catch(() => null));

/** SOL/USD: Aurora's own token list carries prices (the same source as the funding leg); CoinGecko as fallback. */
let rateCache;
async function rate() {
  if (rateCache && Date.now() - rateCache.t < 60_000) return rateCache.v;
  let v;
  try { const sol = (await auroraTokens("sol")).find((t) => t.symbol === "SOL"); v = { usdPerSol: sol.price, source: "Aurora Intents /api/tokens", at: new Date().toISOString() }; }
  catch { const j = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd")).json(); v = { usdPerSol: j.solana.usd, source: "CoinGecko", at: new Date().toISOString() }; }
  rateCache = { t: Date.now(), v };
  return v;
}

const memoLen = (s) => (s.length > 128 ? s.slice(0, 125) + "…" : s);

/**
 * The service's schedule, one table for the three rails (tarif.json, public):
 *   solana  — read from the program's FeeConfig account, never from this file (the program is the truth);
 *   aurora  — basis points asked of Aurora Intents on a bridged payment (appFees). MEASURED 03/11/2026: Aurora's
 *             API ignores what the client sends and applies its own 10 bps to its own recipient, whatever we ask
 *             (0, 10 or 100 bps, or nothing): a dareskro cut on the bridge would need the 1Click API directly;
 *   xrpl    — drops the XRPL oracle asks per conditioned escrow before it signs the release (oracle/tarif.json).
 * The schedule an employer sees is one line whatever the rail; `capBps` bounds the sum when two rails stack.
 */
const TARIF = join(HERE, "tarif.json");
const tarif = () => readJson(TARIF, { auroraBps: 10, auroraRecipient: "dareskro.near", capBps: 100 });
/** What the program will charge on top of `lamports` right now (0 before config_init or at a zero schedule). */
async function feeNow(lamports) {
  const cfg = await getFeeConfig(program).catch(() => null);
  const f = feeFor(cfg, lamports);
  return { lamports: f, sol: f / LAMPORTS, schedule: cfg };
}
const errCode = (err) => err?.error?.errorCode?.code ?? (String(err?.message ?? err).match(/Error Code: (\w+)/) || [])[1] ?? null;

// ------------------------------------------------------------------ HTTP
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
  res.end(JSON.stringify(body, null, 2));
};
const withBody = (req, res, handler) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => { try { await handler(JSON.parse(body || "{}")); } catch (err) { log("400:", err.message); json(res, 400, { error: String(err.message ?? err), code: errCode(err) }); } });
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") return json(res, 204, {});

  if (req.method === "GET" && url.pathname === "/identity") {
    const [b, eb, o, r] = await Promise.all([balance(employer.publicKey), balance(employee.publicKey), oracle(), rate().catch(() => null)]);
    const fee = await getFeeConfig(program).catch(() => null);
    return json(res, 200, { cluster: CLUSTER, programId: PROGRAM_ID.toBase58(), programExplorer: explorerAccount(PROGRAM_ID.toBase58(), CLUSTER),
      employer: { address: employer.publicKey.toBase58(), balanceSol: b == null ? null : b / LAMPORTS, explorer: explorerAccount(employer.publicKey.toBase58(), CLUSTER) },
      employee: { address: employee.publicKey.toBase58(), balanceSol: eb == null ? null : eb / LAMPORTS, explorer: explorerAccount(employee.publicKey.toBase58(), CLUSTER) },
      oracle: o, rate: r,
      fee: fee ? { ...fee, explorer: explorerAccount(fee.address, CLUSTER) } : null, tarif: tarif() });
  }

  if (req.method === "GET" && url.pathname === "/escrows") {
    const [mine, reg] = await Promise.all([listEscrows(program, { owner: employer.publicKey.toBase58() }), oracleRegistry()]);
    const byAddr = new Map(reg.map((e) => [e.escrow, e]));
    const locks = readJson(LOCKS, []);
    const lockBy = new Map(locks.map((l) => [l.escrow, l]));
    return json(res, 200, { escrows: mine.map((e) => ({ ...e, explorer: explorerAccount(e.address, CLUSTER), oracle: byAddr.get(e.address) ?? null, lock: lockBy.get(e.address) ?? null })) });
  }

  if (req.method === "POST" && url.pathname === "/lock") {
    return withBody(req, res, async (p) => {
      // p: { statementSha256, statementId, fiat: { amount, currency }, destination?, finishAfterS?, kind?, proof?, scale?, validatedBy? }
      if (!/^[0-9a-f]{64}$/i.test(p.statementSha256 ?? "")) throw new Error("statementSha256 must be 64 hex chars");
      const kind = p.kind ?? "payroll";
      const destination = new PublicKey(p.destination ?? employee.publicKey.toBase58());
      const r = await rate();
      const scale = Number(p.scale ?? 1);
      const amountUsd = Number(p.fiat?.amount);
      if (!(amountUsd > 0)) throw new Error("fiat.amount must be > 0");
      const lamports = Math.round((amountUsd / r.usdPerSol / scale) * LAMPORTS);
      const have = await balance(employer.publicKey);
      const fee = await feeNow(lamports);
      if (have != null && have < lamports + fee.lamports + 0.01 * LAMPORTS) throw new Error(`employer has ${(have / LAMPORTS).toFixed(3)} SOL, the escrow needs ${(lamports / LAMPORTS).toFixed(3)} SOL + ${fee.sol.toFixed(4)} SOL of fee: lower the scale`);
      const o = await oracle();
      const memos = [
        memoLen(`sha256:${p.statementSha256.toLowerCase()}`),
        memoLen(`${amountUsd.toFixed(2)} ${p.fiat?.currency ?? "USD"} @ ${r.usdPerSol} USD/SOL${scale !== 1 ? ` scale 1/${scale}` : ""}${p.statementId ? ` ${p.statementId}` : ""}`),
      ];
      if (o) memos.push(memoLen(`dareskro/oracle:${o.address}`));
      const now = await chainNow(connection);
      let condition, cancelAfter, finishAfter, deliveryId, proof;
      if (kind === "payroll") {
        finishAfter = now + Math.max(5, Number(p.finishAfterS ?? 90));
      } else if (kind === "delivery") {
        if (!o) throw new Error("the oracle is not running: a delivery escrow needs its condition");
        const c = await fetch(`${ORACLE_URL}/condition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, url: p.proof?.url, sha256: p.proof?.sha256 }) });
        const cj = await c.json();
        if (!c.ok) throw new Error(`oracle /condition: ${cj.error}`);
        ({ deliveryId, condition, proof } = cj);
        cancelAfter = now + Math.max(60, Number(p.cancelAfterS ?? 3600));
      } else throw new Error(`unknown kind ${kind}`);
      const created = await createEscrow(program, { owner: employer, destination, lamports, finishAfter, cancelAfter, condition, memos });
      const record = { ...created, kind, cluster: CLUSTER, lamports, sol: lamports / LAMPORTS, fiat: { amount: amountUsd, currency: p.fiat?.currency ?? "USD" }, rate: r, scale,
        fee: { lamports: fee.lamports, sol: fee.sol, usd: fee.sol * r.usdPerSol * scale, bps: fee.schedule?.feeBps ?? 0, floorSol: fee.schedule?.feeMinSol ?? 0, paidBy: "employer, on top of the amount locked" },
        statementSha256: p.statementSha256.toLowerCase(), statementId: p.statementId ?? null, validatedBy: p.validatedBy ?? null, destination: destination.toBase58(),
        finishAfter: finishAfter ?? null, cancelAfter: cancelAfter ?? null, condition: condition ?? null, deliveryId: deliveryId ?? null, proof: proof ?? null, memos,
        explorer: explorerTx(created.signature, CLUSTER), escrowExplorer: explorerAccount(created.escrow, CLUSTER), lockedAt: new Date().toISOString(), oracle: o?.address ?? null, watched: false };
      if (o) {
        try {
          const w = await fetch(`${ORACLE_URL}/watch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ escrow: created.escrow, kind, deliveryId, createSignature: created.signature, statementSha256: record.statementSha256, fiat: record.fiat }) });
          record.watched = w.ok; if (!w.ok) record.watchError = (await w.json()).error;
        } catch (e) { record.watchError = e.message; }
      }
      const locks = readJson(LOCKS, []); locks.push(record); writeFileSync(LOCKS, JSON.stringify(locks, null, 2));
      log(`locked ${record.sol} SOL (${amountUsd} ${record.fiat.currency}${scale !== 1 ? ` /${scale}` : ""}) for ${record.destination}, fee ${fee.sol} SOL on top — ${record.explorer}`);
      json(res, 201, record);
    });
  }

  if (req.method === "POST" && url.pathname === "/attempt") {
    return withBody(req, res, async (p) => {
      // p: { escrow, what: "early-finish" | "cancel" | "wrong-destination" | "finish" }
      const esc = new PublicKey(p.escrow);
      const on = await getEscrow(program, esc);
      if (!on) throw new Error("no such escrow");
      let out, who, expected;
      if (p.what === "cancel") {
        who = "the employer"; expected = on.cancelAfter == null ? "NotCancellable" : "CancelTooEarly";
        out = await sendRecorded(provider, program.methods.cancel().accountsPartial({ caller: employer.publicKey, escrow: esc, ownerAccount: new PublicKey(on.owner) }), [employer]);
      } else {
        // a passer-by: a fresh key the employer funds with the fee (0.003 SOL), so the refusal is signed by a stranger
        const passerby = Keypair.generate();
        const fund = await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: employer.publicKey, toPubkey: passerby.publicKey, lamports: 3_000_000 })), [employer]);
        const dest = p.what === "wrong-destination" ? passerby.publicKey : new PublicKey(on.destination);
        who = "a passer-by"; expected = p.what === "wrong-destination" ? "WrongDestination" : p.what === "early-finish" ? "TooEarly" : "(release)";
        out = await sendRecorded(provider, program.methods.finish(null).accountsPartial({ caller: passerby.publicKey, escrow: esc, destination: dest }), [passerby]);
        out.fundSignature = fund;
      }
      const result = { what: p.what, who, expected, got: out.code ?? (out.err ? "error" : "ok"), message: out.message, signature: out.signature, explorer: explorerTx(out.signature, CLUSTER), refused: !!out.err, at: new Date().toISOString() };
      log(`attempt ${p.what} by ${who}: ${result.got} — ${result.explorer}`);
      json(res, 200, result);
    });
  }

  if (req.method === "GET" && url.pathname === "/fund/tokens") {
    const all = await auroraTokens();
    const want = [["xrp", "XRP"], ["eth", "ETH"], ["eth", "USDC"], ["base", "USDC"], ["arb", "USDC"], ["btc", "BTC"], ["near", "NEAR"], ["tron", "USDT"], ["sol", "SOL"]];
    const list = want.map(([chain, sym]) => all.find((t) => t.blockchain === chain && t.symbol === sym)).filter(Boolean)
      .map((t) => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals, price: t.price }));
    return json(res, 200, { tokens: list, destinationAsset: USDC_SOL, count: all.length });
  }
  if (req.method === "POST" && url.pathname === "/fund/quote") {
    return withBody(req, res, async (p) => {
      // p: { originAsset, usdc, refundTo, dry? } — recipient is always the employer's own Solana address
      const usdcOut = Math.round(Number(p.usdc) * 1e6);
      const t = tarif();
      const q = await quoteExactUsdcOut({ originAsset: p.originAsset, usdcOut, recipient: employer.publicKey.toBase58(), refundTo: p.refundTo, dry: p.dry !== false, appFeeBps: t.auroraBps, appFeeRecipient: t.auroraRecipient });
      json(res, 200, { dry: p.dry !== false, amountIn: q.quote.amountInFormatted, amountInUsd: q.quote.amountInUsd, amountOut: q.quote.amountOutFormatted, timeEstimate: q.quote.timeEstimate,
        deadline: q.quoteRequest.deadline, depositAddress: q.quote.depositAddress ?? null, depositMemo: q.quote.depositMemo ?? null, withdrawFee: q.quote.withdrawFee, minAmountIn: q.quote.minAmountIn,
        // what we asked Aurora for, and what Aurora actually applied (its own 10 bps, measured 03/11/2026)
        appFeeAsked: { recipient: t.auroraRecipient, bps: t.auroraBps }, appFeeApplied: q.quoteRequest.appFees ?? null });
    });
  }
  if (req.method === "GET" && url.pathname === "/fund/status") {
    try { return json(res, 200, await auroraStatus(url.searchParams.get("depositAddress"), url.searchParams.get("memo") || undefined)); }
    catch (e) { return json(res, e.status ?? 500, { error: e.message }); }
  }
  if (req.method === "GET" && url.pathname === "/fund/proof") {
    const dir = join(HERE, "..", "client", "sortie");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("aurora_xrp_")).sort() : [];
    for (const f of files.reverse()) {
      const d = readJson(join(dir, f));
      if (d.watch?.final?.status === "SUCCESS") {
        const s = d.watch.final.swapDetails;
        return json(res, 200, { at: d.askedAt, payer: d.payer, recipient: d.recipient, amountIn: d.quoteResponse.quote.amountInFormatted + " XRP", amountOut: s.amountOutFormatted + " USDC", seconds: Math.round((Date.parse(d.watch.final.updatedAt) - Date.parse(d.askedAt)) / 1000),
          xrpl: d.xrplPayment, solanaTx: s.destinationChainTxHashes?.[0]?.hash, solanaExplorer: `https://solscan.io/tx/${s.destinationChainTxHashes?.[0]?.hash}`, usdcBefore: d.usdcBefore, usdcAfter: d.watch.usdcAfter });
      }
    }
    return json(res, 404, { error: "no successful run recorded yet" });
  }
  json(res, 404, { error: "not found" });
}).listen(PORT, "127.0.0.1", () => log(`desk (employer ${employer.publicKey.toBase58()}, ${CLUSTER}) listening on http://127.0.0.1:${PORT}`));
