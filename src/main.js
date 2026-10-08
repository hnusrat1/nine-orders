import * as THREE from 'three';
import { loadData } from './data.js';
import { loadAssets } from './assets.js';
import { LEVELS, KEYS, T_END, STORY_START, STORY_LEN, Z_MIN, Z_MAX, zAt, smooth } from './journey.js';
import { RoomLevel } from './levels/room.js';
import { PatientLevel } from './levels/patient.js';
import { TissueLevel } from './levels/tissue.js';
import { CellLevel } from './levels/cell.js';
import { ChromatinLevel } from './levels/chromatin.js';
import { DnaLevel } from './levels/dna.js';
import { LogStrip, ScaleBar, Callout, SubtitlePanel } from './hud.js';
import { Narrator, script } from './narration.js';
import { aboutHTML } from './about.js';

const $ = (id) => document.getElementById(id);
const CLASSES = { room: RoomLevel, patient: PatientLevel, tissue: TissueLevel, cell: CellLevel, chromatin: ChromatinLevel, dna: DnaLevel };
const HOLD_T = 21, HOLD_MAX = 12; // Guided waits here for the photon to be chosen

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(0.2);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.02, 400);
scene.add(new THREE.HemisphereLight(0xb9c8d8, 0x1a1410, 0.9));
const key = new THREE.DirectionalLight(0xfff1e0, 1.6);
key.position.set(1.5, 3, 2);
scene.add(key);
const rim = new THREE.DirectionalLight(0x8fb4ff, 0.6);
rim.position.set(-2, 1, -2);
scene.add(rim);

// Anchor: where the particle sits in display space. Desktop orbits a camera
// around it; in VR it floats in front of the viewer at table height.
const ANCHOR_DESKTOP = new THREE.Vector3(0, 1.2, 0);
const ANCHOR_VR = new THREE.Vector3(0, 1.1, -0.85);
const anchorWorld = ANCHOR_DESKTOP.clone();
const userQuat = new THREE.Quaternion();
const orbit = { r: 1.55, theta: 0.32, phi: 1.12 };

// ------------------------------------------------------------------ state
const S = {
  mode: 'guided', paused: false, started: false,
  T: 0, z: 0, zVel: 0, lastZ: 0,
  selected: false, holdTime: 0,
  clocks: Object.fromEntries(LEVELS.map((l) => [l.id, 0])),
  time: 0, voice: true, dominant: 'room', ended: false,
};
const debug = { frameTimes: [], errors: [], ready: false };
window.__nine = debug;

let levels = [], data, narrator, logstrip, scaleBar, subsPanel, labelPanel, closingPanel;
const hint = $('hint');

// ------------------------------------------------------------------ boot
async function boot() {
  $('status').textContent = 'Loading data…';
  data = await loadData();
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
  $('status').textContent = data.index.synthetic ? 'Skeleton build: placeholder geometry and synthetic tracks. Numbers on screen are not yet from simulation.' : '';
  debug.levels = levels;
  debug.ready = true;
  // warm up shaders so the first transition does not hitch
  for (const L of levels) L.root.visible = true;
  renderer.compile(scene, camera);
  applyFrame(0);
}

// ------------------------------------------------------------------ menu
function setMode(m) {
  S.mode = m;
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  if (m === 'explore') for (const l of LEVELS) S.clocks[l.id] = Math.max(0, S.T - STORY_START[l.id]);
  if (m === 'guided') S.T = timeForZ(S.z);
}
function setVoice(on) {
  S.voice = on;
  document.querySelectorAll('[data-voice]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.voice === 'on') === on)));
  if (narrator) narrator.setMuted(!on);
}
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('[data-voice]').forEach((b) => b.addEventListener('click', () => setVoice(b.dataset.voice === 'on')));
$('btn-about').addEventListener('click', () => { $('about').hidden = false; });
$('about-close').addEventListener('click', () => { $('about').hidden = true; });
$('menu-btn').addEventListener('click', () => { $('menu').hidden = false; S.paused = true; });

function start() {
  $('menu').hidden = true;
  $('hud').hidden = false;
  if (!S.started || S.ended) restart();
  S.paused = false;
  S.started = true;
  // A user gesture is needed before speech works on most browsers.
  if (narrator && S.voice && window.speechSynthesis) window.speechSynthesis.resume();
}
function restart() {
  S.T = 0; S.z = 0; S.selected = false; S.holdTime = 0; S.ended = false;
  for (const l of LEVELS) S.clocks[l.id] = 0;
  if (narrator) narrator.reset();
}
$('btn-start').addEventListener('click', start);

if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) return;
    $('btn-vr').hidden = false;
  }).catch(() => {});
}
$('btn-vr').addEventListener('click', async () => {
  try {
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    await renderer.xr.setSession(session);
    start();
    session.addEventListener('end', () => { $('menu').hidden = false; S.paused = true; });
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

// ------------------------------------------------------------------ input: shared actions
function zoomBy(dz) { // explore: change z; guided: scrub along the timeline
  if (S.mode === 'explore') S.z = Math.min(Z_MAX, Math.max(Z_MIN, S.z + dz));
  else scrub(dz * 9);
}
function scrub(dT) {
  S.T = Math.min(T_END, Math.max(0, S.T + dT));
  if (S.T > HOLD_T && !S.selected) S.selected = true;
}
function rayPick(ray) {
  let best = null;
  for (const L of levels) {
    const p = L.pick(ray);
    if (p && (!best || p.distance < best.distance)) best = p;
  }
  return best;
}
function activate(ray, screen) { // click / tap / trigger
  const hit = rayPick(ray);
  const room = levels[0];
  if (!S.selected && room.weight > 0.5 && room.pick(ray, 'photon')) {
    S.selected = true; S.paused = false; hideLabel();
    return;
  }
  if (S.paused) { S.paused = false; hideLabel(); return; }
  S.paused = true;
  if (hit) showLabel(hit, screen); else showLabel({ label: 'Paused. Point at something to label it; select again to continue.', point: null }, screen);
}
function showLabel(hit, screen) {
  if (renderer.xr.isPresenting) {
    labelPanel.set('', []);
    const words = hit.label;
    labelPanel.set(words.length > 60 ? words.slice(0, words.lastIndexOf(' ', 58)) : words, splitRows(words.length > 60 ? words.slice(words.lastIndexOf(' ', 58) + 1) : ''));
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
    el.style.left = Math.min(window.innerWidth - 320, x + 14) + 'px';
    el.style.top = Math.max(10, y - 20) + 'px';
  }
}
function splitRows(s) {
  const out = []; let cur = '';
  for (const w of s.split(' ')) { if ((cur + ' ' + w).length > 60) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; }
  if (cur) out.push(cur);
  return out.slice(0, 3);
}
function hideLabel() { $('label').hidden = true; labelPanel.opacity = 0; }

// ------------------------------------------------------------------ input: desktop + touch
const el = renderer.domElement;
const pointers = new Map();
let drag = null, pinch = null;
el.addEventListener('pointerdown', (e) => {
  el.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    drag = null;
  } else drag = { moved: false };
});
el.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    zoomBy(Math.log10(d / pinch.d) * 1.6);
    pinch.d = d;
    return;
  }
  if (drag) {
    if (Math.hypot(p.x - p.x0, p.y - p.y0) > 5) drag.moved = true;
    if (drag.moved) {
      orbit.theta -= dx * 0.005;
      orbit.phi = Math.min(2.6, Math.max(0.35, orbit.phi - dy * 0.005));
    }
  }
});
function endPointer(e) {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (p && drag && !drag.moved && performance.now() - p.t0 < 600 && S.started) {
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
  if (k === ' ') { S.paused = !S.paused; if (!S.paused) hideLabel(); e.preventDefault(); }
  if (k === 'g') setMode('guided');
  if (k === 'e') setMode('explore');
  if (k === 'm') setVoice(!S.voice);
  if (k === 'escape') { $('about').hidden = true; $('menu').hidden = !$('menu').hidden; S.paused = !$('menu').hidden; }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------ input: XR controllers
const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const ray = new THREE.Mesh(new THREE.CylinderGeometry(0.0015, 0.0015, 1, 6, 1, true).translate(0, -0.5, 0).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffb35c, transparent: true, opacity: 0.45, depthWrite: false }));
  ray.scale.z = 1.5;
  c.add(ray);
  c.userData = { ray, prev: {}, grab: null };
  c.addEventListener('connected', (e) => { c.userData.source = e.data; });
  c.addEventListener('disconnected', () => { c.userData.source = null; });
  scene.add(c);
  return c;
});

function controllerRay(c) {
  const r = new THREE.Ray();
  r.origin.setFromMatrixPosition(c.matrixWorld);
  r.direction.set(0, 0, -1).transformDirection(c.matrixWorld);
  return r;
}

function pollXR(dt) {
  if (!renderer.xr.isPresenting) return;
  for (const c of controllers) {
    const src = c.userData.source;
    if (!src || !src.gamepad) continue;
    const gp = src.gamepad, b = gp.buttons, ax = gp.axes;
    const pressed = (i) => !!(b[i] && b[i].pressed);
    const edge = (i) => pressed(i) && !c.userData.prev[i];
    // stick: forward (negative y) zooms in. Left stick is the main control; either works.
    const y = ax.length >= 4 ? ax[3] : (ax[1] || 0);
    if (Math.abs(y) > 0.15) {
      const v = -Math.sign(y) * (Math.abs(y) - 0.15) / 0.85;
      if (S.mode === 'explore') S.z = Math.min(Z_MAX, Math.max(Z_MIN, S.z + v * 0.7 * dt));
      else scrub(v * 9 * dt);
    }
    if (edge(0)) activate(controllerRay(c), null);                    // trigger
    if (edge(1)) c.userData.grab = { q0: c.quaternion.clone(), u0: userQuat.clone() }; // grip
    if (!pressed(1)) c.userData.grab = null;
    if (c.userData.grab) {
      const g = c.userData.grab;
      const dq = c.quaternion.clone().multiply(g.q0.clone().invert());
      userQuat.copy(dq).multiply(g.u0);
    }
    if (edge(4)) setMode(S.mode === 'guided' ? 'explore' : 'guided'); // A / X
    if (edge(5)) setVoice(!S.voice);                                   // B / Y
    for (let i = 0; i < b.length; i++) c.userData.prev[i] = pressed(i);
    // while paused, the ray labels whatever it points at
    if (S.paused && edge(0) === false && pressed(0) === false && labelPanel.mesh.visible) {
      const hit = rayPick(controllerRay(c));
      if (hit) showLabel(hit, null);
    }
  }
}

// ------------------------------------------------------------------ VR furniture
let vrPlaced = false, vignette;
function placeVR() {
  anchorWorld.copy(ANCHOR_VR);
  const ls = logstrip.makeMesh(0.46);
  ls.position.copy(ANCHOR_VR).add(new THREE.Vector3(-0.78, 0.05, 0.25));
  ls.lookAt(0, 1.5, 0.3);
  scene.add(ls);
  subsPanel.mesh.position.copy(ANCHOR_VR).add(new THREE.Vector3(0, -0.4, 0.3));
  subsPanel.mesh.lookAt(0, 1.55, 0.2);
  scene.add(subsPanel.mesh);
  // head-locked edge vignette for fast zooms
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
  scene.add(camera);
  vrPlaced = true;
}
renderer.xr.addEventListener('sessionstart', () => { if (!vrPlaced) placeVR(); else anchorWorld.copy(ANCHOR_VR); });
renderer.xr.addEventListener('sessionend', () => { anchorWorld.copy(ANCHOR_DESKTOP); });

// ------------------------------------------------------------------ frame
const clock = new THREE.Clock();
function step(dt) {
  S.time += dt;
  // keyboard zoom
  const kz = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  if (kz) { if (S.mode === 'explore') S.z = Math.min(Z_MAX, Math.max(Z_MIN, S.z + kz * 0.6 * dt)); else scrub(kz * 8 * dt); }
  pollXR(dt);

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
  const ctx = { dt, time: S.time, selected: S.selected, T: S.T };
  let dom = null, dw = 0;
  for (const L of levels) {
    const w = L.computeWeight(z);
    L.weight = w;
    L.root.position.copy(anchorWorld);
    if (w > 0.002) L.update(S.mode === 'guided' ? S.T - STORY_START[L.id] : S.clocks[L.id], ctx);
    L.apply(z, anchorWorld, userQuat, w);
    if (w > dw) { dw = w; dom = L; }
  }
  S.dominant = dom ? dom.id : 'room';

  // camera (desktop/phone)
  if (!renderer.xr.isPresenting) {
    camera.position.set(
      anchorWorld.x + orbit.r * Math.sin(orbit.phi) * Math.sin(orbit.theta),
      anchorWorld.y + orbit.r * Math.cos(orbit.phi),
      anchorWorld.z + orbit.r * Math.sin(orbit.phi) * Math.cos(orbit.theta));
    camera.lookAt(anchorWorld);
  }
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

  // narration
  if (narrator && S.started) {
    if (S.mode === 'guided') narrator.atTime(S.T);
    else narrator.forLevel(S.dominant);
  }
  hint.textContent = (!S.selected && S.started && levels[0].weight > 0.5 && (S.mode === 'explore' ? S.clocks.room : S.T) > 11)
    ? (renderer.xr.isPresenting ? 'Point at the glowing photon and pull the trigger' : 'Click or tap the glowing photon')
    : S.paused && S.started ? 'Paused' : '';

  // comfort vignette during fast zooms
  const zv = dt > 0 ? Math.abs(z - S.lastZ) / dt : 0;
  S.zVel = S.zVel * 0.85 + zv * 0.15;
  S.lastZ = z;
  const vo = smooth((S.zVel - 0.35) / 0.8) * 0.85;
  $('vignette').style.opacity = vo.toFixed(2);
  if (vignette) vignette.material.uniforms.uO.value = vo;
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
  renderer.render(scene, camera);
  debug.drawCalls = renderer.info.render.calls;
  debug.triangles = renderer.info.render.triangles;
});

// ------------------------------------------------------------------ test hooks
Object.assign(debug, {
  state: () => ({ T: S.T, z: S.z, mode: S.mode, paused: S.paused, selected: S.selected, dominant: S.dominant, started: S.started, ended: S.ended, presenting: renderer.xr.isPresenting, drawCalls: debug.drawCalls, triangles: debug.triangles }),
  start, setMode, setVoice,
  setT: (t) => { S.T = t; if (t > HOLD_T) S.selected = true; },
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
