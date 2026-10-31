#!/usr/bin/env node
/**
 * One placement campaign, live on testnet, end to end — the measurement.
 *
 *   BottomRadar (a faucet account standing in for the advertiser) creates a
 *   campaign on the placement service, locks the amount in an escrow whose
 *   condition the oracle issued, hands it over, and this script follows the
 *   oracle until it releases (post live at the date) or refunds (post gone).
 *
 *   node demo_bottomradar.mjs --url <public URL> --must "bottomradar.com" \
 *        [--period 600] [--grace 600] [--amount 25] [--creator r…] [--label live]
 *
 *   --period   seconds until the date the publication is checked (30 days in real life)
 *   --grace    seconds after the date before the advertiser is refunded
 *   --creator  the creator's XRPL address; a faucet account is made when absent
 *
 * The publication itself is NOT made by this script: it reads whatever is at
 * --url, like the oracle. Publish before, delete during, and watch what happens.
 * Needs: the oracle (node oracle/oracle.mjs watch) and the service (node server.mjs).
 * Writes measurements/<time>-<label>.json with every hash.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, xrpToDrops } from "xrpl";
import { explorerTx, fromRippleTime } from "./campaign.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]] : null)).filter(Boolean));
const URL_ = args.url;
const MUST = args.must ?? "bottomradar.com";
const PERIOD_S = Number(args.period ?? 600);
const GRACE_S = Number(args.grace ?? 600);
const AMOUNT = String(args.amount ?? 25);
const LABEL = args.label ?? "run";
const PROBE_S = Number(args.probe ?? 60);
const SERVICE = process.env.PLACEMENTS_URL || "http://127.0.0.1:8789";
const WSS = process.env.XRPL_WSS || "wss://testnet.xrpl-labs.com";
if (!URL_) {
  console.error("usage: node demo_bottomradar.mjs --url <public URL> [--must text] [--period s] [--grace s] [--amount xrp] [--creator r…] [--label name]");
  process.exit(2);
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), `[${LABEL}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

async function api(method, p, body) {
  const r = await fetch(SERVICE + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} — ${j.error ?? "?"}`);
  return j;
}

let c;
async function onLedger(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      if (!c.isConnected()) await c.connect();
      return await fn();
    } catch (err) {
      if (i >= tries - 1) throw err;
      log(`ledger hiccup (${String(err?.message ?? err).split("\n")[0].slice(0, 80)}), retrying in 5 s…`);
      try { await c.disconnect(); } catch { /* closed */ }
      await sleep(5000);
    }
  }
}

const out = { label: LABEL, url: URL_, mustContain: MUST, periodS: PERIOD_S, graceS: GRACE_S, startedAt: new Date().toISOString(), node: WSS };
try {
  c = new Client(WSS);
  await c.connect();
  log(`funding the advertiser (BottomRadar stand-in)${args.creator ? "" : " and a creator"} on testnet…`);
  const { wallet: brand } = await onLedger(() => c.fundWallet());
  let creatorAddress = args.creator;
  if (!creatorAddress) creatorAddress = (await onLedger(() => c.fundWallet())).wallet.classicAddress;
  out.advertiser = brand.classicAddress;
  out.creator = creatorAddress;
  log(`advertiser ${brand.classicAddress} — creator ${creatorAddress}`);
  const creatorBefore = await onLedger(() => c.getXrpBalance(creatorAddress));

  // 1. the campaign: the service validates, asks the oracle for the condition, computes the memos
  const camp = await api("POST", "/campaigns", {
    advertiser: { name: "BottomRadar", address: brand.classicAddress },
    creator: { address: creatorAddress, handle: args.handle ?? null },
    url: URL_, mustContain: MUST, amountXrp: AMOUNT,
    periodEnd: `${PERIOD_S}s`, deadline: `${PERIOD_S + GRACE_S}s`,
    publicUrl: true, probeEveryS: PROBE_S, note: `measurement ${LABEL}`,
  });
  out.campaignId = camp.id;
  out.contractSha256 = camp.contractSha256;
  out.deliveryId = camp.deliveryId;
  out.condition = camp.condition;
  out.creatorPage = camp.links.creator;
  log(`campaign ${camp.id}: contract sha256 ${camp.contractSha256.slice(0, 16)}…, condition ${camp.condition.slice(0, 16)}… — creator page ${camp.links.creator}`);

  // 2. a look before locking: is the publication there now?
  const pre = await api("POST", `/campaigns/${camp.id}/observe`);
  out.preCheck = { at: pre.at, ok: pre.ok, why: pre.why, method: pre.method, status: pre.status, bodySha256: pre.bodySha256 };
  log(`before locking: ${pre.ok ? "OK" : "NO"} — ${pre.why}`);

  // 3. lock: EscrowCreate with the condition, FinishAfter = the date, CancelAfter = the deadline, the memos the service computed
  const tx = {
    TransactionType: "EscrowCreate",
    Account: brand.classicAddress,
    Destination: creatorAddress,
    Amount: xrpToDrops(AMOUNT),
    Condition: camp.condition,
    FinishAfter: camp.finishAfter,
    CancelAfter: camp.cancelAfter,
    Memos: camp.memos.map((m) => ({ Memo: { MemoType: hex(m.type), MemoData: hex(m.data), MemoFormat: hex("text/plain") } })),
  };
  const r = await onLedger(() => c.submitAndWait(tx, { wallet: brand, autofill: true }));
  const code = r.result.meta.TransactionResult;
  const seq = r.result.tx_json?.Sequence ?? r.result.Sequence;
  out.lock = { hash: r.result.hash, result: code, sequence: seq, finishAfter: fromRippleTime(camp.finishAfter).toISOString(), cancelAfter: fromRippleTime(camp.cancelAfter).toISOString(), memos: camp.memos };
  if (code !== "tesSUCCESS") throw new Error(`EscrowCreate ${code}: nothing locked`);
  log(`EscrowCreate ${code} #${seq}: ${AMOUNT} XRP locked, checked at ${out.lock.finishAfter}, refund after ${out.lock.cancelAfter} — ${explorerTx(r.result.hash)}`);

  // 4. hand it to the oracle through the service
  const w = await api("POST", `/campaigns/${camp.id}/locked`, { owner: brand.classicAddress, sequence: seq, createHash: r.result.hash });
  log(`oracle watching (${w.note ?? "registered"}), looks every ${PROBE_S} s until the date`);

  // 5. follow what the oracle sees until it decides
  let last = "";
  let v;
  const until = Date.now() + (PERIOD_S + GRACE_S + 180) * 1000;
  do {
    await sleep(5000);
    v = await api("GET", `/campaigns/${camp.id}`);
    const o = v.oracle;
    const seen = o?.lastSeen ? `${o.lastSeen.live ? "LIVE+TEXT" : o.lastSeen.online ? "ONLINE, NO TEXT" : "OFFLINE"} (${o.lastSeen.why})` : "no look yet";
    const line = `${v.status} — ${seen}`;
    if (line !== last) { log(`oracle sees: ${line}`); last = line; }
  } while (v.oracle?.status === "waiting" && Date.now() < until);
  out.endedAt = new Date().toISOString();
  out.status = v.status;
  out.oracle = { status: v.oracle?.status, finishHash: v.oracle?.finishHash ?? null, refundHash: v.oracle?.refundHash ?? null, lastResult: v.oracle?.lastResult, lastWhy: v.oracle?.lastWhy, looks: v.oracle?.looks, lastSeen: v.oracle?.lastSeen };
  out.observations = (v.observations ?? []).map((o) => ({ at: o.at, phase: o.phase, ok: o.ok, live: o.live, textFound: o.textFound, method: o.method, status: o.status, finalUrl: o.finalUrl, why: o.why, bodySha256: o.bodySha256 }));
  const creatorAfter = await onLedger(() => c.getXrpBalance(creatorAddress));
  const brandAfter = await onLedger(() => c.getXrpBalance(brand.classicAddress));
  out.balances = { creator: [creatorBefore, creatorAfter], advertiserAfter: brandAfter };
  if (v.status === "released") log(`RELEASED — ${v.oracle.lastWhy} — ${explorerTx(v.oracle.finishHash)} — creator ${creatorBefore} → ${creatorAfter} XRP`);
  else if (v.status === "refunded") log(`REFUNDED — ${v.oracle.lastWhy ?? "post not live at the date"} — ${explorerTx(v.oracle.refundHash)} — advertiser now ${brandAfter} XRP`);
  else log(`ended ${v.status}: ${v.oracle?.lastWhy ?? v.oracle?.note ?? "?"}`);
  log(`${out.observations.length} observation(s) kept by the oracle (GET ${SERVICE}/campaigns/${camp.id})`);
} catch (err) {
  out.error = String(err?.message ?? err).split("\n")[0];
  log(`FAILED: ${out.error}`);
} finally {
  try { if (c?.isConnected()) await c.disconnect(); } catch { /* closed */ }
  mkdirSync(path.join(HERE, "measurements"), { recursive: true });
  const f = path.join(HERE, "measurements", `${out.startedAt.replace(/[:.]/g, "-").slice(0, 19)}-${LABEL}.json`);
  writeFileSync(f, JSON.stringify(out, null, 2));
  log(`written ${path.relative(process.cwd(), f)}`);
  process.exit(out.error ? 1 : 0);
}
