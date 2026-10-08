// Level 3 — tissue, 1 mm to 100 µm. Units: µm, origin at the Compton point.
import * as THREE from 'three';
import { Level, spheresHit, sphereHit } from '../level.js';
import { Ribbons, GlowPoints, CellImpostors } from '../gfx.js';
import { trackSegments, trackPolyline } from '../tracks.js';
import { Callout } from '../hud.js';
import { fmt } from '../data.js';
import { smooth } from '../journey.js';
import { rng, gauss, cumulativeLength, pointAtLength } from '../build.js';

const FOLLOW = [5, 32]; // level-local seconds over which we ride the electron to the hand-off point

export class TissueLevel extends Level {
  constructor(def, data) {
    super(def);
    const ix = data.index, n = data.n, set = data.sets.patientElectron;
    const K = 1000; // mm → µm
    this.set = set;

    // primary electron path, truncated at the hand-off point
    const prim = trackPolyline(set, 0, K);
    const ho = new THREE.Vector3(...ix.handoff.origin_mm).multiplyScalar(K);
    let iHo = 0, best = Infinity;
    for (let i = 0; i < prim.pts.length / 3; i++) {
      const d = ho.distanceToSquared(new THREE.Vector3(prim.pts[3 * i], prim.pts[3 * i + 1], prim.pts[3 * i + 2]));
      if (d < best) { best = d; iHo = i; }
    }
    this.path = prim.pts.slice(0, 3 * (iHo + 1));
    this.path.set(ho.toArray(), 3 * iHo);
    this.L = cumulativeLength(this.path);
    this.sHo = this.L[this.L.length - 1];
    this.ho = ho;
    // kinetic energy along the primary (keV) for the callout
    this.ekin = []; for (let i = 0; i < set.count; i++) if (set.track[i] === 0) this.ekin.push(set.ekin[i]);

    // ---- full track (already travelled in the previous level)
    const segs = trackSegments(set, {
      k: K, width: (tr) => (tr === 0 ? 1.1 : 0.6),
      color: (tr) => (tr === 0 ? [0.45, 0.85, 1.0] : [0.35, 0.55, 0.9]),
    });
    this.track = new Ribbons({ ...segs, minAngle: 0.0014 });
    this.offset.add(this.track);
    this.fade(this.track.material, 0.9);

    // ---- condensed-history step points (each sums many ionisations)
    const sel = [];
    for (let i = 0; i < set.count; i++) if (set.edep[i] > 0) sel.push(i);
    const pp = new Float32Array(3 * sel.length), pc = new Float32Array(3 * sel.length), ps = new Float32Array(sel.length);
    sel.forEach((i, j) => {
      for (let q = 0; q < 3; q++) pp[3 * j + q] = set.pos[3 * i + q] * K;
      pc.set([0.9, 0.6, 0.3], 3 * j); ps[j] = 1.2;
    });
    this.steps = new GlowPoints({ pos: pp, color: pc, size: ps, minAngle: 0.0035 });
    this.offset.add(this.steps);
    this.fade(this.steps.material, 0.7);
    this.pickables.push({ hit: (ray) => sphereHit(this.anchor, 6)(ray), label: 'Points mark Geant4 condensed-history steps along the electron track; each one sums many individual ionisations.' });

    // ---- packed cells around the track (procedural, deterministic)
    const cell = ix.handoff.cell;
    const chosen = ho.clone().add(new THREE.Vector3(...cell.centre_um));
    const r = rng(11), sp = 11.2, R = 55;
    const pos = [], rad = [], nuc = [], tint = [];
    const tmp = new THREE.Vector3();
    const box = new THREE.Box3();
    for (let i = 0; i < this.path.length / 3; i++) box.expandByPoint(tmp.set(this.path[3 * i], this.path[3 * i + 1], this.path[3 * i + 2]));
    box.expandByScalar(R);
    const pathDist = (p) => {
      let m = Infinity;
      const a = new THREE.Vector3(), b = new THREE.Vector3(), l = new THREE.Line3();
      for (let i = 0; i + 1 < this.path.length / 3; i++) {
        a.fromArray(this.path, 3 * i); b.fromArray(this.path, 3 * i + 3);
        l.set(a, b); m = Math.min(m, l.closestPointToPoint(p, true, tmp).distanceTo(p));
      }
      return m;
    };
    for (let x = box.min.x; x <= box.max.x; x += sp)
      for (let y = box.min.y; y <= box.max.y; y += sp * 0.87)
        for (let zz = box.min.z; zz <= box.max.z; zz += sp * 0.82) {
          const p = new THREE.Vector3(x + gauss(r) * 1.4 + ((Math.round(y / sp) % 2) * sp) / 2, y + gauss(r) * 1.4, zz + gauss(r) * 1.4);
          const d = Math.min(pathDist(p), p.distanceTo(ho));
          if (d > R) continue;
          const rr = 5.0 + r() * 1.3;
          if (p.distanceTo(chosen) < (rr + cell.radius_um) * 0.92) continue;
          pos.push(p.x, p.y, p.z); rad.push(rr); nuc.push(0.42 + r() * 0.12); tint.push(r());
        }
    pos.push(chosen.x, chosen.y, chosen.z); rad.push(cell.radius_um); nuc.push(cell.nucleusRadius_um / cell.radius_um); tint.push(1);
    this.cellPos = new Float32Array(pos);
    this.cells = new CellImpostors({ pos: this.cellPos, radius: new Float32Array(rad), nucleus: new Float32Array(nuc), tint: new Float32Array(tint) });
    this.offset.add(this.cells);
    this.fade(this.cells.material, 1);
    this.cells.material.uniforms.uGain.value = 1.15;
    this.cellCount = rad.length;
    this.pickables.push({ hit: spheresHit(this.cellPos, new Float32Array(rad)), priority: 0.5, label: 'A cell, about 10–12 µm across, with its nucleus. Placement is illustrative; the track is simulated.' });

    // ---- electron "head" marker at the anchor
    this.head = new GlowPoints({ pos: new Float32Array(3), color: new Float32Array([0.7, 0.95, 1]), size: new Float32Array([1.4]), minAngle: 0.01 });
    this.offset.add(this.head);
    this.fade(this.head.material);

    this.callout = new Callout({ lines: 2, height: 0.18 });
    this.callout.mesh.position.set(0.33, 0.168, 0);
    this.ui.add(this.callout.mesh);
    this.nLET = n.letPrimary;
  }

  update(lt, ctx) {
    const f = smooth((lt - FOLLOW[0]) / (FOLLOW[1] - FOLLOW[0]));
    const s = f * this.sHo;
    pointAtLength(this.path, this.L, s, this.anchor);
    this.head.geometry.attributes.iPos.array.set(this.anchor.toArray());
    this.head.geometry.attributes.iPos.needsUpdate = true;
    this.cells.material.uniforms.uAnchor.value.copy(this.root.position);
    this.cells.material.uniforms.uFadeR.value = 0.7;
    // energy remaining: nearest primary step along the path
    let idx = 0;
    while (idx + 1 < this.L.length && this.L[idx + 1] <= s) idx++;
    const E = this.ekin[Math.min(idx, this.ekin.length - 1)];
    this.callout.set('Recoil electron', [['energy', `${(E / 1000).toFixed(3)} MeV`], ['energy loss', fmt(this.nLET)]]);
    this.callout.opacity = this.weight * smooth((lt - 2) / 1.5);
  }
}
