// Small helpers to build merged, vertex-coloured geometry (one draw call per batch).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export class Batch {
  constructor() { this.parts = []; }
  add(geom, color, matrix) {
    const g = geom.index ? geom.toNonIndexed() : geom.clone();
    if (matrix) g.applyMatrix4(matrix);
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
    this.parts.push(g);
    return this;
  }
  box(w, h, d, x, y, z, color, rot) {
    return this.add(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z, rot));
  }
  cyl(rt, rb, h, x, y, z, color, rot, seg = 32) {
    return this.add(new THREE.CylinderGeometry(rt, rb, h, seg), color, mat(x, y, z, rot));
  }
  sphere(r, x, y, z, color, sx = 1, sy = 1, sz = 1, seg = 24) {
    const m = mat(x, y, z);
    m.scale(new THREE.Vector3(sx, sy, sz));
    return this.add(new THREE.SphereGeometry(r, seg, Math.max(8, seg >> 1)), color, m);
  }
  build() { return mergeGeometries(this.parts, false); }
}

export function mat(x = 0, y = 0, z = 0, rot) {
  const m = new THREE.Matrix4();
  if (rot) m.makeRotationFromEuler(new THREE.Euler(rot[0] || 0, rot[1] || 0, rot[2] || 0));
  m.setPosition(x, y, z);
  return m;
}

// Deterministic RNG so procedural tissue looks the same on every load.
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Polyline utilities over Float32Array xyz points.
export function cumulativeLength(pts) {
  const n = pts.length / 3;
  const L = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const dx = pts[3 * i] - pts[3 * i - 3], dy = pts[3 * i + 1] - pts[3 * i - 2], dz = pts[3 * i + 2] - pts[3 * i - 1];
    L[i] = L[i - 1] + Math.hypot(dx, dy, dz);
  }
  return L;
}

export function pointAtLength(pts, L, s, out = new THREE.Vector3()) {
  const n = L.length;
  if (s <= 0) return out.set(pts[0], pts[1], pts[2]);
  if (s >= L[n - 1]) return out.set(pts[3 * n - 3], pts[3 * n - 2], pts[3 * n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L[m] < s) lo = m; else hi = m; }
  const f = (s - L[lo]) / Math.max(L[hi] - L[lo], 1e-12);
  return out.set(
    pts[3 * lo] + f * (pts[3 * hi] - pts[3 * lo]),
    pts[3 * lo + 1] + f * (pts[3 * hi + 1] - pts[3 * lo + 1]),
    pts[3 * lo + 2] + f * (pts[3 * hi + 2] - pts[3 * lo + 2]));
}
