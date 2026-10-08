// Background: a dark gradient dome tinted per scale, and slow drifting motes
// near the viewer that give parallax depth. Both cost one draw call each.
import * as THREE from 'three';
import { GlowPoints } from './gfx.js';
import { rng } from './build.js';

// Per-level tints (horizon, zenith), sRGB
const TINTS = {
  room: [0x0b0d10, 0x030405], patient: [0x08121c, 0x020407], tissue: [0x061318, 0x020507],
  cell: [0x0e0a1a, 0x030208], chromatin: [0x140d06, 0x040302], dna: [0x060c1a, 0x020306],
};

export class Ambient {
  constructor() {
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16), new THREE.ShaderMaterial({
      uniforms: { uLow: { value: new THREE.Color() }, uHigh: { value: new THREE.Color() } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 uLow, uHigh; varying vec3 vP;
        void main(){ float h = clamp(vP.y * 0.5 + 0.5, 0.0, 1.0); vec3 c = mix(uLow, uHigh, smoothstep(0.35, 1.0, h));
          c *= 0.75 + 0.25 * smoothstep(0.0, 0.5, h);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide, depthWrite: false,
    }));
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    const r = rng(99), n = 420;
    const pos = new Float32Array(3 * n), col = new Float32Array(3 * n), size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = r() * 2 - 1, th = r() * Math.PI * 2, rad = 0.6 + Math.pow(r(), 0.6) * 5.5;
      pos.set([Math.sqrt(1 - u * u) * Math.cos(th) * rad, u * rad * 0.6, Math.sqrt(1 - u * u) * Math.sin(th) * rad], 3 * i);
      const g = 0.05 + r() * 0.07;
      col.set([g, g * 1.05, g * 1.15], 3 * i);
      size[i] = 0.004 + r() * 0.006;
    }
    this.motes = new GlowPoints({ pos, color: col, size, minAngle: 0.0015, core: 0, clip: false });
    this.base = pos.slice();
    this.low = new THREE.Color(); this.high = new THREE.Color(); this.tmp = new THREE.Color();
  }

  addTo(scene) { scene.add(this.dome, this.motes); }

  update(levels, centre, time) {
    this.low.setRGB(0, 0, 0); this.high.setRGB(0, 0, 0);
    let wsum = 0;
    for (const L of levels) {
      if (L.weight <= 0) continue;
      const t = TINTS[L.id];
      this.low.add(this.tmp.setHex(t[0]).multiplyScalar(L.weight));
      this.high.add(this.tmp.setHex(t[1]).multiplyScalar(L.weight));
      wsum += L.weight;
    }
    if (wsum > 0) { this.low.multiplyScalar(1 / wsum); this.high.multiplyScalar(1 / wsum); }
    this.dome.material.uniforms.uLow.value.copy(this.low);
    this.dome.material.uniforms.uHigh.value.copy(this.high);
    this.dome.position.copy(centre);
    this.motes.position.copy(centre);
    this.motes.rotation.y = time * 0.004;
  }
}
