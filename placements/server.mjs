#!/usr/bin/env node
/**
 * Placement campaign service — the advertiser's back office and the creator's
 * page, in front of the dareskro oracle.
 *
 *   node server.mjs            http://127.0.0.1:8789
 *
 * It stores campaigns (campaigns.json, public: no secret ever lands here), asks
 * the oracle for the condition when a campaign is created, hands the escrow to
 * the oracle once the advertiser has locked it, and shows each side what the
 * oracle has seen. It holds no key and signs nothing: the advertiser signs the
 * EscrowCreate on its own device (the desk, app/) or with its own wallet
 * (demo_bottomradar.mjs); the oracle signs the finish or the refund.
 *
 * ROUTES (JSON unless said otherwise; CORS open for the desk on 5173)
 *   GET  /campaigns                     all campaigns, with the oracle's state
 *   POST /campaigns                     create: { creator:{address,handle?,name?}, url,
 *                                       mustContain, amountXrp, periodEnd, deadline?,
 *                                       advertiser?:{name,address}, publicUrl?, probeEveryS?, note? }
 *                                       → the campaign, with condition, deliveryId, memos,
 *                                       finishAfter/cancelAfter (ripple times)
 *   GET  /campaigns/<id>                one campaign + oracle entry + observations + status
 *   POST /campaigns/<id>/observe        look at the URL now (before locking: is the text there?)
 *   POST /campaigns/<id>/locked         { owner, sequence, createHash } → oracle /watch
 *   GET  /c/<id>                        the creator's page (HTML, French): what to publish,
 *                                       when it is paid, the escrow on the explorer, the
 *                                       oracle's last look
 *   GET  /                              the list (HTML)
 *
 * ENV  PLACEMENTS_PORT (8789) · ORACLE_URL (http://127.0.0.1:8787) ·
 *      PUBLIC_URL (base of the links given to creators, default this server) ·
 *      PROBE_EVERY_S (300: how often the oracle looks before the date)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { explorerAccount, explorerTx, fromRippleTime, memosFor, newCampaign, statusOf, watchBody } from "./campaign.mjs";
import { observe } from "./presence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, "campaigns.json");
const PORT = Number(process.env.PLACEMENTS_PORT || 8789);
const ORACLE = process.env.ORACLE_URL || "http://127.0.0.1:8787";
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const PROBE_EVERY_S = Number(process.env.PROBE_EVERY_S || 300);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const load = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { campaigns: [] });
const save = (db) => writeFileSync(STORE, JSON.stringify(db, null, 2));

// ------------------------------------------------------------------ oracle

async function oracleGet(p) {
  const r = await fetch(ORACLE + p, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`oracle GET ${p}: HTTP ${r.status}`);
  return r.json();
}
async function oraclePost(p, body) {
  const r = await fetch(ORACLE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { error: text.slice(0, 200) }; }
  if (!r.ok) {
    const err = new Error(`oracle POST ${p}: HTTP ${r.status} — ${j.error ?? text}`);
    err.status = 502;
    throw err;
  }
  return j;
}
async function oracleIdentity() {
  try { return await oracleGet("/identity"); } catch { return undefined; }
}
async function oracleEntry(c) {
  if (!c.escrow) return undefined;
  try {
    return (await oracleGet("/escrows")).escrows.find((e) => e.owner === c.escrow.owner && e.sequence === c.escrow.sequence);
  } catch {
    return undefined;
  }
}
async function observations(c, last) {
  if (!c.deliveryId) return [];
  try {
    return (await oracleGet(`/observations/${c.deliveryId}${last ? `?last=${last}` : ""}`)).observations;
  } catch {
    return [];
  }
}

/** The campaign as the API gives it: the record, the oracle's view, the links. */
async function view(c, { withObservations = true } = {}) {
  const entry = await oracleEntry(c);
  const obs = withObservations ? await observations(c, 200) : undefined;
  return {
    ...c,
    status: statusOf(c, entry),
    oracle: entry ?? null,
    observations: obs,
    links: {
      creator: `${PUBLIC_URL}/c/${c.id}`,
      api: `${PUBLIC_URL}/campaigns/${c.id}`,
      escrow: c.escrow ? explorerTx(c.escrow.createHash) : null,
      release: entry?.finishHash ? explorerTx(entry.finishHash) : null,
      refund: entry?.refundHash ? explorerTx(entry.refundHash) : null,
      creatorAccount: explorerAccount(c.contract.creator.address),
      oracleAccount: c.contract.oracle ? explorerAccount(c.contract.oracle) : null,
    },
  };
}

// ------------------------------------------------------------------ http

const json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body, null, 2));
};
const html = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
    });
  });

async function createCampaign(input) {
  const id = await oracleIdentity();
  if (!id) {
    const err = new Error(`no oracle at ${ORACLE}: start it with "cd oracle && node oracle.mjs watch"`);
    err.status = 503;
    throw err;
  }
  const c = newCampaign(input, { oracle: id.address });
  const probeEveryS = Number.isInteger(input.probeEveryS) ? Math.max(10, input.probeEveryS) : PROBE_EVERY_S;
  // the oracle issues the condition and keeps the secret; what it agreed to (url + text) comes back as `proof`
  const cond = await oraclePost("/condition", {
    kind: "presence",
    url: c.contract.publication.url,
    mustContain: c.contract.publication.mustContain,
    note: `placement ${c.id} · ${c.contract.advertiser.name} → ${c.contract.creator.handle ?? c.contract.creator.address}`,
  });
  const stored = { ...c, deliveryId: cond.deliveryId, condition: cond.condition, proof: cond.proof, probeEveryS, memos: memosFor(c), memosCompact: memosFor(c, { compact: true }) };
  const db = load();
  db.campaigns.push(stored);
  save(db);
  log(`campaign ${c.id}: ${c.contract.amountXrp} XRP for ${c.contract.publication.url} containing "${c.contract.publication.mustContain}", checked at ${c.contract.periodEnd}, refund after ${c.contract.deadline} — condition ${cond.condition.slice(0, 16)}…`);
  return stored;
}

async function markLocked(c, body) {
  const { owner, sequence, createHash } = body;
  if (typeof owner !== "string" || !Number.isInteger(sequence) || !/^[0-9A-F]{64}$/i.test(createHash ?? "")) {
    const err = new Error("need owner (r…), sequence (integer) and createHash (64 hex)");
    err.status = 400;
    throw err;
  }
  if (c.escrow && (c.escrow.owner !== owner || c.escrow.sequence !== sequence)) {
    const err = new Error(`campaign already locked by escrow ${c.escrow.owner}#${c.escrow.sequence}`);
    err.status = 409;
    throw err;
  }
  const w = await oraclePost("/watch", watchBody(c, { owner, sequence, createHash: createHash.toUpperCase() }));
  c.escrow = { owner, sequence, createHash: createHash.toUpperCase(), lockedAt: new Date().toISOString() };
  c.status = "locked";
  log(`campaign ${c.id}: locked by ${owner}#${sequence} — ${explorerTx(c.escrow.createHash)} — oracle ${w.note ?? "watching"}`);
  return w;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const fmtParis = (iso) => new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full", timeStyle: "short" }) + " (Paris)";

const STATUS_FR = {
  draft: ["Brouillon", "L’annonceur n’a pas encore verrouillé le paiement."],
  locked: ["Verrouillé", "Le paiement est dans l’escrow ; l’oracle va commencer à observer."],
  watching: ["Observé", "Le paiement est verrouillé. L’oracle regarde la publication jusqu’à la date : rien ne peut être payé avant."],
  deciding: ["Décision en cours", "La date est passée : l’oracle lit la publication et décide."],
  released: ["Payé", "La publication était en ligne à la date : l’oracle a libéré le paiement vers le créateur."],
  refunded: ["Remboursé", "La publication n’était pas en ligne (ou sans le texte convenu) : l’annonceur a été remboursé à la date limite."],
  gone: ["Terminé par un tiers", "L’escrow n’existe plus : quelqu’un d’autre l’a terminé ou annulé."],
  failed: ["Échec", "L’oracle a renoncé ; l’escrow reste sur le registre, voir l’explorateur."],
};

/** The creator's page: no login, nothing to click, everything verifiable on the explorer. */
function creatorPage(v) {
  const p = v.contract.publication;
  const [stLabel, stText] = STATUS_FR[v.status] ?? [v.status, ""];
  const last = v.observations?.at(-1);
  const platform = { x: "X (Twitter)", youtube: "YouTube", web: "page web" }[p.platform] ?? p.platform;
  const rows = (v.observations ?? []).slice(-12).reverse().map((o) => `<tr><td>${esc(o.at?.replace("T", " ").slice(0, 19))} UTC</td><td>${o.phase === "decision" ? "décision" : "observation"}</td><td class="${o.ok ? "ok" : "ko"}">${o.ok ? "en ligne avec le texte" : o.live ? "en ligne SANS le texte" : "hors ligne"}</td><td class="muted">${esc(o.why)}</td><td class="mono">${esc((o.bodySha256 ?? "").slice(0, 12))}</td></tr>`).join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Placement ${esc(v.id)} — ${esc(v.contract.advertiser.name)}</title>
<style>
:root{color-scheme:light dark;--ok:#0a7d32;--ko:#c4171d;--muted:#777;--line:#ddd}
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:860px;margin:0 auto;padding:24px 16px;line-height:1.5}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}.lead{color:var(--muted);margin:0 0 20px}
.status{display:inline-block;padding:6px 12px;border-radius:999px;font-weight:700;background:#eee;color:#111}
.status.released{background:#d9f3e1;color:var(--ok)}.status.refunded,.status.failed{background:#fde2e2;color:var(--ko)}.status.watching,.status.deciding,.status.locked{background:#fff1dc;color:#9a4b00}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:12px 0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
code,.mono{font-family:ui-monospace,SF Mono,Menlo,monospace;font-size:.9em}.ok{color:var(--ok);font-weight:600}.ko{color:var(--ko);font-weight:600}.muted{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}
.box{border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}.big{font-size:28px;font-weight:800}
a{color:inherit}footer{margin-top:36px;color:var(--muted);font-size:13px}
</style></head><body>
<h1>${esc(v.contract.advertiser.name)} vous paie pour en parler</h1>
<p class="lead">Campagne <code>${esc(v.id)}</code> · <span class="status ${esc(v.status)}">${esc(stLabel)}</span></p>
<p>${esc(stText)}</p>

<div class="box">
<h2 style="margin-top:0">Ce que vous publiez</h2>
<dl>
<dt>Où</dt><dd><a href="${esc(p.url)}" rel="noopener" target="_blank">${esc(p.url)}</a> <span class="muted">(${esc(platform)})</span></dd>
<dt>Texte obligatoire</dt><dd><code>${esc(p.mustContain)}</code> — il doit être dans la publication <b>et y rester</b> jusqu’à la date de vérification.</dd>
<dt>Montant</dt><dd><span class="big">${esc(v.contract.amountXrp)} XRP</span> <span class="muted">(testnet)</span></dd>
<dt>Vérifié le</dt><dd>${esc(fmtParis(v.contract.periodEnd))}</dd>
<dt>Payé</dt><dd>automatiquement, juste après cette date, si la publication est encore en ligne avec le texte. Personne ne peut payer avant, pas même l’annonceur.</dd>
<dt>Sinon</dt><dd>publication supprimée ou texte retiré : l’annonceur est remboursé après le ${esc(fmtParis(v.contract.deadline))}. Personne ne garde l’argent entre les deux.</dd>
<dt>Vers</dt><dd><a href="${esc(v.links.creatorAccount)}" target="_blank" rel="noopener"><code>${esc(v.contract.creator.address)}</code></a> — votre adresse XRPL, écrite dans l’escrow à la création : elle ne peut plus changer.</dd>
</dl>
</div>

<h2>Où est l’argent</h2>
${v.escrow
    ? `<p>Verrouillé sur le XRP Ledger le ${esc(fmtParis(v.escrow.lockedAt))} : <a href="${esc(v.links.escrow)}" target="_blank" rel="noopener">voir l’escrow sur l’explorateur</a> (compte <code>${esc(v.escrow.owner)}</code>, n° ${esc(v.escrow.sequence)}).</p>`
    : `<p class="muted">Pas encore verrouillé : l’annonceur n’a pas signé l’escrow. Ne publiez pas avant que cette ligne change.</p>`}
${v.links.release ? `<p class="ok">Payé : <a href="${esc(v.links.release)}" target="_blank" rel="noopener">transaction de libération</a>, signée par l’oracle avec le secret.</p>` : ""}
${v.links.refund ? `<p class="ko">Remboursé à l’annonceur : <a href="${esc(v.links.refund)}" target="_blank" rel="noopener">transaction d’annulation</a>.</p>` : ""}

<h2>Ce que l’oracle a vu</h2>
<p class="muted">L’oracle <a href="${esc(v.links.oracleAccount ?? "#")}" target="_blank" rel="noopener"><code>${esc(v.contract.oracle)}</code></a> lit la publication comme n’importe qui, sans compte ni clé. Il ne détient jamais l’argent ; il ne peut que révéler un secret à la date, ou laisser rembourser.</p>
${last ? `<p>Dernier regard, ${esc(last.at?.replace("T", " ").slice(0, 19))} UTC : <span class="${last.ok ? "ok" : "ko"}">${esc(last.why)}</span></p>` : `<p class="muted">Aucune observation encore.</p>`}
${rows ? `<table><tbody>${rows}</tbody></table>` : ""}

<h2>Le contrat, mot pour mot</h2>
<p class="muted">Son empreinte SHA-256 est écrite dans l’escrow (mémo <code>dareskro/placement-sha256</code>) : <code>${esc(v.contractSha256)}</code>. Recalculez-la sur le JSON ci-dessous pour vérifier que rien n’a changé.</p>
<details><summary>Afficher le JSON</summary><pre class="mono" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(v.contract))}</pre></details>

<footer>dareskro — l’escrow décide, l’oracle exécute. Page rafraîchie toutes les 60 s · <a href="${esc(v.links.api)}">JSON</a> · <a href="https://github.com/LeDenti/dareskro">code source</a></footer>
</body></html>`;
}

function listPage(vs) {
  const rows = vs.map((v) => `<tr><td><a href="/c/${esc(v.id)}"><code>${esc(v.id)}</code></a></td><td>${esc(v.contract.creator.handle ?? v.contract.creator.address.slice(0, 10) + "…")}</td><td><a href="${esc(v.contract.publication.url)}" target="_blank" rel="noopener">${esc(v.contract.publication.url.slice(0, 60))}</a></td><td>${esc(v.contract.amountXrp)} XRP</td><td>${esc(v.contract.periodEnd.slice(0, 16).replace("T", " "))}Z</td><td>${esc(v.status)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>dareskro placements</title><style>body{font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px 16px}table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 8px;border-top:1px solid #ddd;text-align:left}code{font-family:ui-monospace,Menlo,monospace}</style></head><body><h1>Placement campaigns</h1><p>${vs.length} campaign(s). The advertiser's desk is the pay desk (app/, case "Placement"); each row is a creator page.</p><table><thead><tr><th>id</th><th>creator</th><th>publication</th><th>amount</th><th>checked at (UTC)</th><th>status</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    const u = new URL(req.url, "http://x");
    const parts = u.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && parts.length === 0) {
      const db = load();
      return html(res, 200, listPage(await Promise.all(db.campaigns.map((c) => view(c, { withObservations: false })))));
    }
    if (req.method === "GET" && parts[0] === "campaigns" && parts.length === 1) {
      const db = load();
      return json(res, 200, { campaigns: await Promise.all(db.campaigns.map((c) => view(c, { withObservations: false }))) });
    }
    if (req.method === "POST" && parts[0] === "campaigns" && parts.length === 1) {
      const c = await createCampaign(await readBody(req));
      return json(res, 201, await view(c));
    }
    if (parts[0] === "campaigns" && parts.length >= 2) {
      const db = load();
      const c = db.campaigns.find((x) => x.id === parts[1]);
      if (!c) return json(res, 404, { error: "unknown campaign" });
      if (req.method === "GET" && parts.length === 2) return json(res, 200, await view(c));
      if (req.method === "POST" && parts[2] === "observe") {
        const obs = await observe(c.contract.publication.url, c.contract.publication.mustContain);
        c.preChecks = [...(c.preChecks ?? []).slice(-9), obs];
        save(db);
        log(`campaign ${c.id}: looked now — ${obs.ok ? "OK" : "NO"} ${obs.why}`);
        return json(res, 200, obs);
      }
      if (req.method === "POST" && parts[2] === "locked") {
        const w = await markLocked(c, await readBody(req));
        save(db);
        return json(res, 200, { ok: true, note: w.note, campaign: await view(c) });
      }
    }
    if (req.method === "GET" && parts[0] === "c" && parts.length === 2) {
      const c = load().campaigns.find((x) => x.id === parts[1]);
      if (!c) return html(res, 404, "<h1>Campagne inconnue</h1>");
      return html(res, 200, creatorPage(await view(c)));
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) log("error:", err.message);
    json(res, status, { error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", () => log(`placements listening on http://127.0.0.1:${PORT} — oracle ${ORACLE} — creator links on ${PUBLIC_URL}`));
