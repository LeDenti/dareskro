/**
 * The privacy service behind the pay desk's "Privacy" card. A thin HTTP wrapper
 * around three scripts, so the browser can run them and show their words:
 *   GET  /zk                       the latest proof's public values (zk/sortie/public_inputs.json)
 *   POST /seal   { escrow }        seal the statement for the employee and the administration, bound to that escrow
 *   GET  /view?role=&escrow=       what the public, the administration or the employee sees (agent/divulgation.mjs)
 *   GET  /verify?escrow=           verify the zero-knowledge proof against the chain, as anyone can (zk/verify.mjs)
 *
 * In the demo the two private keys (employee, administration) sit on this machine in
 * agent/cles/ (0600, never committed); in production each reader runs its own copy of
 * divulgation.mjs with its own key — the service is a stand-in for three parties.
 * Usage: node agent/service_confidentialite.mjs   (127.0.0.1:8788)
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = Number(process.env.PRIVACY_PORT || 8788);
const ROLES = new Set(["public", "administration", "employee"]);
const HEX64 = /^[0-9a-fA-F]{64}$/;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body, null, 2));
};

/** Run one of the scripts and hand back its words, stdout then stderr, with its exit code. */
const run = (args, timeout = 90000) =>
  new Promise((resolve) => {
    execFile("node", args, { cwd: ROOT, timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const lines = [...String(stdout ?? "").split("\n"), ...String(stderr ?? "").split("\n")].filter((l) => l.trim() !== "");
      resolve({ exit: err ? (typeof err.code === "number" ? err.code : 1) : 0, lines });
    });
  });

function zkPublic() {
  const f = path.join(ROOT, "zk", "sortie", "public_inputs.json");
  if (!existsSync(f)) return null;
  const pub = JSON.parse(readFileSync(f, "utf8"));
  const proofFile = path.join(ROOT, "zk", "sortie", "proof.json");
  let proofBytes;
  try { proofBytes = JSON.parse(readFileSync(proofFile, "utf8")).proof?.length / 2 || undefined; } catch { /* no proof */ }
  return { commitment: pub.commitment, total_cents: pub.total_cents, statement_sha256: pub.statement_sha256, generated: pub.generated, proof_bytes: proofBytes };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method === "GET" && url.pathname === "/zk") {
    const pub = zkPublic();
    return pub ? json(res, 200, pub) : json(res, 404, { error: "no proof yet: node zk/prove.mjs" });
  }
  if (req.method === "POST" && url.pathname === "/seal") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      let escrow;
      try { escrow = JSON.parse(body || "{}").escrow; } catch { return json(res, 400, { ok: false, error: "bad JSON" }); }
      if (!HEX64.test(escrow ?? "")) return json(res, 400, { ok: false, error: "escrow must be a 64-hex EscrowCreate hash" });
      log(`seal for escrow ${escrow.slice(0, 8)}…`);
      const r = await run([path.join(HERE, "confidentiel.mjs"), "--chiffre", "--escrow", escrow]);
      if (r.exit !== 0) return json(res, 200, { ok: false, error: r.lines.at(-1) ?? "sealing failed", lines: r.lines });
      let file = {};
      try { file = JSON.parse(readFileSync(path.join(HERE, "sortie", "bulletin.chiffre.json"), "utf8")); } catch { /* keep going */ }
      const bytes = (() => { try { return readFileSync(path.join(HERE, "sortie", "bulletin.chiffre.json")).length; } catch { return undefined; } })();
      json(res, 200, { ok: true, sha256_plain: file.sha256_plain, file_bytes: bytes, recipients: Object.keys(file.recipients ?? {}), lines: r.lines });
    });
    return;
  }
  if (req.method === "GET" && (url.pathname === "/view" || url.pathname === "/verify")) {
    const escrow = url.searchParams.get("escrow") ?? "";
    const role = url.pathname === "/verify" ? "public" : url.searchParams.get("role") ?? "";
    if (!HEX64.test(escrow)) return json(res, 400, { role, ok: false, exit: 2, lines: ["escrow must be a 64-hex EscrowCreate hash"] });
    if (!ROLES.has(role)) return json(res, 400, { role, ok: false, exit: 2, lines: ["role must be public, administration or employee"] });
    const args = url.pathname === "/verify"
      ? [path.join(ROOT, "zk", "verify.mjs"), "--escrow", escrow]
      : [path.join(HERE, "divulgation.mjs"), "--role", role, "--escrow", escrow];
    log(`${url.pathname} ${role} for escrow ${escrow.slice(0, 8)}…`);
    const r = await run(args);
    return json(res, 200, { role, ok: r.exit === 0, exit: r.exit, lines: r.lines });
  }
  json(res, 404, { error: "not found" });
});
server.listen(PORT, "127.0.0.1", () => log(`privacy service listening on http://127.0.0.1:${PORT} — /zk, /seal, /view, /verify`));
