// Shared GPU primitives. Everything here draws many items in one call:
// glow points (events), ribbons (tracks), impostor spheres (cells) and a rim-lit
// "fresnel" surface material for translucent anatomy.
import * as THREE from 'three';
import { CLIP, CLIP_GLSL, clipMaterial } from './clip.js';

// Minimum on-screen angular size (radians) so that physically tiny markers
// stay visible when zoomed out. Physical size wins whenever it is larger.
const MIN_ANGLE = 0.0022;

// Every level primitive fades with the diorama bubble (clip.js) unless built with clip: false.
const clipUniforms = (u) => ({ ...CLIP, ...u });
const clipDefines = (on) => (on ? { CLIP: 1 } : {});
const CLIP_DECL = /* glsl */`
  #ifdef CLIP
  ${CLIP_GLSL}
  #endif`;

const quad = (() => {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
})();

function instGeom(base, count) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.attributes.position = base.attributes.position;
  g.instanceCount = count;
  return g;
}

function setInst(g, name, arr, size) {
  g.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
}

// ---------------------------------------------------------------- GlowPoints
// items: {pos: Float32Array(3n), color: Float32Array(3n), size: Float32Array(n), birth: Float32Array(n)}
export class GlowPoints extends THREE.Mesh {
  constructor({ pos, color, size, birth, minAngle = MIN_ANGLE, flash = 0, core = 0.35, clip = true }) {
    const n = size.length;
    const g = instGeom(quad, n);
    setInst(g, 'iPos', pos, 3);
    setInst(g, 'iColor', color, 3);
    setInst(g, 'iSize', size, 1);
    setInst(g, 'iBirth', birth || new Float32Array(n), 1);
    const m = new THREE.ShaderMaterial({
      uniforms: clipUniforms({
        uReveal: { value: 1e9 }, uOpacity: { value: 1 }, uMinAngle: { value: minAngle },
        uFlash: { value: flash }, uCore: { value: core }, uTimeScale: { value: 1 },
      }),
      defines: clipDefines(clip),
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute vec3 iColor; attribute float iSize; attribute float iBirth;
        uniform float uReveal, uOpacity, uMinAngle, uFlash, uTimeScale;
        varying vec2 vUv; varying vec3 vColor; varying float vAlpha;
        ${CLIP_DECL}
        void main() {
          float age = (uReveal - iBirth) * uTimeScale;
          if (age < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float cf = 1.0;
          #ifdef CLIP
            cf = clipFade((modelMatrix * vec4(iPos, 1.0)).xyz);
            if (cf < 0.003) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          #endif
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          float sc = length(modelViewMatrix[0].xyz);
          float flash = 1.0 + uFlash * exp(-age * 2.5);
          float s = max(iSize * sc, uMinAngle * max(-mv.z, 0.01)) * flash;
          mv.xy += position.xy * s;
          vUv = position.xy; vColor = iColor * flash; vAlpha = uOpacity * cf;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uCore;
        varying vec2 vUv; varying vec3 vColor; varying float vAlpha;
        void main() {
          float r2 = dot(vUv, vUv);
          if (r2 > 1.0) discard;
          float a = exp(-r2 * 5.0) * 0.75 + smoothstep(uCore * uCore, 0.0, r2) * 0.6;
          gl_FragColor = sRGBTransferEOTF(vec4(vColor * a * vAlpha, 1.0)); // authored as display values
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    super(g, m);
    this.frustumCulled = false;
    this.count = n;
  }
  set reveal(v) { this.material.uniforms.uReveal.value = v; }
  set opacity(v) { this.material.uniforms.uOpacity.value = v; }
}

// ---------------------------------------------------------------- Ribbons
// segs: {a: Float32Array(3n), b: Float32Array(3n), color: Float32Array(3n), width: Float32Array(n), birth: Float32Array(2n)}
export class Ribbons extends THREE.Mesh {
  constructor({ a, b, color, width, birth, minAngle = MIN_ANGLE * 0.45, softness = 1.0, clip = true }) {
    const n = width.length;
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    base.setIndex([0, 1, 2, 0, 2, 3]);
    const g = instGeom(base, n);
    setInst(g, 'iA', a, 3);
    setInst(g, 'iB', b, 3);
    setInst(g, 'iColor', color, 3);
    setInst(g, 'iWidth', width, 1);
    setInst(g, 'iBirth', birth || new Float32Array(2 * n), 2);
    const m = new THREE.ShaderMaterial({
      uniforms: clipUniforms({ uReveal: { value: 1e9 }, uOpacity: { value: 1 }, uMinAngle: { value: minAngle }, uSoft: { value: softness } }),
      defines: clipDefines(clip),
      vertexShader: /* glsl */`
        attribute vec3 iA, iB, iColor; attribute float iWidth; attribute vec2 iBirth;
        uniform float uReveal, uOpacity, uMinAngle;
        varying float vY; varying vec3 vColor; varying float vAlpha;
        ${CLIP_DECL}
        void main() {
          float f = clamp((uReveal - iBirth.x) / max(iBirth.y - iBirth.x, 1e-6), 0.0, 1.0);
          if (uReveal < iBirth.x) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vec3 B = mix(iA, iB, f);
          vec4 ma = modelViewMatrix * vec4(iA, 1.0);
          vec4 mb = modelViewMatrix * vec4(B, 1.0);
          vec4 mp = mix(ma, mb, position.x);
          vec3 d = mb.xyz - ma.xyz;
          vec3 side = cross(d, mp.xyz);
          float L = length(side);
          side = L > 1e-12 ? side / L : vec3(0.0, 1.0, 0.0);
          float sc = length(modelViewMatrix[0].xyz);
          float w = max(iWidth * sc, uMinAngle * max(-mp.z, 0.01));
          mp.xyz += side * position.y * w;
          float cf = 1.0;
          #ifdef CLIP
            cf = clipFade((modelMatrix * vec4(mix(iA, B, position.x), 1.0)).xyz);
          #endif
          vY = position.y; vColor = iColor; vAlpha = uOpacity * cf;
          gl_Position = projectionMatrix * mp;
        }`,
      fragmentShader: /* glsl */`
        uniform float uSoft;
        varying float vY; varying vec3 vColor; varying float vAlpha;
        void main() {
          float a = 1.0 - pow(abs(vY), mix(8.0, 1.6, uSoft));
          gl_FragColor = sRGBTransferEOTF(vec4(vColor * a * vAlpha, 1.0)); // authored as display values
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    super(g, m);
    this.frustumCulled = false;
  }
  set reveal(v) { this.material.uniforms.uReveal.value = v; }
  set opacity(v) { this.material.uniforms.uOpacity.value = v; }
}

// Build ribbon segments from a polyline list. points: array of [x,y,z]; births: per point.
export function polylineSegments(points, births, color, width) {
  const n = Math.max(points.length - 1, 0);
  const a = new Float32Array(3 * n), b = new Float32Array(3 * n), c = new Float32Array(3 * n);
  const w = new Float32Array(n), br = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    a.set(points[i], 3 * i); b.set(points[i + 1], 3 * i); c.set(color, 3 * i);
    w[i] = width; br[2 * i] = births ? births[i] : 0; br[2 * i + 1] = births ? births[i + 1] : 0;
  }
  return { a, b, color: c, width: w, birth: br };
}

export function concatSegments(list) {
  const n = list.reduce((s, x) => s + x.width.length, 0);
  const out = { a: new Float32Array(3 * n), b: new Float32Array(3 * n), color: new Float32Array(3 * n), width: new Float32Array(n), birth: new Float32Array(2 * n) };
  let o = 0;
  for (const x of list) {
    const k = x.width.length;
    out.a.set(x.a, 3 * o); out.b.set(x.b, 3 * o); out.color.set(x.color, 3 * o);
    out.width.set(x.width, o); out.birth.set(x.birth, 2 * o); o += k;
  }
  return out;
}

// ---------------------------------------------------------------- Cell impostors
// Rim-lit spheres with an inner nucleus, faded by distance from the anchor (world space).
export class CellImpostors extends THREE.Mesh {
  constructor({ pos, radius, nucleus, tint, clip = true }) {
    const n = radius.length;
    const g = instGeom(quad, n);
    setInst(g, 'iPos', pos, 3);
    setInst(g, 'iRad', radius, 1);
    setInst(g, 'iNuc', nucleus, 1);
    setInst(g, 'iTint', tint, 1);
    const m = new THREE.ShaderMaterial({
      uniforms: clipUniforms({
        uOpacity: { value: 1 }, uAnchor: { value: new THREE.Vector3() }, uFadeR: { value: 2.0 },
        uMem: { value: new THREE.Color(0x6fa9c9) }, uNuc: { value: new THREE.Color(0x9a7fd6) }, uGain: { value: 1 },
      }),
      defines: clipDefines(clip),
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute float iRad, iNuc, iTint;
        uniform vec3 uAnchor; uniform float uFadeR, uOpacity;
        varying vec2 vUv; varying float vNuc, vAlpha, vTint;
        ${CLIP_DECL}
        void main() {
          vec4 wc = modelMatrix * vec4(iPos, 1.0);
          float d = distance(wc.xyz, uAnchor);
          float fade = 1.0 - smoothstep(0.45 * uFadeR, uFadeR, d);
          #ifdef CLIP
            fade *= clipFade(wc.xyz);
          #endif
          if (fade <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          float sc = length(modelViewMatrix[0].xyz);
          mv.xy += position.xy * iRad * sc;
          vUv = position.xy; vNuc = iNuc; vAlpha = fade * uOpacity; vTint = iTint;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uMem, uNuc; uniform float uGain;
        varying vec2 vUv; varying float vNuc, vAlpha, vTint;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        void main() {
          float r2 = dot(vUv, vUv);
          if (r2 > 1.0) discard;
          float z = sqrt(1.0 - r2);
          vec2 q = vUv / (1.0 + z) * 3.0 + vTint * 17.0;           // pseudo-spherical coordinates for texture
          float rim = pow(1.0 - z, 3.0);
          float mem = rim * (0.7 + 0.6 * noise(q * 4.0));           // uneven membrane
          vec3 col = uMem * (0.012 + 0.42 * mem + 0.035 * noise(q * 11.0)) * (0.75 + 0.5 * vTint);
          vec2 nc = vUv - vec2(0.08, -0.05) * vNuc;                  // nucleus slightly off-centre
          float rn2 = dot(nc, nc) / (vNuc * vNuc);
          if (rn2 < 1.0) {
            float zn = sqrt(1.0 - rn2);
            float chrom = 0.6 + 0.8 * noise(q * 9.0 + 3.1);          // chromatin texture
            col += uNuc * (0.05 + 0.34 * pow(1.0 - zn, 2.0)) * chrom;
            float nucleolus = smoothstep(0.32, 0.18, length(nc / vNuc - vec2(-0.25, 0.2)));
            col += uNuc * 0.12 * nucleolus;
          }
          gl_FragColor = sRGBTransferEOTF(vec4(col * vAlpha * uGain, 1.0)); // authored as display values
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    super(g, m);
    this.frustumCulled = false;
  }
  set opacity(v) { this.material.uniforms.uOpacity.value = v; }
}

// ---------------------------------------------------------------- Fresnel surfaces
export function fresnelMaterial({ color = 0x88aacc, rim = 2.2, base = 0.06, strength = 1.0, side = THREE.FrontSide, clip = true } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: clipUniforms({ uColor: { value: new THREE.Color(color) }, uOpacity: { value: 1 }, uRim: { value: rim }, uBase: { value: base }, uStrength: { value: strength } }),
    defines: clipDefines(clip),
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV; varying vec3 vTint; varying vec3 vClipW;
      void main() {
        vec4 p = vec4(position, 1.0);
        vec3 n = normal;
        vTint = vec3(1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
          n = mat3(instanceMatrix) * n;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vTint = instanceColor;
        #endif
        vec4 mv = modelViewMatrix * p;
        vClipW = (modelMatrix * p).xyz;
        vN = normalize(normalMatrix * n);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uOpacity, uRim, uBase, uStrength;
      varying vec3 vN; varying vec3 vV; varying vec3 vTint; varying vec3 vClipW;
      ${CLIP_DECL}
      void main() {
        float cf = 1.0;
        #ifdef CLIP
          cf = clipFade(vClipW);
          if (cf < 0.003) discard;
        #endif
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uRim);
        gl_FragColor = sRGBTransferEOTF(vec4(uColor * vTint * (uBase + f) * uStrength * uOpacity * cf, 1.0)); // authored as display values
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side,
  });
}

// Lit surface that can fade: transparent (with depth writes) so whole levels
// can cross-fade by opacity, and clipped to the diorama bubble.
export function solidMaterial(params) {
  return clipMaterial(new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.0, transparent: true, depthWrite: true, ...params }));
}

// Sprite-like text label rendered to a canvas, sized in display metres.
export function textSprite(text, { size = 0.05, color = '#e8edf2', bg = 'rgba(5,7,10,0.0)', font = 400 } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const px = 64;
  ctx.font = `${font} ${px}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  c.width = w; c.height = px + 24;
  ctx.font = `${font} ${px}px system-ui, sans-serif`;
  ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = color; ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size * c.width / c.height, size), mat);
  mesh.userData.canvas = c;
  return mesh;
}

export const EVENT_COLORS = {
  // Geant4-DNA process classes (see sim/README and assets/data/index.json "eventTypes")
  0: [0.35, 0.38, 0.42], // elastic scattering (no deposit)
  1: [0.35, 0.69, 1.0],  // electronic excitation
  2: [1.0, 0.62, 0.25],  // ionisation
  3: [0.70, 0.55, 1.0],  // vibrational excitation
  4: [0.45, 0.95, 0.55], // dissociative attachment
  5: [0.6, 0.6, 0.6],    // other / transport
  // condensed-history step points at patient/tissue scale
  10: [1.0, 0.62, 0.25], // eIoni / continuous loss step
  11: [0.55, 0.6, 0.66], // msc / transportation
  12: [1.0, 0.9, 0.5],   // bremsstrahlung
};
