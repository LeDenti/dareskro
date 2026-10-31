#!/usr/bin/env node
/**
 * The freelance case end to end, through the desk's API — the same endpoints
 * the two screens call. Replays what was measured on 31/10/2026 (README,
 * "Le freelance, en vrai"):
 *
 *   1. a mission paid on an AGREED HASH: locked, the agreed URL answers 404,
 *      then the file is published; the oracle streams it, matches, reveals;
 *   2. a mission NEVER delivered: locked, nothing published, refunded at CancelAfter;
 *   3. a mission paid on the CLIENT'S SIGNED ACCEPTANCE: locked, the client signs
 *      an AccountSet naming the escrow, the oracle verifies it on the ledger, reveals.
 *
 * Needs: the oracle (cd oracle && node oracle.mjs watch) and the desk
 * (node service.mjs) running, with a client key on the desk (POST /api/client/create
 * on testnet). The freelancer is a fresh faucet account unless FREELANCER is set.
 *
 * The published file must sit at a PUBLIC URL. Two ways:
 *   PROOF_URL=https://…/file  PUBLISH_CMD='gh release upload tag ./file'
 *       the script locks, then runs PUBLISH_CMD to put the file online
 *   PROOF_URL=https://…/file   (no PUBLISH_CMD)
 *       the script locks, prints the hash, and WAITS for you to publish the file
 *   neither: a local server on 127.0.0.1 (the oracle then needs FREELANCE_ALLOW_PRIVATE=1)
 *
 * Writes run/run.log (what happened, with the explorer links) and run/compte_rendu.json.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESK = (process.env.DESK_URL || "http://127.0.0.1:8781").replace(/\/$/, "");
const FILE = process.env.DELIVERABLE || path.join(HERE, "run", "landing-copy-v1.md");
const PROOF_URL = process.env.PROOF_URL;
const PUBLISH_CMD = process.env.PUBLISH_CMD;
const NEVER_URL = process.env.NEVER_URL || (PROOF_URL ? PROOF_URL.replace(/[^/]+$/, "never-delivered.pdf") : undefined);
const AMOUNTS = { delivered: process.env.AMOUNT_DELIVERED || "25", never: process.env.AMOUNT_NEVER || "10", accepted: process.env.AMOUNT_ACCEPTED || "15" };
const DEADLINE_NEVER_S = Number(process.env.DEADLINE_NEVER_S || 240);
const RUN_DIR = path.join(HERE, "run");
mkdirSync(RUN_DIR, { recursive: true });
const LOG = path.join(RUN_DIR, "run.log");
const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(" ")}`; console.log(line); appendFileSync(LOG, line + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function api(p, body) {
  const r = await fetch(DESK + "/api" + p, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${r.status} ${j.error}`);
  return j;
}
const view = async (id, mid) => (await api(`/missions/${id}`)).milestones.find((x) => x.id === mid);
async function until(id, mid, pred, maxS, everyS = 5) {
  for (let t = 0; t < maxS; t += everyS) {
    const v = await view(id, mid);
    if (pred(v)) return v;
    await sleep(everyS * 1000);
  }
  return view(id, mid);
}
const ex = (cfg, h) => `${cfg.explorer}/transactions/${h}`;

// --- the deliverable, and where it will be published
const deliverable = readFileSync(FILE);
const expected = sha256(deliverable);
let proofUrl = PROOF_URL, neverUrl = NEVER_URL, server, publish;
if (!proofUrl) {
  let online = false;
  server = createServer((req, res) => {
    if (req.url === "/landing-copy-v1.md" && online) { res.writeHead(200, { "Content-Type": "text/markdown", "Content-Length": deliverable.length }); return res.end(deliverable); }
    res.writeHead(404); res.end("not published");
  });
  await new Promise((r) => server.listen(8796, "127.0.0.1", r));
  proofUrl = "http://127.0.0.1:8796/landing-copy-v1.md";
  neverUrl = "http://127.0.0.1:8796/never-delivered.pdf";
  publish = async () => { online = true; log("local server now serves the file (the oracle needs FREELANCE_ALLOW_PRIVATE=1 for 127.0.0.1)"); };
} else if (PUBLISH_CMD) {
  publish = async () => { log(`publishing: ${PUBLISH_CMD}`); execSync(PUBLISH_CMD, { stdio: "inherit" }); };
} else {
  publish = async () => { log(`PUBLISH NOW the file ${path.basename(FILE)} (sha256 ${expected}) at ${proofUrl} — waiting until it is there…`); };
}

const cfg = await api("/config");
if (!cfg.client) throw new Error("no client key on the desk: POST /api/client/create (testnet) or put your seed in freelance/.client.json");
if (!cfg.oracle) throw new Error(`no oracle at ${cfg.oracleUrl}`);
log(`desk ${DESK} · ${cfg.network} · client ${cfg.client.address} (${cfg.client.balance} XRP) · oracle ${cfg.oracle.name} ${cfg.oracle.address}`);
let freelancer = process.env.FREELANCER;
if (!freelancer) {
  const { Client } = await import("xrpl");
  const c = new Client(cfg.node);
  await c.connect();
  freelancer = (await c.fundWallet()).wallet.classicAddress;
  await c.disconnect();
}
log(`freelancer ${freelancer} · deliverable ${path.basename(FILE)} ${deliverable.length} bytes sha256 ${expected} · proof URL ${proofUrl}`);
const report = { at: new Date().toISOString(), desk: DESK, network: cfg.network, client: cfg.client.address, freelancer, oracle: cfg.oracle.address, deliverable: { file: path.basename(FILE), bytes: deliverable.length, sha256: expected, url: proofUrl }, missions: {} };
const iso = (s) => new Date(Date.now() + s * 1000).toISOString();

async function lockMission(label, body) {
  const m = await api("/missions", body);
  const ms = m.milestones[0];
  log(`${label}: mission ${m.id} created, share link ${m.shareUrl}`);
  await api(`/missions/${m.id}/milestones/${ms.id}/prepare`, {});
  const r = await api(`/missions/${m.id}/milestones/${ms.id}/lock`, {});
  const e = r.milestone.escrow;
  log(`${label}: EscrowCreate ${e.result} #${e.sequence} ${e.amountXrp} XRP, refund after ${new Date((e.cancelAfter + 946684800) * 1000).toISOString()} — ${ex(cfg, e.hash)} — handed to the oracle: ${r.milestone.handed?.ok}`);
  if (e.result !== "tesSUCCESS") throw new Error(`${label}: lock failed, stopping`);
  return { id: m.id, mid: ms.id, shareUrl: m.shareUrl, escrow: e, deliveryId: r.milestone.condition.deliveryId };
}

// 1. the agreed hash
const m1 = await lockMission("delivered", { title: "Landing page copy, v1", description: "the landing page copy for dareskro's freelance product, as a Markdown file", client: cfg.client.address, freelancer, amountXrp: AMOUNTS.delivered, deadline: iso(3600), proofMode: "hash", url: proofUrl, sha256: expected, currency: "EUR" });
// 2. never delivered
const m2 = await lockMission("never", { title: "Never delivered", description: "nothing will be published; the client must be refunded at the deadline", client: cfg.client.address, freelancer, amountXrp: AMOUNTS.never, deadline: iso(DEADLINE_NEVER_S), proofMode: "hash", url: neverUrl, sha256: "0".repeat(63) + "1" });
// 3. acceptance
const m3 = await lockMission("accepted", { title: "Logo, three proposals", description: "three PNG proposals sent by e-mail; the client signs when satisfied", client: cfg.client.address, freelancer, amountXrp: AMOUNTS.accepted, deadline: iso(3600), proofMode: "acceptance" });

let v = await until(m1.id, m1.mid, (x) => (x.oracle?.checks ?? 0) >= 1, 40);
log(`delivered: before publication the oracle says "${v.oracle?.lastWhy}" after ${v.oracle?.checks} look(s)`);
v = await until(m2.id, m2.mid, (x) => (x.oracle?.checks ?? 0) >= 1, 40);
log(`never: the oracle says "${v.oracle?.lastWhy}"`);

// the client signs the acceptance of mission 3
const acc = await api(`/missions/${m3.id}/milestones/${m3.mid}/accept`, {});
log(`accepted: the client signed the acceptance ${acc.acceptance.result} — ${ex(cfg, acc.acceptance.hash)} — oracle ${acc.acceptance.oracle?.status} ${acc.acceptance.oracle?.note ?? acc.acceptance.oracle?.error ?? ""}`);
v = await until(m3.id, m3.mid, (x) => x.status === "paid", 90);
log(`accepted: ${v.status} — ${v.oracle?.lastWhy} — ${v.oracle?.finishHash ? ex(cfg, v.oracle.finishHash) : v.oracle?.lastResult}`);
report.missions.accepted = { ...m3, acceptance: acc.acceptance, finishHash: v.oracle?.finishHash, status: v.status };

// publish the real file, the oracle pays
await publish();
v = await until(m1.id, m1.mid, (x) => x.status === "paid", PROOF_URL && !PUBLISH_CMD ? 3600 : 300, 6);
log(`delivered: ${v.status} — ${v.oracle?.lastWhy} — ${v.oracle?.finishHash ? ex(cfg, v.oracle.finishHash) : v.oracle?.lastResult ?? ""}`);
report.missions.delivered = { ...m1, finishHash: v.oracle?.finishHash, status: v.status, lastWhy: v.oracle?.lastWhy, journal: v.journal };

// the deadline passes on mission 2
log(`never: waiting for the deadline (${DEADLINE_NEVER_S} s after the lock)…`);
v = await until(m2.id, m2.mid, (x) => x.status === "refunded", DEADLINE_NEVER_S + 120, 8);
log(`never: ${v.status} — ${v.oracle?.refundHash ? ex(cfg, v.oracle.refundHash) : v.oracle?.lastWhy}`);
report.missions.never = { ...m2, refundHash: v.oracle?.refundHash, status: v.status, journal: v.journal };

const after = await api("/config");
report.clientBalanceAfter = after.client.balance;
writeFileSync(path.join(RUN_DIR, "compte_rendu.json"), JSON.stringify(report, null, 2));
log(`client balance after: ${after.client.balance} XRP · report in run/compte_rendu.json`);
server?.close();
process.exit(0);
