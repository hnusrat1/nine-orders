// Level 2 — patient, 10 cm. Units: mm, origin at the Compton interaction point.
import * as THREE from 'three';
import { Level, sphereHit, meshHit } from '../level.js';
import { Ribbons, GlowPoints, fresnelMaterial, polylineSegments, concatSegments, solidMaterial, fieldVolume } from '../gfx.js';
import { clipMaterial, CLIP, CLIP_GLSL } from '../clip.js';
import { trackSegments } from '../tracks.js';
import { Callout } from '../hud.js';
import { fmt } from '../data.js';
import { smooth } from '../journey.js';
import { photonRemaining, PHOTON_T1 } from './shared.js';

const C_MM_PER_NS = 299.792458;
export const COMPTON_LT = PHOTON_T1 - 24; // level-local time of the interaction (20 s)
const ELECTRON_SHOW = 10;                  // seconds of story time to replay the electron track

// How each structure looks: colour, roughness, opacity facing you and at the rim, draw order.
const ANATOMY_LOOK = {
  bone: { color: 0xe4d6bb, rough: 0.55, face: 0.95, rim: 1.0, order: 1, depthWrite: true },
  prostate: { color: 0xc9545f, rough: 0.42, face: 0.92, rim: 1.0, order: 2, depthWrite: true, glow: 0x5a1a1e },
  bladder: { color: 0xd8b85e, rough: 0.25, face: 0.42, rim: 0.85, order: 2, depthWrite: false },
  rectum: { color: 0xaf7868, rough: 0.5, face: 0.78, rim: 0.95, order: 2, depthWrite: true },
  organ: { color: 0xb08a80, rough: 0.5, face: 0.8, rim: 0.95, order: 2, depthWrite: true },
};

function anatomyMaterial(look) {
  const m = clipMaterial(new THREE.MeshStandardMaterial({ color: look.color, roughness: look.rough, metalness: 0, transparent: true,
    depthWrite: look.depthWrite, emissive: look.glow ?? 0x000000, envMapIntensity: look.env ?? 0.5 }));
  m.userData.programKey = 'anat';
  m.userData.extraCompile = (sh) => {
    sh.uniforms.uFace = { value: look.face }; sh.uniforms.uRim = { value: look.rim };
    sh.fragmentShader = 'uniform float uFace, uRim;\n' + sh.fragmentShader.replace('#include <premultiplied_alpha_fragment>', `{
        float fr = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.2);
        gl_FragColor.a *= mix(uFace, uRim, fr);
        gl_FragColor.rgb += vec3(0.9, 0.95, 1.0) * fr * 0.08;
      }
      #include <premultiplied_alpha_fragment>`);
  };
  return m;
}

// CT grey (red channel) and relative dose (green) on one texture; dose as a colour wash with isodose lines.
function doseSlice(set, sl) {
  const w = sl.width, h = sl.height, px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[4 * i] = set.ct[i]; px[4 * i + 1] = set.dose[i]; px[4 * i + 3] = 255; }
  const tex = new THREE.DataTexture(px, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  return new THREE.ShaderMaterial({
    uniforms: { ...CLIP, uTex: { value: tex }, uOpacity: { value: 1 }, uDose: { value: 0 }, uTexel: { value: new THREE.Vector2(w, h) } },
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vW;
      void main() { vUv = uv; vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uTex; uniform float uOpacity, uDose; uniform vec2 uTexel;
      varying vec2 vUv; varying vec3 vW;
      ${CLIP_GLSL}
      vec3 wash(float t) { return clamp(vec3(1.5 - abs(4.0 * t - 3.0), 1.5 - abs(4.0 * t - 2.0), 1.5 - abs(4.0 * t - 1.0)), 0.0, 1.0); }
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec4 s = texture2D(uTex, vUv);
        float ct = s.r, d = s.g;
        float edge = smoothstep(0.08, 0.3, ct);                   // air: the slice shows the body only
        if (edge < 0.01) discard;
        float grain = (hash(floor(vUv * uTexel * 2.0)) - 0.5) * 0.025; // a little CT-like grain
        vec3 col = vec3(clamp(ct * 0.95 + grain, 0.0, 1.0));
        float a = smoothstep(0.3, 0.6, d) * 0.42 * uDose;           // wash: only where the dose is high
        col = mix(col, wash(d), a);
        float lines = 0.0, fw = fwidth(d) * 0.9 + 1e-4;
        for (int i = 0; i < 3; i++) {                                // isodose lines: 50, 70, 90 %
          float L = 0.5 + 0.2 * float(i);
          lines = max(lines, 1.0 - smoothstep(0.0, fw, abs(d - L)));
        }
        col = mix(col, wash(d) * 1.1, lines * 0.7 * uDose);
        float alpha = uOpacity * clipFade(vW) * edge * 0.75;
        if (alpha < 0.01) discard;
        gl_FragColor = sRGBTransferEOTF(vec4(col, alpha));
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

// 6e6 → "6 million", 3.76e13 → "4 × 10¹³"
function fmtSci(entry) {
  if (!entry) return '?';
  const v = entry.value, e = Math.floor(Math.log10(v)), m = Math.round(v / 10 ** e);
  if (e === 6) return `${m} million`;
  return `${m} × 10${String(e).split('').map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+c]).join('')}`;
}

export class PatientLevel extends Level {
  constructor(def, data, assets) {
    super(def);
    const ix = data.index, n = data.n;
    this.dirIn = new THREE.Vector3(...ix.photon.dirIn).normalize();
    this.dirOut = new THREE.Vector3(...ix.photon.dirOut).normalize();
    this.src = new THREE.Vector3(...ix.geometry.source_mm);

    // ---- anatomy: lit like an anatomy model: ivory bone, the organs in tissue colours, a glassy skin shell
    const anat = new THREE.Group();
    this.offset.add(anat);
    this.anatMats = [];
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
          if (info.id === 'body') {
            // the skin as a glassy shell: additive rim light only, so it never darkens what is inside
            o.material = fresnelMaterial({ color: 0xe0b8a2, rim: 2.6, base: 0.0, strength: 0.4 });
            o.renderOrder = 6;
          } else {
            const look = ANATOMY_LOOK[bone ? 'bone' : info.id] || ANATOMY_LOOK.organ;
            o.material = anatomyMaterial(look);
            o.renderOrder = look.order;
            this.anatMats.push(o.material);
          }
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

    // ---- the couch top under the patient (carbon fibre, as in the room)
    const ct = ix.geometry.couchTop_mm, iso = new THREE.Vector3(...ix.geometry.iso_mm);
    const couch = new THREE.Mesh(new THREE.BoxGeometry(530, 50, 900), solidMaterial({ color: 0x15171a, roughness: 0.45 }));
    couch.position.set(iso.x, ct - 25, iso.z + 60);
    this.offset.add(couch); this.fade(couch.material);

    // ---- CT-style slices of the simulation's voxel phantom through the interaction point,
    // with the dose of the whole 10 × 10 cm field from the Geant4 dose run as a colour wash
    this.slices = [];
    if (data.sets.sliceAxial && ix.slices) {
      for (const [key, set] of [['axial', data.sets.sliceAxial], ['sagittal', data.sets.sliceSagittal]]) {
        const sl = ix.slices[key];
        const m = doseSlice(set, sl);
        const g = new THREE.PlaneGeometry(sl.size_mm[0], sl.size_mm[1]);
        const mesh = new THREE.Mesh(g, m);
        const cx = sl.min_mm[0] + sl.size_mm[0] / 2, cy = sl.min_mm[1] + sl.size_mm[1] / 2;
        if (key === 'axial') mesh.position.set(cx, cy, sl.at_mm);
        else { mesh.position.set(sl.at_mm, cy, cx); mesh.rotation.y = -Math.PI / 2; }
        mesh.renderOrder = 3;
        this.offset.add(mesh);
        m.userData.normal = key === 'axial' ? 'z' : 'x';
        this.slices.push(m);
        this.pickables.push({ hit: meshHit(mesh), priority: 0.4,
          label: `${key === 'axial' ? 'Axial' : 'Sagittal'} slice through the voxel phantom the simulation used (2.5 mm voxels), with the dose of this 6 MV 10 × 10 cm beam from ${fmtSci(n.dosePhotons)} simulated photons. Dose peaks ${fmt(n.dmaxDepth)} under the skin.` });
      }
    }

    // ---- the treatment field: a faint volume of light, 10 × 10 cm at the isocentre, diverging from the target
    this._v = new THREE.Vector3(); this._q = new THREE.Quaternion();
    const fv = fieldVolume(new THREE.Vector3(...ix.geometry.source_mm), iso, ix.geometry.field_mm[0] / 2, iso.y + 260, iso.y - 200, 0.5);
    this.field = fv.volume; this.fieldEdges = fv.edges;
    this.offset.add(this.field, this.fieldEdges);

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
    // the dose wash comes up after the interaction, with the narration
    const dose = smooth((lt - 25) / 3);
    // show the slice that faces you: axial when you look along the body, sagittal from the side
    let face = 0.5;
    if (ctx.camPos) {
      this._v.copy(ctx.camPos).sub(this.root.position).applyQuaternion(this._q.copy(this.root.quaternion).invert());
      face = smooth((Math.abs(this._v.z) / (Math.abs(this._v.x) + Math.abs(this._v.z) + 1e-6) - 0.35) / 0.3);
    }
    for (const m of this.slices) {
      m.uniforms.uOpacity.value = w * 0.9 * (m.userData.normal === 'z' ? face : 1 - face);
      m.uniforms.uDose.value = dose;
    }
    this.field.material.uniforms.uOpacity.value = w;
    this.fieldEdges.material.uniforms.uOpacity.value = w * 0.35;
  }

  setEnv(env) { for (const m of this.anatMats) { m.envMap = env; m.needsUpdate = true; } }
}
