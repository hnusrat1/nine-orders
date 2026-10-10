// Level 1 — treatment room, 1 m. Units: metres, origin at the Compton point.
import * as THREE from 'three';
import { Level, sphereHit, meshHit } from '../level.js';
import { Ribbons, GlowPoints, solidMaterial, textSprite, fieldVolume } from '../gfx.js';
import { clipMaterial, setClip } from '../clip.js';
import { Batch, rng } from '../build.js';
import { fmt } from '../data.js';
import { smooth, levelScale } from '../journey.js';
import { photonRemaining } from './shared.js';

const N_PHOTONS = 240;

// Surface finish per baked material: roughness, and how strongly it mirrors the room.
const ROOM_FINISH = {
  default: { rough: 0.6, env: 0.25 },
  floor: { rough: 0.3, env: 0.9 }, floorInlay: { rough: 0.35, env: 0.8 }, wall: { rough: 0.85, env: 0.15 }, wood: { rough: 0.45, env: 0.5 },
  ceiling: { rough: 0.95, env: 0.05 }, sky: { rough: 1, env: 0 }, downlight: { rough: 1, env: 0 }, cove: { rough: 1, env: 0 },
  lightTrim: { rough: 0.4, env: 0.4 }, shell: { rough: 0.2, env: 1.0 }, shellGrey: { rough: 0.3, env: 0.8 }, accent: { rough: 0.25, env: 0.9 },
  dark: { rough: 0.35, env: 0.7 }, glass: { rough: 0.05, env: 1.2 }, metal: { rough: 0.3, env: 1.0 }, couchTop: { rough: 0.4, env: 0.7 },
  couchFrame: { rough: 0.25, env: 0.9 }, foam: { rough: 0.9, env: 0.1 }, sheet: { rough: 0.95, env: 0.05 }, cabinet: { rough: 0.4, env: 0.6 },
  red: { rough: 0.3, env: 0.8 }, yellow: { rough: 0.4, env: 0.6 }, maze: { rough: 0.9, env: 0.1 },
};
const ROOM_EXPOSURE = 0.75 * Math.pow(2, 1.3); // the atlas is baked 1.3 stops down (sim/art/room.py BAKE_EXPOSURE)

// Skin, lit by the room's reflections, with the linac's light field (the 10 × 10 cm field and
// its crosshair, projected from the target) and the green alignment lasers falling on it.
function skinMaterial(bodyToRoom, src, iso) {
  const m = clipMaterial(new THREE.MeshStandardMaterial({ color: 0xc79a82, roughness: 0.55, metalness: 0, envMapIntensity: 0.9, transparent: true }));
  m.userData.programKey = 'skin';
  m.userData.extraCompile = (sh) => {
    sh.uniforms.uBodyToRoom = { value: bodyToRoom };
    sh.uniforms.uSrc = { value: src.clone() };
    sh.uniforms.uIso = { value: iso.clone() };
    sh.uniforms.uField = { value: 0.0 };
    sh.uniforms.uLaser = { value: 1.0 };
    m.userData.shader = sh;
    sh.vertexShader = 'uniform mat4 uBodyToRoom; varying vec3 vRoom; varying vec3 vRoomN;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      vRoom = (uBodyToRoom * vec4(transformed, 1.0)).xyz;
      vRoomN = normalize(mat3(uBodyToRoom) * objectNormal);`);
    sh.fragmentShader = 'uniform vec3 uSrc, uIso; uniform float uField, uLaser; varying vec3 vRoom; varying vec3 vRoomN;\n'
      + sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        vec3 n = normalize(vRoomN);
        // light field: project this point from the target onto the isocentre plane
        vec3 d = vRoom - uSrc;
        float t = (uIso.y - uSrc.y) / d.y;
        vec2 q = vec2(uSrc.x + d.x * t - uIso.x, uSrc.z + d.z * t - uIso.z);
        float aa = max(fwidth(q.x), fwidth(q.y)) * 1.5;
        float inside = (1.0 - smoothstep(0.05 - aa, 0.05 + aa, abs(q.x))) * (1.0 - smoothstep(0.05 - aa, 0.05 + aa, abs(q.y)));
        float hair = min(smoothstep(0.0007, 0.0007 + aa, abs(q.x)), smoothstep(0.0007, 0.0007 + aa, abs(q.y)));
        float facing = max(dot(n, -normalize(d)), 0.0);
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.93, 0.78) * (uField * 1.6 * inside * hair * facing);
        // lasers: the three planes through the isocentre
        vec3 r = vRoom - uIso;
        float w = 0.0007;
        float ls = 1.0 - smoothstep(w, w + fwidth(r.x) * 1.5, abs(r.x));
        float lh = 1.0 - smoothstep(w, w + fwidth(r.y) * 1.5, abs(r.y));
        float lc = 1.0 - smoothstep(w, w + fwidth(r.z) * 1.5, abs(r.z));
        float laser = max(ls * max(n.y, 0.0), max(lh * abs(n.x), lc));
        totalEmissiveRadiance += vec3(0.15, 1.0, 0.35) * laser * uLaser * 1.4;
      }`);
  };
  return m;
}

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
      // Room, linac and couch with lighting baked in Blender (sim/art/room.py). The bake is
      // drawn as emission; reflections of the room itself (captured at load, see
      // buildReflections) give glossy surfaces their sheen as you move.
      const m = assets.room.clone();
      m.position.set(iso.x, floorY, iso.z);
      this.roomMats = [];
      m.traverse((o) => {
        if (!o.isMesh) return;
        const name = (o.material.name || '').replace(/\.\d+$/, '');
        if (/laser/i.test(o.name) || name === 'laser') { // alignment lasers: pure emissive light
          const lm = clipMaterial(new THREE.MeshBasicMaterial({ color: 0x22c95e, toneMapped: false, transparent: true }));
          o.material = lm; this.fade(lm); return;
        }
        if (name === 'screen') { // in-room monitors: their own display image
          const sm = clipMaterial(new THREE.MeshBasicMaterial({ map: o.material.map, color: 0x9aa4b0, toneMapped: false, transparent: true }));
          o.material = sm; this.fade(sm); return;
        }
        if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); // lit materials need normals
        const f = ROOM_FINISH[name] || ROOM_FINISH.default;
        const mat = clipMaterial(new THREE.MeshStandardMaterial({
          color: 0x000000, emissive: 0xffffff, emissiveMap: o.material.map, emissiveIntensity: ROOM_EXPOSURE,
          roughness: f.rough, metalness: 0, envMapIntensity: f.env, transparent: true,
        }));
        o.material = mat;
        this.roomMats.push(mat);
        this.fade(mat);
      });
      content.add(m);
      this.roomMesh = m;
      if (assets.body) {
        const body = assets.body.clone();
        body.scale.setScalar(1e-3);
        body.position.copy(iso);
        body.updateMatrixWorld(true);
        let bodyMesh = null;
        body.traverse((o) => { if (o.isMesh && !bodyMesh) bodyMesh = o; });
        const bm = skinMaterial(bodyMesh.matrixWorld.clone(), this.src, iso); // mesh → room coordinates
        body.traverse((o) => { if (o.isMesh) o.material = bm; });
        this.skin = bm;
        this.roomMats.push(bm);
        this.fade(bm);
        content.add(body);
        this.pickables.push({ hit: meshHit(body), priority: 0.5, label: 'The patient, lying on their back with the prostate at the isocentre. Body surface from MakeHuman (CC0).' });
      }
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
    this.pickables.push({ hit: meshHit(this.roomMesh), priority: 0, label: 'Treatment room: a generic medical linear accelerator at gantry 0°, beam pointing straight down. Isocentre 100 cm from the X-ray target.' });

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

    // ---- the light field: a faint pyramid of light from the collimator to the patient
    {
      const fv = fieldVolume(this.src, iso, g.field_mm[0] * 0.5e-3, iso.y + 0.4, iso.y + 0.08, 0.0006, 0.14);
      this.field = fv.volume; this.fieldEdges = fv.edges;
      content.add(this.field, this.fieldEdges);
    }

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

    // "this one": a pulsing ring and a prompt around the photon while we wait for the viewer
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.036, 0.041, 48), new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    this.ring.userData.billboard = true;
    this.ring.renderOrder = 12;
    this.prompt = textSprite('Pick this photon', { size: 0.032, color: '#ffd9a8', font: 500 });
    this.prompt.material.depthTest = false;
    this.prompt.userData.billboard = true;
    this.prompt.renderOrder = 12;
    this.ui.add(this.ring, this.prompt);
  }

  // Capture the room once from above the couch and use it as every room surface's
  // reflection (and the skin's ambient light), so the lighting all agrees.
  buildReflections(renderer) {
    if (!this.roomMats) return;
    const holder = this.roomMesh.parent, tmp = new THREE.Scene();
    tmp.add(this.roomMesh);
    const rt = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cam = new THREE.CubeCamera(0.05, 40, rt);
    cam.position.set(this.roomMesh.position.x, this.iso.y + 0.4, this.iso.z + 0.6);
    setClip(new THREE.Vector3(), { r: [1e4, 2e4], near: [0, 1e-4] });
    cam.update(renderer, tmp);
    holder.add(this.roomMesh);
    const pm = new THREE.PMREMGenerator(renderer);
    const env = pm.fromCubemap(rt.texture).texture;
    for (const m of this.roomMats) { m.envMap = env; m.needsUpdate = true; }
    rt.dispose(); pm.dispose();
    this.env = env;
  }

  update(lt, ctx) {
    // the light field shows the beam's shape on the skin once time has stopped
    const fieldOn = smooth((lt - 7) / 3);
    if (this.skin && this.skin.userData.shader) this.skin.userData.shader.uniforms.uField.value = 0.75 * fieldOn;
    this.field.material.uniforms.uOpacity.value = this.weight * fieldOn;
    this.fieldEdges.material.uniforms.uOpacity.value = this.weight * fieldOn * 0.3;
    const waiting = !ctx.selected && lt > 10.5;
    const ws = levelScale(this.unit, ctx.z ?? 0);
    // the ring sits in the (scaled) ui group: express the photon's display offset in its units
    const pd = this.photonPos.clone().sub(this.anchorShown || this.anchor).multiplyScalar(ws / this.uiScale);
    const ringPulse = 1 + 0.18 * Math.sin((ctx.time || 0) * 4);
    this.ring.position.copy(pd);
    this.ring.scale.setScalar(ringPulse);
    this.ring.material.opacity = waiting ? this.weight * smooth((lt - 10.5) / 1.5) : 0;
    this.ring.visible = this.ring.material.opacity > 0.01;
    this.prompt.position.copy(pd).add(new THREE.Vector3(0, 0.075, 0));
    this.prompt.material.opacity = this.ring.material.opacity;
    this.prompt.visible = this.ring.visible;

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
