#!/usr/bin/env node
/**
 * Drives the real pay desk (vite on 127.0.0.1:5175, services on 8790/8791) through the
 * Solana tab and photographs each stage at 1920x1080 for the final film. Real devnet
 * transactions: lock the full amount, three refusals, the oracle's finish.
 *   node capture_desk.mjs [--delay 75]   → build/final/shots/desk_*.png + desk_run.json
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'build', 'final', 'shots');
const argv = process.argv.slice(2); const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const DELAY = Number(opt('delay', 75));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const shotCard = async (n, name) => { const el = page.locator('section.card', { hasText: `Step ${n}` }).first(); await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await el.screenshot({ path: `${OUT}/${name}.png` }); log('shot', name); };
const shotPage = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); log('shot', name); };

await page.goto('http://127.0.0.1:5175/');
await page.getByRole('button', { name: 'Solana · same desk' }).click();
await page.waitForSelector('text=Employee (demo wallet)', { timeout: 15000 });
await page.waitForTimeout(1500);
await shotPage('desk_00_tab');
await shotCard(1, 'desk_01_rail');
// 2. validate
await page.getByPlaceholder('name of the human who checked the lines').fill('Julien');
await page.getByRole('button', { name: 'Validate', exact: true }).click();
await page.waitForSelector('text=Validated by Julien');
await shotCard(2, 'desk_02_statement');
// 3. quote (dry)
await page.getByRole('button', { name: /^Quote / }).click();
await page.waitForSelector('text=Employer pays', { timeout: 30000 });
await page.waitForTimeout(500);
await shotCard(3, 'desk_03_funding');
// 4. lock, full amount
await page.getByLabel('Payable in (seconds)').fill(String(DELAY));
const t0 = Date.now();
await page.getByRole('button', { name: 'Lock the net pay' }).click();
await page.waitForSelector('text=Payable at', { timeout: 60000 });
await page.waitForTimeout(800);
await shotCard(4, 'desk_04_locked');
// 5. three refusals
const tries = ['Passer-by releases before the date', 'Employer takes the money back', 'Passer-by releases to themselves'];
for (const [i, label] of tries.entries()) {
  await page.getByRole('button', { name: label }).click();
  await page.waitForFunction((n) => document.querySelectorAll('section.card table.lines tbody tr td.ko').length >= n, i + 1, { timeout: 60000 });
  await page.waitForTimeout(400);
  await shotCard(5, `desk_05_refusal${i + 1}`);
}
// 6. the oracle finishes after the date
await page.waitForFunction(() => /finished by the oracle/.test(document.body.innerText), null, { timeout: (DELAY + 90) * 1000, polling: 2000 });
await page.waitForTimeout(1200);
await shotCard(4, 'desk_06_finished');
await shotCard(6, 'desk_07_registry');
await shotPage('desk_08_full');
const text = await page.innerText('main');
writeFileSync(`${OUT}/desk_run.json`, JSON.stringify({ at: new Date().toISOString(), delay: DELAY, seconds: Math.round((Date.now() - t0) / 1000), text }, null, 2));
await browser.close();
log('done');
