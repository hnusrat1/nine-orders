"""Export the patient meshes built by sim/anatomy.py as glTF.

  patient_body.glb   MakeHuman body surface, arms at the sides (CC0)
  pelvis_organs.glb  BodyParts3D bones and organs, decimated (CC BY-SA 2.1 JP;
                     this file stays under that licence)
Frame: mm, origin at the isocentre, +x patient left, +y anterior, +z inferior.
Run: python sim/art/anatomy_models.py
"""
import json, os
import numpy as np
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
W = os.path.join(HERE, "..", "work")
OUT = os.path.join(W, "art")
os.makedirs(OUT, exist_ok=True)
TARGET_TRIS = {"body": 14000, "hip_r": 3500, "hip_l": 3500, "sacrum": 2500, "l5": 1200, "femur_r": 2500, "femur_l": 2500,
               "bladder": 1800, "prostate": 900, "rectum": 1800}


def to_blender(V):
    # app (x, y_up, z) → Blender (x, -z, y); the glTF exporter converts back to y-up
    return np.c_[V[:, 0], -V[:, 2], V[:, 1]]


def make(name, V, F):
    me = bpy.data.meshes.new(name)
    me.from_pydata(to_blender(V).tolist(), [], F.tolist())
    me.validate()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.01)
    bpy.ops.object.mode_set(mode="OBJECT")
    n = len(o.data.polygons)
    t = TARGET_TRIS.get(name, 2000)
    if n > t:
        mod = o.modifiers.new("dec", "DECIMATE"); mod.ratio = t / n
        bpy.ops.object.modifier_apply(modifier="dec")
    for p in o.data.polygons:
        p.use_smooth = True
    m = bpy.data.materials.new(name + "_m")
    o.data.materials.append(m)
    o.select_set(False)
    return o


def export(objs, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_normals=True, export_texcoords=False,
                              export_materials="PLACEHOLDER", export_apply=True)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    A = np.load(os.path.join(W, "anatomy.npz"))
    meta = json.load(open(os.path.join(W, "anatomy.json")))
    body = make("body", A["body_V"], A["body_F"])
    export([body], os.path.join(OUT, "patient_body.glb"))
    organs = [make(k, A[f"{k}_V"], A[f"{k}_F"]) for k in meta]
    export(organs, os.path.join(OUT, "pelvis_organs.glb"))
    for o in [body] + organs:
        print(f"{o.name:10s} {len(o.data.polygons):6d} faces")


main()
