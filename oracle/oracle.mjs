#!/usr/bin/env node
/**
 * dareskro oracle — the named third party that executes what the ledger
 * already decided.
 *
 * WHAT IT IS. An XRPL account with a name, a birth certificate on-chain and a
 * job: watch the escrows it is cited in, and submit EscrowFinish when the
 * ledger allows it. It pays the fee of that transaction. That is all it ever
 * pays.
 *
 * WHAT IT CANNOT DO, by construction, not by promise:
 *   - it never holds the funds: an escrow's money sits in the ledger, between
 *     the employer's account and the employee's, and goes to the Destination
 *     written at creation, whoever submits the finish;
 *   - it cannot pay early: EscrowFinish before FinishAfter is refused by the
 *     ledger (tecNO_PERMISSION, measured);
 *   - it cannot redirect: there is no field in EscrowFinish for a destination;
 *   - it cannot cancel: the payroll escrow has no CancelAfter, so nobody can.
 *   For a payroll escrow (FinishAfter only), the oracle's whole power is
 *   *punctuality*. If it dies, anyone else can finish the escrow — the
 *   employee included — and the money still goes where it was written.
 *
 * WHERE IT GETS POWER: the conditional shapes below. There the oracle holds the
 * preimage of a PREIMAGE-SHA-256 condition and reveals it when the agreed fact
 * is proven. There, the oracle decides *whether*; on payroll it only decides
 * *when*, and even that is bounded below by the ledger.
 *
 * HOW IT IS CITED. The pay desk writes the oracle's address in a memo of the
 * EscrowCreate ("dareskro/oracle"), so the employer reads it on the Ledger
 * device before signing, and anyone can read it on the explorer afterwards.
 * The oracle's own account carries a birth certificate: an AccountSet with a
 * memo saying what it is.
 *
 * USAGE
 *   node oracle.mjs create     fund a testnet account, publish the birth memo
 *   node oracle.mjs watch      serve http://127.0.0.1:8787 and finish escrows
 *   node oracle.mjs status     identity and the registry
 *
 * HTTP (for the pay desk and the demos)
 *   GET  /identity             address, network, birth tx
 *   GET  /escrows              what it watches, with states
 *   POST /condition            { kind, url?, sha256?, mustContain?, orderRef?, note? }
 *                                → { deliveryId, condition, proof, confirmToken? }
 *                              delivery: url + sha256 (64 hex) · presence: url, mustContain?
 *                              affiliate: orderRef?; confirmToken is given ONCE and only its
 *                              sha256 is kept. /delivery/condition is the old alias.
 *   POST /watch                payroll: { owner, sequence, finishAfter, destination,
 *                                amountXrp, statementSha256, createHash }
 *                              delivery: { kind: "delivery", deliveryId, owner, sequence,
 *                                cancelAfter, destination, amountXrp, proof: { url, sha256 } }
 *                              presence: { kind: "presence", deliveryId, owner, sequence,
 *                                checkAfter, finishAfter?, cancelAfter, destination, amountXrp,
 *                                proof: { url, mustContain? } }
 *                              affiliate: { kind: "affiliate", deliveryId, owner, sequence,
 *                                cancelAfter, destination, amountXrp, proof: { orderRef? } }
 *   POST /affiliate/confirm    { deliveryId, orderHash, token } — the merchant's system
 *                                says the sale happened; 403 on a bad token
 *   POST /payout/retry         { owner, sequence } — run the dollar leg again
 *
 * FOUR SHAPES, ONE ACCOUNT.
 *   payroll   (FinishAfter only): the oracle decides *when*, and only after the
 *             ledger allows. It cannot pay early, redirect or cancel.
 *   delivery  (Condition + CancelAfter): it decides *whether*, by reading a public
 *             fact — the file at the agreed URL has the agreed SHA-256 — and
 *             reveals the secret.
 *   presence  (Condition + FinishAfter + CancelAfter): it decides *whether the
 *             post is still there* at the date — it reads the page at the agreed
 *             address, checks the agreed text is in it, and only then reveals the
 *             secret. Deleted post, no pay. Before the date it only watches.
 *   affiliate (Condition + CancelAfter): it decides nothing. The merchant's sales
 *             system — a party — confirms the sale with a token given once; the
 *             oracle only guarantees that the money was locked *before* the sale
 *             and that the release carries the order hash, in a memo anyone can
 *             read on the explorer.
 *   In the three conditional shapes, past CancelAfter it submits the refund; the
 *   payroll escrow has no CancelAfter. In none of them can it keep or redirect
 *   the money.
 *
 * FILES
 *   .oracle.json               seed (0600, never committed)
 *   .deliveries.json           secrets of conditional escrows and the hash of affiliate
 *                              tokens (0600, never committed)
 *   registry.json              what it watches (public)
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Wallet } from "xrpl";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDENTITY = path.join(HERE, ".oracle.json");
const REGISTRY = path.join(HERE, "registry.json");
/** The secrets of conditional escrows (delivery, presence, affiliate token hashes): 0600, never committed. */
const SECRETS = path.join(HERE, ".deliveries.json");
const TESTNET = "wss://s.altnet.rippletest.net:51233";
const PORT = Number(process.env.ORACLE_PORT || 8787);
const RIPPLE_EPOCH = 946684800;
const TICK_MS = 4000;
/** Ledger close times are coarse: wait this many seconds past FinishAfter before the first try. */
const CLOSE_TIME_MARGIN = 6;
const MAX_ATTEMPTS = 12;
/** Before its date a presence escrow is only observed: look at the page this often at most, not every tick. */
const PROBE_MS = 20000;

const toHex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const explorerTx = (h) => `https://testnet.xrpl.org/transactions/${h}`;
const explorerAccount = (a) => `https://testnet.xrpl.org/accounts/${a}`;
const now = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let client;
async function ledger() {
  if (!client) client = new Client(TESTNET);
  if (!client.isConnected()) await client.connect();
  return client;
}

const loadRegistry = () =>
  existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, "utf8")) : { escrows: [] };
const saveRegistry = (r) => writeFileSync(REGISTRY, JSON.stringify(r, null, 2));

const entryKey = (e) => `${e.owner}#${e.sequence}`;
/**
 * Write back the entries one pass of the loop touched. The HTTP side may have
 * written the file meanwhile (a new watch, a merchant's confirmation): merge
 * over a fresh copy, the loop's fields winning, instead of overwriting it all.
 */
function mergeRegistry(touched) {
  const fresh = loadRegistry();
  for (const e of touched) {
    const i = fresh.escrows.findIndex((x) => entryKey(x) === entryKey(e));
    if (i >= 0) fresh.escrows[i] = { ...fresh.escrows[i], ...e };
    else fresh.escrows.push(e);
  }
  saveRegistry(fresh);
}

function loadIdentity() {
  if (!existsSync(IDENTITY)) throw new Error("no oracle yet: run `node oracle.mjs create`");
  return JSON.parse(readFileSync(IDENTITY, "utf8"));
}

// ------------------------------------------- conditional escrows (three kinds)
//
// The escrow carries a PREIMAGE-SHA-256 condition. The oracle holds the preimage
// and reveals it when the agreed fact is proven. What the fact is depends on the
// kind, and so does how much the oracle decides:
//   delivery   a PUBLIC FACT the oracle reads by itself: the file at an agreed
//              URL has the agreed SHA-256. Publish the right file, get paid. No
//              click from the client, none from the freelancer.
//   presence   a public page is live at the date, with the agreed text in it.
//              Before the date the oracle only watches; at the date it decides.
//   affiliate  nothing the oracle can read: the merchant's sales system, a party,
//              confirms with a token given once. The oracle writes the order
//              hash in the finish, so the release is auditable by anyone.
// If the fact is not proven before CancelAfter, the oracle submits the cancel
// and the payer is refunded — it cannot keep the money either way.

const loadSecrets = () => (existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, "utf8")) : {});
function saveSecrets(s) {
  writeFileSync(SECRETS, JSON.stringify(s, null, 2));
  chmodSync(SECRETS, 0o600);
}

/** A PREIMAGE-SHA-256 crypto-condition, DER-encoded the way XRPL wants it. */
function conditionPair() {
  const preimage = randomBytes(32);
  const digest = createHash("sha256").update(preimage).digest();
  const n = preimage.length;
  const fulfillment = Buffer.concat([Buffer.from([0xa0, n + 2, 0x80, n]), preimage]);
  const body = Buffer.concat([Buffer.from([0x80, 0x20]), digest, Buffer.from([0x81, 0x01, n])]);
  const condition = Buffer.concat([Buffer.from([0xa0, body.length]), body]);
  return {
    condition: condition.toString("hex").toUpperCase(),
    fulfillment: fulfillment.toString("hex").toUpperCase(),
  };
}

/** Minimum fee of a conditional EscrowFinish: 330 drops + 10 per 16 bytes of fulfillment, plus a margin. */
const finishFee = (fulfillmentHex) => String(330 + 10 * Math.ceil(fulfillmentHex.length / 2 / 16) + 100);

const HEX64 = /^[0-9a-fA-F]{64}$/;
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
/** Compare two hex digests in constant time: the affiliate token is a password. */
const sameHex = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/** Read the agreed URL and compare its SHA-256 with the agreed one. */
async function checkProof(proof) {
  let res;
  try {
    res = await fetch(proof.url, { signal: AbortSignal.timeout(10000), cache: "no-store" });
  } catch (err) {
    return { ok: false, why: `unreachable: ${err.message}` };
  }
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  const expected = proof.sha256.toLowerCase();
  return sha === expected
    ? { ok: true, why: `match (${buf.length} bytes)` }
    : { ok: false, why: `published sha256 ${sha.slice(0, 10)}… ≠ agreed ${expected.slice(0, 10)}…` };
}

/** Read the agreed page: live means HTTP 200 and, when agreed, the text in the body. */
async function checkPresence(proof) {
  let res;
  try {
    res = await fetch(proof.url, { signal: AbortSignal.timeout(10000), cache: "no-store" });
  } catch (err) {
    return { ok: false, why: `unreachable: ${err.message}` };
  }
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
  const body = await res.text();
  if (proof.mustContain && !body.includes(proof.mustContain)) {
    return { ok: false, why: `live but without "${proof.mustContain}"` };
  }
  return {
    ok: true,
    why: proof.mustContain ? `live with "${proof.mustContain}" (${body.length} chars)` : `live (${body.length} chars)`,
  };
}

/**
 * Before its date a presence escrow is observed, not decided: look at the page
 * every PROBE_MS at most, remember what was seen, say it only when it changes.
 * Returns whether the entry changed.
 */
async function probePresence(e) {
  const t = Date.now();
  if (e.lastSeen && t - Date.parse(e.lastSeen.at) < PROBE_MS) return false;
  const seen = await checkPresence(e.proof);
  const was = e.lastSeen?.live;
  e.lastSeen = { at: new Date(t).toISOString(), live: seen.ok, why: seen.why };
  if (was !== seen.ok) {
    log(`presence #${e.sequence}: post ${seen.ok ? "live" : "not live"} — ${seen.why}; decision at ripple time ${e.checkAfter}`);
  }
  return true;
}

/**
 * Per kind: what the payer agrees to (agree), what /watch needs, and the verdict
 * that reveals the secret. A verdict is { ok, why }; `polls: false` says nothing
 * was fetched, so a repeated "not yet" is not a check worth saving.
 */
const KINDS = {
  delivery: {
    agree: (p) =>
      !p.url || !HEX64.test(p.sha256 ?? "")
        ? { error: "need url and sha256 (64 hex)" }
        : { proof: { url: p.url, sha256: p.sha256.toLowerCase() } },
    issued: (proof) => `for ${proof.url} (sha256 ${proof.sha256.slice(0, 10)}…)`,
    watchFields: ["owner", "sequence", "cancelAfter", "destination", "deliveryId", "proof"],
    watching: (e) =>
      `${e.amountXrp ?? "?"} XRP to ${e.destination} once ${e.proof.url} has sha256 ${e.proof.sha256.slice(0, 10)}…, refund after ripple time ${e.cancelAfter}`,
    verdict: (e) => checkProof(e.proof),
    expired: "deadline passed without a matching file",
  },
  presence: {
    agree: (p) =>
      !p.url
        ? { error: "need url" }
        : { proof: p.mustContain ? { url: p.url, mustContain: String(p.mustContain) } : { url: p.url } },
    issued: (proof) => `for ${proof.url}${proof.mustContain ? ` containing "${proof.mustContain}"` : ""}`,
    watchFields: ["owner", "sequence", "checkAfter", "cancelAfter", "destination", "deliveryId", "proof"],
    validate: (e) =>
      Number.isInteger(e.checkAfter) && Number.isInteger(e.cancelAfter)
        ? null
        : "checkAfter and cancelAfter must be ripple times (integers)",
    watching: (e) =>
      `${e.amountXrp ?? "?"} XRP to ${e.destination} if ${e.proof.url} is live at ripple time ${e.checkAfter}, refund after ${e.cancelAfter}`,
    probe: probePresence,
    verdict: async (e) => {
      const seen = await checkPresence(e.proof);
      e.lastSeen = { at: new Date().toISOString(), live: seen.ok, why: seen.why };
      return seen;
    },
    expired: "deadline passed with the post not live",
  },
  affiliate: {
    agree: (p) => ({ proof: p.orderRef ? { orderRef: String(p.orderRef) } : {} }),
    issued: (proof) => `${proof.orderRef ? `for order ${proof.orderRef}, ` : ""}token given once to the merchant`,
    watchFields: ["owner", "sequence", "cancelAfter", "destination", "deliveryId"],
    validate: (e) => (Number.isInteger(e.cancelAfter) ? null : "cancelAfter must be a ripple time (integer)"),
    watching: (e) =>
      `${e.amountXrp ?? "?"} XRP to ${e.destination} once the merchant confirms ${e.proof?.orderRef ? `order ${e.proof.orderRef}` : "the sale"}, refund after ripple time ${e.cancelAfter}`,
    polls: false,
    verdict: (e) =>
      e.confirmed
        ? { ok: true, why: `sale confirmed by the merchant, order sha256 ${e.confirmed.orderHash.slice(0, 10)}…` }
        : { ok: false, why: "waiting for the merchant's confirmation" },
    // the release carries the order hash: anyone can tie the payment to the sale record
    memos: (e) => [{ Memo: { MemoType: toHex("dareskro/order-sha256"), MemoData: toHex(e.confirmed.orderHash) } }],
    finished: (e) => {
      e.orderHash = e.confirmed.orderHash;
    },
    expired: "deadline passed without a confirmed sale",
  },
};
/** The kind's table for a registry entry, or undefined for payroll (no kind, or one we do not know). */
const kindOf = (e) => (Object.hasOwn(KINDS, e.kind ?? "") ? KINDS[e.kind] : undefined);

/** Still there? Someone else may have finished or cancelled it: then nothing to do. */
async function escrowGone(c, e) {
  try {
    await c.request({ command: "ledger_entry", escrow: { owner: e.owner, seq: e.sequence }, ledger_index: "validated" });
    return false;
  } catch (err) {
    if (err?.data?.error !== "entryNotFound") throw err;
    e.status = "gone";
    e.note = "already finished or cancelled by someone else";
    return true;
  }
}

/** One conditional escrow: wait for its date, ask the kind's verdict, reveal the secret, or refund after the deadline. */
async function tickConditional(e, wallet) {
  const kind = kindOf(e);
  const label = `${e.kind} #${e.sequence}`;
  const c = await ledger();
  if (now() > e.cancelAfter + CLOSE_TIME_MARGIN) {
    if (await escrowGone(c, e)) return true;
    log(`${label}: ${kind.expired}, submitting EscrowCancel (refund to ${e.owner})…`);
    const res = await c.submitAndWait(
      { TransactionType: "EscrowCancel", Account: wallet.classicAddress, Owner: e.owner, OfferSequence: e.sequence },
      { wallet, autofill: true },
    );
    const code = typeof res.result.meta === "object" ? res.result.meta.TransactionResult : "?";
    e.lastResult = code;
    e.lastHash = res.result.hash;
    e.lastTry = new Date().toISOString();
    if (code === "tesSUCCESS") {
      e.status = "expired-refunded";
      e.refundHash = res.result.hash;
      log(`${label}: refunded — ${explorerTx(res.result.hash)}`);
    } else {
      e.status = "failed";
      log(`${label}: cancel ${code}`);
    }
    return true;
  }
  // A presence escrow is decided at checkAfter, and the ledger refuses a finish
  // before FinishAfter anyway. Delivery and affiliate have no date: decide now.
  const date = Math.max(e.checkAfter ?? 0, e.finishAfter ?? 0);
  if (now() < date + CLOSE_TIME_MARGIN) return kind.probe ? kind.probe(e) : false;
  const check = await kind.verdict(e);
  if (kind.polls !== false) {
    e.lastCheck = new Date().toISOString();
    e.checks = (e.checks ?? 0) + 1;
  }
  if (!check.ok) {
    if (e.lastWhy === check.why) return kind.polls !== false;
    log(`${label}: not yet — ${check.why}`);
    e.lastWhy = check.why;
    return true;
  }
  const secret = loadSecrets()[e.deliveryId];
  if (!secret) {
    e.status = "failed";
    e.note = "no secret for this delivery id";
    return true;
  }
  log(`${label}: ${check.why} — revealing the secret, submitting EscrowFinish…`);
  const tx = {
    TransactionType: "EscrowFinish",
    Account: wallet.classicAddress,
    Owner: e.owner,
    OfferSequence: e.sequence,
    Condition: secret.condition,
    Fulfillment: secret.fulfillment,
    Fee: finishFee(secret.fulfillment),
  };
  if (kind.memos) tx.Memos = kind.memos(e);
  const res = await c.submitAndWait(tx, { wallet, autofill: true });
  const code = typeof res.result.meta === "object" ? res.result.meta.TransactionResult : "?";
  e.attempts = (e.attempts ?? 0) + 1;
  e.lastResult = code;
  e.lastHash = res.result.hash;
  e.lastTry = new Date().toISOString();
  e.lastWhy = check.why;
  if (code === "tesSUCCESS") {
    e.status = "finished";
    e.finishedAt = e.lastTry;
    e.finishHash = res.result.hash;
    kind.finished?.(e);
    log(`${label}: finished — ${e.amountXrp} XRP to ${e.destination} — ${explorerTx(res.result.hash)}`);
  } else if (code === "tecNO_PERMISSION") {
    // Only time explains this one: the ledger's close time is not past FinishAfter
    // yet, or already past CancelAfter (a file published in the last seconds before
    // the deadline). Stay waiting: the next ticks retry, and once our clock is past
    // the deadline too, the cancel branch above submits the refund it promised.
    // Give up only when the date keeps being refused far from the deadline.
    if (now() > e.cancelAfter - CLOSE_TIME_MARGIN) {
      log(`${label}: ${code} (ledger clock already at the deadline), refund on the next tick`);
    } else if (e.attempts < MAX_ATTEMPTS) {
      log(`${label}: ${code} (ledger clock not past the date yet), will retry`);
    } else {
      e.status = "failed";
      log(`${label}: finish ${code} after ${e.attempts} tries, giving up`);
    }
  } else {
    e.status = "failed";
    log(`${label}: finish ${code}, giving up`);
  }
  return true;
}

/** The name the README cites: the conditional handler, whatever the kind. */
const tickDelivery = tickConditional;

/** Public view of the identity: everything but the seed. */
function publicIdentity() {
  const { seed: _seed, ...pub } = loadIdentity();
  return { ...pub, explorer: explorerAccount(pub.address), birthExplorer: explorerTx(pub.birth) };
}

// ------------------------------------------------------------------ create

async function create() {
  if (existsSync(IDENTITY)) {
    const id = publicIdentity();
    log("oracle already exists:", id.address, "born in", id.birth);
    return;
  }
  const c = await ledger();
  log("asking the testnet faucet for an account (fees only)…");
  const { wallet } = await c.fundWallet();
  // Birth certificate: an AccountSet that changes nothing, with a memo anyone can read.
  const tx = await c.autofill({
    TransactionType: "AccountSet",
    Account: wallet.classicAddress,
    Memos: [
      {
        Memo: {
          MemoType: toHex("dareskro/oracle"),
          MemoData: toHex("dareskro payroll oracle v1 — finishes escrows at their date; pays the fee, never holds funds"),
          MemoFormat: toHex("text/plain"),
        },
      },
    ],
  });
  const res = await c.submitAndWait(wallet.sign(tx).tx_blob);
  const id = {
    name: "dareskro payroll oracle v1",
    address: wallet.classicAddress,
    publicKey: wallet.publicKey,
    seed: wallet.seed,
    network: "testnet",
    created: new Date().toISOString(),
    birth: res.result.hash,
    birthResult: typeof res.result.meta === "object" ? res.result.meta.TransactionResult : "?",
  };
  writeFileSync(IDENTITY, JSON.stringify(id, null, 2));
  chmodSync(IDENTITY, 0o600);
  log("oracle created:", id.address);
  log("birth certificate:", id.birthResult, explorerTx(id.birth));
  log("seed kept in", IDENTITY, "(0600). Never share it; never put it in a chat.");
}

// ------------------------------------------------------------------- watch

/**
 * The employee chose dollars: once the ledger has released the escrow (and only
 * then — payout.mjs re-checks the EscrowFinish on XRPL before paying), settle
 * RLUSD to the employee's payout wallet through Mastercard Agent Pay for
 * Machines. The oracle still holds no money: it drives the agent's channel,
 * inside the employer's budget.
 */
async function dollarPayout(e) {
  const { execFile } = await import("node:child_process");
  const script = path.join(HERE, "..", "ap4m", "payout.mjs");
  log(`escrow #${e.sequence}: employee paid in dollars — settling ${e.amount ?? e.amountXrp} ${e.currency ?? ""} through Mastercard AP4M…`);
  await new Promise((resolve) => {
    execFile("node", [script, "--escrow", e.finishHash, "--amount", String(e.amount ?? e.amountXrp), "--sequence", String(e.sequence)],
      { cwd: path.dirname(script), timeout: 240000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        // write on the entry the caller holds: tick() saves the registry right after
        try {
          if (err) throw err;
          const json = stdout.slice(stdout.indexOf("{\n"));
          e.payoutResult = JSON.parse(json);
          log(`escrow #${e.sequence}: ${e.payoutResult.amount_rlusd} RLUSD settled via AP4M — ${e.payoutResult.redemption_explorer}`);
        } catch (x) {
          // keep the script's own verdict (its last stderr line), then the last steps it logged
          const errLines = (stderr ?? "").trim().split("\n").filter(Boolean);
          const verdict = errLines.find((l) => /^(payout failed|XRPL says no|usage)/.test(l)) ?? errLines.find((l) => /^\w*Error/.test(l)) ?? errLines.at(-1) ?? `${x.message ?? x}`.split("\n")[0];
          const steps = (stdout ?? "").trim().split("\n").filter(Boolean).slice(-3).join(" | ");
          e.payoutResult = { error: verdict.slice(0, 300) + (steps ? ` — after: ${steps.slice(-300)}` : "") };
          log(`escrow #${e.sequence}: payout failed — ${e.payoutResult.error}`);
        }
        resolve();
      });
  });
}

/** One pass over the registry: finish what the ledger now allows. */
async function tick(wallet) {
  const reg = loadRegistry();
  const before = new Map(reg.escrows.map((e) => [entryKey(e), JSON.stringify(e)]));
  let changed = false;
  try {
    for (const e of reg.escrows) {
      if (e.status !== "waiting") continue;
      if (kindOf(e)) {
        if (await tickConditional(e, wallet)) changed = true;
        continue;
      }
      if (now() < e.finishAfter + CLOSE_TIME_MARGIN) continue;
      const c = await ledger();
      // Still there? (finished or cancelled by someone else → nothing to do)
      try {
        await c.request({
          command: "ledger_entry",
          escrow: { owner: e.owner, seq: e.sequence },
          ledger_index: "validated",
        });
      } catch (err) {
        if (err?.data?.error === "entryNotFound") {
          e.status = "gone";
          e.note = "already finished or cancelled by someone else";
          changed = true;
          log(`escrow #${e.sequence}: gone (someone else finished it) — the money went where it was written anyway`);
          continue;
        }
        throw err;
      }
      log(`escrow #${e.sequence}: date passed, submitting EscrowFinish…`);
      const res = await c.submitAndWait(
        { TransactionType: "EscrowFinish", Account: wallet.classicAddress, Owner: e.owner, OfferSequence: e.sequence },
        { wallet, autofill: true },
      );
      const code = typeof res.result.meta === "object" ? res.result.meta.TransactionResult : "?";
      e.attempts = (e.attempts ?? 0) + 1;
      e.lastResult = code;
      e.lastHash = res.result.hash;
      e.lastTry = new Date().toISOString();
      changed = true;
      if (code === "tesSUCCESS") {
        e.status = "finished";
        e.finishedAt = e.lastTry;
        e.finishHash = res.result.hash;
        log(`escrow #${e.sequence}: finished — ${e.amountXrp} XRP to ${e.destination} — ${explorerTx(res.result.hash)}`);
        if (e.payout === "usd") {
          saveRegistry(reg);
          await dollarPayout(e);
        }
      } else if (code === "tecNO_PERMISSION" && e.attempts < MAX_ATTEMPTS) {
        log(`escrow #${e.sequence}: ${code} (ledger clock not past the date yet), will retry`);
      } else {
        e.status = "failed";
        log(`escrow #${e.sequence}: ${code}, giving up — anyone else can still finish it`);
      }
    }
  } finally {
    // written even when one escrow threw: what this pass learned about the
    // others (a post seen, an attempt made) must not depend on the next entry's luck
    if (changed) mergeRegistry(reg.escrows.filter((e) => before.get(entryKey(e)) !== JSON.stringify(e)));
  }
}

function serve(identity) {
  const json = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end(JSON.stringify(body, null, 2));
  };
  /** Collect a JSON body, then run the handler; a bad body or a thrown error is a 400. */
  const withBody = (req, res, handler) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        handler(JSON.parse(body));
      } catch (err) {
        json(res, 400, { error: String(err) });
      }
    });
  };
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (req.method === "GET" && req.url === "/identity") {
      return json(res, 200, { ...identity, watching: loadRegistry().escrows.filter((e) => e.status === "waiting").length });
    }
    if (req.method === "GET" && req.url === "/escrows") return json(res, 200, loadRegistry());
    if (req.method === "POST" && req.url === "/payout/retry") {
      // the dollar leg again, for an escrow the ledger already released (budget topped up, merchant back…)
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        try {
          const q = JSON.parse(body);
          const reg = loadRegistry();
          const e = reg.escrows.find((x) => x.owner === q.owner && x.sequence === q.sequence);
          if (!e) return json(res, 404, { error: "unknown escrow" });
          if (e.status !== "finished" || !e.finishHash) return json(res, 409, { error: `escrow is ${e.status}: the ledger must release first` });
          e.payout = "usd";
          delete e.payoutResult;
          saveRegistry(reg);
          json(res, 202, { ok: true, note: "payout running; poll /escrows" });
          await dollarPayout(e);
          const fresh = loadRegistry();
          const f = fresh.escrows.find((x) => x.owner === e.owner && x.sequence === e.sequence);
          if (f) f.payoutResult = e.payoutResult;
          saveRegistry(fresh);
        } catch (err) {
          json(res, 400, { error: String(err) });
        }
      });
      return;
    }
    if (req.method === "POST" && (req.url === "/condition" || req.url === "/delivery/condition")) {
      // The payer asks for a condition before locking. The oracle keeps the secret;
      // the payer gets the condition and the agreed proof, to write in the memos.
      return withBody(req, res, (p) => {
        const kind = p.kind ?? "delivery";
        const spec = Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
        if (!spec) return json(res, 400, { error: `unknown kind ${kind}: delivery, presence or affiliate` });
        const agreed = spec.agree(p);
        if (agreed.error) return json(res, 400, { error: agreed.error });
        const pair = conditionPair();
        const deliveryId = randomBytes(6).toString("hex");
        const record = { ...pair, kind, proof: agreed.proof, note: p.note ?? "", created: new Date().toISOString() };
        const reply = { deliveryId, condition: pair.condition, proof: agreed.proof };
        if (kind === "affiliate") {
          // the merchant gets the token once; only its hash stays here, so whoever
          // reads this file still cannot confirm a sale
          reply.confirmToken = randomBytes(32).toString("hex");
          record.tokenHash = sha256hex(reply.confirmToken);
        }
        const secrets = loadSecrets();
        secrets[deliveryId] = record;
        saveSecrets(secrets);
        log(`${kind} ${deliveryId}: condition issued ${spec.issued(agreed.proof)}`);
        json(res, 201, reply);
      });
    }
    if (req.method === "POST" && req.url === "/affiliate/confirm") {
      // The merchant's sales system says the sale happened. It is a party, so the
      // oracle judges nothing about the sale: only the token it issued once, and
      // that the money was locked first. The order hash goes on-chain with the release.
      return withBody(req, res, (q) => {
        if (!q.deliveryId || !HEX64.test(q.orderHash ?? "") || typeof q.token !== "string") {
          return json(res, 400, { error: "need deliveryId, orderHash (64 hex) and token" });
        }
        const secret = loadSecrets()[q.deliveryId];
        if (!secret) return json(res, 404, { error: "unknown deliveryId" });
        if (!secret.tokenHash) return json(res, 409, { error: `deliveryId is a ${secret.kind ?? "delivery"} condition, not affiliate` });
        if (!sameHex(sha256hex(q.token), secret.tokenHash)) {
          log(`affiliate ${q.deliveryId}: confirmation refused — bad token`);
          return json(res, 403, { error: "bad token" });
        }
        const reg = loadRegistry();
        const e =
          reg.escrows.find((x) => x.deliveryId === q.deliveryId && x.status === "waiting") ??
          reg.escrows.find((x) => x.deliveryId === q.deliveryId);
        if (!e) return json(res, 409, { error: "no escrow locked behind this condition yet" });
        if (e.status !== "waiting") return json(res, 409, { error: `escrow is ${e.status}` });
        const orderHash = q.orderHash.toLowerCase();
        if (e.confirmed && e.confirmed.orderHash !== orderHash) {
          return json(res, 409, { error: "already confirmed with another order hash" });
        }
        if (!e.confirmed) {
          e.confirmed = { orderHash, at: new Date().toISOString() };
          saveRegistry(reg);
          log(`affiliate #${e.sequence}: sale confirmed by the merchant, order sha256 ${orderHash.slice(0, 10)}… — releasing on the next tick`);
        }
        json(res, 202, { ok: true, note: "release on the next tick; poll /escrows" });
      });
    }
    if (req.method === "POST" && req.url === "/watch") {
      return withBody(req, res, (e) => {
        const spec = kindOf(e); // no known kind: payroll
        const required = spec ? spec.watchFields : ["owner", "sequence", "finishAfter", "destination"];
        for (const k of required) {
          if (e[k] === undefined) return json(res, 400, { error: `missing ${k}` });
        }
        if (spec) {
          const secret = loadSecrets()[e.deliveryId];
          if (!secret) return json(res, 400, { error: "unknown deliveryId" });
          if ((secret.kind ?? "delivery") !== e.kind) {
            return json(res, 400, { error: `deliveryId issued for kind ${secret.kind ?? "delivery"}, not ${e.kind}` });
          }
          const bad = spec.validate?.(e);
          if (bad) return json(res, 400, { error: bad });
          // The agreed proof is the contract: the one issued at /condition, not what
          // the caller sends now (a secret older than that field falls back to the
          // body's). Either way it goes through the kind's own shape check.
          const agreed = spec.agree(secret.proof ?? e.proof ?? {});
          if (agreed.error) return json(res, 400, { error: `proof: ${agreed.error}` });
          if (e.proof !== undefined && JSON.stringify(e.proof) !== JSON.stringify(agreed.proof)) {
            log(`watch ${e.kind} #${e.sequence}: the body's proof differs from the agreed one, keeping the agreed one`);
          }
          e.proof = agreed.proof;
        }
        const reg = loadRegistry();
        if (reg.escrows.some((x) => x.owner === e.owner && x.sequence === e.sequence)) {
          return json(res, 200, { ok: true, note: "already watching" });
        }
        reg.escrows.push({ ...e, status: "waiting", registered: new Date().toISOString() });
        saveRegistry(reg);
        if (spec) {
          log(`watching ${e.kind} #${e.sequence} of ${e.owner}: ${spec.watching(e)}`);
        } else {
          log(`watching escrow #${e.sequence} of ${e.owner}: ${e.amountXrp ?? "?"} XRP to ${e.destination}, payable at ripple time ${e.finishAfter}`);
        }
        json(res, 201, { ok: true });
      });
    }
    json(res, 404, { error: "not found" });
  });
  server.listen(PORT, "127.0.0.1", () => log(`oracle ${identity.address} listening on http://127.0.0.1:${PORT}`));
}

async function watch() {
  const id = loadIdentity();
  const wallet = Wallet.fromSeed(id.seed);
  serve(publicIdentity());
  log(`${id.name} — ${id.address} — born ${id.birth.slice(0, 8)}… — watching ${loadRegistry().escrows.filter((e) => e.status === "waiting").length} escrow(s)`);
  for (;;) {
    try {
      await tick(wallet);
    } catch (err) {
      log("tick error:", err?.message ?? err);
      try {
        await client?.disconnect();
      } catch {
        /* ignore */
      }
      client = undefined;
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

// ------------------------------------------------------------------ status

async function status() {
  const id = publicIdentity();
  console.log(JSON.stringify({ identity: id, registry: loadRegistry() }, null, 2));
}

const cmd = process.argv[2];
const commands = { create, watch, status };
if (!commands[cmd]) {
  console.log("usage: node oracle.mjs create | watch | status");
  process.exit(1);
}
commands[cmd]()
  .then(() => {
    if (cmd !== "watch") process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
