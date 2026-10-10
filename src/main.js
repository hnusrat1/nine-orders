import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadData } from './data.js';
import { loadAssets } from './assets.js';
import { LEVELS, KEYS, T_END, STORY_START, STORY_LEN, STAGES, Z_MIN, Z_MAX, zAt, smooth, lifeAmount } from './journey.js';
import { RoomLevel } from './levels/room.js';
import { PatientLevel } from './levels/patient.js';
import { TissueLevel } from './levels/tissue.js';
import { CellLevel } from './levels/cell.js';
import { ChromatinLevel } from './levels/chromatin.js';
import { DnaLevel } from './levels/dna.js';
import { LogStrip, ScaleBar, Callout, SubtitlePanel } from './hud.js';
import { Narrator, script } from './narration.js';
import { aboutHTML } from './about.js';
import { introHTML } from './intro.js';
import { VRMenu, ControllerLabel, controllerBody, pointerRay, TitleCard, LogStripVR, StatsPanel } from './vrui.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { makeComposer } from './post.js';
import { Ambient } from './ambient.js';
import { setClip, CLIP_VR, CLIP_DESKTOP } from './clip.js';

const $ = (id) => document.getElementById(id);
const CLASSES = { room: RoomLevel, patient: PatientLevel, tissue: TissueLevel, cell: CellLevel, chromatin: ChromatinLevel, dna: DnaLevel };
const HOLD_T = 21, HOLD_MAX = 15; // Guided waits here for the photon to be chosen
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');
const params = new URLSearchParams(location.search);

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(0.2);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
$('app').appendChild(renderer.domElement);
renderer.info.autoReset = false; // count draw calls over all passes of a frame

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
// image-based lighting from a neutral studio environment: gives the molecules and the body real shading
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.28;
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 400);
// The player rig carries the camera and controllers, so VR locomotion moves the rig.
const player = new THREE.Group();
player.add(camera);
scene.add(player);
scene.add(new THREE.HemisphereLight(0xb9c8d8, 0x1a1410, 0.6));
const key = new THREE.DirectionalLight(0xfff1e0, 1.5);
key.position.set(1.5, 3, 2);
scene.add(key);
const rim = new THREE.DirectionalLight(0x8fb4ff, 0.6);
rim.position.set(-2, 1, -2);
scene.add(rim);
const ambient = new Ambient();
ambient.addTo(scene);
const post = params.has('nobloom') ? null : makeComposer(renderer, scene, camera);

// Anchor: where the particle sits in display space. In VR it is placed in
// front of the viewer on the first frame; the grip can move it.
const ANCHOR_DESKTOP = new THREE.Vector3(0, 1.2, 0);
const anchorWorld = ANCHOR_DESKTOP.clone();
const userQuat = new THREE.Quaternion();

// Desktop/phone camera: orbit around a focus point, which you can pan and fly.
const CAM0 = { r: 1.55, theta: 0.32, phi: 1.12 };
const cam = { focus: anchorWorld.clone(), ...CAM0, recenter: null };

// ------------------------------------------------------------------ state
const S = {
  mode: 'guided', paused: false, started: false,
  T: 0, z: 0, zVel: 0, lastZ: 0, moveVel: 0,
  selected: false, holdTime: 0,
  clocks: Object.fromEntries(LEVELS.map((l) => [l.id, 0])),
  time: 0, voice: true, dominant: 'room', ended: false, lastStage: null,
};
const debug = { frameTimes: [], errors: [], ready: false, stepMs: 0 };
window.__nine = debug;

let levels = [], data, narrator, logstrip, scaleBar, subsPanel, labelPanel;
const hint = $('hint');

// ------------------------------------------------------------------ boot
async function boot() {
  $('status').textContent = 'Loading data…';
  data = await loadData();
  ISO_HEIGHT = data.index.geometry.isoHeight_mm / 1000;
  $('intro-facts').innerHTML = introHTML(data);
  const assets = await loadAssets(data.index);
  for (const def of LEVELS) {
    const L = new CLASSES[def.id](def, data, assets);
    levels.push(L);
    scene.add(L.root);
    scene.add(L.ui);
  }
  logstrip = new LogStrip($('logstrip'));
  scaleBar = new ScaleBar();
  scene.add(scaleBar.group);
  subsPanel = new SubtitlePanel();
  labelPanel = new Callout({ lines: 3, width: 760, height: 0.1 });
  labelPanel.opacity = 0;
  scene.add(labelPanel.mesh);
  narrator = new Narrator($('subtitles'), script(data.n));
  narrator.onText = (t) => subsPanel.set(t);
  $('about-body').innerHTML = aboutHTML(data);
  $('status').textContent = '';
  buildProgress();
  buildVRFurniture();
  levels[0].buildReflections(renderer);
  if (levels[0].env) levels[1].setEnv(levels[0].env);
  debug.levels = levels;
  applyFrame(0);
  warmUp();
  debug.ready = true;
}

// Draw everything once, hidden behind the start panel: compiles every shader and
// uploads every geometry and texture now rather than as a hitch the first time a
// level, panel or controller appears (worst in VR, where a dropped frame shows).
function warmUp() {
  const restore = [];
  scene.traverse((o) => {
    restore.push([o, o.visible, o.frustumCulled]);
    o.visible = true;
    o.frustumCulled = false;
  });
  const t0 = performance.now();
  renderer.compile(scene, camera);              // the programs used on screen and in the headset
  const rt = new THREE.WebGLRenderTarget(64, 64); // a tiny draw: uploads buffers and textures, and the off-screen variants bloom uses
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  rt.dispose();
  for (const [o, v, f] of restore) { o.visible = v; o.frustumCulled = f; }
  debug.warmUpMs = performance.now() - t0;
}

// ------------------------------------------------------------------ menu, toolbar, onboarding
function setMode(m) {
  S.mode = m;
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('tb-mode').textContent = m === 'guided' ? 'Guided' : 'Explore';
  if (m === 'explore') for (const l of LEVELS) S.clocks[l.id] = Math.max(0, S.T - STORY_START[l.id]);
  if (m === 'guided') S.T = timeForZ(S.z);
}
function setVoice(on) {
  S.voice = on;
  document.querySelectorAll('[data-voice]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.voice === 'on') === on)));
  $('tb-voice').textContent = on ? 'Voice on' : 'Voice off';
  if (narrator) narrator.setMuted(!on);
}
function setPaused(p) {
  S.paused = p;
  $('tb-pause').textContent = p ? '▶' : '❚❚';
  $('tb-pause').setAttribute('aria-label', p ? 'Play' : 'Pause');
  if (!p) hideLabel();
}
function showControls(on) { $('controls-card').hidden = !on; }
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('[data-voice]').forEach((b) => b.addEventListener('click', () => setVoice(b.dataset.voice === 'on')));
$('btn-about').addEventListener('click', () => { $('about').hidden = false; });
$('about-close').addEventListener('click', () => { $('about').hidden = true; });
$('tb-menu').addEventListener('click', () => { $('menu').hidden = false; setPaused(true); });
$('tb-pause').addEventListener('click', () => setPaused(!S.paused));
$('tb-mode').addEventListener('click', () => setMode(S.mode === 'guided' ? 'explore' : 'guided'));
$('tb-voice').addEventListener('click', () => setVoice(!S.voice));
$('tb-recenter').addEventListener('click', () => recenter());
$('tb-help').addEventListener('click', () => showControls($('controls-card').hidden));
$('controls-close').addEventListener('click', () => showControls(false));

function buildProgress() {
  const nav = $('progress');
  nav.innerHTML = '';
  for (const st of STAGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = st.name;
    b.title = `${st.name} · ${st.scale}`;
    b.dataset.stage = st.id;
    b.addEventListener('click', () => jumpTo(st));
    nav.appendChild(b);
  }
}
function jumpTo(st) {
  if (S.mode === 'guided') { S.T = st.jumpT; if (S.T > HOLD_T) S.selected = true; S.ended = false; }
  else S.z = st.jumpZ;
  setPaused(false);
}
function updateProgress() {
  const idx = STAGES.findIndex((s) => s.id === S.dominant);
  document.querySelectorAll('#progress button').forEach((b, i) => {
    b.classList.toggle('now', i === idx);
    b.classList.toggle('done', i < idx);
  });
}

let firstStart = true;
function start() {
  $('menu').hidden = true;
  $('hud').hidden = false;
  if (!S.started || S.ended) restart();
  setPaused(false);
  S.started = true;
  if (firstStart && !renderer.xr.isPresenting) {
    showControls(true);
    setTimeout(() => showControls(false), 16000);
  }
  firstStart = false;
  // A user gesture is needed before speech works on most browsers.
  if (narrator && S.voice && window.speechSynthesis) window.speechSynthesis.resume();
}
function restart() {
  S.T = 0; S.z = 0; S.selected = false; S.holdTime = 0; S.ended = false; S.lastStage = null;
  for (const l of LEVELS) S.clocks[l.id] = 0;
  if (narrator) narrator.reset();
}
$('btn-start').addEventListener('click', start);

if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) return;
    $('btn-vr').hidden = false;
    document.body.classList.add('xr-capable');
  }).catch(() => {});
}
$('btn-vr').addEventListener('click', async () => {
  try {
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    await renderer.xr.setSession(session);
    start();
    setPaused(true); // the welcome panel explains the controls first
    session.addEventListener('end', () => { $('menu').hidden = false; setPaused(true); });
  } catch (e) {
    $('status').textContent = 'Could not start VR: ' + e.message;
  }
});

// Guided time at which the timeline first reaches zoom z (for mode switches).
function timeForZ(z) {
  for (let i = 1; i < KEYS.length; i++) {
    const [t0, z0] = KEYS[i - 1], [t1, z1] = KEYS[i];
    if (z1 > z0 && z >= z0 && z <= z1) {
      let lo = t0, hi = t1;
      for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (zAt(m) < z) lo = m; else hi = m; }
      return lo;
    }
  }
  return 0;
}

// ------------------------------------------------------------------ shared actions
function zoomBy(dz) { // explore: change z; guided: scrub along the timeline
  if (S.mode === 'explore') S.z = Math.min(Z_MAX, Math.max(Z_MIN, S.z + dz));
  else scrub(dz * 9);
}
function scrub(dT) {
  S.T = Math.min(T_END, Math.max(0, S.T + dT));
  if (S.T > HOLD_T && !S.selected) S.selected = true;
  if (S.T < T_END) S.ended = false;
}
function rayPick(ray) {
  let best = null;
  for (const L of levels) {
    const p = L.pick(ray);
    if (p && (!best || p.priority > best.priority || (p.priority === best.priority && p.distance < best.distance))) best = p;
  }
  return best;
}
function selectPhoton() { S.selected = true; setPaused(false); }
function activate(ray, screen) { // click / tap / trigger
  const room = levels[0];
  if (!S.selected && room.weight > 0.5 && room.pick(ray, 'photon')) { selectPhoton(); return; }
  if (S.paused) { setPaused(false); return; }
  const hit = rayPick(ray);
  setPaused(true);
  if (hit) showLabel(hit, screen); else showLabel({ label: 'Paused. Point at anything to see what it is; select again to continue.', point: null }, screen);
}
function showLabel(hit, screen) {
  if (renderer.xr.isPresenting) {
    const words = hit.label;
    const cut = words.length > 60 ? words.lastIndexOf(' ', 58) : words.length;
    labelPanel.set(words.slice(0, cut), splitRows(words.slice(cut + 1)));
    const p = hit.point ? hit.point.clone() : anchorWorld.clone().add(new THREE.Vector3(0, 0.25, 0));
    p.lerp(xr.head, 0.25);
    labelPanel.mesh.position.copy(p);
    labelPanel.opacity = 1;
  } else {
    const el = $('label');
    el.textContent = hit.label;
    el.hidden = false;
    const x = screen ? screen.x : window.innerWidth / 2, y = screen ? screen.y : window.innerHeight / 2;
    el.style.left = Math.max(10, Math.min(window.innerWidth - 320, x + 14)) + 'px';
    el.style.top = Math.max(10, y - 20) + 'px';
  }
}
function splitRows(s) {
  const out = []; let cur = '';
  for (const w of s.split(' ')) { if ((cur + ' ' + w).length > 60) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; }
  if (cur) out.push(cur);
  return out.slice(0, 3);
}
function hideLabel() { $('label').hidden = true; if (labelPanel) labelPanel.opacity = 0; }
function recenter() {
  if (renderer.xr.isPresenting) { xr.needsPlace = true; return; }
  cam.recenter = { t: 0, from: { focus: cam.focus.clone(), r: cam.r, theta: cam.theta, phi: cam.phi } };
}

// ------------------------------------------------------------------ desktop + touch input
const el = renderer.domElement;
el.addEventListener('contextmenu', (e) => e.preventDefault());
const pointers = new Map();
let drag = null, pinch = null;
el.addEventListener('pointerdown', (e) => {
  try { el.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    drag = null;
  } else drag = { moved: false, pan: e.button === 2 || e.button === 1 || e.shiftKey };
});
el.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    zoomBy(Math.log10(d / pinch.d) * 1.6);
    pan(mx - pinch.mx, my - pinch.my);
    Object.assign(pinch, { d, mx, my });
    return;
  }
  if (drag) {
    if (Math.hypot(p.x - p.x0, p.y - p.y0) > 5) drag.moved = true;
    if (!drag.moved) return;
    if (drag.pan) pan(dx, dy);
    else { cam.theta -= dx * 0.005; cam.phi = Math.min(3.0, Math.max(0.15, cam.phi - dy * 0.005)); }
    cam.recenter = null;
  }
});
function pan(dx, dy) {
  const k = cam.r / window.innerHeight * 1.2;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  cam.focus.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  cam.recenter = null;
}
function endPointer(e) {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (p && drag && !drag.moved && e.button !== 2 && performance.now() - p.t0 < 600 && S.started) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1), camera);
    activate(rc.ray, { x: e.clientX, y: e.clientY });
  }
  if (pointers.size === 0) drag = null;
}
el.addEventListener('pointerup', endPointer);
el.addEventListener('pointercancel', endPointer);
el.addEventListener('wheel', (e) => {
  e.preventDefault();
  const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  zoomBy(-d * 0.0012);
}, { passive: false });
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
  const k = e.key.toLowerCase();
  keys.add(k);
  if (!S.started) return;
  if (k === ' ' || k === 'p') { setPaused(!S.paused); e.preventDefault(); }
  if (k === 'g') setMode(S.mode === 'guided' ? 'explore' : 'guided');
  if (k === 'n') setVoice(!S.voice);
  if (k === 'h' || k === '?') showControls($('controls-card').hidden);
  if (k === 'f') recenter();
  if (k === 'escape') { $('about').hidden = true; $('menu').hidden = !$('menu').hidden; setPaused(!$('menu').hidden); }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (post) post.setSize(window.innerWidth, window.innerHeight);
});

function desktopKeys(dt) {
  // zoom through the scales
  const kz = (keys.has('+') || keys.has('=') || keys.has('pageup') ? 1 : 0) - (keys.has('-') || keys.has('_') || keys.has('pagedown') ? 1 : 0);
  if (kz) zoomBy(kz * 0.6 * dt);
  // fly: WASD in the view direction, Q/E down/up; Shift is faster
  const f = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  const s = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  const u = (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0);
  if (f || s || u) {
    const speed = (keys.has('shift') ? 2.4 : 0.8) * dt;
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
    if (f) { // move towards/away from the focus first (dolly), then through it
      const nr = cam.r - f * speed;
      if (nr > 0.15) cam.r = nr; else cam.focus.addScaledVector(fwd, f * speed);
    }
    cam.focus.addScaledVector(right, s * speed).addScaledVector(new THREE.Vector3(0, 1, 0), u * speed);
    cam.recenter = null;
  }
}

function updateDesktopCamera(dt) {
  if (cam.recenter) {
    const R = cam.recenter;
    R.t = Math.min(1, R.t + dt / 0.7);
    const k = smooth(R.t);
    cam.focus.lerpVectors(R.from.focus, anchorWorld, k);
    cam.r = R.from.r + (CAM0.r - R.from.r) * k;
    cam.theta = R.from.theta + (CAM0.theta - R.from.theta) * k;
    cam.phi = R.from.phi + (CAM0.phi - R.from.phi) * k;
    if (R.t >= 1) cam.recenter = null;
  }
  const r = cam.r * (camera.aspect < 1 ? 1 + 0.6 * (1 - camera.aspect) : 1); // portrait phones see less width
  camera.position.set(
    cam.focus.x + r * Math.sin(cam.phi) * Math.sin(cam.theta),
    cam.focus.y + r * Math.cos(cam.phi),
    cam.focus.z + r * Math.sin(cam.phi) * Math.cos(cam.theta));
  camera.lookAt(cam.focus);
}

// ------------------------------------------------------------------ XR: poses
// three.js updates the XR camera's world matrix only inside render(), so before
// rendering it still holds the previous frame (and the identity on the first
// frame of a session). Everything here reads the viewer pose of the current
// XRFrame instead. Poses come in two frames: rig-local (the reference space,
// what the headset reports) and world (rig-local moved by locomotion).
const xr = {
  head: new THREE.Vector3(), yaw: 0,          // world
  headL: new THREE.Vector3(), yawL: 0,        // rig-local
  valid: false, emulated: false,
  placed: false, waitFrames: 0, needsPlace: false,
};
const _hm = new THREE.Matrix4(), _fwd = new THREE.Vector3();
function readHead() {
  xr.valid = false;
  const frame = renderer.xr.getFrame(), ref = renderer.xr.getReferenceSpace();
  const pose = frame && ref ? frame.getViewerPose(ref) : null;
  if (!pose) return;
  _hm.fromArray(pose.transform.matrix);
  xr.headL.setFromMatrixPosition(_hm);
  _fwd.set(0, 0, -1).transformDirection(_hm);
  xr.yawL = Math.atan2(-_fwd.x, -_fwd.z);
  player.updateMatrixWorld();
  _hm.premultiply(player.matrixWorld);
  xr.head.setFromMatrixPosition(_hm);
  _fwd.set(0, 0, -1).transformDirection(_hm);
  xr.yaw = Math.atan2(-_fwd.x, -_fwd.z);
  xr.valid = true;
  xr.emulated = !!pose.emulatedPosition;
}

// The stage: the particle 0.95 m in front of the eyes and about 19° below them,
// turned to face you. Called on entering VR, from Recenter, and when the
// headset's own recentre (hold the Meta button) resets the reference space.
// Standing, the isocentre goes at its real height, so the life-size room's floor
// is your floor; seated, it goes a little below the eyes. You face the patient's
// side (the room is turned 90°), as a therapist would standing at the couch.
const STAGE_DIST = 0.95, STAGE_DROP = 0.32;
let ISO_HEIGHT = 1.25; // replaced by the data's value at boot
function placeStage() {
  const y = xr.head.y > ISO_HEIGHT + 0.2 ? Math.max(ISO_HEIGHT, xr.head.y - 0.5) : Math.max(0.5, xr.head.y - STAGE_DROP);
  anchorWorld.set(xr.head.x - Math.sin(xr.yaw) * STAGE_DIST, y, xr.head.z - Math.cos(xr.yaw) * STAGE_DIST);
  userQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), xr.yaw - Math.PI / 2);
  hudSnap();
}

// ------------------------------------------------------------------ XR: furniture
// Reading panels live in the player rig, so walking and snap-turning carry them
// along. Within the rig they follow the head lazily: nothing moves until you
// turn more than ~28° or step more than ~25 cm away, then they glide back in
// front. Yaw only, never roll or pitch.
const menu = new VRMenu();
const titleCard = new TitleCard();
const hud = { rig: new THREE.Group(), yaw: 0, pos: new THREE.Vector3(), turning: false, moving: false };
hud.rig.name = 'vr-hud';
hud.rig.visible = false;
player.add(hud.rig, menu.mesh);
let logVR = null, statsVR = null, vignette = null, callouts = [];
const infoSlot = new THREE.Group();
// In VR the callouts dock in a column to the right of the scene; on desktop they float beside the particle.
function dockCallouts(inXR) {
  let y = 0;
  for (const c of callouts) {
    if (inXR) {
      if (c.m.parent !== infoSlot) { infoSlot.add(c.m); c.m.rotation.set(0, 0, 0); c.m.scale.setScalar(0.5); }
      c.m.visible = c.L.weight > 0.3 && c.m.material.opacity > 0.01;
      if (!c.m.visible) continue;
      const h = c.m.geometry.parameters.height * 0.5;
      c.m.position.set(0, -y - h / 2, 0);
      y += h + 0.012;
    } else if (c.m.parent !== c.L.ui) {
      c.L.ui.add(c.m); c.m.position.copy(c.home); c.m.scale.setScalar(1);
    }
  }
}
function buildVRFurniture() {
  subsPanel.mesh.position.set(0, 0.11, -1.25);
  subsPanel.mesh.name = 'vr-subtitles';
  titleCard.mesh.position.set(0, 0.4, -1.4);
  titleCard.mesh.name = 'vr-title';
  logVR = new LogStripVR(LEVELS, 0.36);
  logVR.mesh.position.set(-Math.sin(0.66) * 1.05, -0.06, -Math.cos(0.66) * 1.05);
  logVR.mesh.rotation.y = 0.66;
  logVR.mesh.name = 'vr-logstrip';
  hud.rig.add(subsPanel.mesh, titleCard.mesh, logVR.mesh);
  // numbers (the levels' callouts) are read off to the right in VR, not floated in front of the scene
  infoSlot.position.set(Math.sin(0.62) * 1.0, 0.06, -Math.cos(0.62) * 1.0);
  infoSlot.rotation.y = -0.62;
  infoSlot.name = 'vr-info';
  hud.rig.add(infoSlot);
  callouts = levels.flatMap((L) => L.ui.children.filter((o) => o.userData.callout).map((m) => ({ m, L, home: m.position.clone() })));
  if (params.has('stats')) {
    statsVR = new StatsPanel();
    statsVR.mesh.position.set(0.42, -0.3, -0.9);
    statsVR.mesh.rotation.y = -0.4;
    hud.rig.add(statsVR.mesh);
  }
  // head-locked edge vignette for fast zooms and walking
  vignette = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.6, 48, 1), new THREE.ShaderMaterial({
    uniforms: { uO: { value: 0 } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform float uO; varying vec2 vP; void main(){ float r = length(vP); float a = smoothstep(0.075, 0.13, r) * uO; gl_FragColor = vec4(0.0,0.0,0.0,a); }',
    transparent: true, depthTest: false, depthWrite: false,
  }));
  vignette.position.set(0, 0, -0.1);
  vignette.renderOrder = 40;
  vignette.visible = false;
  camera.add(vignette);
}
function hudSnap() {
  hud.yaw = xr.yawL; hud.pos.copy(xr.headL);
  hud.turning = hud.moving = false;
  hud.rig.position.copy(hud.pos); hud.rig.rotation.set(0, hud.yaw, 0);
}
function hudUpdate(dt) {
  let d = xr.yawL - hud.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  if (Math.abs(d) > 0.49) hud.turning = true;
  if (hud.turning) {
    hud.yaw += d * (1 - Math.exp(-dt * 4));
    if (Math.abs(d) < 0.04) hud.turning = false;
  }
  const dx = xr.headL.x - hud.pos.x, dy = xr.headL.y - hud.pos.y, dz = xr.headL.z - hud.pos.z;
  const dh = Math.hypot(dx, dz);
  if (dh > 0.25 || Math.abs(dy) > 0.2) hud.moving = true;
  if (hud.moving) {
    hud.pos.lerp(xr.headL, 1 - Math.exp(-dt * 4));
    if (dh < 0.02 && Math.abs(dy) < 0.02) hud.moving = false;
  }
  hud.rig.position.copy(hud.pos);
  hud.rig.rotation.set(0, hud.yaw, 0);
  titleCard.update(dt);
}

// ------------------------------------------------------------------ XR: controllers
const modelFactory = new XRControllerModelFactory().setPath('assets/controllers');
const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const ray = pointerRay();
  c.add(ray.group);
  const grip = renderer.xr.getControllerGrip(i);
  const body = controllerBody();
  const model = modelFactory.createControllerModel(grip);
  grip.add(body, model);
  c.userData = { ray, prev: {}, grab: null, grip, body, model, turnArmed: true, hand: null, label: null, source: null };
  menu.mesh.add(ray.dot);
  c.addEventListener('connected', (e) => {
    c.userData.source = e.data;
    c.userData.hand = e.data.handedness;
    if (!c.userData.label) { c.userData.label = new ControllerLabel(e.data.handedness === 'left' ? 'left' : 'right'); grip.add(c.userData.label.mesh); }
    c.userData.label.setMode(S.mode);
  });
  c.addEventListener('disconnected', () => { c.userData.source = null; c.userData.grab = null; });
  player.add(c, grip);
  return c;
});
let labelsUntil = 0;

const _rq = new THREE.Quaternion();
function controllerRay(c, out = new THREE.Ray()) {
  out.origin.setFromMatrixPosition(c.matrixWorld);
  out.direction.set(0, 0, -1).transformDirection(c.matrixWorld);
  return out;
}
// Rotation about the vertical axis only (swing–twist): grabbing never tilts the horizon.
function yawOf(q) {
  return 2 * Math.atan2(q.y, q.w);
}

function menuState() { return { paused: S.paused, mode: S.mode, voice: S.voice }; }
let pausedBeforeMenu = false;
function openMenu(welcome) {
  if (!welcome) { pausedBeforeMenu = S.paused; setPaused(true); }
  menu.open(welcome, menuState(), xr.headL, xr.yawL);
  labelsUntil = Infinity;
}
function closeMenu(resume = true) {
  const wasWelcome = menu.welcome;
  menu.close();
  labelsUntil = S.time + (wasWelcome ? 30 : 12);
  if (resume) setPaused(wasWelcome ? false : pausedBeforeMenu);
}
function menuAction(id) {
  if (id === 'primary') closeMenu();
  else if (id === 'mode') setMode(S.mode === 'guided' ? 'explore' : 'guided');
  else if (id === 'voice') setVoice(!S.voice);
  else if (id === 'recenter') { xr.needsPlace = true; closeMenu(false); setPaused(false); }
  else if (id === 'restart') { restart(); closeMenu(false); setPaused(false); }
  else if (id === 'exit') { const s = renderer.xr.getSession(); if (s) s.end(); }
  if (menu.isOpen) menu.setState(menuState());
}

const _ray = new THREE.Ray();
function pollXR(dt) {
  player.updateMatrixWorld(true); // controllers were posed for this frame; bring their world matrices up to date
  let hoverIdx = -1;
  for (const c of controllers) {
    const u = c.userData, src = u.source;
    // stand-in body until the real model has loaded
    u.body.visible = !(u.model.motionController && u.model.children.length);
    if (!src || !src.gamepad) { u.ray.dot.visible = false; continue; }
    const gp = src.gamepad, b = gp.buttons, ax = gp.axes;
    const pressed = (i) => !!(b[i] && b[i].pressed);
    const edge = (i) => pressed(i) && !u.prev[i];
    const sx = ax.length >= 4 ? ax[2] : (ax[0] || 0), sy = ax.length >= 4 ? ax[3] : (ax[1] || 0);
    const left = src.handedness === 'left';
    const ray = controllerRay(c, _ray);
    const mh = menu.hit(ray);
    if (mh.onPanel && hoverIdx < 0) hoverIdx = mh.index;
    u.ray.setLength(mh.onPanel ? mh.distance : 1.2);
    u.ray.dot.visible = mh.onPanel;
    if (mh.onPanel) u.ray.dot.position.copy(mh.point).applyMatrix4(_inv4.copy(menu.mesh.matrixWorld).invert()).setZ(0.002);

    if (!menu.isOpen) {
      if (left) {
        // left stick: walk where you look
        const mag = Math.hypot(sx, sy);
        if (mag > 0.18) {
          const v = 1.1 * dt * Math.min(1, (mag - 0.18) / 0.82) / mag;
          // forward = (-sin yaw, -cos yaw); right = (cos yaw, -sin yaw); stick up (sy < 0) walks forward
          player.position.x += (-Math.sin(xr.yaw) * -sy + Math.cos(xr.yaw) * sx) * v;
          player.position.z += (-Math.cos(xr.yaw) * -sy - Math.sin(xr.yaw) * sx) * v;
          S.moveVel = Math.min(1, mag);
        }
      } else {
        // right stick: up/down zooms (Explore) or moves along the story (Guided); left/right snap-turns 30°
        if (Math.abs(sy) > 0.2 && Math.abs(sy) > Math.abs(sx)) {
          const v = -Math.sign(sy) * (Math.abs(sy) - 0.2) / 0.8;
          if (S.mode === 'explore') S.z = Math.min(Z_MAX, Math.max(Z_MIN, S.z + v * 0.7 * dt));
          else scrub(v * 9 * dt);
        }
        if (u.turnArmed && Math.abs(sx) > 0.7 && !u.grab) { snapTurn(-Math.sign(sx) * Math.PI / 6); u.turnArmed = false; }
        if (Math.abs(sx) < 0.3) u.turnArmed = true;
      }
    }

    if (edge(0)) {                                                      // trigger
      if (menu.isOpen) { if (mh.index >= 0) menuAction(menu.buttons[mh.index].id); }
      else activate(ray, null);
    }
    if (edge(1) && !menu.isOpen) {                                      // grip: grab the photon, or grab the scene
      const room = levels[0];
      if (!S.selected && room.weight > 0.5 && room.pick(ray, 'photon')) selectPhoton();
      else {
        for (const k of controllers) k.userData.grab = null; // one hand at a time
        u.grab = { p0: ray.origin.clone(), yaw0: yawOf(c.getWorldQuaternion(_rq)), a0: anchorWorld.clone(), u0: userQuat.clone() };
      }
    }
    if (!pressed(1)) u.grab = null;
    if (u.grab) {
      // the scene follows the hand: its translation, and its turn about the vertical
      const g = u.grab;
      const dyaw = yawOf(c.getWorldQuaternion(_rq)) - g.yaw0;
      const R = _gq.setFromAxisAngle(_Y, dyaw);
      anchorWorld.copy(g.a0).sub(g.p0).applyQuaternion(R).add(ray.origin);
      userQuat.copy(R).multiply(g.u0);
    }
    if (edge(4) && !menu.isOpen) setMode(S.mode === 'guided' ? 'explore' : 'guided'); // A / X
    if (edge(5)) { if (menu.isOpen) closeMenu(); else openMenu(false); } // B / Y
    for (let i = 0; i < b.length; i++) u.prev[i] = pressed(i);
  }
  menu.setHover(hoverIdx);
  if (menu.isOpen) menu.setState(menuState()); // redraws only if something changed
  // while paused, the right ray labels what it points at (when it has moved)
  if (S.paused && !menu.isOpen && labelPanel.mesh.visible && S.time - (pollXR.lastHover || 0) > 0.2) {
    const c = controllers.find((k) => k.userData.hand === 'right') || controllers[0];
    const ray = controllerRay(c);
    const key = ray.direction.toArray().map((v) => v.toFixed(2)).join() + ray.origin.toArray().map((v) => v.toFixed(2)).join();
    if (key !== pollXR.lastKey) {
      pollXR.lastKey = key; pollXR.lastHover = S.time;
      const hit = rayPick(ray);
      if (hit) showLabel(hit, null);
    }
  }
  const showLabels = S.time < labelsUntil;
  for (const c of controllers) if (c.userData.label) { c.userData.label.mesh.visible = showLabels; c.userData.label.setMode(S.mode); }
}
const _inv4 = new THREE.Matrix4(), _gq = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0);

// Turn the rig about the head, so you stay where you are and the world turns.
function snapTurn(angle) {
  const p = player.position.clone().sub(xr.head).applyAxisAngle(_Y, angle).add(xr.head);
  player.position.copy(p);
  player.rotation.y += angle;
  readHead();
}

function xrFrame(dt) {
  readHead();
  if (!xr.valid) return false;
  if (!xr.placed) {
    // wait until the headset reports a tracked position (or ~1 s), then set the stage and say hello
    if (xr.emulated && ++xr.waitFrames < 72) return false;
    placeStage();
    openMenu(true);
    xr.placed = true;
  } else if (xr.needsPlace) {
    placeStage();
    xr.needsPlace = false;
  }
  pollXR(dt);
  readHead(); // walking may have moved the rig
  hudUpdate(dt);
  return true;
}

renderer.xr.addEventListener('sessionstart', () => {
  Object.assign(xr, { placed: false, waitFrames: 0, needsPlace: false });
  hud.rig.visible = true;
  vignette.visible = true;
  const ref = renderer.xr.getReferenceSpace();
  if (ref && ref.addEventListener) ref.addEventListener('reset', () => { xr.needsPlace = true; });
});
renderer.xr.addEventListener('sessionend', () => {
  anchorWorld.copy(ANCHOR_DESKTOP); userQuat.identity();
  player.position.set(0, 0, 0); player.rotation.set(0, 0, 0);
  menu.close();
  hud.rig.visible = false;
  vignette.visible = false;
  hideLabel();
});

// ------------------------------------------------------------------ frame
const clock = new THREE.Clock();
function step(dt) {
  S.time += dt;
  S.moveVel *= 0.85;
  if (renderer.xr.isPresenting) xrFrame(dt);
  else if (S.started) desktopKeys(dt);

  if (S.mode === 'guided') {
    if (S.started && !S.paused && !S.ended) {
      let next = S.T + dt;
      if (!S.selected && next >= HOLD_T) {
        next = Math.max(S.T, HOLD_T);
        S.holdTime += dt;
        if (S.holdTime > HOLD_MAX) S.selected = true;
      }
      S.T = Math.min(T_END, next);
      if (S.T >= T_END) S.ended = true;
    }
    S.z = zAt(S.T);
  } else if (S.started && !S.paused) {
    for (const L of levels) if (L.weight > 0.3) S.clocks[L.id] = Math.min(STORY_LEN[L.id], S.clocks[L.id] + dt);
    if (S.clocks.room >= HOLD_T) S.selected = true;
  }
  applyFrame(dt);
}

function applyFrame(dt) {
  const z = S.z;
  const ctx = { dt, time: S.time, selected: S.selected, T: S.T, z, camPos: _camPos }; // camPos: last frame's eye position
  let dom = null, dw = 0;
  for (const L of levels) {
    const w = L.computeWeight(z);
    L.weight = w;
    L.root.position.copy(anchorWorld);
    L.uiScale = renderer.xr.isPresenting ? 0.72 : 1;
    if (w > 0.002) L.update(S.mode === 'guided' ? S.T - STORY_START[L.id] : S.clocks[L.id], ctx);
    L.apply(z, anchorWorld, userQuat, w, dt);
    if (w > dw) { dw = w; dom = L; }
  }
  S.dominant = dom ? dom.id : 'room';
  if (S.started && S.dominant !== S.lastStage) {
    S.lastStage = S.dominant;
    announceStage(S.dominant);
  }

  const inXR = renderer.xr.isPresenting;
  if (!inXR) updateDesktopCamera(dt);
  camera.updateMatrixWorld();
  const camPos = _camPos;
  if (inXR) camPos.copy(xr.head); else camPos.setFromMatrixPosition(camera.matrixWorld);
  // the diorama bubble opens up while the room is life-size
  const life = lifeAmount(z), clipBase = inXR ? CLIP_VR : CLIP_DESKTOP;
  _clipCfg.r[0] = clipBase.r[0] + life * 7; _clipCfg.r[1] = clipBase.r[1] + life * 11; _clipCfg.near = clipBase.near;
  setClip(anchorWorld, _clipCfg);

  // billboards (callouts, labels) — yaw-only so the horizon stays level
  for (const L of levels) for (const o of L.ui.children) if (o.userData.billboard) yawFace(o, camPos);
  if (labelPanel.mesh.visible) yawFace(labelPanel.mesh, camPos);

  // scale bar under the anchor, facing the viewer
  scaleBar.update(z, { subtle: inXR, opacity: 1 - smooth(life * 3) });
  const toCam = _toCam.copy(camPos).sub(anchorWorld); toCam.y = 0; toCam.normalize();
  scaleBar.group.position.copy(anchorWorld).addScaledVector(toCam, 0.15);
  scaleBar.group.position.y -= inXR ? 0.3 : 0.27;
  yawFace(scaleBar.group, camPos);

  if (inXR) logVR.update(z); else logstrip.draw(z, S.dominant);
  dockCallouts(inXR);
  if (statsVR || statsEl) updateStats();
  // bloom is for the glowing tracks and points; the lit room would turn to haze
  if (post) post.bloom.strength = 0.42 - 0.36 * levels[0].weight;
  ambient.update(levels, camPos, S.time);
  updateProgress();

  // narration
  if (narrator && S.started) {
    if (S.mode === 'guided') narrator.atTime(S.T);
    else narrator.forLevel(S.dominant);
  }
  const waiting = !S.selected && S.started && levels[0].weight > 0.5 && (S.mode === 'explore' ? S.clocks.room : S.T) > 11;
  hint.textContent = waiting
    ? (isTouch ? 'Tap the glowing photon to follow it' : 'Click the glowing photon to follow it')
    : S.paused && S.started ? 'Paused · click or tap to continue' : '';

  // comfort vignette during fast zooms and while walking
  const zv = dt > 0 ? Math.abs(z - S.lastZ) / dt : 0;
  S.zVel = S.zVel * 0.85 + zv * 0.15;
  S.lastZ = z;
  const vo = Math.max(smooth((S.zVel - 0.35) / 0.8) * 0.85, S.moveVel * 0.55);
  const vd = inXR ? '0' : (smooth((S.zVel - 0.35) / 0.8) * 0.85).toFixed(2);
  if (vd !== applyFrame.vd) { $('vignette').style.opacity = vd; applyFrame.vd = vd; }
  if (vignette) vignette.material.uniforms.uO.value = vo;
}
const _camPos = new THREE.Vector3(), _toCam = new THREE.Vector3(), _clipCfg = { r: [0, 0], near: [0, 0] };

// ?stats: frame-time readout (in the headset, a small panel lower right)
const statsEl = params.has('stats') ? Object.assign(document.createElement('div'), { id: 'stats' }) : null;
if (statsEl) document.body.appendChild(statsEl);
function updateStats() {
  const now = performance.now();
  if (now - (updateStats.t || 0) < 500) return;
  updateStats.t = now;
  const ft = debug.frameTimes.slice(-90).sort((a, b) => a - b);
  if (!ft.length) return;
  const p50 = ft[Math.floor(ft.length * 0.5)], p95 = ft[Math.floor(ft.length * 0.95)];
  const lines = [`${(1000 / p50).toFixed(0)} fps  p95 ${p95.toFixed(1)} ms`, `step ${(debug.stepMs || 0).toFixed(1)} ms  calls ${debug.drawCalls}`, `${(debug.triangles / 1000).toFixed(0)}k tris  ${S.dominant}`];
  if (statsVR && renderer.xr.isPresenting) statsVR.draw(lines);
  if (statsEl) statsEl.textContent = lines.join('\n');
}

let stageTimer = null;
function announceStage(id) {
  const st = STAGES.find((s) => s.id === id);
  if (!st) return;
  const isReturn = S.mode === 'guided' && S.T > STORY_START.return;
  const num = isReturn ? 'Return' : st.num, name = isReturn ? (id === 'room' ? 'Back in the room' : st.name) : st.name;
  const box = $('stage-title');
  box.querySelector('.num').textContent = num;
  box.querySelector('.name').textContent = name;
  box.querySelector('.scale').textContent = st.scale;
  box.classList.add('show');
  clearTimeout(stageTimer);
  stageTimer = setTimeout(() => box.classList.remove('show'), 3200);
  titleCard.show(num, name, st.scale);
}

const _yp = new THREE.Vector3(), _yq = new THREE.Quaternion();
function yawFace(o, camPos) {
  o.updateWorldMatrix(true, false);
  const p = _yp.setFromMatrixPosition(o.matrixWorld);
  o.rotation.set(0, Math.atan2(camPos.x - p.x, camPos.z - p.z), 0);
  if (o.parent && o.parent !== scene) {
    // undo parent rotation so the panel still faces the viewer
    o.quaternion.premultiply(o.parent.getWorldQuaternion(_yq).invert());
  }
}

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  debug.frameTimes.push(now - last);
  if (debug.frameTimes.length > 2000) debug.frameTimes.shift();
  last = now;
  const dt = Math.min(clock.getDelta(), 0.1) * (debug.speed || 1);
  if (debug.ready) { const t0 = performance.now(); step(dt); debug.stepMs = debug.stepMs * 0.9 + (performance.now() - t0) * 0.1; }
  renderer.info.reset();
  const r0 = performance.now();
  if (post && !renderer.xr.isPresenting) post.render();
  else renderer.render(scene, camera);
  debug.renderMs = performance.now() - r0;
  debug.drawCalls = renderer.info.render.calls;
  debug.triangles = renderer.info.render.triangles;
});

// ------------------------------------------------------------------ test hooks
Object.assign(debug, {
  state: () => ({ T: S.T, z: S.z, mode: S.mode, paused: S.paused, selected: S.selected, dominant: S.dominant, started: S.started, ended: S.ended,
    presenting: renderer.xr.isPresenting, drawCalls: debug.drawCalls, triangles: debug.triangles, menuOpen: menu.isOpen, voice: S.voice, time: S.time }),
  start, setMode, setVoice,
  setT: (t) => { S.T = t; if (t > HOLD_T) S.selected = true; S.ended = t >= T_END; },
  setZ: (z) => { S.z = z; },
  setClocks: (v) => { for (const k in S.clocks) S.clocks[k] = v; },
  pickAt: (x, y) => {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1), camera);
    const h = rayPick(rc.ray);
    return h && { label: h.label, id: h.id, distance: h.distance };
  },
  subtitles: () => $('subtitles').textContent,
  photonWorld: () => levels[0].photonPos.clone().applyMatrix4(levels[0].offset.matrixWorld).toArray(),
  anchorWorld: () => anchorWorld.toArray(),
  userQuat: () => userQuat.toArray(),
  player: () => ({ pos: player.position.toArray(), yaw: player.rotation.y }),
  worldToRig: (p) => { player.updateMatrixWorld(); return new THREE.Vector3(...p).applyMatrix4(player.matrixWorld.clone().invert()).toArray(); },
  camera: () => ({ pos: camera.position.toArray(), focus: cam.focus.toArray(), r: cam.r }),
  menuButtonWorld: (id) => { menu.mesh.updateWorldMatrix(true, false); const p = menu.buttonWorld(id); return p && p.toArray(); },
  vrStart: () => { if (menu.isOpen) menuAction('primary'); },
  controllers: () => controllers.map((c) => ({ hand: c.userData.hand, model: !!(c.userData.model.motionController && c.userData.model.children.length),
    body: c.userData.body.visible, label: !!(c.userData.label && c.userData.label.mesh.visible) })),
  hudStill: () => !hud.turning && !hud.moving,
  menuButtons: () => menu.buttons.map((b) => ({ id: b.id, label: b.label })),
  // distance (display m) between the "pick this photon" ring and the photon it marks
  ringOffset: () => {
    const room = levels[0];
    room.ui.updateWorldMatrix(true, true);
    const r = new THREE.Vector3().setFromMatrixPosition(room.ring.matrixWorld);
    return { d: r.distanceTo(room.photonPos.clone().applyMatrix4(room.offset.matrixWorld)), visible: room.ring.visible };
  },
  xrHead: () => ({ pos: xr.head.toArray(), yaw: xr.yaw, valid: xr.valid, placed: xr.placed }),
  // Where something appears from the eyes: azimuth (+ right) and elevation (+ up) relative to the gaze, in degrees, and distance.
  // Also whether a panel faces the eyes (cosine between its normal and the direction to the eyes).
  xrView: (what) => {
    let p, n = null;
    if (what === 'anchor') p = anchorWorld.clone();
    else {
      const o = scene.getObjectByName(what);
      if (!o) return null;
      o.updateWorldMatrix(true, false);
      p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      n = new THREE.Vector3(0, 0, 1).transformDirection(o.matrixWorld);
      if (!o.visible) return { hidden: true };
    }
    const d = p.clone().sub(xr.head);
    const fwd = new THREE.Vector3(-Math.sin(xr.yaw), 0, -Math.cos(xr.yaw)), right = new THREE.Vector3(Math.cos(xr.yaw), 0, -Math.sin(xr.yaw));
    const f = d.dot(fwd), r = d.dot(right);
    return { az: Math.atan2(r, f) * 57.2958, el: Math.atan2(d.y, Math.hypot(f, r)) * 57.2958, dist: d.length(),
      facing: n ? n.dot(d.clone().negate().normalize()) : null };
  },
  labelText: () => (labelPanel.mesh.visible ? labelPanel.key : ''),
  setSpeed: (k) => { debug.speed = k; },
  photonScreen: () => {
    const room = levels[0];
    const p = room.photonPos.clone().applyMatrix4(room.offset.matrixWorld).project(camera);
    return { x: (p.x + 1) / 2 * window.innerWidth, y: (1 - p.y) / 2 * window.innerHeight };
  },
  numbers: () => data && data.n,
});

window.addEventListener('error', (e) => debug.errors.push(String(e.message)));
boot().catch((e) => { console.error(e); $('status').textContent = 'Failed to load: ' + e.message; debug.errors.push(String(e)); });
