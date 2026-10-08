// Shared GPU primitives. Everything here draws many items in one call:
// glow points (events), ribbons (tracks), impostor spheres (cells) and a rim-lit
// "fresnel" surface material for translucent anatomy.
import * as THREE from 'three';

// Minimum on-screen angular size (radians) so that physically tiny markers
// stay visible when zoomed out. Physical size wins whenever it is larger.
const MIN_ANGLE = 0.0022;

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
  constructor({ pos, color, size, birth, minAngle = MIN_ANGLE, flash = 0, core = 0.35 }) {
    const n = size.length;
    const g = instGeom(quad, n);
    setInst(g, 'iPos', pos, 3);
    setInst(g, 'iColor', color, 3);
    setInst(g, 'iSize', size, 1);
    setInst(g, 'iBirth', birth || new Float32Array(n), 1);
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uReveal: { value: 1e9 }, uOpacity: { value: 1 }, uMinAngle: { value: minAngle },
        uFlash: { value: flash }, uCore: { value: core }, uTimeScale: { value: 1 },
      },
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute vec3 iColor; attribute float iSize; attribute float iBirth;
        uniform float uReveal, uOpacity, uMinAngle, uFlash, uTimeScale;
        varying vec2 vUv; varying vec3 vColor; varying float vAlpha;
        void main() {
          float age = (uReveal - iBirth) * uTimeScale;
          if (age < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          float sc = length(modelViewMatrix[0].xyz);
          float flash = 1.0 + uFlash * exp(-age * 2.5);
          float s = max(iSize * sc, uMinAngle * max(-mv.z, 0.01)) * flash;
          mv.xy += position.xy * s;
          vUv = position.xy; vColor = iColor * flash; vAlpha = uOpacity;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uCore;
        varying vec2 vUv; varying vec3 vColor; varying float vAlpha;
        void main() {
          float r2 = dot(vUv, vUv);
          if (r2 > 1.0) discard;
          float a = exp(-r2 * 5.0) * 0.75 + smoothstep(uCore * uCore, 0.0, r2) * 0.6;
          gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
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
  constructor({ a, b, color, width, birth, minAngle = MIN_ANGLE * 0.45, softness = 1.0 }) {
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
      uniforms: { uReveal: { value: 1e9 }, uOpacity: { value: 1 }, uMinAngle: { value: minAngle }, uSoft: { value: softness } },
      vertexShader: /* glsl */`
        attribute vec3 iA, iB, iColor; attribute float iWidth; attribute vec2 iBirth;
        uniform float uReveal, uOpacity, uMinAngle;
        varying float vY; varying vec3 vColor; varying float vAlpha;
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
          vY = position.y; vColor = iColor; vAlpha = uOpacity;
          gl_Position = projectionMatrix * mp;
        }`,
      fragmentShader: /* glsl */`
        uniform float uSoft;
        varying float vY; varying vec3 vColor; varying float vAlpha;
        void main() {
          float a = 1.0 - pow(abs(vY), mix(8.0, 1.6, uSoft));
          gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
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
  constructor({ pos, radius, nucleus, tint }) {
    const n = radius.length;
    const g = instGeom(quad, n);
    setInst(g, 'iPos', pos, 3);
    setInst(g, 'iRad', radius, 1);
    setInst(g, 'iNuc', nucleus, 1);
    setInst(g, 'iTint', tint, 1);
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 1 }, uAnchor: { value: new THREE.Vector3() }, uFadeR: { value: 2.0 },
        uMem: { value: new THREE.Color(0x6fa9c9) }, uNuc: { value: new THREE.Color(0x9a7fd6) }, uGain: { value: 1 },
      },
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute float iRad, iNuc, iTint;
        uniform vec3 uAnchor; uniform float uFadeR, uOpacity;
        varying vec2 vUv; varying float vNuc, vAlpha, vTint;
        void main() {
          vec4 wc = modelMatrix * vec4(iPos, 1.0);
          float d = distance(wc.xyz, uAnchor);
          float fade = 1.0 - smoothstep(0.45 * uFadeR, uFadeR, d);
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
        void main() {
          float r2 = dot(vUv, vUv);
          if (r2 > 1.0) discard;
          float z = sqrt(1.0 - r2);
          float rim = pow(1.0 - z, 3.0);
          vec3 col = uMem * (0.015 + 0.42 * rim) * (0.75 + 0.5 * vTint);
          float rn2 = r2 / (vNuc * vNuc);
          if (rn2 < 1.0) {
            float zn = sqrt(1.0 - rn2);
            col += uNuc * (0.03 + 0.25 * pow(1.0 - zn, 2.0));
          }
          gl_FragColor = vec4(col * vAlpha * uGain, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    super(g, m);
    this.frustumCulled = false;
  }
  set opacity(v) { this.material.uniforms.uOpacity.value = v; }
}

// Dissolve (dithered) surfaces closer than `near` display metres to the eye, so
// nearby objects do not hide the particle at the anchor.
export function nearFade(material, near = 0.35) {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uNear = { value: near };
    sh.fragmentShader = 'uniform float uNear;\n' + sh.fragmentShader.replace('#include <alphahash_fragment>', `#include <alphahash_fragment>
      {
        float nd = vViewPosition.z; // vViewPosition = -mvPosition, so this is the distance in front of the eye
        float h = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
        if (nd < uNear && h > smoothstep(0.35 * uNear, uNear, nd)) discard;
      }`);
  };
  material.customProgramCacheKey = () => 'nearfade' + near;
  return material;
}

// ---------------------------------------------------------------- Fresnel surfaces
export function fresnelMaterial({ color = 0x88aacc, rim = 2.2, base = 0.06, strength = 1.0, side = THREE.FrontSide } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 1 }, uRim: { value: rim }, uBase: { value: base }, uStrength: { value: strength } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV; varying vec3 vTint;
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
        vN = normalize(normalMatrix * n);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uOpacity, uRim, uBase, uStrength;
      varying vec3 vN; varying vec3 vV; varying vec3 vTint;
      void main() {
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uRim);
        gl_FragColor = vec4(uColor * vTint * (uBase + f) * uStrength * uOpacity, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side,
  });
}

// Opaque lit material that can still fade (dithered alpha, no sorting).
export function solidMaterial(params) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.0, ...params });
  m.alphaHash = true;
  return m;
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
