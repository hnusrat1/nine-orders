// Desktop run through every level with a screenshot of each.
// Fails on any console error or page error, or if a level exceeds 150 draw calls.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const { server, url } = await serve(ROOT);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const fail = (msg) => { console.error('FAIL', msg); process.exitCode = 1; };

await page.goto(url + '/index.html');
await page.waitForFunction(() => window.__nine && window.__nine.ready, null, { timeout: 60000 });
await page.click('#btn-start');
const frames = (n) => page.evaluate((n) => new Promise((ok) => { let k = 0; const f = () => (++k >= n ? ok() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const st = () => page.evaluate(() => window.__nine.state());

// Stage 1: room, time stopped, photon glowing — click it
await page.evaluate(() => window.__nine.setT(15));
await frames(20);
await page.screenshot({ path: path.join(OUT, '1-room.png') });
const ps = await page.evaluate(() => window.__nine.photonScreen());
await page.evaluate(() => window.__nine.setT(18));
await frames(3);
const ps2 = await page.evaluate(() => window.__nine.photonScreen());
await page.mouse.click(ps2.x, ps2.y);
await frames(3);
if (!(await st()).selected) fail('clicking the glowing photon did not select it');
else console.log('ok  photon selected by click at', ps2);

const stages = [
  ['2-patient-photon', 36], ['2-patient-compton', 50], ['3-tissue', 70], ['3-tissue-cells', 88],
  ['4-cell', 106], ['4-cell-delta', 118], ['5-chromatin', 140], ['5-nucleosomes', 158],
  ['6-dna-events', 178], ['6-dna-dsb', 200], ['7-return', 211], ['7-closing', 225],
];
const report = [];
for (const [name, T] of stages) {
  await page.evaluate((T) => window.__nine.setT(T), T);
  await frames(12);
  const s = await st();
  const subs = await page.evaluate(() => window.__nine.subtitles());
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  report.push({ name, T, z: +s.z.toFixed(2), level: s.dominant, drawCalls: s.drawCalls, triangles: s.triangles, subs: subs.slice(0, 50) });
  if (s.drawCalls > 150) fail(`${name}: ${s.drawCalls} draw calls`);
}
console.table(report);

// Guided mode actually plays: run 2 s of real time from the start
await page.evaluate(() => { window.__nine.setT(0); });
const t0 = (await st()).T;
await page.waitForTimeout(2000);
const t1 = (await st()).T;
if (!(t1 > t0 + 1)) fail(`guided time did not advance (${t0} → ${t1})`);

// Explore: wheel zoom
await page.evaluate(() => window.__nine.setMode('explore'));
await page.evaluate(() => window.__nine.setZ(3.5));
await frames(5);
const z0 = (await st()).z;
await page.mouse.move(640, 380);
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -200); await frames(2); }
const z1 = (await st()).z;
if (!(z1 > z0 + 0.5)) fail(`wheel did not zoom in (z ${z0} → ${z1})`);
else console.log(`ok  wheel zoom ${z0.toFixed(2)} → ${z1.toFixed(2)}`);
await page.screenshot({ path: path.join(OUT, '8-explore.png') });
// pause + label by click
await page.mouse.click(640, 380);
await frames(3);
if (!(await st()).paused) fail('click did not pause');
const lbl = await page.$eval('#label', (e) => (e.hidden ? '' : e.textContent));
console.log('ok  click pauses; label:', lbl.slice(0, 90));

const ft = await page.evaluate(() => window.__nine.frameTimes.slice(-120));
ft.sort((a, b) => a - b);
console.log(`frame time (headless swiftshader, not representative of Quest): median ${ft[60].toFixed(1)} ms`);

if (errors.length) { fail('console errors:\n' + errors.join('\n')); }
await browser.close();
server.close();
if (!process.exitCode) console.log('desktop run passed');
