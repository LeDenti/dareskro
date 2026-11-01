#!/usr/bin/env node
/**
 * Records the NEAR tab of the pay desk, for real, on testnet: starts the desk service and the
 * React app, drives them in a browser the way an operator would, and keeps the film, the
 * screenshots and the list of every transaction signed meanwhile.
 *
 *   node enregistre.mjs            → sortie/pupitre_near_<date>.mp4, sortie/pupitre_near_<date>_<n>.png,
 *                                    sortie/pupitre_near_<date>.json
 *
 * Steps filmed: the rail; the statement validated by a named human; the payroll escrow locked
 * (25 s); a stranger too early and the employer's cancel, both refused; the stranger's release
 * after the date; the deposit locked by the tenant; a stranger's vote refused; the landlord alone
 * (nothing moves); the tenant disagrees; the mediator decides (paid both ways); a second deposit
 * nobody decides, the deadline call too soon, then the return to the tenant; the registry.
 * Needs: presentation/video's Playwright (chromium), ffmpeg, the testnet keys in ~/.near-credentials.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../presentation/video/node_modules/playwright/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..', 'app');
const OUT = join(HERE, 'sortie');
const DESK_PORT = 8794, APP_PORT = 5179;
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const base = join(OUT, `pupitre_near_${stamp}`);
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)}  ${s}`);
const listening = (port) => new Promise((r) => { const s = createConnection({ port, host: '127.0.0.1' }); s.once('connect', () => { s.end(); r(true); }); s.once('error', () => r(false)); });
async function ensure(port, cmd, args, cwd, label) {
  if (await listening(port)) { say(`${label} already on ${port}`); return null; }
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  for (let i = 0; i < 60; i++) { if (await listening(port)) { say(`${label} started on ${port}`); return child; } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`${label} did not come up on ${port}`);
}
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []);
const started = new Date().toISOString();
mkdirSync(OUT, { recursive: true });
const children = [await ensure(DESK_PORT, 'node', ['desk_near.mjs'], HERE, 'desk'), await ensure(APP_PORT, 'npx', ['vite', '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort'], APP, 'app')];

const videoDir = join(OUT, `.video_${stamp}`);
let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 900 } } });
const page = await context.newPage();
let shot = 0;
const snap = async (what) => { shot += 1; const f = `${base}_${String(shot).padStart(2, '0')}.png`; await page.screenshot({ path: f, fullPage: false }); say(`${what} → ${f.split('/').pop()}`); };
const seen = (text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 90_000 });
const card = (n) => page.locator('section.card').filter({ hasText: `Step ${n}` }).first();
const pause = (ms) => page.waitForTimeout(ms);
const timeline = [];
const mark = (s) => { timeline.push({ at: new Date().toISOString(), step: s }); say(s); };

try {
  await page.goto(`http://127.0.0.1:${APP_PORT}/`);
  await page.getByRole('button', { name: 'NEAR · same desk' }).click();
  await seen('dareskro.testnet');
  await pause(1500);
  mark('1 the rail: contract, roles, balances'); await snap('rail');

  // 2 the statement, validated by a named human
  await card(2).scrollIntoViewIfNeeded();
  await page.getByPlaceholder('name of the human who checked the lines').fill('Julien, pay desk operator');
  await page.getByRole('button', { name: 'Validate' }).click();
  await seen('Validated by Julien');
  mark('2 statement validated'); await snap('statement');

  // 3 lock, 4 proofs
  await card(3).scrollIntoViewIfNeeded();
  await page.getByLabel('Payable in (seconds)').fill('25');
  await page.getByRole('button', { name: 'Lock the net pay' }).click();
  await seen('Payable at');
  mark('3 payroll escrow locked'); await snap('lock');
  await card(4).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Stranger releases before the date' }).click();
  await seen('refused: too early');
  await page.getByRole('button', { name: 'Employer takes the money back' }).click();
  await seen('refused: this escrow has no cancel_after');
  mark('4 early release and cancel refused'); await snap('refusals');
  await seen('date passed');
  await page.getByRole('button', { name: 'Stranger releases after the date' }).click();
  await card(4).getByText('accepted').first().waitFor({ timeout: 90_000 });
  mark('4 released after the date by a stranger'); await snap('released');

  // 5 the deposit
  await card(5).scrollIntoViewIfNeeded();
  await page.getByLabel('Deadline (seconds)').fill('600');
  await page.getByRole('button', { name: 'Tenant locks the deposit' }).click();
  await seen('none yet');
  mark('5 deposit locked by the tenant, 2 of 3'); await snap('deposit');
  await page.getByRole('button', { name: 'stranger votes', exact: true }).click();
  await seen('refused: not a party');
  await page.getByRole('button', { name: 'landlord votes', exact: true }).click();
  await seen('recorded, nothing moves');
  mark('5 stranger refused, landlord alone moves nothing'); await snap('landlord-alone');
  await page.getByRole('button', { name: 'tenant votes', exact: true }).click();
  await card(5).getByText('recorded, nothing moves').nth(1).waitFor({ timeout: 90_000 });
  await page.getByRole('button', { name: 'mediator votes', exact: true }).click();
  await seen('threshold reached: paid');
  await seen('to the landlord, the rest back to the tenant');
  mark('5 mediator decides: paid both ways'); await snap('decided');
  await pause(2000);
  await page.getByRole('button', { name: 'New deposit' }).click();
  await page.getByLabel('Deadline (seconds)').fill('30');
  await page.getByRole('button', { name: 'Tenant locks the deposit' }).click();
  await seen('none yet');
  await page.getByRole('button', { name: 'Stranger calls the deadline' }).click();
  await seen('refused: deadline not reached');
  mark('5 second deposit: deadline call too soon refused'); await snap('too-soon');
  await seen('passed: anyone may return the deposit');
  await page.getByRole('button', { name: 'Stranger calls the deadline' }).click();
  await seen('returned to the tenant');
  mark('5 after the deadline: returned to the tenant'); await snap('returned');

  // 6 registry
  await card(6).scrollIntoViewIfNeeded();
  await pause(6000);
  mark('6 registry: escrows, deposits, payslips'); await snap('registry');
  await pause(1500);
} finally {
  await context.close();
  await browser.close();
  const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'));
  if (webm) {
    await new Promise((r) => spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(videoDir, webm), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${base}.mp4`], { stdio: 'inherit' }).on('exit', r));
    rmSync(videoDir, { recursive: true, force: true });
    say(`film → ${base}.mp4`);
  }
  const since = (l) => l.filter((r) => (r.at ?? r.lockedAt) >= started);
  writeFileSync(`${base}.json`, JSON.stringify({ started, finished: new Date().toISOString(), timeline, locks: since(readJson(join(OUT, 'locks.json'))), vaults: since(readJson(join(OUT, 'vaults.json'))) }, null, 2) + '\n');
  say(`record → ${base}.json`);
  for (const c of children) if (c) c.kill();
  if (existsSync(`${base}.mp4`)) copyFileSync(`${base}.mp4`, join(OUT, 'pupitre_near.mp4'));
}
