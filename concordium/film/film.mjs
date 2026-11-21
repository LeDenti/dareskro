#!/usr/bin/env node
// Records every shot of the Concordium demo as its own clip (1920x1080), with the caption band
// injected at the bottom. Each clip notes when its page was ready, so montage.py can cut the
// loading time. Public pages are filmed live; terminal shots replay real captured outputs.
//   node film.mjs            -> prises/<scene>_<n>.webm + prises/plans.json
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '/Users/jul/dareskro/presentation/video/node_modules/playwright/index.mjs';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const P = path.join(ICI, 'prises'); mkdirSync(P, { recursive: true });
const SCRIPT = JSON.parse(readFileSync(path.join(ICI, 'script.json'), 'utf8'));
const DUR = JSON.parse(readFileSync(path.join(ICI, 'durees.json'), 'utf8'));
const W = 1920, H = 1080, MARGE = 1.6;
const page = (n, q = '') => pathToFileURL(path.join(ICI, 'pages', n)).href + q;
const tx = (h) => `https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${h}`;
const log = (n) => readFileSync(path.join(ICI, 'logs', `${n}.txt`), 'utf8').replace(/\n+$/, '').split('\n');
const proprietairePage = pathToFileURL(path.join(ICI, '..', 'verification', 'public', 'index.html')).href;

// shot: { url, part (share of the scene), prep(page) after load, anim(page, seconds) while held }
// replay speed fitted to the shot: everything is on screen by 75 % of the shot
const termine = (nom) => ({ url: page('terminal.html'), anim: async (p, s) => {
  const l = log(nom), cmds = l.filter((x) => x.startsWith('$')), frappe = cmds.reduce((a, x) => a + (x.length / 3) * 12, 0);
  const ms = Math.max(60, (s * 1000 * 0.75 - frappe) / (cmds.length + 0.55 * (l.length - cmds.length)));
  return p.evaluate(([x, m]) => window.rejouer(x, m), [l, ms]); } });
const defile = (px) => async (p, s) => { const pas = 30, n = Math.max(1, Math.floor((s * 1000) / pas)); for (let i = 0; i < n; i++) { await p.mouse.wheel(0, px / n); await p.waitForTimeout(pas); } };
const PLAN = {
  titre: [{ url: page('carte.html', '?id=titre'), part: 1 }],
  existant: [{ url: page('carte.html', '?id=existant'), part: 1 }],
  proprietaire: [
    { url: proprietairePage, part: 0.55, prep: async (p) => p.evaluate(() => { const e = document.getElementById('etat'); e.className = 'ok';
        e.textContent = 'Verified: a human over 18 owns agent 1345 (account 3f3W8fwh..., owner: yes). Record 6f6b999a5609...';
        document.body.style.zoom = '1.9'; }) },
    { url: tx('6f6b999a56096191ee83f2d0048a8800472a0ea496de49db5d91c1d7a58dd3ca'), part: 0.45 }],
  registre: [
    { url: page('carte_agent.html'), part: 0.45, prep: async (p) => {
        const u = 'https://raw.githubusercontent.com/LeDenti/dareskro/main/concordium/carte/agent-card.v3.json';
        const c = await (await fetch(u)).json(); await p.evaluate(([x, y]) => window.afficher(x, y), [c, u]); } },
    { url: page('badge.html'), part: 0.55, prep: async (p) => {
        const d = await (await fetch('https://agent-registry-mcp.concordium.com/v1/check-badge/JyP9V7ZjVu29m1xTU1KDH')).json();
        await p.evaluate((x) => window.afficher(x), d); } }],
  rails: [
    { url: 'https://testnet.ccdscan.io/?dcount=1&dentity=account&daddress=4ATXveK2NKvMYSruV7rxKTWmz5Gm4mchtJAEPNToz5UfqHQuzr', part: 0.45 },
    { url: tx('7618fc2f22bf9ad0d1c1b61b0d3c06787c582b0943faff4c7b1b1c018fd8b88a'), part: 0.55 }],
  cycle: [{ ...termine('cycle'), part: 0.68 }, { url: tx('e57122b6b4fbae7b56429308149b5a6bedf674c364f904fa89d9b9e4bad4e4e0'), part: 0.32 }],
  collecteur: [{ ...termine('collecteur'), part: 1 }],
  paiement: [{ ...termine('paiement'), part: 0.5 }, { url: tx('febf17b2779930804050265e9886dc20ce4a4868b6e5727f1389dca5ae1aa10f'), part: 0.5 }],
  journal: [{ ...termine('journal'), part: 0.55 }, { url: tx('52ce72c9f9283f4bc464478ad84c70c67f7bcf83d1c28eb091c66ea6074ce662'), part: 0.45 }],
  production: [{ url: page('carte.html', '?id=production'), part: 1 }],
  fin: [{ url: page('carte.html', '?id=fin'), part: 1 }],
};

const bandeau = (texte) => `(() => { const mk = () => { if (document.getElementById('__cap')) return;
  const b = document.createElement('div'); b.id = '__cap';
  b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:120px;z-index:2147483647;background:#0b0d14;border-top:2px solid #3ee0a1;color:#eef0f5;display:flex;align-items:center;padding:0 60px;font:500 27px/1.3 -apple-system,Helvetica,Arial,sans-serif';
  b.textContent = ${JSON.stringify(texte)}; document.documentElement.appendChild(b); };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mk); else mk(); })();`;

const filtre = process.argv[2];
const navigateur = await chromium.launch({ channel: 'chrome' });
const plans = {};
for (const sc of SCRIPT) {
  if (filtre && sc.id !== filtre) continue;
  const total = DUR[sc.id] + MARGE; plans[sc.id] = [];
  for (const [n, s] of (PLAN[sc.id] ?? []).entries()) {
    const dir = path.join(P, `.v_${sc.id}_${n}`); rmSync(dir, { recursive: true, force: true });
    const ctx = await navigateur.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'dark',
      recordVideo: { dir, size: { width: W, height: H } } });
    await ctx.addInitScript(bandeau(sc.caption));
    const pg = await ctx.newPage(); const t0 = Date.now();
    await pg.goto(s.url, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
    if (/ccdscan/.test(s.url)) { await pg.waitForTimeout(3500); await pg.evaluate(() => { document.body.style.zoom = '1.45'; }); await pg.waitForTimeout(500); }
    if (s.prep) await s.prep(pg);
    await pg.waitForTimeout(400);
    const pret = (Date.now() - t0) / 1000, duree = total * s.part;
    const anim = s.anim ? s.anim(pg, duree) : Promise.resolve();
    await Promise.all([anim, pg.waitForTimeout(duree * 1000)]);
    await pg.waitForTimeout(300);
    await ctx.close();
    const f = readdirSync(dir).find((x) => x.endsWith('.webm'));
    const dest = path.join(P, `${sc.id}_${n}.webm`); renameSync(path.join(dir, f), dest); rmSync(dir, { recursive: true, force: true });
    plans[sc.id].push({ fichier: dest, debut: pret, duree });
    console.log(sc.id, n, `ready at ${pret.toFixed(1)} s, held ${duree.toFixed(1)} s`);
  }
}
await navigateur.close();
const ancien = (() => { try { return JSON.parse(readFileSync(path.join(P, 'plans.json'), 'utf8')); } catch { return {}; } })();
writeFileSync(path.join(P, 'plans.json'), JSON.stringify({ ...ancien, ...plans }, null, 1));
