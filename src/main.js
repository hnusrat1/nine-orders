import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadData } from './data.js';
import { loadAssets } from './assets.js';
import { LEVELS, KEYS, T_END, STORY_START, STORY_LEN, STAGES, Z_MIN, Z_MAX, zAt, smooth } from './journey.js';
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
import { VRMenu, controllerLabel, controllerBody, TitleCard } from './vrui.js';
import { makeComposer } from './post.js';
import { Ambient } from './ambient.js';

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
const debug = { frameTimes: [], errors: [], ready: false };
window.__nine = debug;

let levels = [], data, narrator, logstrip, scaleBar, subsPanel, labelPanel;
const hint = $('hint');

// ------------------------------------------------------------------ boot
async function boot() {
  $('status').textContent = 'Loading data…';
  data = await loadData();
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
  debug.levels = levels;
  debug.ready = true;
  // compile every level's shaders up front so the first transition does not hitch
  for (const L of levels) L.root.visible = true;
  renderer.compile(scene, camera);
  applyFrame(0);
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
    if (p && (!best || p.distance < best.distance)) best = p;
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
    const head = renderer.xr.getCamera().getWorldPosition(new THREE.Vector3());
    p.lerp(head, 0.25);
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
  if (renderer.xr.isPresenting) { placeAnchorInFront(); return; }
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

// ------------------------------------------------------------------ XR controllers and locomotion
const menu = new VRMenu();
scene.add(menu.mesh);
const titleCard = new TitleCard();
const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const ray = new THREE.Mesh(new THREE.CylinderGeometry(0.0012, 0.0012, 1, 6, 1, true).translate(0, -0.5, 0).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffb35c, transparent: true, opacity: 0.5, depthWrite: false }));
  ray.scale.z = 1.5;
  c.add(ray);
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerBody());
  c.userData = { ray, prev: {}, grab: null, grip, turnArmed: true, hand: null };
  c.addEventListener('connected', (e) => {
    c.userData.source = e.data;
    c.userData.hand = e.data.handedness;
    if (!c.userData.label) { c.userData.label = controllerLabel(e.data.handedness === 'left' ? 'left' : 'right'); grip.add(c.userData.label); }
  });
  c.addEventListener('disconnected', () => { c.userData.source = null; });
  player.add(c, grip);
  return c;
});
let labelsUntil = 0;

function controllerRay(c) {
  const r = new THREE.Ray();
  r.origin.setFromMatrixPosition(c.matrixWorld);
  r.direction.set(0, 0, -1).transformDirection(c.matrixWorld);
  return r;
}
function headPose() {
  const xc = renderer.xr.getCamera();
  const head = new THREE.Vector3().setFromMatrixPosition(xc.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).transformDirection(xc.matrixWorld);
  return { head, fwd, yaw: Math.atan2(-fwd.x, -fwd.z) };
}
function menuState() { return { paused: S.paused, mode: S.mode, voice: S.voice }; }
function openMenu(welcome) {
  const { head, yaw } = headPose();
  menu.open(welcome, menuState(), head, yaw);
  labelsUntil = Infinity;
}
function closeMenu() { menu.close(); labelsUntil = S.time + 20; }
function menuAction(id) {
  if (id === 'primary') { const wasWelcome = menu.welcome; closeMenu(); setPaused(false); if (wasWelcome) labelsUntil = S.time + 25; }
  else if (id === 'mode') setMode(S.mode === 'guided' ? 'explore' : 'guided');
  else if (id === 'voice') setVoice(!S.voice);
  else if (id === 'recenter') { placeAnchorInFront(); closeMenu(); setPaused(false); }
  else if (id === 'restart') { restart(); closeMenu(); setPaused(false); }
  else if (id === 'exit') { const s = renderer.xr.getSession(); if (s) s.end(); }
  if (menu.isOpen) menu.setState(menuState());
}

function pollXR(dt) {
  if (!renderer.xr.isPresenting) return;
  let hoverIdx = -1;
  for (const c of controllers) {
    const src = c.userData.source;
    if (!src || !src.gamepad) continue;
    const gp = src.gamepad, b = gp.buttons, ax = gp.axes;
    const pressed = (i) => !!(b[i] && b[i].pressed);
    const edge = (i) => pressed(i) && !c.userData.prev[i];
    const sx = ax.length >= 4 ? ax[2] : (ax[0] || 0), sy = ax.length >= 4 ? ax[3] : (ax[1] || 0);
    const left = src.handedness === 'left';
    const ray = controllerRay(c);
    const mh = menu.hit(ray);
    if (mh.onPanel) hoverIdx = mh.index;
    c.userData.ray.scale.z = mh.onPanel ? 0.75 : 1.5;

    if (!menu.isOpen) {
      if (left) {
        // left stick: walk, relative to where you look
        const mag = Math.hypot(sx, sy);
        if (mag > 0.18) {
          const { yaw } = headPose();
          const v = 1.1 * dt * Math.min(1, (mag - 0.18) / 0.82) / mag;
          // forward = (-sin yaw, -cos yaw); right = (cos yaw, -sin yaw); stick up (sy < 0) walks forward
          player.position.x += (-Math.sin(yaw) * -sy + Math.cos(yaw) * sx) * v;
          player.position.z += (-Math.cos(yaw) * -sy - Math.sin(yaw) * sx) * v;
          S.moveVel = Math.min(1, mag);
        }
      } else {
        // right stick: up/down zooms through the scales, left/right snap-turns 30°
        if (Math.abs(sy) > 0.2 && Math.abs(sy) > Math.abs(sx)) {
          const v = -Math.sign(sy) * (Math.abs(sy) - 0.2) / 0.8;
          if (S.mode === 'explore') S.z = Math.min(Z_MAX, Math.max(Z_MIN, S.z + v * 0.7 * dt));
          else scrub(v * 9 * dt);
        }
        if (c.userData.turnArmed && Math.abs(sx) > 0.7) { snapTurn(-Math.sign(sx) * Math.PI / 6); c.userData.turnArmed = false; }
        if (Math.abs(sx) < 0.3) c.userData.turnArmed = true;
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
        c.updateMatrixWorld();
        c.userData.grab = { m0inv: c.matrixWorld.clone().invert(), a0: anchorWorld.clone(), u0: userQuat.clone() };
      }
    }
    if (!pressed(1)) c.userData.grab = null;
    if (c.userData.grab) {
      // the scene follows the hand: same rigid motion applied to the anchor and orientation
      const g = c.userData.grab;
      const delta = new THREE.Matrix4().multiplyMatrices(c.matrixWorld, g.m0inv);
      anchorWorld.copy(g.a0).applyMatrix4(delta);
      const dq = new THREE.Quaternion().setFromRotationMatrix(delta);
      userQuat.copy(dq).multiply(g.u0);
    }
    if (edge(4) && !menu.isOpen) setMode(S.mode === 'guided' ? 'explore' : 'guided'); // A / X
    if (edge(5)) { if (menu.isOpen) { closeMenu(); setPaused(false); } else { openMenu(false); setPaused(true); } } // B / Y
    for (let i = 0; i < b.length; i++) c.userData.prev[i] = pressed(i);
  }
  menu.setHover(hoverIdx);
  // while paused, the right ray labels what it points at (a few times a second)
  if (S.paused && !menu.isOpen && labelPanel.mesh.visible && S.time - (pollXR.lastHover || 0) > 0.2) {
    pollXR.lastHover = S.time;
    const c = controllers.find((k) => k.userData.hand === 'right') || controllers[0];
    const hit = rayPick(controllerRay(c));
    if (hit) showLabel(hit, null);
  }
  const showLabels = S.time < labelsUntil;
  for (const c of controllers) if (c.userData.label) c.userData.label.visible = showLabels;
}

function snapTurn(angle) {
  const { head } = headPose();
  const p = player.position.clone().sub(head).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).add(head);
  player.position.copy(p);
  player.rotation.y += angle;
}

// ------------------------------------------------------------------ VR furniture
let vrPlaced = false, vignette;
// Reading panels in VR follow the head lazily, by yaw only: they stay put until
// you turn more than ~30°, then glide back in front. No roll, no pitch.
const hudRig = new THREE.Group();
const hudFollow = { yaw: null, height: null };
function placeVR() {
  const ls = logstrip.makeMesh(0.34);
  ls.position.set(-0.62, 0.02, -1.05);
  ls.rotation.y = Math.atan2(0.62, 1.05);
  hudRig.add(ls);
  // subtitles just above eye level and the stage title above them, so neither covers the particle below
  subsPanel.mesh.position.set(0, 0.12, -1.15);
  hudRig.add(subsPanel.mesh);
  titleCard.mesh.position.set(0, 0.36, -1.35);
  hudRig.add(titleCard.mesh);
  scene.add(hudRig);
  // head-locked edge vignette for fast zooms and walking
  const vg = new THREE.RingGeometry(0.06, 0.6, 48, 1);
  vignette = new THREE.Mesh(vg, new THREE.ShaderMaterial({
    uniforms: { uO: { value: 0 } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform float uO; varying vec2 vP; void main(){ float r = length(vP); float a = smoothstep(0.075, 0.13, r) * uO; gl_FragColor = vec4(0.0,0.0,0.0,a); }',
    transparent: true, depthTest: false, depthWrite: false,
  }));
  vignette.position.set(0, 0, -0.1);
  vignette.renderOrder = 20;
  camera.add(vignette);
  vrPlaced = true;
}
renderer.xr.addEventListener('sessionstart', () => { hudFollow.yaw = null; if (!vrPlaced) placeVR(); });
renderer.xr.addEventListener('sessionend', () => {
  anchorWorld.copy(ANCHOR_DESKTOP); userQuat.identity();
  player.position.set(0, 0, 0); player.rotation.set(0, 0, 0);
  menu.close();
});

function placeAnchorInFront() {
  const { head, yaw } = headPose();
  anchorWorld.set(head.x - Math.sin(yaw) * 1.0, Math.min(1.5, Math.max(0.85, head.y - 0.27)), head.z - Math.cos(yaw) * 1.0);
  userQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
}

function followHead(dt) {
  if (!renderer.xr.isPresenting) return;
  const { head, yaw } = headPose();
  if (hudFollow.yaw === null) {
    // first VR frame: put the particle 1 m in front of the viewer, about 15° below eye level, and say hello
    hudFollow.yaw = yaw; hudFollow.height = head.y;
    placeAnchorInFront();
    openMenu(true);
  }
  let d = yaw - hudFollow.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  if (Math.abs(d) > 0.52 || hudFollow.moving) {
    hudFollow.moving = Math.abs(d) > 0.05;
    hudFollow.yaw += d * Math.min(1, dt * 2.5);
  }
  hudFollow.height += (head.y - hudFollow.height) * Math.min(1, dt * 1.5);
  hudRig.position.set(head.x, hudFollow.height, head.z);
  hudRig.rotation.set(0, hudFollow.yaw, 0);
  titleCard.update(dt);
}

// ------------------------------------------------------------------ frame
const clock = new THREE.Clock();
function step(dt) {
  S.time += dt;
  S.moveVel *= 0.85;
  if (!renderer.xr.isPresenting && S.started) desktopKeys(dt);
  pollXR(dt);
  followHead(dt);

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
  const ctx = { dt, time: S.time, selected: S.selected, T: S.T, z };
  let dom = null, dw = 0;
  for (const L of levels) {
    const w = L.computeWeight(z);
    L.weight = w;
    L.root.position.copy(anchorWorld);
    if (w > 0.002) L.update(S.mode === 'guided' ? S.T - STORY_START[L.id] : S.clocks[L.id], ctx);
    L.apply(z, anchorWorld, userQuat, w, dt);
    if (w > dw) { dw = w; dom = L; }
  }
  S.dominant = dom ? dom.id : 'room';
  if (S.started && S.dominant !== S.lastStage) {
    S.lastStage = S.dominant;
    announceStage(S.dominant);
  }

  if (!renderer.xr.isPresenting) updateDesktopCamera(dt);
  const view = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  view.updateMatrixWorld();
  const camPos = new THREE.Vector3().setFromMatrixPosition(view.matrixWorld);

  // billboards (callouts, labels) — yaw-only so the horizon stays level
  for (const L of levels) for (const o of L.ui.children) if (o.userData.billboard) yawFace(o, camPos);
  if (labelPanel.mesh.visible) yawFace(labelPanel.mesh, camPos);

  // scale bar under the anchor, facing the viewer
  scaleBar.update(z);
  const toCam = camPos.clone().sub(anchorWorld); toCam.y = 0; toCam.normalize();
  scaleBar.group.position.copy(anchorWorld).add(new THREE.Vector3(0, -0.27, 0)).addScaledVector(toCam, 0.15);
  yawFace(scaleBar.group, camPos);

  logstrip.draw(z, S.dominant);
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
  $('vignette').style.opacity = renderer.xr.isPresenting ? '0' : (smooth((S.zVel - 0.35) / 0.8) * 0.85).toFixed(2);
  if (vignette) vignette.material.uniforms.uO.value = vo;
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

function yawFace(o, camPos) {
  const p = o.getWorldPosition(new THREE.Vector3());
  o.rotation.set(0, Math.atan2(camPos.x - p.x, camPos.z - p.z), 0);
  if (o.parent && o.parent !== scene) {
    // undo parent rotation so the panel still faces the viewer
    const pq = o.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    o.quaternion.premultiply(pq);
  }
}

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  debug.frameTimes.push(now - last);
  if (debug.frameTimes.length > 2000) debug.frameTimes.shift();
  last = now;
  const dt = Math.min(clock.getDelta(), 0.1) * (debug.speed || 1);
  if (debug.ready) step(dt);
  renderer.info.reset();
  if (post && !renderer.xr.isPresenting) post.render();
  else renderer.render(scene, camera);
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
  menuButtonWorld: (id) => {
    const b = menu.buttons.find((x) => x.id === id);
    if (!b) return null;
    const g = menu.mesh.geometry.parameters;
    const p = new THREE.Vector3(((b.x + b.w / 2) / menu.canvas.width - 0.5) * g.width, (0.5 - (b.y + b.h / 2) / menu.canvas.height) * g.height, 0);
    return p.applyMatrix4(menu.mesh.matrixWorld).toArray();
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
