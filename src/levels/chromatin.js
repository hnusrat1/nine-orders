// Level 5 — chromatin, 100 nm to 10 nm. Units: nm, origin at the hand-off point.
import * as THREE from 'three';
import { Level, spheresHit, sphereHit } from '../level.js';
import { Ribbons, GlowPoints, solidMaterial } from '../gfx.js';
import { trackSegments, eventPoints, trackPolyline } from '../tracks.js';
import { Callout } from '../hud.js';
import { fmt } from '../data.js';
import { smooth } from '../journey.js';

const SHOW = [3, 27];    // level-local seconds: replay of the delta electron
const TO_SITE = [24, 33]; // glide from the track to the break site

// Nucleosome placeholder: histone core + 1.65 left-handed superhelical turns of DNA.
// Dimensions from the 1KX5 crystal structure (Davey et al. 2002): superhelix radius ≈ 4.19 nm, pitch ≈ 2.39 nm.
export function nucleosomeGeometries() {
  const core = new THREE.CylinderGeometry(3.2, 3.2, 5.6, 28, 1);
  const turns = 1.65, R = 4.19, pitch = 2.39;
  class Helix extends THREE.Curve {
    getPoint(t, out = new THREE.Vector3()) {
      const a = -(t - 0.5) * turns * 2 * Math.PI; // left-handed superhelix
      return out.set(R * Math.cos(a), (t - 0.5) * turns * pitch, R * Math.sin(a));
    }
  }
  const dna = new THREE.TubeGeometry(new Helix(), 96, 1.0, 10, false);
  // match the 1KX5 nucleosome reference frame used by the data (superhelix axis along z)
  core.rotateX(Math.PI / 2); dna.rotateX(Math.PI / 2);
  return { core, dna };
}

export class ChromatinLevel extends Level {
  constructor(def, data, assets) {
    super(def);
    const ix = data.index, n = data.n;
    const N = data.sets.nucleosomes;
    const geoms = assets.nucleosome || nucleosomeGeometries();
    const mCore = solidMaterial({ color: 0x4f4190, roughness: 0.62 });
    const mDna = solidMaterial({ color: 0xa8792f, roughness: 0.5 });
    // Two levels of detail: full surfaces for the nucleosomes nearest the particle, light ones elsewhere.
    this.core = new THREE.InstancedMesh(geoms.core, mCore, N.count);
    this.dna = new THREE.InstancedMesh(geoms.dna, mDna, N.count);
    this.coreLo = new THREE.InstancedMesh(geoms.coreLo || geoms.core, mCore, N.count);
    this.dnaLo = new THREE.InstancedMesh(geoms.dnaLo || geoms.dna, mDna, N.count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    this.nucMatrices = [];
    for (let i = 0; i < N.count; i++) {
      p.fromArray(N.pos, 3 * i); q.fromArray(N.quat, 4 * i);
      this.nucMatrices.push(new THREE.Matrix4().compose(p, q, one));
    }
    this.nucCentres = Array.from({ length: N.count }, (_, i) => new THREE.Vector3().fromArray(N.pos, 3 * i));
    this.lodAt = null;
    this.assignLod(new THREE.Vector3());
    this.offset.add(this.core, this.dna, this.coreLo, this.dnaLo);
    this.fade(mCore); this.fade(mDna);
    this.pickables.push({ hit: spheresHit(N.pos, 5.5), priority: 0.5, label: 'Nucleosome: 147 base pairs of DNA wrapped 1.65 turns around eight histone proteins (structure from PDB 1KX5).' });

    // linker DNA between nucleosomes: B-DNA, 2 nm across
    const Lk = data.sets.linkers;
    const nL = Lk.count / 2;
    this.linkers = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), mDna, nL);
    const up = new THREE.Vector3(0, 1, 0), a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), lq = new THREE.Quaternion();
    for (let i = 0; i < nL; i++) {
      a.fromArray(Lk.pos, 6 * i); b.fromArray(Lk.pos, 6 * i + 3);
      d.subVectors(b, a);
      lq.setFromUnitVectors(up, d.clone().normalize());
      m.compose(a.clone().add(b).multiplyScalar(0.5), lq, new THREE.Vector3(1, d.length(), 1));
      this.linkers.setMatrixAt(i, m);
    }
    this.offset.add(this.linkers);
    this.pickables.push({ hit: (ray) => spheresHit(Lk.pos, 1.5)(ray), priority: 0.5, label: 'Linker DNA between nucleosomes: B-DNA, 2 nm across (built from PDB 1BNA).' });

    // delta electron events and path
    const D = data.sets.delta;
    this.dT = [Infinity, -Infinity];
    for (let i = 0; i < D.count; i++) { this.dT[0] = Math.min(this.dT[0], D.time[i]); this.dT[1] = Math.max(this.dT[1], D.time[i]); }
    this.dTrack = new Ribbons({ ...trackSegments(D, { width: (tr) => (tr === 0 ? 0.12 : 0.07), color: (tr) => (tr === 0 ? [1, 0.75, 0.4] : [0.85, 0.55, 0.3]) }), minAngle: 0.001 });
    this.offset.add(this.dTrack);
    this.dEvents = new GlowPoints({ ...eventPoints(D, { size: 0.6, filter: (i) => D.type[i] >= 1 && D.type[i] <= 4, gain: 1.3 }), minAngle: 0.0032, flash: 1.5 });
    this.offset.add(this.dEvents);
    this.pickables.push({ hit: (ray) => spheresHit(this.dEvents.geometry.attributes.iPos.array, 1.2)(ray), label: 'Interaction points of the delta electron: orange = ionisation, blue = electronic excitation, violet = vibrational excitation or attachment.' });
    this.prim = trackPolyline(D, 0);
    this.site = new THREE.Vector3(...ix.dsb.site_nm);
    this.pickables.push({ hit: sphereHit(this.site, 2.5), label: 'The double-strand break site.' });

    this.callout = new Callout({ lines: 2, height: 0.18 });
    this.callout.mesh.position.set(0.33, 0.168, 0);
    this.callout.set('Chromatin', [['nucleosome repeat', fmt(n.nrl)], ['shown here', `${N.count} nucleosomes`]], '#c9b3ff');
    this.ui.add(this.callout.mesh);
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3();
  }

  assignLod(centre) {
    const NEAR = 40;
    const order = this.nucCentres.map((c, i) => [c.distanceToSquared(centre), i]).sort((x, y) => x[0] - y[0]);
    let h = 0, l = 0;
    order.forEach(([, i], k) => {
      if (k < NEAR) { this.core.setMatrixAt(h, this.nucMatrices[i]); this.dna.setMatrixAt(h, this.nucMatrices[i]); h++; }
      else { this.coreLo.setMatrixAt(l, this.nucMatrices[i]); this.dnaLo.setMatrixAt(l, this.nucMatrices[i]); l++; }
    });
    this.core.count = this.dna.count = h;
    this.coreLo.count = this.dnaLo.count = l;
    for (const im of [this.core, this.dna, this.coreLo, this.dnaLo]) { im.instanceMatrix.needsUpdate = true; im.boundingSphere = null; }
    this.lodAt = centre.clone();
  }

  update(lt, ctx) {
    const w = this.weight;
    const f = (lt - SHOW[0]) / (SHOW[1] - SHOW[0]);
    const t = this.dT[0] + Math.min(Math.max(f, 0), 1) * (this.dT[1] - this.dT[0]);
    const rev = f < 0 ? -1 : t;
    this.dTrack.material.uniforms.uReveal.value = rev;
    this.dEvents.material.uniforms.uReveal.value = rev;
    this.dTrack.material.uniforms.uOpacity.value = w;
    this.dEvents.material.uniforms.uOpacity.value = w;
    this.dEvents.material.uniforms.uTimeScale.value = 1 / Math.max((this.dT[1] - this.dT[0]) / (SHOW[1] - SHOW[0]), 1e-12);
    // anchor follows the delta's own path, then glides to the break site
    const { pts, times } = this.prim;
    let k = 0;
    while (k + 1 < times.length && times[k + 1] <= t) k++;
    const k2 = Math.min(k + 1, times.length - 1);
    const u = times[k2] > times[k] ? Math.min(1, Math.max(0, (t - times[k]) / (times[k2] - times[k]))) : 0;
    this._a.fromArray(pts, 3 * k).lerp(this._b.fromArray(pts, 3 * k2), f < 0 ? 0 : u);
    if (f < 0) this._a.set(0, 0, 0);
    const g = smooth((lt - TO_SITE[0]) / (TO_SITE[1] - TO_SITE[0]));
    this.anchor.copy(this._a).lerp(this.site, g);
    if (this.lodAt.distanceTo(this.anchor) > 8) this.assignLod(this.anchor); // re-sort when the particle has moved 8 nm
    this.callout.opacity = w * smooth((lt - 1) / 1.5);
  }
}
