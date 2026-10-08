// In-headset UI: the welcome/menu panel (pointed at and clicked with the
// trigger), labels on the controllers, stage title cards, the log-scale strip
// and an optional stats readout. Canvas textures are drawn only when their
// content changes; hover highlights and moving markers are separate meshes, so
// pointing around never re-uploads a texture.
import * as THREE from 'three';

const INK = '#e8edf2', DIM = '#9aa6b2', ACC = '#ffb35c';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

export function canvasMesh(w, h, heightM, renderOrder = 30) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(heightM * w / h, heightM),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  mesh.renderOrder = renderOrder;
  return { canvas, ctx: canvas.getContext('2d'), mesh, tex };
}

const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _r = new THREE.Ray(), _p = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------ menu / welcome panel
export class VRMenu {
  constructor() {
    const { canvas, ctx, mesh, tex } = canvasMesh(1100, 900, 0.54);
    Object.assign(this, { canvas, ctx, mesh, tex });
    this.mesh.visible = false;
    this.mesh.name = 'vr-menu';
    this.welcome = true;
    this.hover = -1;
    this.state = { paused: false, mode: 'guided', voice: true };
    this.buttons = [];
    // hover highlight: a quad over the button, so hovering never redraws the canvas
    this.hi = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffb35c, transparent: true, opacity: 0.28, depthTest: false, depthWrite: false, toneMapped: false }));
    this.hi.renderOrder = 31;
    this.hi.visible = false;
    this.mesh.add(this.hi);
  }

  layout() {
    const s = this.state;
    const primary = this.welcome ? 'Start' : s.paused ? 'Resume' : 'Close menu';
    this.buttons = [
      { id: 'primary', label: primary, x: 60, y: 610, w: 980, h: 96, primary: true },
      { id: 'mode', label: s.mode === 'guided' ? 'Mode: Guided' : 'Mode: Explore', x: 60, y: 722, w: 315, h: 80 },
      { id: 'voice', label: s.voice ? 'Narration: on' : 'Narration: off', x: 392, y: 722, w: 315, h: 80 },
      { id: 'recenter', label: 'Recenter', x: 724, y: 722, w: 316, h: 80 },
      { id: 'restart', label: 'Restart', x: 60, y: 814, w: 480, h: 64 },
      { id: 'exit', label: 'Exit VR', x: 560, y: 814, w: 480, h: 64 },
    ];
  }

  draw() {
    this.layout();
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height, s = this.state;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(6,9,13,0.95)'; roundRect(c, 4, 4, W - 8, H - 8, 28); c.fill();
    c.strokeStyle = 'rgba(232,237,242,0.18)'; c.lineWidth = 3; c.stroke();
    c.textBaseline = 'alphabetic'; c.textAlign = 'left';
    c.fillStyle = INK; c.font = `300 58px ${FONT}`;
    c.fillText(this.welcome ? 'Nine Orders' : 'Menu', 60, 100);
    c.fillStyle = DIM; c.font = `400 28px ${FONT}`;
    c.fillText(this.welcome ? 'One photon, from the linac to a break in DNA. Every track is simulated.'
      : s.mode === 'guided' ? 'Guided: the story plays by itself. Explore: you choose the scale.' : 'Explore: you choose the scale. Guided: the story plays by itself.', 60, 148);
    const rows = [
      ['Left stick', 'walk'],
      ['Right stick', s.mode === 'guided' ? 'up/down: fast-forward or rewind · left/right: turn' : 'up/down: zoom in or out · left/right: turn'],
      ['Trigger', 'select the glowing photon · pause and label anything'],
      ['Grip', 'hold to grab the scene: move it, turn it'],
      ['B or Y', 'this menu'],
    ];
    rows.forEach(([k, v], i) => {
      const y = 228 + i * 70;
      c.fillStyle = ACC; c.font = `600 30px ${FONT}`; c.fillText(k, 60, y);
      c.fillStyle = INK; c.font = `400 29px ${FONT}`; c.fillText(v, 270, y);
    });
    this.buttons.forEach((b) => {
      c.fillStyle = b.primary ? 'rgba(255,179,92,0.25)' : 'rgba(232,237,242,0.07)';
      roundRect(c, b.x, b.y, b.w, b.h, 16); c.fill();
      c.strokeStyle = b.primary ? ACC : 'rgba(232,237,242,0.25)'; c.lineWidth = 2; c.stroke();
      c.fillStyle = INK; c.textAlign = 'center';
      c.font = b.primary ? `600 40px ${FONT}` : `500 30px ${FONT}`;
      c.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + (b.primary ? 14 : 10));
      c.textAlign = 'left';
    });
    this.tex.needsUpdate = true;
    this.setHover(this.hover, true);
  }

  // Open in front of the head (both in the parent's frame), facing the eyes.
  open(welcome, state, head, yaw) {
    this.welcome = welcome;
    this.state = { ...state };
    const d = 0.8;
    this.mesh.position.set(head.x - Math.sin(yaw) * d, head.y - 0.1, head.z - Math.cos(yaw) * d);
    _m.lookAt(head, this.mesh.position, UP); // +z towards the eyes
    this.mesh.quaternion.setFromRotationMatrix(_m);
    this.mesh.visible = true;
    this.hover = -1;
    this.draw();
  }

  close() { this.mesh.visible = false; this.hover = -1; this.hi.visible = false; }
  get isOpen() { return this.mesh.visible; }

  setState(state) {
    const k = JSON.stringify(state);
    if (k !== JSON.stringify(this.state)) { this.state = { ...state }; this.draw(); }
  }

  // Ray in world space → {onPanel, index of the button under it or -1, distance, point (world)}
  hit(ray) {
    const miss = { onPanel: false, index: -1, distance: Infinity, point: null };
    if (!this.mesh.visible) return miss;
    _inv.copy(this.mesh.matrixWorld).invert();
    _r.copy(ray).applyMatrix4(_inv);
    if (Math.abs(_r.direction.z) < 1e-6) return miss;
    const t = -_r.origin.z / _r.direction.z;
    if (t < 0) return miss;
    _p.copy(_r.origin).addScaledVector(_r.direction, t);
    const g = this.mesh.geometry.parameters;
    const u = _p.x / g.width + 0.5, v = 0.5 - _p.y / g.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return miss;
    const x = u * this.canvas.width, y = v * this.canvas.height;
    const index = this.buttons.findIndex((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    const point = _p.clone().applyMatrix4(this.mesh.matrixWorld);
    return { onPanel: true, index, distance: point.distanceTo(ray.origin), point };
  }

  setHover(i, force = false) {
    if (i === this.hover && !force) return;
    this.hover = i;
    const b = this.buttons[i];
    this.hi.visible = !!b;
    if (!b) return;
    const g = this.mesh.geometry.parameters, W = this.canvas.width, H = this.canvas.height;
    this.hi.scale.set(b.w / W * g.width, b.h / H * g.height, 1);
    this.hi.position.set(((b.x + b.w / 2) / W - 0.5) * g.width, (0.5 - (b.y + b.h / 2) / H) * g.height, 0.001);
  }

  // Centre of a button in world space (tests)
  buttonWorld(id) {
    const b = this.buttons.find((x) => x.id === id);
    if (!b) return null;
    const g = this.mesh.geometry.parameters;
    return new THREE.Vector3(((b.x + b.w / 2) / this.canvas.width - 0.5) * g.width, (0.5 - (b.y + b.h / 2) / this.canvas.height) * g.height, 0).applyMatrix4(this.mesh.matrixWorld);
  }
}

// ------------------------------------------------------------------ controller labels
export class ControllerLabel {
  constructor(hand) {
    Object.assign(this, canvasMesh(560, 300, 0.085));
    this.hand = hand;
    this.mesh.position.set(0, 0.075, 0.03);
    this.mesh.rotation.x = -0.75;
    this.mode = null;
  }
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    const lines = this.hand === 'left'
      ? [['Stick', 'walk'], ['Trigger', 'select / label'], ['Grip', 'grab scene'], ['Y', 'menu']]
      : [['Stick', mode === 'guided' ? '↕ forward/back  ↔ turn' : '↕ zoom  ↔ turn'], ['Trigger', 'select / label'], ['Grip', 'grab scene'], ['B', 'menu']];
    const c = this.ctx;
    c.clearRect(0, 0, 560, 300);
    c.fillStyle = 'rgba(6,9,13,0.85)'; roundRect(c, 4, 4, 552, 292, 22); c.fill();
    lines.forEach(([k, v], i) => {
      c.fillStyle = ACC; c.font = `600 40px ${FONT}`; c.fillText(k, 26, 70 + i * 64);
      c.fillStyle = INK; c.font = `400 ${v.length > 16 ? 34 : 38}px ${FONT}`; c.fillText(v, 190, 70 + i * 64);
    });
    this.tex.needsUpdate = true;
  }
}

// Stand-in shown until the real controller model has loaded (or if there is none).
export function controllerBody() {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.5, metalness: 0.2 });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.019, 0.1, 16), m);
  handle.rotation.x = -0.7; handle.position.set(0, -0.02, 0.03);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.006, 8, 32), new THREE.MeshStandardMaterial({ color: 0x8a939e, roughness: 0.4 }));
  ring.rotation.x = 0.3; ring.position.set(0, 0.015, -0.01);
  g.add(handle, ring);
  return g;
}

// Pointer ray: bright at the hand, fading out; a dot where it meets the menu.
export function pointerRay() {
  const geo = new THREE.PlaneGeometry(1, 1).translate(0, -0.5, 0).rotateX(Math.PI / 2); // along -z, length 1
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xffc27a) }, uO: { value: 0.65 } },
    vertexShader: 'varying float vT; varying float vX; void main(){ vT = -position.z; vX = position.x * 2.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 uColor; uniform float uO; varying float vT; varying float vX; void main(){ float a = uO * (1.0 - vT) * (1.0 - vX * vX); gl_FragColor = vec4(uColor, a); }',
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(geo, mat);
  beam.scale.set(0.003, 1, 1.2);
  beam.renderOrder = 29;
  const beam2 = beam.clone(); beam2.rotation.z = Math.PI / 2; // cross-shaped so it is visible from any side
  const g = new THREE.Group();
  g.add(beam, beam2);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.006, 20), new THREE.MeshBasicMaterial({ color: 0xffe2bd, depthTest: false, depthWrite: false, toneMapped: false, transparent: true }));
  dot.renderOrder = 32;
  dot.visible = false;
  return { group: g, beams: [beam, beam2], dot, setLength(L) { for (const b of this.beams) b.scale.z = L; } };
}

// ------------------------------------------------------------------ stage title card
export class TitleCard {
  constructor() {
    Object.assign(this, canvasMesh(1000, 260, 0.2));
    this.mesh.material.opacity = 0;
    this.mesh.visible = false;
    this.t = 99;
  }
  show(num, name, scale) {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(5,7,10,0.6)'; roundRect(c, 120, 8, W - 240, H - 16, 24); c.fill();
    c.textAlign = 'center';
    c.fillStyle = ACC; c.font = `600 34px ${FONT}`; c.fillText(num, W / 2, 60);
    c.fillStyle = INK; c.font = `300 92px ${FONT}`; c.fillText(name, W / 2, 158);
    c.fillStyle = DIM; c.font = `400 36px ${FONT}`; c.fillText(scale, W / 2, 218);
    this.tex.needsUpdate = true;
    this.t = 0;
  }
  update(dt) {
    this.t += dt;
    const a = this.t < 0.5 ? this.t / 0.5 : this.t < 3.5 ? 1 : Math.max(0, 1 - (this.t - 3.5) / 0.8);
    this.mesh.material.opacity = a;
    this.mesh.visible = a > 0.01;
  }
}

// ------------------------------------------------------------------ log-scale strip (VR)
// A static texture of the nine decades with the stage names, and a marker that moves.
export class LogStripVR {
  constructor(levels, heightM = 0.4) {
    const W = 300, H = 760;
    Object.assign(this, canvasMesh(W, H, heightM, 28));
    const c = this.ctx;
    this.top = 70; this.bot = H - 40; this.x = 92;
    const y = (e) => this.top + (this.bot - this.top) * (e / 9);
    c.fillStyle = 'rgba(5,7,10,0.62)'; roundRect(c, 4, 4, W - 8, H - 8, 22); c.fill();
    c.fillStyle = DIM; c.font = `500 30px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('scale', W / 2, 36);
    // stage bands
    for (const L of levels) {
      const a = Math.max(0, L.range[1]), b = Math.min(9, L.range[2]);
      if (b <= a) continue;
      c.fillStyle = 'rgba(232,237,242,0.06)';
      c.fillRect(this.x + 22, y(a) + 2, W - this.x - 34, y(b) - y(a) - 4);
      c.fillStyle = 'rgba(232,237,242,0.55)'; c.font = `500 22px ${FONT}`; c.textAlign = 'left';
      c.fillText(L.name.replace('Treatment room', 'Room'), this.x + 32, (y(a) + y(b)) / 2);
    }
    c.strokeStyle = 'rgba(232,237,242,0.4)'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(this.x, this.top); c.lineTo(this.x, this.bot); c.stroke();
    const names = ['1 m', '10 cm', '1 cm', '1 mm', '100 µm', '10 µm', '1 µm', '100 nm', '10 nm', '1 nm'];
    for (let e = 0; e <= 9; e++) {
      c.strokeStyle = 'rgba(232,237,242,0.55)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(this.x - 9, y(e)); c.lineTo(this.x + 9, y(e)); c.stroke();
      c.textAlign = 'right'; c.fillStyle = 'rgba(232,237,242,0.8)'; c.font = `400 22px ${FONT}`;
      c.fillText(names[e], this.x - 16, y(e));
    }
    this.tex.needsUpdate = true;
    this.marker = new THREE.Mesh(new THREE.CircleGeometry(1, 24), new THREE.MeshBasicMaterial({ color: 0xffb35c, depthTest: false, depthWrite: false, toneMapped: false, transparent: true }));
    this.marker.renderOrder = 29;
    this.marker.scale.setScalar(heightM * 13 / H);
    this.mesh.add(this.marker);
    this.H = H; this.W = W; this.h = heightM;
  }
  update(z) {
    const e = Math.max(0, Math.min(9, z));
    const py = this.top + (this.bot - this.top) * (e / 9);
    this.marker.position.set((this.x / this.W - 0.5) * this.h * this.W / this.H, (0.5 - py / this.H) * this.h, 0.001);
  }
}

// ------------------------------------------------------------------ stats readout (?stats)
export class StatsPanel {
  constructor() {
    Object.assign(this, canvasMesh(420, 150, 0.06, 33));
    this.last = 0;
  }
  draw(lines) {
    const c = this.ctx;
    c.clearRect(0, 0, 420, 150);
    c.fillStyle = 'rgba(0,0,0,0.75)'; roundRect(c, 2, 2, 416, 146, 12); c.fill();
    c.fillStyle = '#b8f5c8'; c.font = `500 30px ui-monospace, monospace`; c.textBaseline = 'middle';
    lines.forEach((l, i) => c.fillText(l, 16, 30 + i * 44));
    this.tex.needsUpdate = true;
  }
}
