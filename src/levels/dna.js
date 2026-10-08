// Level 6 — DNA, 1 nm. Units: nm, origin at the double-strand-break site.
import * as THREE from 'three';
import { Level, spheresHit } from '../level.js';
import { GlowPoints, Ribbons } from '../gfx.js';
import { eventPoints, trackSegments } from '../tracks.js';
import { Callout } from '../hud.js';
import { fmt } from '../data.js';
import { smooth } from '../journey.js';

const SHOW = [3, 21];    // replay of events near the site
const BREAK = [25, 31];  // the helix comes apart
const VDW = [0.170, 0.155, 0.152, 0.180, 0.110]; // C N O P H (nm), Bondi radii
const ELEM = ['C', 'N', 'O', 'P', 'H'];

export class DnaLevel extends Level {
  constructor(def, data) {
    super(def);
    const ix = data.index, n = data.n, A = data.sets.dnaAtoms, dsb = ix.dsb;
    this.dsb = dsb;
    // which side of the break each atom ends up on
    const pair = dsb.pair.map((k) => dsb.ssb[k]);
    const cut = { [pair[0].strand]: pair[0].bp, [pair[1].strand]: pair[1].bp };
    const sides = [[], []];
    for (let i = 0; i < A.count; i++) sides[A.bp[i] <= cut[A.strand[i]] ? 0 : 1].push(i);
    // Ball-and-stick: atoms at 0.4 × their van der Waals radius, bonds wherever two
    // heavy atoms are closer than 0.19 nm (covalent bond lengths are 0.13–0.16 nm).
    const geo = new THREE.SphereGeometry(1, 12, 8);
    const bondGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.05, envMapIntensity: 0.7, transparent: true });
    const bondMat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.0, envMapIntensity: 0.9, transparent: true });
    this.fade(mat); this.fade(bondMat);
    const cBack = [new THREE.Color(0xd9893a), new THREE.Color(0x3f86d1)];
    const cBase = [new THREE.Color(0xa89d8e), new THREE.Color(0x8f9aa8)];
    const cP = new THREE.Color(0xffd06a), cO = new THREE.Color(0xff6f5c), cN = new THREE.Color(0x7d8cff);
    const colourOf = (i) => {
      const st = A.strand[i], e = A.elem[i];
      if (A.backbone[i]) return e === 3 ? cP : e === 2 ? cBack[st].clone().lerp(cO, 0.35) : cBack[st];
      return cBase[st].clone().lerp(e === 2 ? cO : e === 1 ? cN : cBase[st], 0.45);
    };
    const P = (i) => new THREE.Vector3(A.pos[3 * i], A.pos[3 * i + 1], A.pos[3 * i + 2]);
    this.halves = sides.map((list) => {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4();
      list.forEach((i, j) => {
        const r = VDW[A.elem[i]] * 0.4;
        m.makeScale(r, r, r).setPosition(A.pos[3 * i], A.pos[3 * i + 1], A.pos[3 * i + 2]);
        im.setMatrixAt(j, m);
        im.setColorAt(j, colourOf(i));
      });
      // bonds within this half
      const bonds = [];
      for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
        const i = list[a], k = list[b];
        const dx = A.pos[3 * i] - A.pos[3 * k], dy = A.pos[3 * i + 1] - A.pos[3 * k + 1], dz = A.pos[3 * i + 2] - A.pos[3 * k + 2];
        if (dx * dx + dy * dy + dz * dz < 0.0361) bonds.push([i, k]);
      }
      const bm = new THREE.InstancedMesh(bondGeo, bondMat, Math.max(bonds.length, 1));
      const up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), c = new THREE.Color();
      bonds.forEach(([i, k], j) => {
        const a = P(i), b = P(k), d = b.clone().sub(a);
        q.setFromUnitVectors(up, d.clone().normalize());
        m.compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(0.022, d.length(), 0.022));
        bm.setMatrixAt(j, m);
        bm.setColorAt(j, c.copy(colourOf(i)).lerp(colourOf(k), 0.5).multiplyScalar(0.8));
      });
      bm.count = bonds.length;
      const g = new THREE.Group();
      g.add(im, bm);
      this.offset.add(g);
      return g;
    });
    this.atomPos = A.pos;
    this.pickables.push({ hit: spheresHit(A.pos, 0.17), label: (r) => {
      const i = r.index;
      return `${ELEM[A.elem[i]]} atom, ${A.backbone[i] ? 'sugar–phosphate backbone' : 'base'}, strand ${A.strand[i] ? 'B' : 'A'}. B-DNA coordinates from PDB 1BNA.`;
    } });

    // events near the site
    const D = data.sets.delta;
    const s = new THREE.Vector3(...ix.dsb.site_nm);
    const near = (i) => D.type[i] >= 1 && D.type[i] <= 4 && Math.hypot(D.pos[3 * i] - s.x, D.pos[3 * i + 1] - s.y, D.pos[3 * i + 2] - s.z) < ix.dsb.showRadius_nm;
    const ev = eventPoints(D, { shift: s.toArray(), size: 0.09, filter: near, gain: 1.2 });
    this.events = new GlowPoints({ ...ev, minAngle: 0.004, flash: 2.5 });
    this.offset.add(this.events);
    this.tWin = [Infinity, -Infinity];
    for (const i of ev.index) { this.tWin[0] = Math.min(this.tWin[0], D.time[i]); this.tWin[1] = Math.max(this.tWin[1], D.time[i]); }
    this.evIndex = ev.index;
    this.pickables.push({ hit: (ray) => spheresHit(ev.pos, 0.25)(ray), label: (r) => {
      const i = ev.index[r.index];
      const kind = { 1: 'electronic excitation', 2: 'ionisation', 3: 'vibrational excitation', 4: 'dissociative attachment' }[D.type[i]];
      return `${kind}: ${D.edep[i].toFixed(1)} eV deposited.`;
    } });
    // faint track segments near the site
    this.track = new Ribbons({ ...trackSegments(D, { shift: s.toArray(), width: 0.025, color: () => [1, 0.7, 0.35], filter: near }), minAngle: 0.0008 });
    this.offset.add(this.track);

    // strand-break markers (one per SSB that forms the DSB, plus any others)
    const bpos = [], bcol = [], bsz = [], bbirth = [];
    for (const b of dsb.ssb) { bpos.push(...b.pos_nm); bcol.push(1, 0.35, 0.3); bsz.push(0.35); bbirth.push(b.time_ns); }
    this.breaks = new GlowPoints({ pos: new Float32Array(bpos), color: new Float32Array(bcol), size: new Float32Array(bsz), birth: new Float32Array(bbirth), minAngle: 0.01, flash: 1.2, core: 0.2 });
    this.offset.add(this.breaks);
    this.pickables.push({ hit: (ray) => spheresHit(new Float32Array(bpos), 0.4)(ray), label: (r) => {
      const b = dsb.ssb[r.index];
      return `Strand break on strand ${b.strand ? 'B' : 'A'}: ${b.edep_eV.toFixed(1)} eV deposited in this nucleotide's sugar–phosphate backbone (threshold 17.5 eV).`;
    } });
    this.axis = new THREE.Vector3(...dsb.axis);

    this.legend = new Callout({ lines: 3, height: 0.216 });
    this.legend.mesh.position.set(-0.5, 0.3, 0);
    this.legend.set('Interaction types', [['●  orange', 'ionisation', '#ffa040'], ['●  blue', 'electronic excitation', '#5ab0ff'], ['●  red', 'strand break', '#ff5a4d']], '#e8edf2');
    this.ui.add(this.legend.mesh);
    this.callout = new Callout({ lines: 3, height: 0.216 });
    this.callout.mesh.position.set(0.5, 0.3, 0);
    this.ui.add(this.callout.mesh);
    this.n = n;
  }

  update(lt, ctx) {
    const w = this.weight;
    const f = (lt - SHOW[0]) / (SHOW[1] - SHOW[0]);
    const t = f < 0 ? -1 : this.tWin[0] + Math.min(f, 1.05) * (this.tWin[1] - this.tWin[0]);
    const ts = 1 / Math.max((this.tWin[1] - this.tWin[0]) / (SHOW[1] - SHOW[0]), 1e-12);
    for (const o of [this.events, this.breaks, this.track]) {
      o.material.uniforms.uReveal.value = t;
      o.material.uniforms.uOpacity.value = w;
      if (o.material.uniforms.uTimeScale) o.material.uniforms.uTimeScale.value = ts;
    }
    this.track.material.uniforms.uOpacity.value = w * 0.6;
    const b = smooth((lt - BREAK[0]) / (BREAK[1] - BREAK[0]));
    this.halves[1].position.copy(this.axis).multiplyScalar(0.55 * b);
    this.halves[1].rotation.set(0.12 * b, 0, 0.08 * b);
    this.halves[0].position.copy(this.axis).multiplyScalar(-0.2 * b);
    const nb = this.dsb.ssb.filter((x) => x.time_ns <= t).length;
    if (b > 0.02) this.callout.set('Double-strand break', [['breaks', `strand A and strand B`], ['separation', `${this.dsb.separation_bp} bp`], ['threshold', '17.5 eV per nucleotide']], '#ff6a5c');
    else this.callout.set('Strand breaks', [['so far', `${nb} of ${this.dsb.ssb.length}`], ['threshold', '17.5 eV per nucleotide'], ['backbone', 'sugar + phosphate']], '#ff6a5c');
    this.legend.opacity = w * smooth((lt - 2) / 1.5);
    this.callout.opacity = w * smooth((lt - 6) / 1.5);
  }
}
