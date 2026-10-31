/** Self-checks of the verifier against a local server that misbehaves on purpose. Run: node verifier.test.mjs */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { observe, isPrivateHost } from "./verifier.mjs";

const body = Buffer.from("deliverable v1 — " + "x".repeat(200_000));
const sha = createHash("sha256").update(body).digest("hex");
let flaky = 0;
const server = createServer((req, res) => {
  const u = req.url;
  if (u === "/ok") { res.writeHead(200, { "Content-Length": body.length }); return res.end(body); }
  if (u === "/chunked") { res.writeHead(200); let i = 0; const t = setInterval(() => { res.write(body.subarray(i, i + 50_000)); i += 50_000; if (i >= body.length) { clearInterval(t); res.end(); } }, 30); return; }
  if (u === "/redir") { res.writeHead(302, { Location: "/redir2" }); return res.end(); }
  if (u === "/redir2") { res.writeHead(301, { Location: `http://127.0.0.1:${port}/ok?sig=SECRET` }); return res.end(); }
  if (u.startsWith("/ok?")) { res.writeHead(200, { "Content-Length": body.length }); return res.end(body); }
  if (u === "/loop") { res.writeHead(302, { Location: "/loop" }); return res.end(); }
  if (u === "/flaky") { if (++flaky < 3) { res.writeHead(503, { "Retry-After": "1" }); return res.end("later"); } res.writeHead(200); return res.end(body); }
  if (u === "/truncated") { res.writeHead(200, { "Content-Length": body.length * 2 }); res.write(body); return res.destroy(); }
  if (u === "/forbidden") { res.writeHead(403); return res.end(); }
  if (u === "/stall") { res.writeHead(200); res.write("abc"); return; }
  if (u === "/big") { res.writeHead(200, { "Content-Length": 10 ** 12 }); return res.end(); }
  res.writeHead(404); res.end("not here");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const o = { allowPrivate: true, backoffMs: [100, 100], idleTimeoutMs: 800, headersTimeoutMs: 2000 };

let failed = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); if (!cond) failed++; };

let r = await observe(`${base}/ok`, { ...o, expected: sha });
check("200 + right hash → match", r.verdict === "match" && r.bytes === body.length, r.why);
r = await observe(`${base}/ok`, { ...o, expected: "0".repeat(64) });
check("200 + wrong hash → mismatch, not retried", r.verdict === "mismatch" && r.attempts === 1, r.why);
r = await observe(`${base}/chunked`, { ...o, expected: sha });
check("chunked body streamed → match", r.verdict === "match", r.why);
r = await observe(`${base}/redir`, { ...o, expected: sha });
check("two redirects followed, hops recorded, signature masked", r.verdict === "match" && r.hops.length === 3 && JSON.stringify(r.hops).includes("sig=…") && !JSON.stringify(r).includes("SECRET"), JSON.stringify(r.hops));
r = await observe(`${base}/loop`, { ...o, expected: sha, maxHops: 3 });
check("redirect loop → unreachable, not retried", r.verdict === "unreachable" && r.attempts === 1, r.why);
r = await observe(`${base}/flaky`, { ...o, expected: sha });
check("503 ×2 then 200 → match on attempt 3 (Retry-After honoured)", r.verdict === "match" && r.attempts === 3, r.why);
r = await observe(`${base}/truncated`, { ...o, expected: sha });
check("truncated body → unreachable, retried", r.verdict === "unreachable" && r.attempts === 3 && /truncated|interrupted|closed/.test(r.error), r.why);
r = await observe(`${base}/missing`, { ...o, expected: sha });
check("404 → absent, not retried", r.verdict === "absent" && r.attempts === 1, r.why);
r = await observe(`${base}/forbidden`, { ...o, expected: sha });
check("403 → forbidden", r.verdict === "forbidden", r.why);
r = await observe(`${base}/stall`, { ...o, expected: sha, attempts: 1 });
check("server goes quiet → idle timeout → unreachable", r.verdict === "unreachable" && /no data/.test(r.error), r.why);
r = await observe(`${base}/big`, { ...o, expected: sha, maxBytes: 1000 });
check("announced size beyond the cap → too-large", r.verdict === "too-large", r.why);
r = await observe(`${base}/chunked`, { ...o, expected: sha, maxBytes: 1000 });
check("body beyond the cap (no Content-Length) → too-large, stopped while streaming", r.verdict === "too-large" && r.bytes > 1000 && r.bytes < body.length, r.why);
r = await observe(`${base}/ok`, { expected: sha, allowPrivate: false });
check("127.0.0.1 refused when private hosts are not allowed", r.verdict === "refused", r.why);
r = await observe(`ftp://example.org/x`, { expected: sha });
check("ftp refused", r.verdict === "refused", r.why);
check("private host table", isPrivateHost("10.1.2.3") && isPrivateHost("172.20.0.1") && isPrivateHost("localhost") && !isPrivateHost("github.com") && !isPrivateHost("172.32.0.1"));

server.close();
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
