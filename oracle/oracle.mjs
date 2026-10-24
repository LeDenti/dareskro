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
 * WHERE IT GETS POWER (not in this demo): a *conditional* escrow, the freelance
 * case, where the oracle holds the preimage of a PREIMAGE-SHA-256 condition
 * and reveals it when delivery is proven. There, the oracle decides *whether*;
 * here it only decides *when*, and even that is bounded below by the ledger.
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
 * HTTP (for the pay desk and the freelance demo)
 *   GET  /identity             address, network, birth tx
 *   GET  /escrows              what it watches, with states
 *   POST /watch                payroll: { owner, sequence, finishAfter, destination,
 *                                amountXrp, statementSha256, createHash }
 *                              delivery: { kind: "delivery", deliveryId, owner, sequence,
 *                                cancelAfter, destination, amountXrp, proof: { url, sha256 } }
 *   POST /delivery/condition   { url, sha256, note } → { deliveryId, condition, proof }
 *
 * TWO SHAPES, ONE ACCOUNT. Payroll escrows (FinishAfter only): the oracle decides
 * *when*, and only after the ledger allows. Delivery escrows (Condition +
 * CancelAfter): the oracle decides *whether*, by reading a public fact — the
 * file at the agreed URL has the agreed SHA-256 — and reveals the secret. Past
 * CancelAfter it submits the refund. In neither case can it keep or redirect
 * the money.
 *
 * FILES
 *   .oracle.json               seed (0600, never committed)
 *   .deliveries.json           secrets of conditional escrows (0600, never committed)
 *   registry.json              what it watches (public)
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Wallet } from "xrpl";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDENTITY = path.join(HERE, ".oracle.json");
const REGISTRY = path.join(HERE, "registry.json");
/** The secrets of conditional escrows (freelance deliveries): 0600, never committed. */
const SECRETS = path.join(HERE, ".deliveries.json");
const TESTNET = "wss://s.altnet.rippletest.net:51233";
const PORT = Number(process.env.ORACLE_PORT || 8787);
const RIPPLE_EPOCH = 946684800;
const TICK_MS = 4000;
/** Ledger close times are coarse: wait this many seconds past FinishAfter before the first try. */
const CLOSE_TIME_MARGIN = 6;
const MAX_ATTEMPTS = 12;

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

function loadIdentity() {
  if (!existsSync(IDENTITY)) throw new Error("no oracle yet: run `node oracle.mjs create`");
  return JSON.parse(readFileSync(IDENTITY, "utf8"));
}

// ---------------------------------------------------- deliveries (example 3)
//
// The freelance case: the escrow carries a PREIMAGE-SHA-256 condition. The
// oracle holds the preimage and reveals it when delivery is proven. Here the
// proof is a PUBLIC FACT the oracle can read by itself: the file at an agreed
// URL has the agreed SHA-256. No click from the client, no click from the
// freelancer: publish the right file, get paid. The oracle is party to nothing.
// If nothing matching is published before CancelAfter, the oracle submits the
// cancel and the client is refunded — it cannot keep the money either way.

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

/** One delivery escrow: verify online, reveal the secret, or refund after the deadline. */
async function tickDelivery(e, wallet) {
  const c = await ledger();
  if (now() > e.cancelAfter + CLOSE_TIME_MARGIN) {
    try {
      await c.request({ command: "ledger_entry", escrow: { owner: e.owner, seq: e.sequence }, ledger_index: "validated" });
    } catch (err) {
      if (err?.data?.error === "entryNotFound") {
        e.status = "gone";
        e.note = "already finished or cancelled by someone else";
        return true;
      }
      throw err;
    }
    log(`delivery #${e.sequence}: deadline passed without a matching file, submitting EscrowCancel (refund to ${e.owner})…`);
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
      log(`delivery #${e.sequence}: refunded — ${explorerTx(res.result.hash)}`);
    } else {
      e.status = "failed";
      log(`delivery #${e.sequence}: cancel ${code}`);
    }
    return true;
  }
  const check = await checkProof(e.proof);
  e.lastCheck = new Date().toISOString();
  e.checks = (e.checks ?? 0) + 1;
  if (!check.ok) {
    if (e.lastWhy !== check.why) log(`delivery #${e.sequence}: not yet — ${check.why}`);
    e.lastWhy = check.why;
    return true;
  }
  const secret = loadSecrets()[e.deliveryId];
  if (!secret) {
    e.status = "failed";
    e.note = "no secret for this delivery id";
    return true;
  }
  log(`delivery #${e.sequence}: ${check.why} — revealing the secret, submitting EscrowFinish…`);
  const res = await c.submitAndWait(
    {
      TransactionType: "EscrowFinish",
      Account: wallet.classicAddress,
      Owner: e.owner,
      OfferSequence: e.sequence,
      Condition: secret.condition,
      Fulfillment: secret.fulfillment,
      Fee: finishFee(secret.fulfillment),
    },
    { wallet, autofill: true },
  );
  const code = typeof res.result.meta === "object" ? res.result.meta.TransactionResult : "?";
  e.lastResult = code;
  e.lastHash = res.result.hash;
  e.lastTry = new Date().toISOString();
  e.lastWhy = check.why;
  if (code === "tesSUCCESS") {
    e.status = "finished";
    e.finishedAt = e.lastTry;
    e.finishHash = res.result.hash;
    log(`delivery #${e.sequence}: finished — ${e.amountXrp} XRP to ${e.destination} — ${explorerTx(res.result.hash)}`);
  } else {
    e.status = "failed";
    log(`delivery #${e.sequence}: finish ${code}, giving up`);
  }
  return true;
}

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
  let changed = false;
  for (const e of reg.escrows) {
    if (e.status !== "waiting") continue;
    if (e.kind === "delivery") {
      if (await tickDelivery(e, wallet)) changed = true;
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
  if (changed) saveRegistry(reg);
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
    if (req.method === "POST" && req.url === "/delivery/condition") {
      // The client asks for a condition before creating the escrow. The oracle
      // keeps the secret; the client gets the condition and the agreed proof.
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        try {
          const p = JSON.parse(body);
          if (!p.url || !/^[0-9a-fA-F]{64}$/.test(p.sha256 ?? "")) return json(res, 400, { error: "need url and sha256 (64 hex)" });
          const pair = conditionPair();
          const deliveryId = randomBytes(6).toString("hex");
          const secrets = loadSecrets();
          secrets[deliveryId] = { ...pair, proof: { url: p.url, sha256: p.sha256.toLowerCase() }, note: p.note ?? "", created: new Date().toISOString() };
          saveSecrets(secrets);
          log(`delivery ${deliveryId}: condition issued for ${p.url} (sha256 ${p.sha256.slice(0, 10)}…)`);
          json(res, 201, { deliveryId, condition: pair.condition, proof: secrets[deliveryId].proof });
        } catch (err) {
          json(res, 400, { error: String(err) });
        }
      });
      return;
    }
    if (req.method === "POST" && req.url === "/watch") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        try {
          const e = JSON.parse(body);
          const required = e.kind === "delivery"
            ? ["owner", "sequence", "cancelAfter", "destination", "deliveryId", "proof"]
            : ["owner", "sequence", "finishAfter", "destination"];
          for (const k of required) {
            if (e[k] === undefined) return json(res, 400, { error: `missing ${k}` });
          }
          if (e.kind === "delivery" && !loadSecrets()[e.deliveryId]) return json(res, 400, { error: "unknown deliveryId" });
          const reg = loadRegistry();
          if (reg.escrows.some((x) => x.owner === e.owner && x.sequence === e.sequence)) {
            return json(res, 200, { ok: true, note: "already watching" });
          }
          reg.escrows.push({ ...e, status: "waiting", registered: new Date().toISOString() });
          saveRegistry(reg);
          if (e.kind === "delivery") {
            log(`watching delivery #${e.sequence} of ${e.owner}: ${e.amountXrp ?? "?"} XRP to ${e.destination} once ${e.proof.url} has sha256 ${e.proof.sha256.slice(0, 10)}…, refund after ripple time ${e.cancelAfter}`);
          } else {
            log(`watching escrow #${e.sequence} of ${e.owner}: ${e.amountXrp ?? "?"} XRP to ${e.destination}, payable at ripple time ${e.finishAfter}`);
          }
          json(res, 201, { ok: true });
        } catch (err) {
          json(res, 400, { error: String(err) });
        }
      });
      return;
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
