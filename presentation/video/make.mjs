#!/usr/bin/env node
/**
 * dareskro — the La Linea film as one reproducible brick.
 *
 *   node make.mjs all    --scenario xrpl|near          stills, frames, audio, mux, sheet
 *   node make.mjs stills --scenario near [t t t…]      a few frames to check the drawing  → build/<name>/stills/
 *   node make.mjs frames --scenario near [--start s]   every frame, 30 fps                → build/<name>/frames/
 *   node make.mjs audio  --scenario near               voices (macOS `say`), effects, pencil scratch → build/<name>/mix.wav
 *   node make.mjs mux    --scenario near               frames + mix.wav → dareskro_la_linea_<name>.mp4
 *   node make.mjs sheet  --scenario near               contact sheet of the stills → build/<name>/sheet.png
 *   node make.mjs fill   --scenario near               writes device/caption from ../../near/compte_rendu.json
 *
 * The film itself is film.html: one canvas, one function render(t). Everything that
 * depends on the chain (the device's screen, the verification caption, the end card)
 * comes from scenarios/<name>.json, injected as window.FILM before the page runs.
 *
 * Needs: Google Chrome (playwright uses the installed one), ffmpeg, and on macOS the
 * `say` voices "Alice" and "Grandpa (Italien (Italie))" for the charabia.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = 1920, H = 1080, FPS = 30, DUR = 120;
const argv = process.argv.slice(2);
const cmd = argv[0] || 'all';
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')));
const name = opt('scenario', 'xrpl');
const scenarioPath = resolve(HERE, 'scenarios', name + '.json');
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const OUT = resolve(HERE, 'build', name);
const FILM = resolve(HERE, 'film.html');
const MP4 = resolve(HERE, `dareskro_la_linea_${name}.mp4`);
mkdirSync(OUT, { recursive: true });

const ffmpeg = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

async function openFilm() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.addInitScript((s) => { window.FILM = s; }, scenario);
  await page.goto('file://' + FILM);
  return { browser, page };
}
const shot = (page, path) => page.screenshot({ path, clip: { x: 0, y: 0, width: W, height: H } });

async function stills(times) {
  if (!times.length) times = [9, 17, 20.5, 22, 31, 38, 42, 57, 62, 67, 78, 82.5, 100, 112];
  const dir = resolve(OUT, 'stills'); mkdirSync(dir, { recursive: true });
  const { browser, page } = await openFilm();
  for (const t of times) {
    await page.evaluate((t) => window.render(t), Number(t));
    await shot(page, `${dir}/t${String(t).padStart(6, '0')}.png`);
  }
  await browser.close();
  console.log(`stills: ${times.length} → ${dir}`);
}

async function frames(start = 0) {
  const dir = resolve(OUT, 'frames'); mkdirSync(dir, { recursive: true });
  const { browser, page } = await openFilm();
  const n = DUR * FPS;
  for (let i = Math.round(start * FPS); i < n; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    await shot(page, `${dir}/f${String(i).padStart(5, '0')}.png`);
    if (i % 300 === 0) console.log(`frame ${i}/${n}`);
  }
  await browser.close();
}

async function audio() {
  const { browser, page } = await openFilm();
  const { SOUNDS, SCRATCH } = await page.evaluate(() => ({ SOUNDS: window.SOUNDS, SCRATCH: window.SCRATCH }));
  await browser.close();
  const snd = resolve(OUT, 'snd'); mkdirSync(snd, { recursive: true });
  const inputs = [], chains = [];
  const add = (file, filt) => { inputs.push('-i', file); chains.push(`[${inputs.length / 2 - 1}:a]${filt}[a${chains.length}]`); };
  // voices: macOS say, pitched up a third (asetrate 1.3) like the cartoon
  let n = 0;
  for (const s of SOUNDS) {
    if (s.kind !== 'say') continue;
    const f = `${snd}/say${n++}.aiff`;
    execFileSync('say', ['-v', s.voice, '-r', String(s.rate), '-o', f, s.text]);
    const ms = Math.round(s.t * 1000);
    add(f, `asetrate=44100*1.3,aresample=44100,volume=1.4,adelay=${ms}|${ms}`);
  }
  // effects, synthesised
  const lav = (nm, desc, dur) => { const f = `${snd}/${nm}.wav`; ffmpeg(['-f', 'lavfi', '-i', desc, '-t', String(dur), '-ar', '44100', '-ac', '1', f]); return f; };
  const scratch = lav('scratch', 'anoisesrc=color=pink:amplitude=0.6:seed=7', 3);
  const tic = lav('tic', 'sine=frequency=1600', 0.05), tic2 = lav('tic2', 'sine=frequency=700', 0.08);
  const plop = lav('plop', 'sine=frequency=180', 0.12);
  const coin = lav('coin', 'sine=frequency=2600', 0.14), coin2 = lav('coin2', 'sine=frequency=3900', 0.10);
  for (const s of SOUNDS) {
    const ms = Math.round(s.t * 1000);
    if (s.kind === 'tic') { add(tic, `afade=t=out:st=0.01:d=0.04,volume=0.9,adelay=${ms}|${ms}`); add(tic2, `afade=t=out:st=0.02:d=0.06,volume=0.9,adelay=${ms + 50}|${ms + 50}`); }
    if (s.kind === 'plop') add(plop, `afade=t=out:st=0.02:d=0.1,volume=1.0,adelay=${ms}|${ms}`);
    if (s.kind === 'coin') { add(coin, `afade=t=out:st=0.02:d=0.12,volume=0.5,adelay=${ms}|${ms}`); add(coin2, `afade=t=out:st=0.01:d=0.09,volume=0.35,adelay=${ms + 40}|${ms + 40}`); }
    if (s.kind === 'whistle') {
      const notes = [[880, 0.28], [988, 0.28], [1047, 0.45], [880, 0.3], [784, 0.5]]; let off = 0;
      notes.forEach(([f, d], i) => { const w = lav(`wh${i}`, `sine=frequency=${f}`, d); const at = ms + Math.round(off * 1000);
        add(w, `tremolo=f=6:d=0.5,afade=t=in:d=0.03,afade=t=out:st=${(d - 0.05).toFixed(2)}:d=0.05,volume=0.35,adelay=${at}|${at}`); off += d + 0.05; });
    }
  }
  // the pencil scratching while each stroke is drawn
  for (const [t0, t1] of SCRATCH) {
    const d = Math.min(3, t1 - t0), ms = Math.round(t0 * 1000);
    add(scratch, `atrim=0:${d.toFixed(3)},highpass=f=1500,lowpass=f=7000,tremolo=f=11:d=0.7,afade=t=in:d=0.05,afade=t=out:st=${Math.max(0, d - 0.08).toFixed(3)}:d=0.08,volume=0.22,adelay=${ms}|${ms}`);
  }
  const fc = chains.join(';') + ';' + chains.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${chains.length}:normalize=0:dropout_transition=0,apad=whole_dur=${DUR},atrim=0:${DUR}[o]`;
  const filter = `${snd}/filter.txt`; writeFileSync(filter, fc);
  ffmpeg([...inputs, '-/filter_complex', filter, '-map', '[o]', '-ac', '2', `${OUT}/mix.wav`]);
  console.log(`audio: ${n} voices, ${SCRATCH.length} scratches → ${OUT}/mix.wav`);
}

function mux() {
  ffmpeg(['-framerate', String(FPS), '-i', `${OUT}/frames/f%05d.png`, '-i', `${OUT}/mix.wav`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', MP4]);
  console.log(`film → ${MP4}`);
}

function sheet() {
  const dir = resolve(OUT, 'stills');
  const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => `${dir}/${f}`);
  const cols = 4, n = files.length;
  const fc = files.map((_, i) => `[${i}:v]scale=480:270[s${i}];`).join('') + files.map((_, i) => `[s${i}]`).join('')
    + `xstack=inputs=${n}:layout=${files.map((_, i) => `${(i % cols) * 480}_${Math.floor(i / cols) * 270}`).join('|')}[o]`;
  ffmpeg([...files.flatMap((f) => ['-i', f]), '-filter_complex', fc, '-map', '[o]', `${OUT}/sheet.png`]);
  console.log(`sheet → ${OUT}/sheet.png`);
}

/** The NEAR scenario reads the real run: amount, date, payee, the finish transaction. */
function fill() {
  const cr = resolve(HERE, '..', '..', 'near', 'compte_rendu.json');
  if (!existsSync(cr)) throw new Error(`no run yet: ${cr}`);
  const r = JSON.parse(readFileSync(cr, 'utf8'));
  const p = r.payroll;
  const date = new Date(Number(BigInt(p.finish_after) / 1000000n)).toISOString().slice(0, 10);
  scenario.device = [`NEAR ${p.amount_near}`, `after ${date}`, `to ${p.destination.replace('.testnet', '…')}`];
  scenario.caption = [`finish() called by the oracle ${p.finished_after_s} s after the date, nobody clicked`, p.finish_explorer.replace(/^https?:\/\//, '')];
  // what he reads aloud, in his charabia: the amount, the day, the payee
  const mesi = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  const d = new Date(date), giorni = ['', 'primo', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove', 'venti', 'ventuno', 'ventidue', 'ventitré', 'ventiquattro', 'venticinque', 'ventisei', 'ventisette', 'ventotto', 'ventinove', 'trenta', 'trentuno'];
  const amount = Number(p.amount_near) >= 0.995 && Number(p.amount_near) <= 1.005 ? 'uno NEAR' : `${p.amount_near.replace('.', ' virgola ')} NEAR`;
  scenario.read = `${amount[0].toUpperCase()}${amount.slice(1)}… ${giorni[d.getUTCDate()]} ${mesi[d.getUTCMonth()]}… ${p.destination.split('.')[0].replace(/-/g, ' ')}… ah ah.`;
  writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2) + '\n');
  console.log(`filled ${scenarioPath}`);
}

const t0 = Date.now();
switch (cmd) {
  case 'stills': await stills(positional.map(Number)); break;
  case 'frames': await frames(Number(opt('start', 0))); break;
  case 'audio': await audio(); break;
  case 'mux': mux(); break;
  case 'sheet': sheet(); break;
  case 'fill': fill(); break;
  case 'all': await stills([]); sheet(); await audio(); await frames(0); mux(); break;
  default: console.error('usage: node make.mjs all|stills|frames|audio|mux|sheet|fill --scenario xrpl|near'); process.exit(2);
}
console.log(`${cmd} done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
