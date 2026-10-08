// Canvas-drawn HUD pieces used both on screen (desktop/phone) and as textured
// panels in VR: the log-scale strip, the 3D scale bar, world-space callouts
// and the subtitle panel.
import * as THREE from 'three';
import { LEVELS, scaleBar, Z_MAX } from './journey.js';

const INK = '#e8edf2', DIM = '#8a96a3', ACC = '#ffb35c';

function panelMesh(canvas, heightM) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(heightM * canvas.width / canvas.height, heightM), mat);
  mesh.renderOrder = 10;
  return mesh;
}

// ------------------------------------------------------------- Log strip
export class LogStrip {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.last = null;
    this.mesh = null;
  }
  makeMesh(h = 0.42) {
    this.mesh = panelMesh(this.canvas, h);
    return this.mesh;
  }
  draw(z, levelId) {
    const key = z.toFixed(2) + levelId;
    if (key === this.last) return;
    // a texture upload per frame stutters in VR: redraw at most ~8 times a second unless the stage changed
    const now = performance.now();
    if (this.lastLevel === levelId && now - (this.lastT || 0) < 120) return;
    this.last = key; this.lastLevel = levelId; this.lastT = now;
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(5,7,10,0.55)';
    roundRect(c, 2, 2, W - 4, H - 4, 18); c.fill();
    const top = 46, bot = H - 40, x = 70;
    const y = (e) => top + (bot - top) * (e / 9);
    c.strokeStyle = 'rgba(232,237,242,0.35)'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(x, top); c.lineTo(x, bot); c.stroke();
    c.font = '500 22px system-ui, sans-serif'; c.textBaseline = 'middle';
    c.fillStyle = DIM; c.textAlign = 'center';
    c.fillText('scale', W / 2, 22);
    const names = { 0: '1 m', 1: '10 cm', 2: '1 cm', 3: '1 mm', 4: '100 µm', 5: '10 µm', 6: '1 µm', 7: '100 nm', 8: '10 nm', 9: '1 nm' };
    for (let e = 0; e <= 9; e++) {
      c.strokeStyle = 'rgba(232,237,242,0.5)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(x - 10, y(e)); c.lineTo(x + 10, y(e)); c.stroke();
      c.textAlign = 'right'; c.fillStyle = DIM; c.font = '400 19px system-ui, sans-serif';
      c.fillText(`10${sup(-e)}`, x - 16, y(e));
      c.textAlign = 'left'; c.fillStyle = 'rgba(232,237,242,0.75)';
      c.fillText(names[e], x + 16, y(e));
    }
    const zz = Math.max(0, Math.min(9, z));
    c.fillStyle = ACC;
    c.beginPath(); c.arc(x, y(zz), 11, 0, Math.PI * 2); c.fill();
    c.font = '600 21px system-ui, sans-serif'; c.textAlign = 'center'; c.fillStyle = INK;
    const lv = LEVELS.find((l) => l.id === levelId);
    c.fillText(lv ? lv.name : '', W / 2, H - 16);
    if (this.mesh) this.mesh.material.map.needsUpdate = true;
  }
}

function sup(n) {
  const m = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  return String(n).split('').map((ch) => m[ch]).join('');
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

// ------------------------------------------------------------- Scale bar (3D, at the anchor's depth)
export class ScaleBar {
  constructor() {
    this.group = new THREE.Group();
    this.bar = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xe8edf2, transparent: true, opacity: 0.85, depthWrite: false }));
    this.capL = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.bar.material);
    this.capR = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.bar.material);
    this.group.add(this.bar, this.capL, this.capR);
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256; this.canvas.height = 64;
    this.label = panelMesh(this.canvas, 0.032);
    this.group.add(this.label);
    this.text = '';
  }
  update(z) {
    const sb = scaleBar(z);
    const L = sb.display, t = 0.0035;
    this.bar.scale.set(L, t, t); this.bar.position.set(0, 0, 0);
    this.capL.scale.set(t, t * 5, t); this.capL.position.set(-L / 2, 0, 0);
    this.capR.scale.set(t, t * 5, t); this.capR.position.set(L / 2, 0, 0);
    this.label.position.set(0, -0.024, 0);
    if (sb.text !== this.text) {
      this.text = sb.text;
      const c = this.canvas.getContext('2d');
      c.clearRect(0, 0, 256, 64);
      c.font = '500 40px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = INK; c.shadowColor = '#000'; c.shadowBlur = 8;
      c.fillText(sb.text, 128, 34);
      this.label.material.map.needsUpdate = true;
    }
    return sb;
  }
}

// ------------------------------------------------------------- Callout panels
export class Callout {
  constructor({ width = 520, lines = 4, height = 0.07 } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width; this.canvas.height = 34 + lines * 40;
    this.mesh = panelMesh(this.canvas, height * (this.canvas.height / 194));
    this.mesh.userData.billboard = true;
    this.key = '';
  }
  set(title, rows, accent = ACC) {
    const key = title + '|' + rows.map((r) => [].concat(r).join('¦')).join('|');
    if (key === this.key) return;
    const now = performance.now();
    if (this.key && title === this.title && now - (this.t || 0) < 250) return; // live values: at most 4 redraws/s
    this.key = key; this.title = title; this.t = now;
    const c = this.canvas.getContext('2d'), W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(5,7,10,0.72)'; roundRect(c, 2, 2, W - 4, H - 4, 14); c.fill();
    c.strokeStyle = 'rgba(232,237,242,0.18)'; c.lineWidth = 2; c.stroke();
    c.textBaseline = 'middle'; c.textAlign = 'left';
    c.font = '600 26px system-ui, sans-serif'; c.fillStyle = accent;
    c.fillText(title, 18, 26);
    c.font = '400 25px system-ui, sans-serif'; c.fillStyle = INK;
    rows.forEach((r, i) => {
      if (Array.isArray(r)) {
        c.fillStyle = r[2] || DIM; c.fillText(r[0], 18, 64 + i * 38);
        c.fillStyle = INK; c.fillText(r[1], W * 0.42, 64 + i * 38);
      } else c.fillText(r, 18, 64 + i * 38);
    });
    this.mesh.material.map.needsUpdate = true;
  }
  set opacity(v) { this.mesh.material.opacity = v; this.mesh.visible = v > 0.01; }
}

// ------------------------------------------------------------- Subtitles panel (VR)
export class SubtitlePanel {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1400; this.canvas.height = 190;
    this.mesh = panelMesh(this.canvas, 0.1);
    this.text = null;
  }
  set(text) {
    if (text === this.text) return;
    this.text = text;
    const c = this.canvas.getContext('2d'), W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    if (!text) { this.mesh.material.map.needsUpdate = true; return; }
    c.font = '400 40px system-ui, sans-serif';
    const lines = wrap(c, text, W - 80);
    c.fillStyle = 'rgba(5,7,10,0.6)';
    const h = lines.length * 50 + 30;
    roundRect(c, 10, (H - h) / 2, W - 20, h, 16); c.fill();
    c.fillStyle = INK; c.textAlign = 'center'; c.textBaseline = 'middle';
    lines.forEach((l, i) => c.fillText(l, W / 2, H / 2 - (lines.length - 1) * 25 + i * 50));
    this.mesh.material.map.needsUpdate = true;
  }
}

function wrap(c, text, maxW) {
  const words = text.split(/\s+/), lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (c.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

export { Z_MAX };
