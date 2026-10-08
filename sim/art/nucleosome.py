"""Nucleosome surface meshes from PDB 1KX5 (Davey et al. 2002).

Gaussian density of the heavy atoms (histone octamer and DNA separately),
iso-surface by marching cubes, decimated in Blender. Coordinates are the
1KX5 coordinates as distributed in the nucleosome reference frame (pynucl,
1KX5_NRF.pdb), in nm — the same frame sim/dnamap.py places nucleosomes in.
Output: sim/work/art/nucleosome.glb with meshes "core" and "dna".
"""
import os, sys
import numpy as np
from skimage.measure import marching_cubes
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from bdna import read_pdb  # noqa: E402

OUT = os.path.join(HERE, "..", "work", "art")
SPACING, SIGMA, LEVEL = 0.15, 0.22, 0.35
TARGET = {"core": 800, "dna": 900}


def surface(P):
    lo, hi = P.min(0) - 1.0, P.max(0) + 1.0
    n = np.ceil((hi - lo) / SPACING).astype(int) + 1
    G = np.zeros(n, np.float32)
    r = int(np.ceil(3 * SIGMA / SPACING))
    off = np.arange(-r, r + 1)
    ox, oy, oz = np.meshgrid(off, off, off, indexing="ij")
    for p in P:
        c = np.round((p - lo) / SPACING).astype(int)
        gx, gy, gz = c[0] + ox, c[1] + oy, c[2] + oz
        d2 = ((lo[0] + gx * SPACING - p[0]) ** 2 + (lo[1] + gy * SPACING - p[1]) ** 2 + (lo[2] + gz * SPACING - p[2]) ** 2)
        m = (gx >= 0) & (gy >= 0) & (gz >= 0) & (gx < n[0]) & (gy < n[1]) & (gz < n[2])
        np.add.at(G, (gx[m], gy[m], gz[m]), np.exp(-d2[m] / (2 * SIGMA ** 2)))
    v, f, _, _ = marching_cubes(G, LEVEL, spacing=(SPACING,) * 3)
    return v + lo, f[:, ::-1]


def make(name, V, F):
    me = bpy.data.meshes.new(name)
    me.from_pydata(np.c_[V[:, 0], -V[:, 2], V[:, 1]].tolist(), [], F.tolist())
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    mod = o.modifiers.new("dec", "DECIMATE"); mod.ratio = TARGET[name] / len(F)
    bpy.ops.object.modifier_apply(modifier="dec")
    for p in o.data.polygons:
        p.use_smooth = True
    o.data.materials.append(bpy.data.materials.new(name + "_m"))
    return o


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    A = read_pdb(os.path.join(HERE, "..", "inputs", "1KX5_NRF.pdb"))
    hist = np.array([a["xyz"] for a in A if a["chain"] in "ABCDEFGH" and a["res"] not in ("MN", "CL")])
    dna = np.array([a["xyz"] for a in A if a["chain"] in "IJ" and a["res"] in ("DA", "DT", "DG", "DC")])
    objs = []
    for name, P in (("core", hist), ("dna", dna)):
        V, F = surface(P)
        objs.append(make(name, V, F))
        print(name, len(P), "atoms →", len(objs[-1].data.polygons), "faces")
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "nucleosome.glb"), export_format="GLB", use_selection=True, export_normals=True,
                              export_texcoords=False, export_materials="PLACEHOLDER")


main()
