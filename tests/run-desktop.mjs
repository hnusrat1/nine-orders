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

await page.goto(url + '/index.html', { timeout: 120000 });
await page.waitForFunction(() => window.__nine && window.__nine.ready, null, { timeout: 60000 });
await page.screenshot({ path: path.join(OUT, '0-menu.png') });
await page.click('#btn-about');
await page.screenshot({ path: path.join(OUT, '0-about.png') });
const aboutText = await page.$eval('#about-body', (e) => e.textContent);
if (!/Known approximations/.test(aboutText) || !/17.5 eV/.test(aboutText)) fail('About panel is missing physics notes');
await page.click('#about-close');
await page.click('#btn-start');
if (await page.$eval('#controls-card', (e) => !e.hidden)) console.log('ok  controls card shown on first start'); else fail('controls card not shown on start');
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
const g0 = await st();
await page.waitForTimeout(2000);
const g1 = await st();
if (!(g1.T - g0.T > 0.8 * (g1.time - g0.time) && g1.T > g0.T)) fail(`guided time did not advance (${g0.T} → ${g1.T} over ${(g1.time - g0.time).toFixed(2)} s)`);

// Onboarding and free movement
const c0 = await page.evaluate(() => window.__nine.camera());
await page.keyboard.down('d'); await page.waitForTimeout(700); await page.keyboard.up('d');
await page.keyboard.down('e'); await page.waitForTimeout(500); await page.keyboard.up('e');
const c1 = await page.evaluate(() => window.__nine.camera());
const flown = Math.hypot(c1.focus[0] - c0.focus[0], c1.focus[1] - c0.focus[1], c1.focus[2] - c0.focus[2]);
if (flown > 0.05) console.log(`ok  WASD/QE fly the camera (${flown.toFixed(2)} m)`); else fail('WASD did not move the camera');
await page.mouse.move(640, 380); await page.mouse.down({ button: 'right' }); await page.mouse.move(540, 330, { steps: 5 }); await page.mouse.up({ button: 'right' });
const c2 = await page.evaluate(() => window.__nine.camera());
if (Math.hypot(c2.focus[0] - c1.focus[0], c2.focus[1] - c1.focus[1], c2.focus[2] - c1.focus[2]) > 0.02) console.log('ok  right-drag pans'); else fail('right-drag did not pan');
await page.keyboard.press('f'); await frames(20);
const c3 = await page.evaluate(() => ({ cam: window.__nine.camera(), a: window.__nine.anchorWorld() }));
if (Math.hypot(c3.cam.focus[0] - c3.a[0], c3.cam.focus[1] - c3.a[1], c3.cam.focus[2] - c3.a[2]) < 0.01) console.log('ok  F recenters on the particle'); else fail('F did not recenter');
await page.evaluate(() => window.__nine.setMode('guided'));
await page.click('#progress button[data-stage="cell"]');
await frames(3);
const sj = await st();
if (sj.T >= 95 && sj.T < 100) console.log(`ok  stage bar jumps to the cell stage (T=${sj.T.toFixed(1)})`); else fail(`stage bar jump failed (T=${sj.T})`);
await page.keyboard.press('h');
if (await page.$eval('#controls-card', (e) => !e.hidden)) console.log('ok  H toggles the controls card'); else fail('H did not toggle controls');
await page.keyboard.press('h');

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

// Phone: touch viewport, tap to start, pinch to zoom (two synthetic touch pointers), tap to pause
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
phone.on('console', (m) => { if (m.type() === 'error') errors.push('phone console: ' + m.text()); });
phone.on('pageerror', (e) => errors.push('phone pageerror: ' + e.message));
await phone.goto(url + '/index.html', { timeout: 120000 });
await phone.waitForFunction(() => window.__nine && window.__nine.ready, null, { timeout: 60000 });
await phone.screenshot({ path: path.join(OUT, '9-phone-menu.png') });
await phone.tap('#btn-start');
await phone.evaluate(() => { window.__nine.setMode('explore'); window.__nine.setZ(4.8); });
await phone.waitForTimeout(300);
const pz0 = await phone.evaluate(() => window.__nine.state().z);
await phone.evaluate(async () => {
  const c = document.querySelector('#app canvas');
  const ev = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 1 }));
  ev('pointerdown', 1, 170, 420); ev('pointerdown', 2, 220, 420);
  for (let k = 1; k <= 10; k++) { ev('pointermove', 1, 170 - k * 10, 420); ev('pointermove', 2, 220 + k * 10, 420); await new Promise((r) => setTimeout(r, 16)); }
  ev('pointerup', 1, 70, 420); ev('pointerup', 2, 320, 420);
});
await phone.waitForTimeout(200);
const pz1 = await phone.evaluate(() => window.__nine.state().z);
if (pz1 > pz0 + 0.3) console.log(`ok  pinch zooms on a phone (z ${pz0.toFixed(2)} → ${pz1.toFixed(2)})`); else fail(`pinch did not zoom (z ${pz0} → ${pz1})`);
await phone.tap('#app canvas', { position: { x: 195, y: 420 } });
await phone.waitForTimeout(200);
if ((await phone.evaluate(() => window.__nine.state().paused))) console.log('ok  tap pauses on a phone'); else fail('tap did not pause on a phone');
await phone.screenshot({ path: path.join(OUT, '9-phone-cell.png') });
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
if (overflow) fail('horizontal overflow on phone');

if (errors.length) { fail('console errors:\n' + errors.join('\n')); }
await browser.close();
server.close();
if (!process.exitCode) console.log('desktop run passed');
