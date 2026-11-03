/** Read the deliverable the way the oracle reads a proof on XRPL: one GET, the bytes, their hash. */
import { sha256 } from "./gate.mjs";

const MAX_BYTES = 2_000_000;

export async function fetchDeliverable(url) {
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "dareskro-paypal-seat/0.1 (+https://github.com/LeDenti/dareskro)" } });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) return { ok: false, url, status: res.status, why: `HTTP ${res.status}` };
    if (buf.length > MAX_BYTES) return { ok: false, url, status: res.status, why: `${buf.length} bytes, over the ${MAX_BYTES} limit` };
    const type = res.headers.get("content-type") ?? "";
    const text = /^(text\/|application\/(json|xml|javascript))/.test(type) || !type ? buf.toString("utf8") : null;
    return { ok: true, url, finalUrl: res.url, status: res.status, bytes: buf.length, sha256: sha256(buf), contentType: type, text };
  } catch (e) {
    return { ok: false, url, status: 0, why: e.message };
  }
}
