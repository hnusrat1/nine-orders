// Diorama bubble. Level content fades out with distance from the anchor and
// close to the eye, so in VR each scale sits in front of you as a bounded model
// instead of a world that wraps around (and through) your head. On desktop the
// bubble is wide enough to act only as depth haze.
import * as THREE from 'three';

export const CLIP = {
  uClipC: { value: new THREE.Vector3() },               // bubble centre (the anchor), display metres
  uClipR: { value: new THREE.Vector2(1.4, 3.2) },       // fully visible inside x, gone beyond y
  uNear: { value: new THREE.Vector2(0.1, 0.26) },       // gone nearer than x to the eye, fully visible beyond y
};

export const CLIP_VR = { r: [0.34, 0.62], near: [0.1, 0.26] };
export const CLIP_DESKTOP = { r: [1.4, 3.2], near: [0.16, 0.45] };

export function setClip(centre, cfg) {
  CLIP.uClipC.value.copy(centre);
  CLIP.uClipR.value.set(cfg.r[0], cfg.r[1]);
  CLIP.uNear.value.set(cfg.near[0], cfg.near[1]);
}

// GLSL: fade factor for a world-space point (cameraPosition is a three.js built-in uniform).
export const CLIP_GLSL = /* glsl */`
  uniform vec3 uClipC; uniform vec2 uClipR; uniform vec2 uNear;
  float clipFade(vec3 wp) {
    float b = 1.0 - smoothstep(uClipR.x, uClipR.y, distance(wp, uClipC));
    float n = smoothstep(uNear.x, uNear.y, distance(wp, cameraPosition));
    return b * n;
  }`;

// Add the bubble to a built-in material (MeshStandardMaterial, MeshBasicMaterial).
// The fade scales alpha, so the material must be transparent.
export function clipMaterial(m) {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, CLIP);
    sh.vertexShader = 'varying vec3 vClipW;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      {
        vec4 cw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cw = instanceMatrix * cw;
        #endif
        vClipW = (modelMatrix * cw).xyz;
      }`);
    sh.fragmentShader = 'varying vec3 vClipW;\n' + CLIP_GLSL + '\n' + sh.fragmentShader.replace('#include <premultiplied_alpha_fragment>', `{
        float cf = clipFade(vClipW);
        if (cf < 0.01) discard;
        gl_FragColor.a *= cf;
      }
      #include <premultiplied_alpha_fragment>`);
  };
  m.customProgramCacheKey = () => 'clip';
  return m;
}
