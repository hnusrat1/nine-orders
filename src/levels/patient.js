// Level 2 — patient, 10 cm. Units: mm, origin at the Compton interaction point.
import * as THREE from 'three';
import { Level, sphereHit, meshHit } from '../level.js';
import { Ribbons, GlowPoints, fresnelMaterial, polylineSegments, concatSegments } from '../gfx.js';
import { trackSegments } from '../tracks.js';
import { Callout } from '../hud.js';
import { fmt } from '../data.js';
import { smooth } from '../journey.js';
import { photonRemaining, PHOTON_T1 } from './shared.js';

const C_MM_PER_NS = 299.792458;
export const COMPTON_LT = PHOTON_T1 - 24; // level-local time of the interaction (20 s)
const ELECTRON_SHOW = 10;                  // seconds of story time to replay the electron track

export class PatientLevel extends Level {
  constructor(def, data, assets) {
    super(def);
    const ix = data.index, n = data.n;
    this.dirIn = new THREE.Vector3(...ix.photon.dirIn).normalize();
    this.dirOut = new THREE.Vector3(...ix.photon.dirOut).normalize();
    this.src = new THREE.Vector3(...ix.geometry.source_mm);

    // ---- anatomy: translucent rim-lit surfaces
    const anat = new THREE.Group();
    this.offset.add(anat);
    if (assets.pelvis) {
      // BodyParts3D organs and bones (CC BY-SA) and the MakeHuman body surface, in the isocentre frame (mm)
      const iso = new THREE.Vector3(...ix.geometry.iso_mm);
      const add = (root, fallback) => {
        const m = root.clone();
        m.position.copy(iso);
        anat.add(m);
        m.traverse((o) => {
          if (!o.isMesh) return;
          const info = (ix.anatomy || []).find((a) => o.name === a.id || o.name.startsWith(a.id)) || fallback;
          const bone = /hip|femur|sacrum|l5/.test(info.id || '');
          o.material = fresnelMaterial({ color: info.color, rim: info.rim ?? (bone ? 2.4 : 1.8), base: info.base ?? (info.id === 'prostate' ? 0.1 : 0.025),
            strength: info.strength ?? (bone ? 0.55 : 0.85), side: THREE.FrontSide });
          this.fade(o.material);
          this.pickables.push({ hit: meshHit(o), label: info.label, priority: info.id === 'body' ? 0 : 0.5 });
        });
      };
      add(assets.pelvis, { id: 'organ', color: '#9fb4c8', label: 'Pelvic anatomy (BodyParts3D)' });
      if (assets.body) add(assets.body, { id: 'body', color: '#7f9fb8', label: 'Body surface (MakeHuman)', rim: 2.8, strength: 0.55 });
    } else {
      for (const a of ix.anatomy) {
        const geo = new THREE.SphereGeometry(1, 40, 24);
        const mesh = new THREE.Mesh(geo, fresnelMaterial({ color: a.color, rim: a.rim ?? 2.0, base: a.base ?? 0.03, strength: a.strength ?? 0.9, side: THREE.DoubleSide }));
        mesh.position.fromArray(a.center_mm);
        mesh.scale.fromArray(a.radii_mm);
        anat.add(mesh);
        this.fade(mesh.material);
        const r = Math.max(...a.radii_mm) * 0.8;
        if (a.id !== 'body') this.pickables.push({ hit: sphereHit(new THREE.Vector3(...a.center_mm), r), priority: 0.5, label: a.label });
      }
    }

    // ---- incoming photon path (source → interaction) and the photon itself
    this.inPath = new Ribbons(polylineSegments([this.src.toArray(), [0, 0, 0]], [0, 1], [1, 0.82, 0.55], 0.6));
    this.offset.add(this.inPath);
    this.photon = new GlowPoints({ pos: new Float32Array(3), color: new Float32Array([1, 0.85, 0.55]), size: new Float32Array([2.5]), minAngle: 0.012 });
    this.offset.add(this.photon);
    this.fade(this.photon.material);
    this.photonPos = new THREE.Vector3();

    // ---- scattered photon leaving the interaction
    this.outLen = 400;
    this.outPath = new Ribbons(polylineSegments([[0, 0, 0], this.dirOut.clone().multiplyScalar(this.outLen).toArray()], [0, this.outLen], [1, 0.82, 0.55], 0.45));
    this.offset.add(this.outPath);
    this.outPhoton = new GlowPoints({ pos: new Float32Array(3), color: new Float32Array([1, 0.85, 0.55]), size: new Float32Array([1.6]), minAngle: 0.009 });
    this.offset.add(this.outPhoton);

    // ---- interaction flash
    this.flash = new GlowPoints({ pos: new Float32Array(3), color: new Float32Array([1, 1, 1]), size: new Float32Array([6]), minAngle: 0.03 });
    this.offset.add(this.flash);

    // ---- recoil electron and its secondaries (condensed-history steps, Geant4 option4)
    const set = data.sets.patientElectron;
    this.eTmax = 0;
    for (let i = 0; i < set.count; i++) if (set.track[i] === 0) this.eTmax = Math.max(this.eTmax, set.time[i]);
    const segs = trackSegments(set, {
      width: (tr) => (tr === 0 ? 0.06 : 0.03),
      color: (tr) => (tr === 0 ? [0.45, 0.85, 1.0] : [0.35, 0.55, 0.9]),
    });
    this.eTrack = new Ribbons({ ...segs, minAngle: 0.0016 });
    this.offset.add(this.eTrack);
    this.pickables.push({ hit: sphereHit(new THREE.Vector3(), 2.5), label: `Compton scattering: the ${fmt(n.photonE0)} photon gives ${fmt(n.electronE0)} to an electron and continues with ${fmt(n.photonE1)}.` });

    // ---- callout with the energies at the interaction
    this.callout = new Callout({ lines: 3, height: 0.234 });
    this.callout.mesh.position.set(0.36, 0.196, 0);
    this.callout.set('Compton scattering', [
      ['photon in', fmt(n.photonE0)],
      ['photon out', `${fmt(n.photonE1)}  at ${fmt(n.photonAngle)}`],
      ['electron', fmt(n.electronE0)],
    ]);
    this.ui.add(this.callout.mesh);
  }

  update(lt, ctx) {
    const w = this.weight;
    // incoming photon
    const rem = photonRemaining(lt + 24);
    this.photonPos.copy(this.dirIn).multiplyScalar(-rem);
    const before = lt < COMPTON_LT;
    this.photon.geometry.attributes.iPos.array.set(this.photonPos.toArray());
    this.photon.geometry.attributes.iPos.needsUpdate = true;
    this.photon.material.uniforms.uOpacity.value = before ? w : 0;
    // the path drawn so far: from where the photon entered view (the source) to its current position
    const srcDist = this.src.length();
    this.inPath.material.uniforms.uReveal.value = 1 - rem / srcDist;
    this.inPath.material.uniforms.uOpacity.value = w * 0.55;

    // scattered photon and electron replay, in physical time (ns)
    const tl = lt - COMPTON_LT;
    const tPhys = tl > 0 ? (tl / ELECTRON_SHOW) * this.eTmax : -1;
    const outD = Math.min(this.outLen, Math.max(0, tPhys * C_MM_PER_NS));
    this.outPath.material.uniforms.uReveal.value = outD;
    this.outPath.material.uniforms.uOpacity.value = tl > 0 ? w * 0.5 : 0;
    this.outPhoton.geometry.attributes.iPos.array.set(this.dirOut.clone().multiplyScalar(outD).toArray());
    this.outPhoton.geometry.attributes.iPos.needsUpdate = true;
    this.outPhoton.material.uniforms.uOpacity.value = tl > 0 && outD < this.outLen ? w : 0;
    this.eTrack.material.uniforms.uReveal.value = tPhys;
    this.eTrack.material.uniforms.uOpacity.value = w;
    const fl = tl > 0 ? Math.exp(-tl * 1.5) : 0;
    this.flash.material.uniforms.uOpacity.value = w * fl;
    this.callout.opacity = w * smooth((tl - 0.6) / 0.8);
  }
}
