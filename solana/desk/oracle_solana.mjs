#!/usr/bin/env node
/**
 * dareskro's oracle on Solana — the same job as oracle/oracle.mjs on XRPL, the
 * same shape, a different ledger. It watches the escrows it is cited in and
 * releases them: payroll when the cluster clock passes finish_after, delivery
 * when the agreed file is published with the agreed hash (it reveals the
 * preimage), refund when cancel_after passes without the proof.
 *
 * What it cannot do is the point. It cannot pay early (TooEarly is the
 * program's answer), cannot redirect (the destination is a constraint on the
 * account, not an argument), cannot invent a proof (the condition is a
 * sha256 the program checks). It only spends its own fees.
 *
 *   node oracle_solana.mjs create     a devnet keypair for the oracle (fees only), airdrop if the faucet allows
 *   node oracle_solana.mjs watch      HTTP on 127.0.0.1:8791 + a tick every 5 s
 *   node oracle_solana.mjs status     the registry, one line per escrow
 *
 * Files (never committed): cles/oracle.<cluster>.json (0600), cles/.secrets.json
 * (0600, the preimages). registry_solana.json is public, like XRPL's registry.json.
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, Keypair, getEscrow, finishEscrow, cancelEscrow, chainNow, explorerTx, explorerAccount, PROGRAM_ID, LAMPORTS } from "../client/dareskro_solana.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLUSTER = process.env.SOLANA_CLUSTER || "devnet";
const KEY = join(HERE, "cles", `oracle.${CLUSTER}.json`);
const SECRETS = join(HERE, "cles", ".secrets.json");
const REGISTRY = join(HERE, "registry_solana.json");
const PORT = Number(process.env.ORACLE_SOLANA_PORT || 8791);
const TICK_MS = 5000, PROBE_MS = 20000, CLOCK_MARGIN = 2, MAX_ATTEMPTS = 12;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const writeJson = (f, v, mode) => { writeFileSync(f, JSON.stringify(v, null, 2)); if (mode) chmodSync(f, mode); };
const loadRegistry = () => readJson(REGISTRY, { escrows: [] });
const saveRegistry = (r) => writeJson(REGISTRY, r);
const loadSecrets = () => { if (existsSync(SECRETS) && statSync(SECRETS).mode & 0o077) throw new Error(`${SECRETS} readable by others`); return readJson(SECRETS, {}); };
const saveSecrets = (s) => writeJson(SECRETS, s, 0o600);

function loadKey() {
  if (!existsSync(KEY)) throw new Error(`no oracle key: run "node oracle_solana.mjs create" first`);
  if (statSync(KEY).mode & 0o077) throw new Error(`${KEY} is readable by others: chmod 600`);
  return Keypair.fromSecretKey(Uint8Array.from(readJson(KEY)));
}

// ------------------------------------------------------------------ the kinds
const KINDS = {
  delivery: {
    agree: (p) => {
      if (!p.url || !/^https?:\/\//.test(p.url)) return { error: "url must be http(s)" };
      if (!/^[0-9a-f]{64}$/i.test(p.sha256 ?? "")) return { error: "sha256 must be 64 hex chars" };
      return { proof: { url: p.url, sha256: p.sha256.toLowerCase() } };
    },
    watchFields: ["escrow", "deliveryId", "cancelAfter"],
  },
};

async function checkProof(proof) {
  let res;
  try { res = await fetch(proof.url, { signal: AbortSignal.timeout(10000), cache: "no-store" }); }
  catch (err) { return { ok: false, why: `unreachable: ${err.message}` }; }
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = sha256hex(buf);
  return sha === proof.sha256 ? { ok: true, why: `match (${buf.length} bytes)` } : { ok: false, why: `published sha256 ${sha.slice(0, 10)}… ≠ agreed ${proof.sha256.slice(0, 10)}…` };
}

/** Anchor's error name out of a failed rpc(), e.g. "TooEarly". */
const errCode = (err) => err?.error?.errorCode?.code ?? (String(err?.message ?? err).match(/Error Code: (\w+)/) || [])[1] ?? String(err?.message ?? err).slice(0, 80);

// ------------------------------------------------------------------ the tick
async function tick(ctx) {
  const { program, connection, payer } = ctx;
  const reg = loadRegistry();
  let changed = false;
  for (const e of reg.escrows) {
    if (e.status !== "waiting") continue;
    try {
      const on = await getEscrow(program, e.escrow);
      if (!on) { e.status = "gone"; e.note = "record closed by its owner"; changed = true; continue; }
      if (on.status !== "locked") {
        e.status = on.status === "finished" ? "finished" : "refunded";
        e.note = `${on.status} by ${on.closedBy} at ${on.closedAt}`; e.closedBy = on.closedBy; changed = true;
        log(`${e.escrow.slice(0, 8)}: ${on.status} by someone else — the money went where it was written anyway`); continue;
      }
      const now = await chainNow(connection);
      if (e.kind === "delivery") {
        if (now >= on.cancelAfter) {
          log(`${e.escrow.slice(0, 8)}: cancel_after passed without the proof, refunding the payer…`);
          const sig = await cancelEscrow(program, { caller: payer, escrow: e.escrow });
          e.status = "expired-refunded"; e.refundSignature = sig; e.refundExplorer = explorerTx(sig, CLUSTER); changed = true; continue;
        }
        if (e.lastCheckAt && Date.now() - Date.parse(e.lastCheckAt) < PROBE_MS) continue;
        const check = await checkProof(e.proof);
        e.checks = (e.checks ?? 0) + 1; e.lastCheckAt = new Date().toISOString(); e.lastWhy = check.why; changed = true;
        if (!check.ok) continue;
        const secret = loadSecrets()[e.deliveryId];
        if (!secret) { e.status = "failed"; e.note = "secret lost"; continue; }
        log(`${e.escrow.slice(0, 8)}: ${check.why} — revealing the secret, finishing…`);
        const sig = await finishEscrow(program, { caller: payer, escrow: e.escrow, fulfillment: secret.secret });
        e.status = "finished"; e.finishedAt = new Date().toISOString(); e.finishSignature = sig; e.finishExplorer = explorerTx(sig, CLUSTER);
        log(`${e.escrow.slice(0, 8)}: finished — ${explorerTx(sig, CLUSTER)}`); continue;
      }
      // payroll: the oracle decides *when*, and only after the date
      if (on.finishAfter == null || now < on.finishAfter + CLOCK_MARGIN) continue;
      log(`${e.escrow.slice(0, 8)}: date passed (cluster clock ${now} ≥ ${on.finishAfter}), finishing…`);
      try {
        const sig = await finishEscrow(program, { caller: payer, escrow: e.escrow });
        e.attempts = (e.attempts ?? 0) + 1; e.status = "finished"; e.finishedAt = new Date().toISOString();
        e.finishSignature = sig; e.finishExplorer = explorerTx(sig, CLUSTER); changed = true;
        log(`${e.escrow.slice(0, 8)}: finished — ${Number(on.amount) / LAMPORTS} SOL to ${on.destination} — ${e.finishExplorer}`);
      } catch (err) {
        const code = errCode(err);
        e.attempts = (e.attempts ?? 0) + 1; e.lastResult = code; e.lastTry = new Date().toISOString(); changed = true;
        if (code === "TooEarly" && e.attempts < MAX_ATTEMPTS) log(`${e.escrow.slice(0, 8)}: TooEarly (cluster clock behind), will retry`);
        else { e.status = e.attempts >= MAX_ATTEMPTS ? "failed" : e.status; log(`${e.escrow.slice(0, 8)}: ${code}`); }
      }
    } catch (err) {
      log(`${e.escrow.slice(0, 8)}: ${err.message}`);
    }
  }
  if (changed) saveRegistry(reg);
}

// ------------------------------------------------------------------ HTTP
function serve(ctx) {
  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
    res.end(JSON.stringify(body, null, 2));
  };
  const withBody = (req, res, handler) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => { try { await handler(JSON.parse(body || "{}")); } catch (err) { json(res, 400, { error: String(err.message ?? err) }); } });
  };
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (req.method === "GET" && req.url === "/identity") {
      const lamports = await ctx.connection.getBalance(ctx.payer.publicKey).catch(() => null);
      return json(res, 200, { name: "dareskro-oracle-solana", address: ctx.payer.publicKey.toBase58(), cluster: CLUSTER, programId: PROGRAM_ID.toBase58(),
        explorer: explorerAccount(ctx.payer.publicKey.toBase58(), CLUSTER), balanceSol: lamports == null ? null : lamports / LAMPORTS,
        watching: loadRegistry().escrows.filter((e) => e.status === "waiting").length });
    }
    if (req.method === "GET" && req.url === "/escrows") return json(res, 200, loadRegistry());
    if (req.method === "POST" && req.url === "/condition") {
      return withBody(req, res, (p) => {
        const kind = p.kind ?? "delivery";
        const spec = KINDS[kind];
        if (!spec) return json(res, 400, { error: `unknown kind ${kind}: delivery` });
        const agreed = spec.agree(p);
        if (agreed.error) return json(res, 400, { error: agreed.error });
        const secret = randomBytes(32).toString("hex");
        const condition = sha256hex(Buffer.from(secret, "hex"));
        const deliveryId = randomBytes(6).toString("hex");
        const secrets = loadSecrets();
        secrets[deliveryId] = { secret, condition, kind, proof: agreed.proof, created: new Date().toISOString() };
        saveSecrets(secrets);
        log(`${kind} ${deliveryId}: condition issued for ${agreed.proof.url}`);
        json(res, 201, { deliveryId, condition, proof: agreed.proof });
      });
    }
    if (req.method === "POST" && req.url === "/watch") {
      return withBody(req, res, async (e) => {
        const spec = e.kind && e.kind !== "payroll" ? KINDS[e.kind] : undefined;
        if (e.kind && e.kind !== "payroll" && !spec) return json(res, 400, { error: `unknown kind ${e.kind}` });
        for (const k of spec ? spec.watchFields : ["escrow"]) if (e[k] === undefined) return json(res, 400, { error: `missing ${k}` });
        if (spec) {
          const s = loadSecrets()[e.deliveryId];
          if (!s) return json(res, 400, { error: "unknown deliveryId" });
          e.proof = s.proof;
        }
        const on = await getEscrow(ctx.program, e.escrow);
        if (!on) return json(res, 400, { error: "no such escrow on chain" });
        const cites = on.memos.some((m) => m.includes(ctx.payer.publicKey.toBase58()));
        const reg = loadRegistry();
        if (reg.escrows.some((x) => x.escrow === e.escrow)) return json(res, 200, { ok: true, note: "already watching" });
        reg.escrows.push({ escrow: e.escrow, kind: e.kind ?? "payroll", deliveryId: e.deliveryId, proof: e.proof, owner: on.owner, destination: on.destination,
          amount: on.amount, finishAfter: on.finishAfter, cancelAfter: on.cancelAfter, memos: on.memos, cited: cites, createSignature: e.createSignature,
          statementSha256: e.statementSha256, fiat: e.fiat, status: "waiting", registered: new Date().toISOString() });
        saveRegistry(reg);
        log(`watching ${e.kind ?? "payroll"} ${e.escrow.slice(0, 8)}: ${Number(on.amount) / LAMPORTS} SOL to ${on.destination}${on.finishAfter ? `, payable at ${on.finishAfter}` : ""}${cites ? "" : " (not cited in the memos — watching anyway, anyone may finish)"}`);
        json(res, 201, { ok: true });
      });
    }
    json(res, 404, { error: "not found" });
  });
  server.listen(PORT, "127.0.0.1", () => log(`oracle ${ctx.payer.publicKey.toBase58()} on ${CLUSTER}, listening on http://127.0.0.1:${PORT}`));
}

// ------------------------------------------------------------------ commands
const cmd = process.argv[2];
if (cmd === "create") {
  if (existsSync(KEY)) { const k = loadKey(); log("oracle already exists:", k.publicKey.toBase58()); process.exit(0); }
  const k = Keypair.generate();
  writeJson(KEY, Array.from(k.secretKey), 0o600);
  log(`oracle key written to ${KEY} (0600) — address ${k.publicKey.toBase58()}`);
  const { connection } = await connect({ cluster: CLUSTER, keypair: k });
  try { const sig = await connection.requestAirdrop(k.publicKey, LAMPORTS); await connection.confirmTransaction(sig, "confirmed"); log("airdrop 1 SOL ok"); }
  catch (e) { log(`airdrop refused (${e.message.slice(0, 60)}): fund it with  solana transfer ${k.publicKey.toBase58()} 0.1 -u ${CLUSTER} --allow-unfunded-recipient`); }
} else if (cmd === "watch") {
  const ctx = await connect({ cluster: CLUSTER, keypair: loadKey() });
  serve(ctx);
  const loop = async () => { try { await tick(ctx); } catch (e) { log("tick:", e.message); } setTimeout(loop, TICK_MS); };
  loop();
} else if (cmd === "status") {
  for (const e of loadRegistry().escrows) console.log(e.status.padEnd(16), e.kind.padEnd(9), e.escrow, e.finishExplorer ?? e.refundExplorer ?? e.lastResult ?? "");
} else {
  console.error("usage: node oracle_solana.mjs create | watch | status"); process.exit(2);
}
