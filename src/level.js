// Base class for one scale level. Each level owns its own scene graph in its
// own units, with the anchor (the particle) at the origin of `root`:
//   root (display transform: anchor position, user rotation, scale s)
//     └ offset (translates level content by -anchorLocal)
//         └ content
import * as THREE from 'three';
import { levelWeight, levelScale } from './journey.js';

export class Level {
  constructor(def) {
    Object.assign(this, def);
    this.root = new THREE.Group();
    this.root.name = def.id;
    this.offset = new THREE.Group();
    this.root.add(this.offset);
    this.root.visible = false;
    this.ui = new THREE.Group();       // display-metre UI that sits at the anchor (callouts)
    this.ui.name = def.id + '-ui';
    this.anchor = new THREE.Vector3(); // anchor in level-local units (where the story says the particle is)
    this.anchorShown = null;           // smoothed anchor actually used for display
    this.smoothTau = def.smoothTau ?? 0.35; // s; follows the particle without transmitting every zig-zag
    this.faders = [];                  // {set(o)} objects
    this.pickables = [];               // {hit(rayLocal) -> distance|null, label()}
    this.weight = 0;
  }

  // Register something whose opacity follows the level weight.
  fade(obj, base = 1) {
    if (obj.isMaterial) {
      const m = obj;
      if (m.uniforms && m.uniforms.uOpacity) this.faders.push((w) => { m.uniforms.uOpacity.value = base * w; });
      else this.faders.push((w) => { m.opacity = base * w; });
    } else if (typeof obj === 'function') this.faders.push(obj);
    else if (obj.material) this.fade(obj.material, base);
    return obj;
  }

  computeWeight(z) { return levelWeight(this.range, z); }

  apply(z, anchorWorld, userQuat, w, dt = 0) {
    this.weight = w;
    this.root.visible = w > 0.002;
    this.ui.visible = w > 0.3;
    if (!this.root.visible) return;
    this.ui.position.copy(anchorWorld);
    this.ui.quaternion.copy(userQuat);
    this.root.position.copy(anchorWorld);
    this.root.quaternion.copy(userQuat);
    const s = levelScale(this.unit, z);
    this.root.scale.setScalar(s);
    // Critically damped follow of the particle. Large jumps (scrubbing, mode
    // switches) snap so the view never drifts for long.
    if (!this.anchorShown || dt <= 0 || this.anchorShown.distanceTo(this.anchor) * s > 0.25) {
      this.anchorShown = (this.anchorShown || new THREE.Vector3()).copy(this.anchor);
    } else {
      this.anchorShown.lerp(this.anchor, 1 - Math.exp(-dt / this.smoothTau));
    }
    this.offset.position.copy(this.anchorShown).multiplyScalar(-1);
    for (const f of this.faders) f(w);
  }

  // Overridden by levels. lt: level-local story time (s); ctx: shared state.
  update(lt, ctx) {}

  // Ray in world space → nearest pick {distance, label, point}
  pick(rayWorld, onlyId) {
    if (!this.root.visible || this.weight < 0.5) return null;
    const inv = new THREE.Matrix4().copy(this.offset.matrixWorld).invert();
    const ray = rayWorld.clone().applyMatrix4(inv);
    const scale = this.offset.matrixWorld.getMaxScaleOnAxis();
    let best = null;
    for (const p of this.pickables) {
      if (p.enabled && !p.enabled()) continue;
      if (onlyId && p.id !== onlyId) continue;
      const r = p.hit(ray, rayWorld, scale, inv);
      if (r && (!best || r.d < best.d)) best = { d: r.d, label: typeof p.label === 'function' ? p.label(r) : p.label, local: r.point, id: p.id };
    }
    if (best) {
      best.point = best.local.clone().applyMatrix4(this.offset.matrixWorld);
      best.distance = best.d * scale;
    }
    return best;
  }
}

// Pick helpers -------------------------------------------------------------
const _v = new THREE.Vector3();
export function sphereHit(center, radius) {
  const s = new THREE.Sphere(center.clone ? center.clone() : new THREE.Vector3(...center), radius);
  return (ray) => {
    const p = ray.intersectSphere(s, new THREE.Vector3());
    return p ? { d: p.distanceTo(ray.origin), point: p } : null;
  };
}
export function meshHit(mesh) {
  const rc = new THREE.Raycaster();
  return (ray, rayWorld, scale, inv) => {
    rc.ray.copy(rayWorld);
    const hits = rc.intersectObject(mesh, true);
    if (!hits.length) return null;
    return { d: hits[0].distance / scale, point: hits[0].point.clone().applyMatrix4(inv) };
  };
}
// Many spheres (e.g. instanced cells). centers: Float32Array(3n), radii: Float32Array(n)|number
export function spheresHit(centers, radii, maxCheck = Infinity) {
  return (ray) => {
    let best = null;
    const n = Math.min(centers.length / 3, maxCheck);
    for (let i = 0; i < n; i++) {
      const r = typeof radii === 'number' ? radii : radii[i];
      _v.set(centers[3 * i], centers[3 * i + 1], centers[3 * i + 2]);
      const t = ray.closestPointToPoint(_v, new THREE.Vector3());
      const d2 = t.distanceToSquared(_v);
      if (d2 <= r * r) {
        const d = t.distanceTo(ray.origin);
        if (!best || d < best.d) best = { d, point: t, index: i };
      }
    }
    return best;
  };
}
