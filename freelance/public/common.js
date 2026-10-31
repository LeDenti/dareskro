// Shared by the client's desk and the freelancer's page. No framework: a desk is a form and a poll.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (s) => (s && s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s ?? "");
const txLink = (explorer, h, label) => (h ? `<a href="${explorer}/transactions/${h}" target="_blank" rel="noopener">${esc(label ?? short(h))}</a>` : "");
const accLink = (explorer, a, label) => `<a href="${explorer}/accounts/${a}" target="_blank" rel="noopener">${esc(label ?? a)}</a>`;
const RIPPLE_EPOCH = 946684800;
const fromRipple = (t) => new Date((t + RIPPLE_EPOCH) * 1000);
const fmtDate = (d) => { const x = new Date(d); return `${x.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (${x.toISOString().slice(0, 16).replace("T", " ")} UTC)`; };
const countdown = (d) => {
  const s = Math.round((new Date(d).getTime() - Date.now()) / 1000);
  if (s <= 0) return "passed";
  if (s < 90) return `${s} s to go`;
  if (s < 5400) return `${Math.round(s / 60)} min to go`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h to go`;
  return `${Math.round(s / 86400)} days to go`;
};
const fmtBytes = (n) => (n === undefined ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`);
async function api(path, body) {
  const r = await fetch(`/api${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) { const e = new Error(j.error ?? `HTTP ${r.status}`); e.status = r.status; e.json = j; throw e; }
  return j;
}
async function sha256File(file) {
  const buf = await file.arrayBuffer();
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** The oracle's view of one milestone, as a sentence with links. */
function oracleLine(v, explorer, who) {
  const o = v.oracle;
  if (!o) return v.status === "locked" ? `<span class="pending">locked; the oracle has not registered it yet${v.handed && v.handed.ok === false ? ` (${esc(v.handed.error ?? "hand-off failed")})` : ""}</span>` : "";
  if (o.status === "finished") return `<span class="ok">paid: the oracle revealed the secret — ${txLink(explorer, o.finishHash, "EscrowFinish + Fulfillment")}${o.acceptHash ? `, after the client's ${txLink(explorer, o.acceptHash, "signed acceptance")}` : ""}${o.lastWhy ? ` · ${esc(o.lastWhy)}` : ""}</span>`;
  if (o.status === "expired-refunded") return `<span class="ko">deadline passed without proof: the ${who} is refunded — ${txLink(explorer, o.refundHash, "EscrowCancel")}</span>`;
  if (o.status === "failed") return `<span class="ko">the oracle gave up (${esc(o.lastResult ?? o.note ?? "?")}); after the deadline anyone can still cancel the escrow and refund the ${who}</span>`;
  if (o.status === "gone") return `<span class="muted">nothing left to do: ${esc(o.note)}</span>`;
  if (v.proof.mode === "hash") return `<span class="pending">watching the URL · ${o.checks ?? 0} looks · ${esc(o.lastWhy ?? "no look yet")}${o.lastCheck ? ` · last ${new Date(o.lastCheck).toISOString().slice(11, 19)} UTC` : ""}</span>`;
  return o.accepted ? `<span class="pending">acceptance seen on the ledger (${txLink(explorer, o.accepted.hash)}), releasing on the next tick</span>` : `<span class="pending">waiting for the client's signed acceptance · refund at the deadline otherwise</span>`;
}
function journalList(entries, explorer) {
  if (!entries || !entries.length) return "";
  return `<ul class="journal">${entries.map((e) => {
    const t = (e.at ?? "").slice(11, 19);
    if (e.kind === "observation" && e.same) return `<li>${t} observation unchanged (${e.ms} ms)</li>`;
    if (e.kind === "observation" || e.kind === "check") return `<li>${t} ${e.kind}${e.by ? ` by ${esc(e.by)}` : ""}: <b>${esc(e.verdict)}</b> — ${esc(e.why)}${e.hops && e.hops.length > 1 ? ` · ${e.hops.length - 1} redirect(s)` : ""}${e.etag ? ` · etag ${esc(e.etag)}` : ""}</li>`;
    if (e.kind === "decision") return `<li>${t} <b>decision: ${esc(e.decision)}</b> — ${esc(e.why ?? e.by ?? "")} ${e.result ? esc(e.result) : ""} ${txLink(explorer, e.hash)}</li>`;
    if (e.kind === "lock") return `<li>${t} <b>locked</b> ${esc(e.amountXrp)} XRP, escrow ${esc(e.escrow)} ${txLink(explorer, e.hash)}${e.handedToOracle ? ", handed to the oracle" : ""}</li>`;
    if (e.kind === "acceptance-signed") return `<li>${t} <b>client signed the acceptance</b> ${txLink(explorer, e.hash)} · oracle ${e.oracle?.status ?? "?"}</li>`;
    return `<li>${t} ${esc(JSON.stringify(e))}</li>`;
  }).join("")}</ul>`;
}
