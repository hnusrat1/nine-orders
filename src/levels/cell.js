// Level 4 — one tumour cell, 10 µm. Units: µm, origin at the hand-off point
// (where the delta electron is set moving, inside the nucleus).
import * as THREE from 'three';
import { Level, sphereHit, spheresHit } from '../level.js';
import { Ribbons, GlowPoints, CellImpostors, fresnelMaterial } from '../gfx.js';
import { trackSegments, eventPoints } from '../tracks.js';
import { Callout } from '../hud.js';
import { fmt } from '../data.js';
import { smooth } from '../journey.js';
import { rng, gauss } from '../build.js';

const PRIMARY_SHOW = [3, 9];   // level-local seconds: fast electron crosses the view
const DELTA_SHOW = [9.5, 17];  // delta electron replay

export class CellLevel extends Level {
  constructor(def, data) {
    super(def);
    const ix = data.index, n = data.n, cell = ix.handoff.cell;
    const r = rng(23);

    // ---- membrane and nucleus of the cell we enter
    const cc = new THREE.Vector3(...cell.centre_um), nc = new THREE.Vector3(...cell.nucleusCentre_um);
    const mem = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 5), fresnelMaterial({ color: 0x6fb3d6, rim: 2.6, base: 0.02, strength: 0.9, side: THREE.DoubleSide }));
    mem.position.copy(cc); mem.scale.set(cell.radius_um, cell.radius_um * 0.9, cell.radius_um * 1.05);
    this.offset.add(mem); this.fade(mem.material);
    const nucMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 5), fresnelMaterial({ color: 0x9d86e0, rim: 2.2, base: 0.03, strength: 1.0, side: THREE.DoubleSide }));
    nucMesh.position.copy(nc); nucMesh.scale.setScalar(cell.nucleusRadius_um);
    this.offset.add(nucMesh); this.fade(nucMesh.material);
    this.pickables.push({ hit: sphereHit(nc, cell.nucleusRadius_um), priority: 0.5, label: `Cell nucleus, ${fmt(n.nucleusDiameter)} across (model), holding the cell's DNA packed as chromatin.` });

    // ---- chromatin domains: 46 chromosome territories as soft clusters
    const pts = [], col = [], sz = [];
    const R = cell.nucleusRadius_um;
    for (let c = 0; c < 46; c++) {
      let ctr;
      do { ctr = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).multiplyScalar(R * 0.8); } while (ctr.length() > R * 0.78);
      const k = 50 + Math.floor(r() * 30);
      const hue = 0.72 + r() * 0.1;
      const cC = new THREE.Color().setHSL(hue, 0.45, 0.55);
      for (let i = 0; i < k; i++) {
        const p = ctr.clone().add(new THREE.Vector3(gauss(r), gauss(r), gauss(r)).multiplyScalar(0.55));
        if (p.length() > R * 0.95) continue;
        p.add(nc);
        pts.push(p.x, p.y, p.z); col.push(cC.r * 0.028, cC.g * 0.028, cC.b * 0.028); sz.push(0.22 + r() * 0.2);
      }
    }
    this.domains = new GlowPoints({ pos: new Float32Array(pts), color: new Float32Array(col), size: new Float32Array(sz), minAngle: 0.002, core: 0 });
    this.offset.add(this.domains); this.fade(this.domains.material);

    // ---- neighbouring cells
    const npos = [], nrad = [], nnuc = [], ntint = [];
    for (let i = 0; i < 400 && nrad.length < 34; i++) {
      const dir = new THREE.Vector3(gauss(r), gauss(r), gauss(r)).normalize();
      const p = cc.clone().add(dir.multiplyScalar(cell.radius_um + 6 + r() * 14));
      const rr = 5 + r() * 1.4;
      let ok = true;
      for (let j = 0; j < nrad.length; j++) if (p.distanceTo(new THREE.Vector3(npos[3 * j], npos[3 * j + 1], npos[3 * j + 2])) < (rr + nrad[j]) * 0.95) ok = false;
      if (!ok) continue;
      npos.push(p.x, p.y, p.z); nrad.push(rr); nnuc.push(0.45 + r() * 0.1); ntint.push(r());
    }
    this.neigh = new CellImpostors({ pos: new Float32Array(npos), radius: new Float32Array(nrad), nucleus: new Float32Array(nnuc), tint: new Float32Array(ntint) });
    this.offset.add(this.neigh); this.fade(this.neigh.material, 0.8);
    this.pickables.push({ hit: spheresHit(new Float32Array(npos), new Float32Array(nrad)), priority: 0.5, label: 'A neighbouring tumour cell.' });

    // ---- fast (primary) electron at cell scale: Geant4-DNA events in water
    const P = data.sets.cellPrimary;
    this.pT = [Infinity, -Infinity];
    for (let i = 0; i < P.count; i++) if (P.track[i] === 0) { this.pT[0] = Math.min(this.pT[0], P.time[i]); this.pT[1] = Math.max(this.pT[1], P.time[i]); }
    this.pTrack = new Ribbons({ ...trackSegments(P, { width: (tr) => (tr === 0 ? 0.03 : 0.012), color: (tr) => (tr === 0 ? [0.45, 0.85, 1] : [0.3, 0.5, 0.8]) }), minAngle: 0.0012 });
    this.offset.add(this.pTrack);
    this.pEvents = new GlowPoints({ ...eventPoints(P, { size: 0.03, filter: (i) => P.type[i] === 1 || P.type[i] === 2 }), minAngle: 0.0022 });
    this.offset.add(this.pEvents);
    this.pickables.push({ hit: (ray) => {
      // nearest primary event within 0.3 µm of the ray
      return spheresHit(this.pEvents.geometry.attributes.iPos.array, 0.3, 4000)(ray);
    }, label: `The fast electron: about ${fmt(n.letPrimary)} here, so its ionisations are sparse on this scale.` });

    // ---- the delta electron (nm → µm)
    const D = data.sets.delta;
    this.dT = [Infinity, -Infinity];
    for (let i = 0; i < D.count; i++) { this.dT[0] = Math.min(this.dT[0], D.time[i]); this.dT[1] = Math.max(this.dT[1], D.time[i]); }
    this.dTrack = new Ribbons({ ...trackSegments(D, { k: 1e-3, width: 0.008, color: () => [1, 0.75, 0.4] }), minAngle: 0.0012 });
    this.offset.add(this.dTrack);
    this.dEvents = new GlowPoints({ ...eventPoints(D, { k: 1e-3, size: 0.006, filter: (i) => D.type[i] === 1 || D.type[i] === 2 }), minAngle: 0.0018 });
    this.offset.add(this.dEvents);
    this.flash = new GlowPoints({ pos: new Float32Array(3), color: new Float32Array([1, 0.9, 0.7]), size: new Float32Array([0.25]), minAngle: 0.02 });
    this.offset.add(this.flash);

    this.callout = new Callout({ lines: 2, height: 0.18 });
    this.callout.mesh.position.set(0.3, 0.168, 0);
    this.callout.set('Delta electron', [['energy', fmt(n.deltaE)], ['range in water', fmt(n.deltaRange)]], '#ffb35c');
    this.ui.add(this.callout.mesh);
    this.pickables.push({ hit: sphereHit(new THREE.Vector3(), 0.25), label: `A ${fmt(n.deltaE)} delta electron, knocked out of a water molecule by the fast electron. Slow electrons like this deposit their energy densely.` });
  }

  update(lt, ctx) {
    const w = this.weight;
    const fp = (lt - PRIMARY_SHOW[0]) / (PRIMARY_SHOW[1] - PRIMARY_SHOW[0]);
    const tp = this.pT[0] + Math.min(Math.max(fp, -0.01), 1) * (this.pT[1] - this.pT[0]);
    this.pTrack.material.uniforms.uReveal.value = fp < 0 ? -1 : tp;
    this.pEvents.material.uniforms.uReveal.value = fp < 0 ? -1 : tp;
    this.pTrack.material.uniforms.uOpacity.value = w;
    this.pEvents.material.uniforms.uOpacity.value = w;
    const fd = (lt - DELTA_SHOW[0]) / (DELTA_SHOW[1] - DELTA_SHOW[0]);
    const td = this.dT[0] + Math.min(Math.max(fd, 0), 1) * (this.dT[1] - this.dT[0]);
    this.dTrack.material.uniforms.uReveal.value = fd < 0 ? -1 : td;
    this.dEvents.material.uniforms.uReveal.value = fd < 0 ? -1 : td;
    this.dTrack.material.uniforms.uOpacity.value = w;
    this.dEvents.material.uniforms.uOpacity.value = w;
    const tf = lt - DELTA_SHOW[0];
    this.flash.material.uniforms.uOpacity.value = tf > -0.4 ? w * Math.exp(-Math.max(tf + 0.4, 0) * 1.2) : 0;
    this.callout.opacity = w * smooth((lt - DELTA_SHOW[0] - 0.5) / 1.0);
  }
}
