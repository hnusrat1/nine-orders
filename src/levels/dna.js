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
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.05 });
    mat.alphaHash = true;
    this.fade(mat);
    const col = new THREE.Color();
    const cBack = [new THREE.Color(0xe0a860), new THREE.Color(0x6fa8dc)];
    const cBase = [new THREE.Color(0xb8b0a4), new THREE.Color(0xa4b0b8)];
    const cP = new THREE.Color(0xffd27a), cO = new THREE.Color(0xe06a5a), cN = new THREE.Color(0x7a8cff);
    this.halves = sides.map((list) => {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4();
      list.forEach((i, j) => {
        const r = VDW[A.elem[i]] * 0.62;
        m.makeScale(r, r, r).setPosition(A.pos[3 * i], A.pos[3 * i + 1], A.pos[3 * i + 2]);
        im.setMatrixAt(j, m);
        const s = A.strand[i], e = A.elem[i];
        if (A.backbone[i]) col.copy(e === 3 ? cP : cBack[s]);
        else col.copy(cBase[s]).lerp(e === 2 ? cO : e === 1 ? cN : cBase[s], 0.35);
        im.setColorAt(j, col);
      });
      const g = new THREE.Group();
      g.add(im);
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
    this.legend.mesh.position.set(-0.45, 0.224, 0);
    this.legend.set('Interaction types', [['orange', 'ionisation'], ['blue', 'electronic excitation'], ['violet', 'vibrational / attachment']], '#e8edf2');
    this.ui.add(this.legend.mesh);
    this.callout = new Callout({ lines: 3, height: 0.216 });
    this.callout.mesh.position.set(0.45, 0.224, 0);
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
