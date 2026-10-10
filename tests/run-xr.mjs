// WebXR run with Meta's IWER emulator (Quest 3 profile). The test page exists
// only in memory here: index.html plus one module that installs IWER before the
// app loads. Nothing in this file is served by GitHub Pages.
//
// Placement is checked from the viewer's eyes (azimuth/elevation relative to
// the gaze), with the headset started off-centre and turned, because that is
// where a stale head pose shows up: the welcome panel, the B menu after turning
// round, the reading panels after walking, snap-turning and turning the head,
// Recenter and the headset's own recentre. Then: the trigger selects the photon;
// Guided plays end to end; the right stick scrubs or zooms and snap-turns; the
// left stick walks; menu buttons work; the trigger labels; the grip grabs the
// scene without tilting it; controller models load; no console errors.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const iwer = fs.readFileSync(path.join(HERE, 'node_modules/iwer/build/iwer.module.js'));
const YAW0 = 0.85; // the headset starts turned ~49° to the left of the room's -z axis, away from the origin
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(
  '<script type="module" src="src/main.js"></script>',
  `<script type="module">
    import { XRDevice, metaQuest3 } from '/__iwer/iwer.module.js';
    const dev = new XRDevice(metaQuest3, { stereoEnabled: true });
    dev.installRuntime({ forceInstall: true });
    dev.position.set(0.6, 1.66, -0.3);
    dev.quaternion.set(0, Math.sin(${YAW0} / 2), 0, Math.cos(${YAW0} / 2));
    window.__iwer = dev;
  </script>
  <script type="module" src="src/main.js"></script>`);
const { server, url } = await serve(ROOT, { extra: { '/__xrtest.html': ['text/html', html], '/__iwer/iwer.module.js': ['text/javascript', iwer] } });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 660 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
let failed = false;
const fail = (msg) => { console.error('FAIL', msg); failed = true; };
const ok = (msg) => console.log('ok ', msg);
const st = () => page.evaluate(() => window.__nine.state());
const wait = (ms) => page.waitForTimeout(ms);
const view = (what) => page.evaluate((w) => window.__nine.xrView(w), what);
const f1 = (v) => (v == null ? '–' : v.toFixed(1));
const fmtView = (v) => (v ? `az ${f1(v.az)}°, el ${f1(v.el)}°, ${v.dist ? v.dist.toFixed(2) : '–'} m` : 'missing');

// Is `what` where it should be relative to the eyes?
async function expectView(what, { az = [-6, 6], el, dist, facing = 0.9 }, msg) {
  const v = await view(what);
  const bad = !v || v.hidden || v.az < az[0] || v.az > az[1] || (el && (v.el < el[0] || v.el > el[1]))
    || (dist && (v.dist < dist[0] || v.dist > dist[1])) || (v.facing != null && facing && v.facing < facing);
  if (bad) fail(`${msg}: ${what} at ${fmtView(v)}${v && v.facing != null ? `, facing ${v.facing.toFixed(2)}` : ''}${v && v.hidden ? ' (hidden)' : ''}`);
  else ok(`${msg} (${fmtView(v)})`);
  return v;
}
const setHead = (pos, yaw) => page.evaluate(({ pos, yaw }) => {
  const d = window.__iwer;
  if (pos) d.position.set(...pos);
  if (yaw != null) d.quaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
}, { pos, yaw });

await page.goto(url + '/__xrtest.html');
await page.waitForFunction(() => window.__nine && window.__nine.ready, null, { timeout: 90000 });
await page.waitForSelector('#btn-vr:not([hidden])', { timeout: 10000 }).catch(() => fail('Enter VR button not shown with IWER'));
await page.click('#btn-vr');
await page.waitForFunction(() => window.__nine.state().presenting, null, { timeout: 10000 }).catch(() => fail('did not enter VR'));
if ((await st()).presenting) ok('entered immersive-vr (IWER Quest 3)');

// helpers to drive controllers. Controllers live in the player rig, so world-space targets are converted to rig space first.
const aim = (hand, target, from = [0.15 * (hand === 'right' ? 1 : -1), 1.35, 0.1]) => page.evaluate(({ hand, target, from }) => {
  target = window.__nine.worldToRig(target);
  const c = window.__iwer.controllers[hand];
  c.position.set(...from);
  const d = [target[0] - from[0], target[1] - from[1], target[2] - from[2]];
  const L = Math.hypot(...d); d[0] /= L; d[1] /= L; d[2] /= L;
  // quaternion rotating -Z onto d: axis cross(-z, d) = (d.y, -d.x, 0), w = 1 + dot(-z, d)
  const qx = d[1], qy = -d[0], qz = 0, qw = 1 - d[2];
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
const OUT = path.join(ROOT, 'tests', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

// 0. Welcome panel: in front of the eyes, wherever the headset started; the stage below it
await page.waitForFunction(() => window.__nine.state().menuOpen, null, { timeout: 5000 }).catch(() => {});
let s0 = await st();
if (s0.menuOpen && s0.paused) ok('welcome panel shown on entering VR (journey paused)'); else fail(`welcome panel not shown (menuOpen=${s0.menuOpen}, paused=${s0.paused})`);
await expectView('vr-menu', { az: [-3, 3], el: [-16, -5], dist: [0.5, 0.7], facing: 0.98 }, 'welcome panel is straight ahead, just below eye level, facing you');
await expectView('anchor', { az: [-3, 3], el: [-26, -14], dist: [0.9, 1.1] }, 'the particle is 1 m ahead, below eye level');
await expectView('vr-subtitles', { az: [-4, 4], el: [0, 12], dist: [1.1, 1.4] }, 'subtitles ahead, just above eye level');
await expectView('vr-logstrip', { az: [-48, -28], el: [-12, 6] }, 'scale strip to the left');
await page.screenshot({ path: path.join(OUT, 'vr-0-welcome.png') });

// controller models (Meta's, from the WebXR input profiles) replace the stand-ins
await page.waitForFunction(() => window.__nine.controllers().every((c) => c.model), null, { timeout: 15000 }).catch(() => {});
const cm = await page.evaluate(() => window.__nine.controllers());
if (cm.every((c) => c.model && !c.body)) ok(`controller models loaded (${cm.map((c) => c.hand).join(', ')})`); else fail('controller models not loaded: ' + JSON.stringify(cm));

await clickMenu('primary');
s0 = await st();
if (!s0.menuOpen && !s0.paused) ok('trigger on Start closes the welcome panel and starts'); else fail('Start button did not start');
if ((await page.evaluate(() => window.__nine.controllers())).every((c) => c.label)) ok('controller labels shown after Start'); else fail('controller labels not shown');

// 1. Room: wait for time to stop, then aim the right controller at the photon and pull the trigger
await page.evaluate(() => window.__nine.setT(16));
await wait(400);
const ring = await page.evaluate(() => window.__nine.ringOffset());
if (ring.visible && ring.d < 0.005) ok(`the "pick this photon" ring is on the photon (${(ring.d * 1000).toFixed(1)} mm off)`); else fail(`ring misplaced: ${JSON.stringify(ring)}`);
const ph = await page.evaluate(() => window.__nine.photonWorld());
await aim('right', ph);
await wait(200);
await press('right', 'trigger');
if ((await st()).selected) ok('trigger on the glowing photon selects it'); else fail('trigger did not select the photon at ' + ph.map((v) => v.toFixed(3)));

// VR views (both eyes as IWER draws them) for a layout check
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
  if (!s.selected && s.T > 20) { await aim('right', await page.evaluate(() => window.__nine.photonWorld())); await press('right', 'trigger'); }
  await wait(250);
}
const s2 = await st();
if (!s2.ended) fail(`guided did not finish (T=${s2.T.toFixed(1)})`); else ok(`guided ran end to end in ${((Date.now() - t0) / 1000).toFixed(1)} s at 10×; levels seen: ${[...seen].join(', ')}; max draw calls ${maxCalls}`);
if (seen.size < 6) fail('not every level was dominant during the run');
if (maxCalls > 150) fail(`draw calls ${maxCalls} > 150`);
await page.evaluate(() => window.__nine.setSpeed(1));

// 3. Right stick up/down scrubs the story in Guided
await page.evaluate(() => { window.__nine.setT(100); });
await wait(200);
// (compared with simulated time, so slow software rendering does not matter: playback alone gives ΔT = Δt)
let sa = await st();
await stick('right', -1); await wait(2000); await stick('right', 0);
let sb = await st();
let rate = (sb.T - sa.T) / Math.max(sb.time - sa.time, 1e-6);
if (rate > 4) ok(`right stick forward scrubs forward (${rate.toFixed(1)}× playback speed)`); else fail(`stick forward did not scrub (rate ${rate.toFixed(2)})`);
sa = sb;
await stick('right', 1); await wait(2000); await stick('right', 0);
sb = await st();
rate = (sb.T - sa.T) / Math.max(sb.time - sa.time, 1e-6);
if (rate < -3) ok(`right stick back scrubs back (${rate.toFixed(1)}× playback speed)`); else fail(`stick back did not scrub (rate ${rate.toFixed(2)})`);

// 4. Turn round (head 120° to the right), press B: the menu opens in front of the new gaze
await setHead(null, YAW0 - 2.1);
await wait(300);
await press('right', 'b-button');
const s4o = await st();
if (s4o.menuOpen && s4o.paused) ok('B opens the menu and pauses'); else fail(`B did not open the menu (open=${s4o.menuOpen}, paused=${s4o.paused})`);
const prim = await page.evaluate(() => window.__nine.menuButtons().find((b) => b.id === 'primary').label);
if (prim === 'Resume') ok('the menu offers Resume'); else fail(`menu primary button reads "${prim}"`);
await expectView('vr-menu', { az: [-3, 3], el: [-16, -5], dist: [0.5, 0.7], facing: 0.98 }, 'after turning round, the menu opens in front of the new gaze');
await page.screenshot({ path: path.join(OUT, 'vr-7-menu-turned.png') });
await clickMenu('mode');
if ((await st()).mode === 'explore') ok('menu Mode button switches to Explore'); else fail('menu Mode button did not switch mode');
await clickMenu('voice');
if ((await st()).voice === false) ok('menu Narration button mutes'); else fail('menu Narration button did not mute');
await clickMenu('voice');
await press('right', 'b-button');
const s4 = await st();
if (!s4.menuOpen && !s4.paused) ok('B closes the menu and play resumes'); else fail(`B did not close the menu (open=${s4.menuOpen}, paused=${s4.paused})`);

// 5. Lazy follow: the reading panels come round to the new gaze, then stay put
await page.waitForFunction(() => window.__nine.hudStill(), null, { timeout: 8000 }).catch(() => {});
await wait(300);
await expectView('vr-subtitles', { az: [-6, 6], el: [0, 12] }, 'subtitles glide round to the new gaze');
await setHead(null, YAW0 - 2.1 + 0.25); // a small look to the left (14°) leaves them where they are
await wait(600);
await expectView('vr-subtitles', { az: [8, 20], el: [0, 12] }, 'a small head turn does not drag the subtitles');
await setHead(null, YAW0 - 2.1);
await wait(300);

// 6. Recenter (menu): the stage is set again in front of you
await press('right', 'b-button'); await clickMenu('recenter');
if ((await st()).menuOpen || (await st()).paused) fail('Recenter should close the menu and resume');
await wait(200);
await expectView('anchor', { az: [-3, 3], el: [-26, -14], dist: [0.9, 1.1] }, 'Recenter puts the particle back in front');

// 7. Explore: the right stick zooms
const e0 = await st();
await stick('right', -1); await wait(1600); await stick('right', 0);
const e1 = await st();
const zr = (e1.z - e0.z) / Math.max(e1.time - e0.time, 1e-6);
if (zr > 0.4) ok(`right stick zooms in Explore (${zr.toFixed(2)} orders of magnitude per second)`); else fail(`explore stick zoom failed (rate ${zr.toFixed(3)})`);

// 8. Left stick walks; the panels come with you
const p0 = await page.evaluate(() => window.__nine.player());
const w0 = await st();
const sub0 = await view('vr-subtitles');
await stick('left', -1); await wait(1500); await stick('left', 0);
const w1 = await st();
await wait(100);
const p1 = await page.evaluate(() => window.__nine.player());
const moved = Math.hypot(p1.pos[0] - p0.pos[0], p1.pos[2] - p0.pos[2]);
const speed = moved / Math.max(w1.time - w0.time, 1e-6); // against simulated time, as above
if (speed > 0.4 && speed < 1.3) ok(`left stick walks (${moved.toFixed(2)} m, ${speed.toFixed(2)} m/s)`); else fail(`left stick walking speed ${speed.toFixed(2)} m/s (moved ${moved.toFixed(3)} m)`);
const sub1 = await view('vr-subtitles');
if (Math.abs(sub1.az - sub0.az) < 2 && Math.abs(sub1.dist - sub0.dist) < 0.05) ok('subtitles travel with you when you walk'); else fail(`subtitles left behind when walking: ${fmtView(sub0)} → ${fmtView(sub1)}`);

// 9. Snap turn: 30° per flick; the panels turn with you
await stick('right', 0, 1); await wait(250); await stick('right', 0, 0); await wait(150);
const p2 = await page.evaluate(() => window.__nine.player());
const turned = Math.abs(p2.yaw - p1.yaw) * 57.2958;
if (Math.abs(turned - 30) < 1) ok(`right stick snap-turns ${turned.toFixed(0)}°`); else fail(`snap turn was ${turned.toFixed(1)}°`);
const sub2 = await view('vr-subtitles');
if (Math.abs(sub2.az - sub1.az) < 2) ok('subtitles turn with you on a snap turn'); else fail(`subtitles moved on a snap turn: ${fmtView(sub1)} → ${fmtView(sub2)}`);
await stick('right', 0, -1); await wait(250); await stick('right', 0, 0); await wait(150);

// 10. The headset's own recentre (hold the Meta button) resets the reference space: the stage is set again
await setHead([1.1, 1.62, 0.4], YAW0 + 0.9);
await wait(200);
await page.evaluate(() => window.__iwer.recenter());
await wait(400);
await expectView('anchor', { az: [-3, 3], el: [-26, -14], dist: [0.9, 1.1] }, 'after the headset recentres, the particle is in front again');
await page.waitForFunction(() => window.__nine.hudStill(), null, { timeout: 8000 }).catch(() => {});
await expectView('vr-subtitles', { az: [-6, 6], el: [0, 12] }, 'and the subtitles too');

// 11. Trigger pauses and labels what it points at (patient level: the interaction point)
await page.evaluate(() => { window.__nine.setMode('guided'); window.__nine.setT(52); });
await wait(600);
const anchor = await page.evaluate(() => window.__nine.anchorWorld());
await aim('right', anchor);
await wait(200);
await press('right', 'trigger');
const s11 = await st();
const label = await page.evaluate(() => window.__nine.labelText());
if (s11.paused && label.length > 5) ok(`trigger pauses and labels: "${label.slice(0, 80)}…"`); else fail(`trigger label failed (paused=${s11.paused}, label="${label}")`);
await press('right', 'trigger');
if (!(await st()).paused) ok('trigger again resumes'); else fail('trigger did not resume');

// 12. Grip grabs the scene: it follows the hand (move and turn about the vertical), and never tilts
const q0 = await page.evaluate(() => window.__nine.userQuat());
const a0 = await page.evaluate(() => window.__nine.anchorWorld());
await page.evaluate(() => { const c = window.__iwer.controllers.right; c.quaternion.set(0, 0, 0, 1); c.updateButtonValue('squeeze', 1); });
await wait(150);
// move 20 cm and twist the wrist: 46° about the vertical plus a 30° pitch and 20° roll that must not reach the scene
await page.evaluate(() => {
  const c = window.__iwer.controllers.right;
  const e = (x, y, z) => { // XYZ Euler → quaternion
    const [c1, c2, c3, s1, s2, s3] = [Math.cos(x / 2), Math.cos(y / 2), Math.cos(z / 2), Math.sin(x / 2), Math.sin(y / 2), Math.sin(z / 2)];
    return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
  };
  c.quaternion.set(...e(0.52, 0.8, 0.35));
  c.position.set(c.position.x + 0.2, c.position.y, c.position.z);
});
await wait(300);
await page.evaluate(() => window.__iwer.controllers.right.updateButtonValue('squeeze', 0));
const q1 = await page.evaluate(() => window.__nine.userQuat());
const a1 = await page.evaluate(() => window.__nine.anchorWorld());
const dq = Math.abs(q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3]);
const da = Math.hypot(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]);
const tilt = Math.hypot(q1[0], q1[2]);
if (dq < 0.995 && da > 0.05) ok(`grip grabs the scene: turned ${(2 * Math.acos(Math.min(1, dq)) * 57.3).toFixed(0)}°, moved ${da.toFixed(2)} m`); else fail(`grip grab failed (dq=${dq}, moved ${da})`);
if (tilt < 1e-3) ok('grabbing never tilts the scene (rotation stays about the vertical)'); else fail(`grab tilted the scene (quaternion ${q1.map((v) => v.toFixed(3))})`);

// frame times
const ft = await page.evaluate(() => window.__nine.frameTimes.slice());
const sorted = [...ft].sort((x, y) => x - y);
const pct = (p) => sorted[Math.floor(sorted.length * p)].toFixed(1);
console.log(`frame times over ${ft.length} frames (software GL in CI, not Quest hardware): p50 ${pct(0.5)} ms, p90 ${pct(0.9)} ms, p99 ${pct(0.99)} ms; JS per frame ${(await page.evaluate(() => window.__nine.stepMs)).toFixed(2)} ms`);

if (errors.length) fail('console errors:\n' + errors.join('\n'));
await browser.close();
server.close();
if (failed) process.exit(1);
console.log('xr run passed');
