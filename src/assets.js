// Optional baked models listed in index.json "models". Missing models fall
// back to the procedural placeholders inside each level.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export async function loadAssets(index, base = 'assets/models/') {
  const out = {};
  const models = index.models || {};
  if (!Object.keys(models).length) return out;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  await Promise.all(Object.entries(models).map(async ([name, file]) => {
    try {
      const gltf = await loader.loadAsync(base + file);
      out[name] = gltf.scene;
    } catch (e) {
      console.warn('model failed', name, e);
    }
  }));
  if (out.nucleosome) {
    // two meshes: histone core and DNA; used as instanced geometry
    const g = {};
    out.nucleosome.traverse((o) => { if (o.isMesh) g[o.name.startsWith('dna') ? 'dna' : 'core'] = o.geometry; });
    out.nucleosome = g.core && g.dna ? g : null;
  }
  return out;
}
