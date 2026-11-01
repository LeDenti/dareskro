#!/usr/bin/env node
/**
 * The final Solana film = part one (dareskro_la_linea_solana.mp4, the drawn story, 2 min)
 * + part two (real screens of 1 Nov 2026, scenarios/final_part2.json rendered by part2.html).
 *   node make_final.mjs all | stills | frames | audio | mux | concat
 * Output: dareskro_la_linea_solana_final.mp4 (1920x1080, 30 fps, h264 + aac), ≈ 3 min 50.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const W = 1920, H = 1080, FPS = 30;
const scenario = JSON.parse(readFileSync(resolve(HERE, 'scenarios', 'final_part2.json'), 'utf8'));
const DUR = scenario.dur;
const OUT = resolve(HERE, 'build', 'final'); mkdirSync(OUT, { recursive: true });
const SHOTS = resolve(OUT, 'shots');
const PART1 = resolve(HERE, 'dareskro_la_linea_solana.mp4');
const PART2 = resolve(OUT, 'part2.mp4');
const FINAL = resolve(HERE, 'dareskro_la_linea_solana_final.mp4');
const ffmpeg = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]).toString().trim());
const cmd = process.argv[2] || 'all';

async function open() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.addInitScript((s) => { window.FILM = s; }, { ...scenario, shotsUrl: 'file://' + SHOTS });
  await page.goto('file://' + resolve(HERE, 'part2.html'));
  await page.evaluate(() => window.ready);
  return { browser, page };
}
const shot = (page, path) => page.screenshot({ path, clip: { x: 0, y: 0, width: W, height: H } });

async function stills() {
  const dir = resolve(OUT, 'stills'); mkdirSync(dir, { recursive: true });
  const { browser, page } = await open();
  for (const s of scenario.slides) { const t = s.t0 + Math.min(3, (s.t1 - s.t0) / 2); await page.evaluate((t) => window.render(t), t); await shot(page, `${dir}/t${String(t).padStart(6, '0')}.png`); }
  await browser.close(); console.log('stills →', dir);
}
async function frames() {
  const dir = resolve(OUT, 'frames'); mkdirSync(dir, { recursive: true });
  const { browser, page } = await open();
  const n = DUR * FPS;
  for (let i = 0; i < n; i++) { await page.evaluate((t) => window.render(t), i / FPS); await shot(page, `${dir}/f${String(i).padStart(5, '0')}.png`); if (i % 300 === 0) console.log(`frame ${i}/${n}`); }
  await browser.close();
}
function audio() {
  const snd = resolve(OUT, 'snd'); mkdirSync(snd, { recursive: true });
  const inputs = [], chains = [];
  const add = (file, filt) => { inputs.push('-i', file); chains.push(`[${inputs.length / 2 - 1}:a]${filt}[a${chains.length}]`); };
  scenario.slides.forEach((s, i) => {
    if (!s.say) return;
    const f = `${snd}/say${i}.aiff`;
    execFileSync('say', ['-v', scenario.voice, '-r', String(scenario.rate), '-o', f, s.say]);
    const d = probe(f), room = s.t1 - s.t0 - 0.6;
    if (d > room) console.log(`WARNING slide ${i} (${s.t0}-${s.t1}): voice ${d.toFixed(1)} s > ${room.toFixed(1)} s available`);
    const ms = Math.round((s.t0 + 0.4) * 1000);
    add(f, `volume=1.5,adelay=${ms}|${ms}`);
  });
  const fc = chains.join(';') + ';' + chains.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${chains.length}:normalize=0:dropout_transition=0,apad=whole_dur=${DUR},atrim=0:${DUR}[o]`;
  const filter = `${snd}/filter.txt`; writeFileSync(filter, fc);
  ffmpeg([...inputs, '-/filter_complex', filter, '-map', '[o]', '-ar', '44100', '-ac', '2', `${OUT}/mix.wav`]);
  console.log(`audio: ${chains.length} voices → ${OUT}/mix.wav`);
}
function mux() {
  ffmpeg(['-framerate', String(FPS), '-i', `${OUT}/frames/f%05d.png`, '-i', `${OUT}/mix.wav`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-shortest', '-movflags', '+faststart', PART2]);
  console.log('part2 →', PART2, probe(PART2).toFixed(1), 's');
}
function concat() {
  if (!existsSync(PART1)) throw new Error('part one missing: ' + PART1);
  ffmpeg(['-i', PART1, '-i', PART2, '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', FINAL]);
  const d = probe(FINAL); console.log(`final → ${FINAL}  ${Math.floor(d / 60)} min ${Math.round(d % 60)} s`);
}
const t0 = Date.now();
switch (cmd) {
  case 'stills': await stills(); break;
  case 'frames': await frames(); break;
  case 'audio': audio(); break;
  case 'mux': mux(); break;
  case 'concat': concat(); break;
  case 'all': await stills(); audio(); await frames(); mux(); concat(); break;
  default: console.error('usage: node make_final.mjs all|stills|frames|audio|mux|concat'); process.exit(2);
}
console.log(`${cmd} done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
