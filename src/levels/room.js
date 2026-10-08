// Level 1 — treatment room, 1 m. Units: metres, origin at the Compton point.
import * as THREE from 'three';
import { Level, sphereHit, meshHit } from '../level.js';
import { Ribbons, GlowPoints, solidMaterial } from '../gfx.js';
import { Batch, rng } from '../build.js';
import { fmt } from '../data.js';
import { smooth } from '../journey.js';
import { photonRemaining } from './shared.js';

const N_PHOTONS = 240;

export class RoomLevel extends Level {
  constructor(def, data, assets) {
    super(def);
    const g = data.index.geometry;
    const iso = new THREE.Vector3(...g.iso_mm).multiplyScalar(1e-3);
    this.iso = iso;
    this.src = new THREE.Vector3(...g.source_mm).multiplyScalar(1e-3);
    const floorY = iso.y - g.isoHeight_mm * 1e-3;
    const couchY = g.couchTop_mm * 1e-3;

    // ---- room + linac + couch (placeholder unless a baked model is supplied)
    const content = new THREE.Group();
    this.offset.add(content);
    if (assets.room) {
      const m = assets.room.clone();
      m.position.copy(iso).setY(floorY);
      content.add(m);
      m.traverse((o) => { if (o.material) this.fade(o.material); });
      this.roomMesh = m;
    } else {
      const b = new Batch();
      const W = 7, D = 8, H = 3.1;
      b.box(W, 0.02, D, iso.x, floorY - 0.01, iso.z, 0x1a1f26);
      b.box(W, H, 0.1, iso.x, floorY + H / 2, iso.z - D / 2, 0x141920);
      b.box(0.1, H, D, iso.x - W / 2, floorY + H / 2, iso.z, 0x11161c);
      b.box(0.1, H, D, iso.x + W / 2, floorY + H / 2, iso.z, 0x11161c);
      // gantry stand and drum
      b.box(1.9, 2.3, 1.0, iso.x, floorY + 1.15, iso.z - 1.75, 0xc9ced4);
      b.cyl(0.95, 0.95, 0.5, iso.x, iso.y, iso.z - 1.25, 0xd8dce0, [Math.PI / 2, 0, 0], 48);
      // arm + head (gantry 0°: head above isocentre)
      b.box(0.75, 0.55, 1.2, iso.x, iso.y + 0.95, iso.z - 0.75, 0xd8dce0);
      b.box(0.75, 0.55, 0.8, iso.x, iso.y + 0.95, iso.z - 0.05, 0xd8dce0);
      b.cyl(0.32, 0.36, 0.28, iso.x, iso.y + 0.55, iso.z, 0x9aa3ad, null, 40);
      b.box(0.3, 0.06, 0.3, iso.x, iso.y + 0.4, iso.z, 0x3b4148);
      // couch
      b.box(0.53, 0.05, 2.1, iso.x, couchY - 0.025, iso.z + 0.35, 0x2b3036);
      b.box(0.35, couchY - floorY - 0.05, 0.6, iso.x, (couchY + floorY) / 2 - 0.025, iso.z + 0.9, 0x5a6068);
      // placeholder patient (supine, head toward gantry)
      const pc = 0x8c7a6e;
      b.sphere(0.17, iso.x, couchY + 0.11, iso.z, pc, 1.0, 0.65, 1.3);
      b.sphere(0.16, iso.x, couchY + 0.11, iso.z - 0.45, pc, 1.05, 0.62, 1.6);
      b.sphere(0.1, iso.x, couchY + 0.1, iso.z - 0.85, pc, 1, 1, 1.15);
      b.cyl(0.075, 0.055, 0.85, iso.x - 0.1, couchY + 0.08, iso.z + 0.55, pc, [Math.PI / 2, 0, 0]);
      b.cyl(0.075, 0.055, 0.85, iso.x + 0.1, couchY + 0.08, iso.z + 0.55, pc, [Math.PI / 2, 0, 0]);
      const mesh = new THREE.Mesh(b.build(), solidMaterial({ vertexColors: true }));
      content.add(mesh);
      this.fade(mesh.material);
      this.roomMesh = mesh;
    }
    this.pickables.push({ hit: meshHit(this.roomMesh), label: 'Treatment room: a generic medical linear accelerator at gantry 0°, beam pointing straight down. Isocentre 100 cm from the X-ray target.' });

    // ---- beam: photon streaks from the target through a 10 × 10 cm field
    const r = rng(7);
    this.streaks = [];
    const half = g.field_mm[0] * 0.5e-3;
    for (let i = 0; i < N_PHOTONS; i++) {
      const tgt = new THREE.Vector3(iso.x + (r() * 2 - 1) * half, iso.y, iso.z + (r() * 2 - 1) * half);
      const dir = tgt.clone().sub(this.src).normalize();
      this.streaks.push({ dir, u: r() });
    }
    this.beamLen = 1.25; // metres from target, to just below the couch
    const a = new Float32Array(3 * N_PHOTONS), bb = new Float32Array(3 * N_PHOTONS);
    const col = new Float32Array(3 * N_PHOTONS).fill(0.55);
    for (let i = 0; i < N_PHOTONS; i++) { col[3 * i] = 0.62; col[3 * i + 1] = 0.78; col[3 * i + 2] = 1.0; }
    this.beam = new Ribbons({ a, b: bb, color: col, width: new Float32Array(N_PHOTONS).fill(0.0025) });
    this.offset.add(this.beam);
    this.fade(this.beam.material);
    this.beamA = a; this.beamB = bb;

    // ---- the chosen photon (its true incoming direction from the simulation)
    this.dirIn = new THREE.Vector3(...data.index.photon.dirIn).normalize();
    this.photon = new GlowPoints({ pos: new Float32Array(3), color: new Float32Array([1, 0.85, 0.55]), size: new Float32Array([0.02]), minAngle: 0.006 });
    this.offset.add(this.photon);
    this.fade(this.photon.material);
    this.photonTrail = new Ribbons({ a: new Float32Array(3), b: new Float32Array(3), color: new Float32Array([1, 0.8, 0.5]), width: new Float32Array([0.003]) });
    this.offset.add(this.photonTrail);
    this.fade(this.photonTrail.material);
    this.photonPos = new THREE.Vector3();
    const E0 = fmt(data.n.photonE0);
    this.pickables.push({ id: 'photon', hit: (ray) => sphereHit(this.photonPos, 0.14)(ray), label: `This photon: ${E0}, drawn from a published 6 MV spectrum.` });
    this.selected = false;
  }

  update(lt, ctx) {
    // Beam on 0–5 s, slows 5–11 s, stopped after 11 s.
    const speed = 1.6 * (1 - smooth((lt - 5) / 6));
    const dt = Math.min(ctx.dt, 0.05);
    for (let i = 0; i < this.streaks.length; i++) {
      const s = this.streaks[i];
      if (lt < 0.2) s.u = (s.u + 0) % 1;
      s.u = (s.u + speed * dt / this.beamLen) % 1;
      const d = s.u * this.beamLen;
      const len = 0.02 + 0.16 * Math.max(speed, 0) / 1.6;
      for (let q = 0; q < 3; q++) {
        const p0 = this.src.getComponent(q) + s.dir.getComponent(q) * d;
        this.beamA[3 * i + q] = p0;
        this.beamB[3 * i + q] = p0 + s.dir.getComponent(q) * len;
      }
    }
    this.beam.geometry.attributes.iA.needsUpdate = true;
    this.beam.geometry.attributes.iB.needsUpdate = true;
    const dim = ctx.selected ? 0.25 : 1;
    this.beam.material.uniforms.uOpacity.value = this.weight * (lt < 0 ? 0 : Math.min(1, lt * 2)) * dim;

    // Chosen photon: frozen 0.5 m up its path; glows from 10 s; travels after selection.
    const rem = photonRemaining(lt) * 1e-3;
    this.photonPos.copy(this.dirIn).multiplyScalar(-rem);
    this.photon.geometry.attributes.iPos.array.set([this.photonPos.x, this.photonPos.y, this.photonPos.z]);
    this.photon.geometry.attributes.iPos.needsUpdate = true;
    const glow = smooth((lt - 9.5) / 2.5);
    const pulse = ctx.selected ? 1 : 0.8 + 0.2 * Math.sin(ctx.time * 4);
    this.photon.material.uniforms.uOpacity.value = this.weight * glow * pulse;
    this.photon.material.uniforms.uMinAngle.value = 0.006 + 0.008 * glow * (ctx.selected ? 0.4 : 1);
    const src = this.src;
    this.photonTrail.geometry.attributes.iA.array.set([src.x, src.y, src.z]);
    this.photonTrail.geometry.attributes.iB.array.set([this.photonPos.x, this.photonPos.y, this.photonPos.z]);
    this.photonTrail.geometry.attributes.iA.needsUpdate = true;
    this.photonTrail.geometry.attributes.iB.needsUpdate = true;
    this.photonTrail.material.uniforms.uOpacity.value = this.weight * (ctx.selected ? 0.5 : 0);
  }
}
