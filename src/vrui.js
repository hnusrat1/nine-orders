// In-headset UI: the welcome/menu panel (pointed at and clicked with the
// trigger), labels on the controllers, and stage title cards.
import * as THREE from 'three';

const INK = '#e8edf2', DIM = '#9aa6b2', ACC = '#ffb35c';

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

function canvasMesh(w, h, heightM) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(heightM * w / h, heightM),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  mesh.renderOrder = 30;
  return { canvas, ctx: canvas.getContext('2d'), mesh, tex };
}

// ------------------------------------------------------------------ menu / welcome panel
export class VRMenu {
  constructor() {
    const { canvas, ctx, mesh, tex } = canvasMesh(1100, 900, 0.62);
    Object.assign(this, { canvas, ctx, mesh, tex });
    this.mesh.visible = false;
    this.welcome = true;
    this.hover = -1;
    this.state = { paused: false, mode: 'guided', voice: true };
    this.buttons = [];
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
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(6,9,13,0.93)'; roundRect(c, 4, 4, W - 8, H - 8, 28); c.fill();
    c.strokeStyle = 'rgba(232,237,242,0.18)'; c.lineWidth = 3; c.stroke();
    c.textBaseline = 'alphabetic'; c.textAlign = 'left';
    c.fillStyle = INK; c.font = '300 58px system-ui, sans-serif';
    c.fillText(this.welcome ? 'Nine Orders' : 'Menu', 60, 100);
    c.fillStyle = DIM; c.font = '400 28px system-ui, sans-serif';
    if (this.welcome) c.fillText('One photon, from the linac to a break in DNA. Every track is simulated.', 60, 148);
    const rows = [
      ['Left stick', 'move around'],
      ['Right stick', 'up/down: zoom through the scales · left/right: turn'],
      ['Trigger', 'point and pull: pause and label anything; the glowing photon'],
      ['Grip', 'grab the scene and move or turn it'],
      ['B or Y', 'this menu'],
    ];
    c.font = '600 30px system-ui, sans-serif';
    rows.forEach(([k, v], i) => {
      const y = 228 + i * 70;
      c.fillStyle = ACC; c.fillText(k, 60, y);
      c.fillStyle = INK; c.font = '400 29px system-ui, sans-serif'; c.fillText(v, 270, y);
      c.font = '600 30px system-ui, sans-serif';
    });
    this.buttons.forEach((b, i) => {
      c.fillStyle = b.primary ? (this.hover === i ? 'rgba(255,179,92,0.45)' : 'rgba(255,179,92,0.25)') : (this.hover === i ? 'rgba(232,237,242,0.18)' : 'rgba(232,237,242,0.07)');
      roundRect(c, b.x, b.y, b.w, b.h, 16); c.fill();
      c.strokeStyle = b.primary ? ACC : 'rgba(232,237,242,0.25)'; c.lineWidth = 2; c.stroke();
      c.fillStyle = INK; c.textAlign = 'center';
      c.font = b.primary ? '600 40px system-ui, sans-serif' : '500 30px system-ui, sans-serif';
      c.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + (b.primary ? 14 : 10));
      c.textAlign = 'left';
    });
    this.tex.needsUpdate = true;
  }

  open(welcome, state, head, yaw) {
    this.welcome = welcome;
    this.state = { ...state };
    this.mesh.position.set(head.x - Math.sin(yaw) * 0.75, head.y - 0.12, head.z - Math.cos(yaw) * 0.75);
    this.mesh.rotation.set(-0.12, yaw, 0, 'YXZ');
    this.mesh.visible = true;
    this.hover = -1;
    this.draw();
  }

  close() { this.mesh.visible = false; }
  get isOpen() { return this.mesh.visible; }

  setState(state) {
    const k = JSON.stringify(state);
    if (k !== JSON.stringify(this.state)) { this.state = { ...state }; this.draw(); }
  }

  // Ray in world space → index of the button under it, or -1 (and whether the panel was hit at all)
  hit(ray) {
    if (!this.mesh.visible) return { onPanel: false, index: -1 };
    const inv = new THREE.Matrix4().copy(this.mesh.matrixWorld).invert();
    const r = ray.clone().applyMatrix4(inv);
    if (Math.abs(r.direction.z) < 1e-6) return { onPanel: false, index: -1 };
    const t = -r.origin.z / r.direction.z;
    if (t < 0) return { onPanel: false, index: -1 };
    const p = r.origin.clone().addScaledVector(r.direction, t);
    const g = this.mesh.geometry.parameters;
    const u = p.x / g.width + 0.5, v = 0.5 - p.y / g.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return { onPanel: false, index: -1 };
    const x = u * this.canvas.width, y = v * this.canvas.height;
    const index = this.buttons.findIndex((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    return { onPanel: true, index };
  }

  setHover(i) { if (i !== this.hover) { this.hover = i; this.draw(); } }
}

// ------------------------------------------------------------------ controller labels
export function controllerLabel(hand) {
  const { ctx, mesh, tex } = canvasMesh(560, 300, 0.085);
  const lines = hand === 'left'
    ? [['Stick', 'move'], ['Trigger', 'select / label'], ['Grip', 'grab scene'], ['Y', 'menu']]
    : [['Stick', '↕ zoom  ↔ turn'], ['Trigger', 'select / label'], ['Grip', 'grab scene'], ['B', 'menu']];
  ctx.fillStyle = 'rgba(6,9,13,0.85)'; roundRect(ctx, 4, 4, 552, 292, 22); ctx.fill();
  ctx.font = '600 40px system-ui, sans-serif';
  lines.forEach(([k, v], i) => {
    ctx.fillStyle = ACC; ctx.fillText(k, 26, 70 + i * 64);
    ctx.fillStyle = INK; ctx.font = '400 38px system-ui, sans-serif'; ctx.fillText(v, 190, 70 + i * 64);
    ctx.font = '600 40px system-ui, sans-serif';
  });
  tex.needsUpdate = true;
  mesh.position.set(0, 0.09, 0.02);
  mesh.rotation.x = -0.6;
  return mesh;
}

// A simple stand-in for the controller so you can see your hands.
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

// ------------------------------------------------------------------ stage title card (VR)
export class TitleCard {
  constructor() {
    const { canvas, ctx, mesh, tex } = canvasMesh(1000, 260, 0.2);
    Object.assign(this, { canvas, ctx, mesh, tex });
    this.mesh.material.opacity = 0;
    this.t = 99;
  }
  show(num, name, scale) {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.textAlign = 'center'; c.shadowColor = '#000'; c.shadowBlur = 18;
    c.fillStyle = ACC; c.font = '600 34px system-ui, sans-serif'; c.fillText(num, W / 2, 60);
    c.fillStyle = INK; c.font = '300 96px system-ui, sans-serif'; c.fillText(name, W / 2, 160);
    c.fillStyle = DIM; c.font = '400 38px system-ui, sans-serif'; c.fillText(scale, W / 2, 222);
    this.tex.needsUpdate = true;
    this.t = 0;
  }
  update(dt) {
    this.t += dt;
    const a = this.t < 0.6 ? this.t / 0.6 : this.t < 3.2 ? 1 : Math.max(0, 1 - (this.t - 3.2) / 0.8);
    this.mesh.material.opacity = a;
    this.mesh.visible = a > 0.01;
  }
}
