/**
 * The delivery verifier, hardened for real URLs.
 *
 * The hackathon oracle read the agreed URL with one fetch(), hashed the body in
 * memory and compared. Real deliveries live on GitHub releases (a 302 to a
 * signed blob URL), IPFS gateways (slow first byte, sometimes 504), plain web
 * servers (403 while the file is being uploaded), and can weigh hundreds of
 * megabytes. This module reads such a URL the way an auditor would:
 *
 *   - follows redirects by hand (at most MAX_HOPS), recording every hop;
 *   - hashes the body as a STREAM: constant memory, a byte cap, and an idle
 *     timeout that fires when the server stops sending, not after a fixed
 *     total that a large file would always exceed;
 *   - retries what is worth retrying (network errors, 5xx, 429, a truncated
 *     body) with a short back-off, and does not retry what is an answer
 *     (404/410 = not published yet, 401/403 = not public, 200 with the wrong
 *     hash = the wrong file);
 *   - refuses private and loopback hosts unless told otherwise (the oracle
 *     must never be turned into a scanner of its own network);
 *   - returns an OBSERVATION: timestamps, hops, status, bytes, hash, headers
 *     that identify the object (ETag, Last-Modified, Content-Length), elapsed
 *     time, and a verdict. Observations are appended to a journal (JSON lines,
 *     one file per delivery id) together with the decisions taken on them:
 *     that journal is the evidence the oracle can show for what it did.
 *
 * Verdicts: "match" (ok), "mismatch", "absent" (404/410), "forbidden" (401/403),
 * "unreachable" (network, 5xx after retries, redirect loop, truncated),
 * "too-large" (beyond the byte cap), "refused" (private host, bad scheme).
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_DIR = process.env.FREELANCE_EVIDENCE_DIR || path.join(HERE, "evidence");

export const DEFAULTS = {
  /** Redirect hops followed by hand (GitHub releases need 1, some CDNs 2). */
  maxHops: 5,
  /** Bytes hashed at most; beyond, the verdict is "too-large" and nothing is paid. */
  maxBytes: 2 * 1024 ** 3,
  /** Time to the response headers, then between two chunks of the body. */
  headersTimeoutMs: 20_000,
  idleTimeoutMs: 30_000,
  /** Attempts per verification, and the pause before each retry (ms). */
  attempts: 3,
  backoffMs: [2_000, 5_000],
  /** Loopback and RFC 1918 hosts: refused unless the deployment says otherwise (demos on 127.0.0.1 do). */
  allowPrivate: process.env.FREELANCE_ALLOW_PRIVATE === "1",
  /** What the server sees. */
  userAgent: "dareskro-delivery-verifier/1.0 (+https://github.com/LeDenti/dareskro)",
};

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|\[?fc[0-9a-f]{2}:.*|\[?fd[0-9a-f]{2}:.*|\[?fe80:.*)$/i;
export const isPrivateHost = (hostname) => PRIVATE_HOST.test(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Signed blob URLs (GitHub, S3) carry a credential in the query: never keep it in the evidence. */
const mask = (u) => (u ? u.replace(/([?&](sig|jwt|X-Amz-Signature|Signature|token|X-Amz-Credential)=)[^&]+/gi, "$1…") : u);
const nowIso = () => new Date().toISOString();

/**
 * One attempt: follow redirects, stream-hash the body. Never throws; returns a
 * partial observation with `error` and `retryable` set when something broke.
 */
async function attemptOnce(url, o) {
  const started = Date.now();
  const hops = [];
  let current = url;
  for (let hop = 0; hop <= o.maxHops; hop++) {
    let u;
    try {
      u = new URL(current);
    } catch {
      return { hops, error: `not a URL: ${current}`, verdict: "refused", retryable: false };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { hops, error: `scheme ${u.protocol} refused (http/https only)`, verdict: "refused", retryable: false };
    }
    if (!o.allowPrivate && isPrivateHost(u.hostname)) {
      return { hops, error: `private host ${u.hostname} refused`, verdict: "refused", retryable: false };
    }
    const ac = new AbortController();
    let timer = setTimeout(() => ac.abort(new Error(`no response headers after ${o.headersTimeoutMs} ms`)), o.headersTimeoutMs);
    let res;
    try {
      res = await fetch(current, {
        redirect: "manual",
        cache: "no-store",
        signal: ac.signal,
        headers: { "User-Agent": o.userAgent, Accept: "*/*" },
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = String(err?.cause?.message ?? err?.message ?? err);
      hops.push({ url: mask(current), error: msg });
      return { hops, error: `unreachable: ${msg}`, verdict: "unreachable", retryable: true };
    }
    clearTimeout(timer);
    const entry = { url: mask(current), status: res.status };
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      entry.location = loc ? mask(new URL(loc, current).href) : null;
      hops.push(entry);
      try { await res.body?.cancel(); } catch { /* nothing to drain */ }
      if (!loc) return { hops, error: `HTTP ${res.status} without Location`, verdict: "unreachable", retryable: false };
      current = new URL(loc, current).href;
      continue;
    }
    hops.push(entry);
    const headers = {
      contentType: res.headers.get("content-type") ?? undefined,
      contentLength: res.headers.get("content-length") ? Number(res.headers.get("content-length")) : undefined,
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      retryAfter: res.headers.get("retry-after") ?? undefined,
    };
    if (res.status === 404 || res.status === 410) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { hops, finalUrl: mask(current), status: res.status, headers, verdict: "absent", retryable: false, ms: Date.now() - started };
    }
    if (res.status === 401 || res.status === 403) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { hops, finalUrl: mask(current), status: res.status, headers, verdict: "forbidden", retryable: false, ms: Date.now() - started };
    }
    if (res.status === 429 || res.status >= 500) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { hops, finalUrl: mask(current), status: res.status, headers, error: `HTTP ${res.status}`, verdict: "unreachable", retryable: true, ms: Date.now() - started };
    }
    if (res.status !== 200) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { hops, finalUrl: mask(current), status: res.status, headers, error: `HTTP ${res.status}`, verdict: "unreachable", retryable: false, ms: Date.now() - started };
    }
    if (headers.contentLength !== undefined && headers.contentLength > o.maxBytes) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { hops, finalUrl: mask(current), status: 200, headers, error: `announced ${headers.contentLength} bytes > cap ${o.maxBytes}`, verdict: "too-large", retryable: false, ms: Date.now() - started };
    }
    // the body, as a stream: hash chunk by chunk, abort if the server goes quiet
    const hash = createHash("sha256");
    let bytes = 0;
    const idle = () => setTimeout(() => ac.abort(new Error(`no data for ${o.idleTimeoutMs} ms after ${bytes} bytes`)), o.idleTimeoutMs);
    timer = idle();
    try {
      if (!res.body) throw new Error("empty body stream");
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(timer);
        bytes += value.byteLength;
        if (bytes > o.maxBytes) {
          await reader.cancel();
          return { hops, finalUrl: mask(current), status: 200, headers, bytes, error: `more than ${o.maxBytes} bytes`, verdict: "too-large", retryable: false, ms: Date.now() - started };
        }
        hash.update(value);
        timer = idle();
      }
    } catch (err) {
      clearTimeout(timer);
      const msg = String(err?.cause?.message ?? err?.message ?? err);
      return { hops, finalUrl: mask(current), status: 200, headers, bytes, error: `body interrupted: ${msg}`, verdict: "unreachable", retryable: true, ms: Date.now() - started };
    }
    clearTimeout(timer);
    if (headers.contentLength !== undefined && bytes !== headers.contentLength) {
      return { hops, finalUrl: mask(current), status: 200, headers, bytes, error: `truncated: ${bytes} of ${headers.contentLength} bytes`, verdict: "unreachable", retryable: true, ms: Date.now() - started };
    }
    return { hops, finalUrl: mask(current), status: 200, headers, bytes, sha256: hash.digest("hex"), ms: Date.now() - started };
  }
  return { hops, error: `more than ${o.maxHops} redirects`, verdict: "unreachable", retryable: false, ms: Date.now() - started };
}

/**
 * Read the URL and hash it, with retries. Returns an observation; `sha256` is
 * set only when a complete 200 body was hashed. Pass `expected` to get the
 * verdict "match"/"mismatch" filled in.
 */
export async function observe(url, { expected, ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const at = nowIso();
  const tries = [];
  let last;
  for (let i = 0; i < o.attempts; i++) {
    if (i > 0) {
      const ra = Number(last?.headers?.retryAfter);
      const wait = Number.isFinite(ra) && ra > 0 && ra <= 30 ? ra * 1000 : o.backoffMs[Math.min(i - 1, o.backoffMs.length - 1)];
      await sleep(wait);
    }
    last = await attemptOnce(url, o);
    tries.push({ at: nowIso(), status: last.status, bytes: last.bytes, error: last.error, ms: last.ms });
    if (!last.retryable) break;
  }
  const obs = { at, url, attempts: tries.length, tries, ...last };
  delete obs.retryable;
  if (obs.sha256) {
    if (expected) {
      obs.expected = expected.toLowerCase();
      obs.verdict = obs.sha256 === obs.expected ? "match" : "mismatch";
    } else {
      obs.verdict = "hashed";
    }
  }
  obs.ok = obs.verdict === "match";
  obs.why = whyOf(obs);
  return obs;
}

/** One line a human reads in the registry and on the screens. */
function whyOf(obs) {
  const size = obs.bytes !== undefined ? `${obs.bytes} bytes` : "";
  const hopsNote = obs.hops && obs.hops.length > 1 ? `, ${obs.hops.length - 1} redirect${obs.hops.length > 2 ? "s" : ""}` : "";
  switch (obs.verdict) {
    case "match": return `match (${size}${hopsNote}${obs.attempts > 1 ? `, attempt ${obs.attempts}` : ""})`;
    case "mismatch": return `published sha256 ${obs.sha256.slice(0, 10)}… ≠ agreed ${obs.expected.slice(0, 10)}… (${size}${hopsNote})`;
    case "hashed": return `hashed ${obs.sha256.slice(0, 10)}… (${size}${hopsNote})`;
    case "absent": return `HTTP ${obs.status}: nothing published at the URL yet`;
    case "forbidden": return `HTTP ${obs.status}: the URL is not public`;
    case "too-large": return `refused: ${obs.error}`;
    case "refused": return `refused: ${obs.error}`;
    default: return `unreachable after ${obs.attempts} attempt${obs.attempts > 1 ? "s" : ""}: ${obs.error}`;
  }
}

/** The delivery kind's verdict: the agreed proof is { url, sha256 }. Same shape the oracle's KINDS expect. */
export async function verifyDelivery(proof, opts = {}) {
  const obs = await observe(proof.url, { ...opts, expected: proof.sha256 });
  return { ok: obs.ok, why: obs.why, observation: obs };
}

// ------------------------------------------------------------------ journal
//
// One JSON-lines file per delivery id: observations as the verifier made them,
// and decisions as the oracle took them ("revealing the secret", "refund
// submitted"). Append-only; never rewritten.

const journalPath = (deliveryId) => {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(deliveryId)) throw new Error("bad delivery id");
  return path.join(EVIDENCE_DIR, `${deliveryId}.jsonl`);
};

export function journal(deliveryId, entry) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  appendFileSync(journalPath(deliveryId), JSON.stringify({ at: nowIso(), ...entry }) + "\n");
}

export function readJournal(deliveryId, { last = 50 } = {}) {
  const p = journalPath(deliveryId);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  return lines.slice(-last).map((l) => {
    try { return JSON.parse(l); } catch { return { raw: l }; }
  });
}

/**
 * What the oracle calls: verify, write the observation in the journal, and
 * only log a decision line when the verdict changes (a 404 polled every 4 s
 * for a week is one line, not 150 000).
 */
export async function verifyAndJournal(deliveryId, proof, opts = {}) {
  const r = await verifyDelivery(proof, opts);
  const prev = readJournal(deliveryId, { last: 1 })[0];
  const o = r.observation;
  const compact = {
    kind: "observation", verdict: o.verdict, why: o.why, status: o.status, bytes: o.bytes, sha256: o.sha256,
    hops: o.hops, etag: o.headers?.etag, lastModified: o.headers?.lastModified, contentType: o.headers?.contentType,
    attempts: o.attempts, ms: o.ms, finalUrl: o.finalUrl,
  };
  const same = prev && prev.kind === "observation" && prev.verdict === compact.verdict && prev.status === compact.status && prev.sha256 === compact.sha256 && prev.etag === compact.etag;
  if (!same) journal(deliveryId, compact);
  else journal(deliveryId, { kind: "observation", verdict: o.verdict, same: true, ms: o.ms });
  return r;
}

// CLI: node verifier.mjs <url> [expected-sha256]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [url, expected] = process.argv.slice(2);
  if (!url) {
    console.log("usage: node verifier.mjs <url> [expected-sha256]   (FREELANCE_ALLOW_PRIVATE=1 for 127.0.0.1)");
    process.exit(1);
  }
  const obs = await observe(url, { expected });
  console.log(JSON.stringify(obs, null, 2));
  process.exit(obs.ok || obs.verdict === "hashed" ? 0 : 2);
}
