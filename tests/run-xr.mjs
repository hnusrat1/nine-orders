// WebXR run with Meta's IWER emulator (Quest 3 profile). The test page exists
// only in memory here: index.html plus one module that installs IWER before the
// app loads. Nothing in this file is served by GitHub Pages.
//
// Checks: Enter VR works and shows the welcome panel; the trigger selects the
// photon; Guided mode plays end to end; the right stick zooms (scrubs in Guided)
// and snap-turns; the left stick walks; B opens the menu and its buttons work;
// the trigger pauses and labels; the grip grabs the scene; no console errors.
// Logs frame times.
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
// Controllers live in the player rig, so world-space targets are converted to rig space first.
const aim = (hand, target, from = [0.15 * (hand === 'right' ? 1 : -1), 1.35, 0.1]) => page.evaluate(({ hand, target, from }) => {
  target = window.__nine.worldToRig(target);
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
const stick = (hand, y, x = 0) => page.evaluate(({ hand, y, x }) => window.__iwer.controllers[hand].updateAxes('thumbstick', x, y), { hand, y, x });
const clickMenu = async (id) => {
  const p = await page.evaluate((id) => window.__nine.menuButtonWorld(id), id);
  if (!p) { fail('menu button not found: ' + id); return; }
  await aim('right', p);
  await wait(150);
  await press('right', 'trigger');
};

// 0. The welcome panel explains the controls; Start begins the journey
await wait(500);
let s0 = await st();
if (s0.menuOpen && s0.paused) ok('welcome panel shown on entering VR (journey paused)'); else fail(`welcome panel not shown (menuOpen=${s0.menuOpen}, paused=${s0.paused})`);
await clickMenu('primary');
s0 = await st();
if (!s0.menuOpen && !s0.paused) ok('trigger on Start closes the welcome panel and starts'); else fail('Start button did not start');

// 1. Room: wait for time to stop, then aim the right controller at the photon and pull the trigger
await page.evaluate(() => window.__nine.setT(16));
await wait(400);
const ph = await page.evaluate(() => window.__nine.photonWorld());
await aim('right', ph);
await wait(200);
await press('right', 'trigger');
if ((await st()).selected) ok('trigger on the glowing photon selects it'); else fail('trigger did not select the photon at ' + ph.map((v) => v.toFixed(3)));

// VR views (both eyes as IWER draws them) for a layout check
const OUT = path.join(ROOT, 'tests', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
for (const [name, T] of [['vr-1-room', 16], ['vr-2-patient', 50], ['vr-3-tissue', 85], ['vr-4-cell', 112], ['vr-5-chromatin', 150], ['vr-6-dna', 196]]) {
  await page.evaluate((T) => window.__nine.setT(T), T);
  await wait(700);
  await page.screenshot({ path: path.join(OUT, name + '.png') });
}

// 2. Guided end to end at 10× speed
await page.evaluate(() => { window.__nine.setT(0); window.__nine.setSpeed(10); });
const t0 = Date.now();
const seen = new Set();
let maxCalls = 0;
while (!(await st()).ended && Date.now() - t0 < 240000) {
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

// 3. Right stick up/down scrubs the zoom in Guided
await page.evaluate(() => { window.__nine.setT(100); });
await wait(200);
// (compared with simulated time, so slow software rendering does not matter: playback alone gives ΔT = Δt)
let sa = await st();
await stick('right', -1); await wait(2000); await stick('right', 0);
let sb = await st();
let rate = (sb.T - sa.T) / Math.max(sb.time - sa.time, 1e-6);
if (rate > 4) ok(`right stick forward scrubs zoom in (${rate.toFixed(1)}× playback speed)`); else fail(`stick forward did not scrub (rate ${rate.toFixed(2)})`);
sa = sb;
await stick('right', 1); await wait(2000); await stick('right', 0);
sb = await st();
rate = (sb.T - sa.T) / Math.max(sb.time - sa.time, 1e-6);
if (rate < -3) ok(`right stick back scrubs zoom out (${rate.toFixed(1)}× playback speed)`); else fail(`stick back did not scrub (rate ${rate.toFixed(2)})`);

// 4. B opens the menu; the Mode button switches to Explore; B closes it; the right stick then zooms freely
await press('right', 'b-button');
if ((await st()).menuOpen) ok('B opens the menu'); else fail('B did not open the menu');
await clickMenu('mode');
if ((await st()).mode === 'explore') ok('menu Mode button switches to Explore'); else fail('menu Mode button did not switch mode');
await clickMenu('voice');
if ((await st()).voice === false) ok('menu Narration button mutes'); else fail('menu Narration button did not mute');
await clickMenu('voice');
await press('right', 'b-button');
if (!(await st()).menuOpen) ok('B closes the menu'); else fail('B did not close the menu');
const e0 = await st();
await stick('right', -1); await wait(1600); await stick('right', 0);
const e1 = await st();
const zr = (e1.z - e0.z) / Math.max(e1.time - e0.time, 1e-6);
if (zr > 0.4) ok(`right stick zooms in Explore (${zr.toFixed(2)} orders of magnitude per second)`); else fail(`explore stick zoom failed (rate ${zr.toFixed(3)})`);

// 5. Left stick walks; right stick left/right snap-turns
const p0 = await page.evaluate(() => window.__nine.player());
await stick('left', -1); await wait(1200); await stick('left', 0);
const p1 = await page.evaluate(() => window.__nine.player());
const moved = Math.hypot(p1.pos[0] - p0.pos[0], p1.pos[2] - p0.pos[2]);
if (moved > 0.25) ok(`left stick walks (${moved.toFixed(2)} m)`); else fail(`left stick did not move the player (${moved.toFixed(3)} m)`);
await stick('right', 0, 1); await wait(250); await stick('right', 0, 0); await wait(150);
const p2 = await page.evaluate(() => window.__nine.player());
const turned = Math.abs(p2.yaw - p1.yaw) * 57.3;
if (Math.abs(turned - 30) < 1) ok(`right stick snap-turns ${turned.toFixed(0)}°`); else fail(`snap turn was ${turned.toFixed(1)}°`);
await stick('right', 0, -1); await wait(250); await stick('right', 0, 0); await wait(150);

// 6. Trigger pauses and labels what it points at (patient level: the interaction point)
await press('right', 'b-button'); await clickMenu('recenter');
if ((await st()).menuOpen || (await st()).paused) fail('Recenter should close the menu and resume');
await page.evaluate(() => { window.__nine.setMode('guided'); window.__nine.setT(52); });
await wait(600);
const anchor = await page.evaluate(() => window.__nine.anchorWorld());
await aim('right', anchor);
await wait(200);
await press('right', 'trigger');
const s5 = await st();
const label = await page.evaluate(() => window.__nine.labelText());
if (s5.paused && label.length > 5) ok(`trigger pauses and labels: "${label.slice(0, 80)}…"`); else fail(`trigger label failed (paused=${s5.paused}, label="${label}")`);
await press('right', 'trigger');
if (!(await st()).paused) ok('trigger again resumes'); else fail('trigger did not resume');

// 7. Grip grabs the scene: it follows the hand (move and turn)
const q0 = await page.evaluate(() => window.__nine.userQuat());
const a0 = await page.evaluate(() => window.__nine.anchorWorld());
await page.evaluate(() => { const c = window.__iwer.controllers.right; c.quaternion.set(0, 0, 0, 1); c.updateButtonValue('squeeze', 1); });
await wait(150);
await page.evaluate(() => { const c = window.__iwer.controllers.right; c.quaternion.set(0, Math.sin(0.4), 0, Math.cos(0.4)); c.position.set(c.position.x + 0.2, c.position.y, c.position.z); });
await wait(300);
await page.evaluate(() => window.__iwer.controllers.right.updateButtonValue('squeeze', 0));
const q1 = await page.evaluate(() => window.__nine.userQuat());
const a1 = await page.evaluate(() => window.__nine.anchorWorld());
const dq = Math.abs(q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3]);
const da = Math.hypot(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]);
if (dq < 0.995 && da > 0.05) ok(`grip grabs the scene: turned ${(2 * Math.acos(Math.min(1, dq)) * 57.3).toFixed(0)}°, moved ${da.toFixed(2)} m`); else fail(`grip grab failed (dq=${dq}, moved ${da})`);

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
