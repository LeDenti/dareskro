#!/usr/bin/env node
/**
 * Films the sandbox measurement as it was logged: the seven shapes, one after the other, every line
 * the demo printed on 3 November 2026 against the real PayPal sandbox (the ids are PayPal's), typed
 * out in a terminal window and recorded by Playwright, then turned into an mp4 by ffmpeg.
 *
 *   node enregistre.mjs                → sortie/film_sandbox_<date>.mp4 (+ .png of the last frame)
 *   node enregistre.mjs --dest ~/Desktop/dareskro/dareskro-videos   also copies the mp4 there
 *   node enregistre.mjs --clip delivery --seconds 12 --size 1280x720   one shape only, fitted to N seconds (an insert for a film)
 *
 * Nothing is replayed against PayPal: the film reads sortie/mesure_<shape>.log. The approvals that a
 * human made on PayPal's page appear as a pause with the order's approve link, as they happened.
 * Needs: presentation/video's Playwright (chromium) and ffmpeg.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../presentation/video/node_modules/playwright/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "sortie");
const SHAPES = ["payroll", "delivery", "presence", "affiliate", "pool", "vault", "advance"];
const TITLES = {
  payroll: "1. payroll — the date decides, one approval, three payouts",
  delivery: "2. delivery — the AI reads, a human validates",
  presence: "3. presence — the post must be live at the date",
  affiliate: "4. affiliate — the merchant's token, given once",
  pool: "5. pool — several payers, the filling share trimmed",
  vault: "6. vault — a deposit decided 2 of 3, and custody",
  advance: "7. advance — AI + policy + operator, 2 of 3 sign",
};
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const DEST = arg("--dest")?.replace(/^~/, process.env.HOME) ?? null;
const CLIP = arg("--clip"); // one shape, fitted to --seconds
const SECONDS = Number(arg("--seconds") || 12);
const [W, H] = (arg("--size") || "1280x900").split("x").map(Number);
const FONT = Number(arg("--font") || (CLIP ? 20 : 15));
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const base = path.join(OUT, CLIP ? `extrait_${CLIP}_${SECONDS}s` : `film_sandbox_${stamp}`);
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)}  ${s}`);

// ---- the script of the film: every logged line, with pauses where a human clicked or the date was waited for
const lines = [];
let header = null;
for (const shape of CLIP ? [CLIP] : SHAPES) {
  const f = path.join(OUT, `mesure_${shape}.log`);
  if (!existsSync(f)) throw new Error(`no ${f}: run DEMO_ONLY=${shape} node demo_paypal.mjs first`);
  const raw = readFileSync(f, "utf8").split("\n");
  header ??= raw.find((l) => l.startsWith("dareskro · PayPal rail"));
  lines.push({ kind: "title", text: TITLES[shape], pause: 900 });
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i];
    if (!l.trim() || /^dareskro · PayPal rail|^1\. |^Report:|^EXIT/.test(l)) continue;
    if (l.includes("▶ As the sandbox BUYER")) {
      lines.push({ kind: "ask", text: l.trim(), pause: 300 });
      const url = (raw[i + 1] || "").trim();
      if (url.startsWith("http")) { lines.push({ kind: "url", text: url, pause: 1400 }); i += 1; }
      lines.push({ kind: "human", text: "⏸ a human approves on PayPal's page, with a sandbox Personal account — minutes pass", pause: 1600 });
      continue;
    }
    if (l.includes("… the date is in")) { lines.push({ kind: "wait", text: `${l.trim()} — cut`, pause: 1200 }); continue; }
    if (l.startsWith("All steps as expected")) { lines.push({ kind: "ok", text: "All steps as expected.", pause: 1300 }); continue; }
    if (l.startsWith("SOME STEPS")) { lines.push({ kind: "bad", text: l.trim(), pause: 1300 }); continue; }
    const sub = /^\s{6}/.test(l);
    lines.push({ kind: l.includes("✗") ? "bad" : sub ? "sub" : "step", text: l.replace(/^\s+/, sub ? "      " : "  "), pause: sub ? 650 : 1000 });
  }
}
const steps = lines.filter((x) => x.kind === "step" || x.kind === "sub").length;
if (CLIP) {
  // an insert: drop the approve link and the human pause, fit the rest to SECONDS (typing at 2 ms per 2 chars + an even pause)
  const keep = lines.filter((x) => !["ask", "url", "human", "wait"].includes(x.kind));
  lines.length = 0;
  lines.push(...keep);
  const typing = keep.reduce((a, x) => a + Math.ceil(x.text.length / 2) * 4, 0); // a browser's shortest sleep is ~4 ms
  const pause = Math.max(150, Math.floor((SECONDS * 1000 - 800 - typing) / keep.length));
  for (const x of keep) x.pause = pause;
  keep.at(-1).pause = pause + 600;
}
if (!CLIP) lines.push({ kind: "end", text: `7 shapes · ${steps} checks · every hold, capture, void and payout is PayPal's own id · every payout SUCCESS at PayPal · registry: sortie/missions.json`, pause: 4500 });

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const html = `<!doctype html><meta charset="utf-8"><title>dareskro · PayPal — sandbox, measured</title>
<style>
  html,body{margin:0;background:#0b0e14;color:#d6dbe3;font:${FONT}px/1.45 "SF Mono",Menlo,Consolas,monospace;height:100%}
  #bar{font-size:13px;white-space:nowrap;overflow:hidden;position:fixed;top:0;left:0;right:0;height:46px;background:#141a24;border-bottom:1px solid #263040;display:flex;align-items:center;padding:0 18px;gap:14px}
  #bar b{color:#fff;font-weight:600}#bar span{color:#8a94a6}
  #bar i{margin-left:auto;font-style:normal;color:#8a94a6}
  #t{padding:62px 22px 40px;white-space:pre-wrap;word-break:break-word}
  .title{color:#f2c94c;font-weight:600;margin-top:14px}
  .step{color:#d6dbe3}.sub{color:#8a94a6}.ok{color:#5fd38d;font-weight:600}.bad{color:#ff6b6b}
  .ask{color:#8ab4ff}.url{color:#8ab4ff;text-decoration:underline}.human{color:#f2c94c;background:#1c2230;display:inline-block;padding:2px 8px;border-radius:4px;margin:4px 0 4px 10px}
  .wait{color:#8a94a6;font-style:italic}
  .end{display:block;margin-top:18px;padding:12px 14px;border:1px solid #2f3a4c;border-radius:6px;background:#121823;color:#fff}
  .cursor{display:inline-block;width:9px;height:17px;background:#d6dbe3;vertical-align:-3px;animation:b 1s steps(2) infinite}@keyframes b{to{visibility:hidden}}
</style>
<div id="bar"><b>dareskro · PayPal rail</b><span>${esc(header || "sandbox")}</span><i>3 November 2026 · the log of the measurement, as printed</i></div>
<div id="t"></div><span class="cursor" id="c"></span><div id="sp" style="height:${CLIP ? 100 : 0}px"></div>
<script>
const L=${JSON.stringify(lines)};const CLIP_MS=${CLIP ? SECONDS * 1000 : 0};
const t=document.getElementById("t"),c=document.getElementById("c"),sp=document.getElementById("sp");
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  await sleep(${CLIP ? 400 : 1200});
  const t0=performance.now();
  for(let k=0;k<L.length;k++){const l=L[k];
    const d=document.createElement("div");d.className=l.kind;t.appendChild(d);t.appendChild(c);t.appendChild(sp);
    const perChar=${CLIP ? 2 : 0}||(l.kind==="url"||l.kind==="ask"?3:l.kind==="title"||l.kind==="end"?14:5);
    for(let i=1;i<=l.text.length;i++){d.textContent=l.text.slice(0,i);if(i%2===0)await sleep(perChar);sp.scrollIntoView({block:"end"});}
    if(CLIP_MS){const left=L.length-k-1;const charsLeft=L.slice(k+1).reduce((a,x)=>a+x.text.length,0);const remaining=CLIP_MS-300-(performance.now()-t0)-charsLeft*2.2;await sleep(Math.max(80,left?remaining/left:remaining));}else await sleep(l.pause);
  }
  window.__done=true;
})();
</script>`;

mkdirSync(OUT, { recursive: true });
const videoDir = path.join(OUT, `.video_${stamp}`);
let browser;
// headless, bundled chromium: no "controlled by automated software" bar, which would push the page down and leave a grey band in the film
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: "chrome" }); }
const RH = CLIP ? H + 100 : H;
const context = await browser.newContext({ viewport: { width: W, height: RH }, recordVideo: { dir: videoDir, size: { width: W, height: RH } } });
const page = await context.newPage();
say(`${lines.length} lines to type, ${steps} checks`);
await page.setContent(html, { waitUntil: "load" });
await page.waitForFunction(() => window.__done === true, null, { timeout: 15 * 60_000 });
await page.screenshot({ path: `${base}.png` });
await context.close();
await browser.close();
const webm = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
await new Promise((r) => spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(videoDir, webm), ...(CLIP ? ["-ss", "0.4", "-t", String(SECONDS), "-vf", `crop=${W}:${H}:0:0`, "-an"] : []), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${base}.mp4`], { stdio: "inherit" }).on("exit", r));
rmSync(videoDir, { recursive: true, force: true });
if (!CLIP) copyFileSync(`${base}.mp4`, path.join(OUT, "film_sandbox.mp4"));
say(`film → ${base}.mp4`);
if (DEST) { mkdirSync(DEST, { recursive: true }); const name = CLIP ? `dareskro_paypal_extrait_${CLIP}_${SECONDS}s.mp4` : "dareskro_paypal_sandbox.mp4"; copyFileSync(`${base}.mp4`, path.join(DEST, name)); say(`copied → ${path.join(DEST, name)}`); }
