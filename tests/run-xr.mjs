// WebXR run with Meta's IWER emulator (Quest 3 profile). The test page exists
// only in memory here: index.html plus one module that installs IWER before the
// app loads. Nothing in this file is served by GitHub Pages.
//
// Checks: Enter VR works; the trigger selects the photon; Guided mode plays end
// to end; the left stick scrubs zoom (Guided) and zooms (Explore); the trigger
// pauses and shows a label; no console errors. Logs frame times.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const iwer = fs.readFileSync(path.join(HERE, 'node_modules/iwer/build/iwer.module.js'));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(
  '<script type="module" src="src/main.js"></script>',
  `<script type="module">
    import { XRDevice, metaQuest3 } from '/__iwer/iwer.module.js';
    const dev = new XRDevice(metaQuest3, { stereoEnabled: true });
    dev.installRuntime({ forceInstall: true });
    dev.position.set(0, 1.6, 0.3);
    window.__iwer = dev;
  </script>
  <script type="module" src="src/main.js"></script>`);
const { server, url } = await serve(ROOT, { extra: { '/__xrtest.html': ['text/html', html], '/__iwer/iwer.module.js': ['text/javascript', iwer] } });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
let failed = false;
const fail = (msg) => { console.error('FAIL', msg); failed = true; };
const ok = (msg) => console.log('ok ', msg);
const st = () => page.evaluate(() => window.__nine.state());
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(url + '/__xrtest.html');
await page.waitForFunction(() => window.__nine && window.__nine.ready, null, { timeout: 60000 });
await page.waitForSelector('#btn-vr:not([hidden])', { timeout: 10000 }).catch(() => fail('Enter VR button not shown with IWER'));
await page.click('#btn-vr');
await page.waitForFunction(() => window.__nine.state().presenting, null, { timeout: 10000 }).catch(() => fail('did not enter VR'));
if ((await st()).presenting) ok('entered immersive-vr (IWER Quest 3)');

// helpers to drive controllers
const aim = (hand, target, from = [0.15 * (hand === 'right' ? 1 : -1), 1.35, 0.1]) => page.evaluate(({ hand, target, from }) => {
  const c = window.__iwer.controllers[hand];
  c.position.set(...from);
  const d = [target[0] - from[0], target[1] - from[1], target[2] - from[2]];
  const L = Math.hypot(...d); d[0] /= L; d[1] /= L; d[2] /= L;
  // quaternion rotating -Z onto d
  const ax = [d[1] * 1 - d[2] * 0, d[2] * 0 - d[0] * 1, 0]; // cross(-z, d) with -z = (0,0,-1): (0*dz - (-1)*dy, (-1)*dx - 0*dz, 0)
  const cx = d[1], cy = -d[0], cz = 0;
  const dot = -d[2];
  let qx = cx, qy = cy, qz = cz, qw = 1 + dot;
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  c.quaternion.set(qx / n, qy / n, qz / n, qw / n);
}, { hand, target, from });
const press = async (hand, button, ms = 120) => {
  await page.evaluate(({ hand, button }) => window.__iwer.controllers[hand].updateButtonValue(button, 1), { hand, button });
  await wait(ms);
  await page.evaluate(({ hand, button }) => window.__iwer.controllers[hand].updateButtonValue(button, 0), { hand, button });
  await wait(ms);
};
const stick = (hand, y) => page.evaluate(({ hand, y }) => window.__iwer.controllers[hand].updateAxes('thumbstick', 0, y), { hand, y });

// 1. Room: wait for time to stop, then aim the right controller at the photon and pull the trigger
await page.evaluate(() => window.__nine.setT(16));
await wait(400);
const ph = await page.evaluate(() => window.__nine.photonWorld());
await aim('right', ph);
await wait(200);
await press('right', 'trigger');
if ((await st()).selected) ok('trigger on the glowing photon selects it'); else fail('trigger did not select the photon at ' + ph.map((v) => v.toFixed(3)));

// 2. Guided end to end at 10× speed
await page.evaluate(() => { window.__nine.setT(0); window.__nine.setSpeed(10); });
const t0 = Date.now();
const seen = new Set();
let maxCalls = 0;
while (!(await st()).ended && Date.now() - t0 < 90000) {
  const s = await st();
  seen.add(s.dominant);
  maxCalls = Math.max(maxCalls, s.drawCalls || 0);
  if (!s.selected && s.T > 20) await press('right', 'trigger'); // in case aim drifted
  await wait(250);
}
const s2 = await st();
if (!s2.ended) fail(`guided did not finish (T=${s2.T.toFixed(1)})`); else ok(`guided ran end to end in ${((Date.now() - t0) / 1000).toFixed(1)} s at 10×; levels seen: ${[...seen].join(', ')}; max draw calls ${maxCalls}`);
if (seen.size < 6) fail('not every level was dominant during the run');
if (maxCalls > 150) fail(`draw calls ${maxCalls} > 150`);
await page.evaluate(() => window.__nine.setSpeed(1));

// 3. Stick scrub in Guided: forward advances the timeline faster than real time, back rewinds
await page.evaluate(() => { window.__nine.setT(100); });
await wait(200);
let a = (await st()).T;
await stick('left', -1); await wait(1000); await stick('left', 0);
let b = (await st()).T;
if (b - a > 4) ok(`left stick forward scrubs zoom in (T ${a.toFixed(1)} → ${b.toFixed(1)})`); else fail(`stick forward did not scrub (T ${a} → ${b})`);
a = b;
await stick('left', 1); await wait(1000); await stick('left', 0);
b = (await st()).T;
if (b < a - 4) ok(`left stick back scrubs zoom out (T ${a.toFixed(1)} → ${b.toFixed(1)})`); else fail(`stick back did not scrub (T ${a} → ${b})`);

// 4. Explore: A button toggles mode; stick changes z directly
await press('right', 'a-button');
if ((await st()).mode === 'explore') ok('A button switches to Explore'); else fail('A button did not switch mode');
let z0 = (await st()).z;
await stick('right', -1); await wait(1600); await stick('right', 0);
let z1 = (await st()).z;
if (z1 > z0 + 0.3) ok(`stick zooms in Explore (z ${z0.toFixed(2)} → ${z1.toFixed(2)})`); else fail(`explore stick zoom failed (${z0} → ${z1})`);

// 5. Trigger pauses and labels what it points at (patient level: the interaction point)
await page.evaluate(() => { window.__nine.setMode('guided'); window.__nine.setT(52); });
await wait(400);
const anchor = await page.evaluate(() => window.__nine.anchorWorld());
await aim('right', anchor);
await wait(200);
await press('right', 'trigger');
const s5 = await st();
const label = await page.evaluate(() => window.__nine.labelText());
if (s5.paused && label.length > 5) ok(`trigger pauses and labels: "${label.slice(0, 80)}…"`); else fail(`trigger label failed (paused=${s5.paused}, label="${label}")`);
await press('right', 'trigger');
if (!(await st()).paused) ok('trigger again resumes'); else fail('trigger did not resume');

// 6. Grip rotates the current object
const q0 = await page.evaluate(() => window.__nine.userQuat());
await page.evaluate(() => window.__iwer.controllers.right.updateButtonValue('squeeze', 1));
await wait(150);
await page.evaluate(() => { const q = window.__iwer.controllers.right.quaternion; q.set(0, Math.sin(0.4), 0, Math.cos(0.4)); });
await wait(300);
await page.evaluate(() => window.__iwer.controllers.right.updateButtonValue('squeeze', 0));
const q1 = await page.evaluate(() => window.__nine.userQuat());
const dq = Math.abs(q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3]);
if (dq < 0.995) ok(`grip grabs and rotates the current object (rotation ${(2 * Math.acos(Math.min(1, dq)) * 57.3).toFixed(0)}°)`); else fail('grip did not rotate the object');

// frame times
const ft = await page.evaluate(() => window.__nine.frameTimes.slice());
const sorted = [...ft].sort((x, y) => x - y);
const pct = (p) => sorted[Math.floor(sorted.length * p)].toFixed(1);
console.log(`frame times over ${ft.length} frames (software GL in CI, not Quest hardware): p50 ${pct(0.5)} ms, p90 ${pct(0.9)} ms, p99 ${pct(0.99)} ms`);

if (errors.length) fail('console errors:\n' + errors.join('\n'));
await browser.close();
server.close();
if (failed) process.exit(1);
console.log('xr run passed');
