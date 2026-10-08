"""Generic treatment room and linear accelerator, modelled in headless Blender.

Run: python sim/art/room.py   (needs `pip install bpy`, Blender 4.x/5.x as a module)
Output: sim/work/art/room.glb (then compressed by sim/art/pack.sh)

Frame: metres; origin on the floor directly below the isocentre; +y up,
+x patient left, +z towards the couch foot (the viewer). Gantry at 0°, so the
head is above the isocentre (1.25 m above the floor) with the X-ray target 1 m
above it. Vendor-neutral: proportions only, no logos or product shapes.
Lighting is baked with Cycles into one lightmap so the app draws the room unlit.
"""
import math, os, sys
import bpy
import bmesh

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "work", "art")
os.makedirs(OUT, exist_ok=True)
ISO = 1.25
COUCH_TOP = float(sys.argv[1]) if len(sys.argv) > 1 else ISO - 0.103  # top surface of the couch (m above floor)
BAKE_SIZE = 2048
SAMPLES = 128

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# Blender is z-up; we model in Blender coordinates (x, y_b, z_b) = (x, -z_app, y_app)
# and let the glTF exporter convert to y-up.
def B(x, y_app, z_app):
    return (x, -z_app, y_app)


def mat(name, rgb, rough=0.6, metal=0.0, emit=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*emit[0], 1)
        bsdf.inputs["Emission Strength"].default_value = emit[1]
    return m


M = {
    "floor": mat("floor", (0.03, 0.032, 0.036), 0.8),
    "floorRing": mat("floorRing", (0.06, 0.064, 0.07), 0.7),
    "wall": mat("wall", (0.045, 0.05, 0.06), 0.9),
    "wallPanel": mat("wallPanel", (0.06, 0.066, 0.078), 0.85),
    "shell": mat("shell", (0.62, 0.63, 0.65), 0.35),
    "trim": mat("trim", (0.30, 0.32, 0.35), 0.4),
    "dark": mat("dark", (0.035, 0.037, 0.04), 0.5),
    "couch": mat("couch", (0.03, 0.03, 0.033), 0.35),
    "metal": mat("metal", (0.55, 0.56, 0.58), 0.3, 0.6),
    "cabinet": mat("cabinet", (0.16, 0.17, 0.19), 0.6),
}


def box(name, size, centre, material, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=B(*centre))
    o = bpy.context.object
    o.name = name
    o.scale = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        mod = o.modifiers.new("bevel", "BEVEL"); mod.width = bevel; mod.segments = 3
        bpy.ops.object.modifier_apply(modifier="bevel")
    o.data.materials.append(material)
    return o


def cyl(name, r, depth, centre, axis, material, verts=64, bevel=0.0, r2=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, vertices=verts, location=B(*centre))
    else:
        bpy.ops.mesh.primitive_cone_add(radius1=r, radius2=r2, depth=depth, vertices=verts, location=B(*centre))
    o = bpy.context.object
    o.name = name
    if axis == "z_app":   # along app z → Blender -y
        o.rotation_euler = (math.pi / 2, 0, 0)
    elif axis == "x":
        o.rotation_euler = (0, math.pi / 2, 0)
    bpy.ops.object.transform_apply(rotation=True)
    if bevel:
        mod = o.modifiers.new("bevel", "BEVEL"); mod.width = bevel; mod.segments = 3; mod.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier="bevel")
    o.data.materials.append(material)
    return o


objs = []
# ---------------------------------------------------------------- room shell (open towards the viewer)
W, D0, D1, H = 7.0, -4.6, 3.6, 3.0
objs.append(box("floor", (W, 0.04, D1 - D0), (0, -0.02, (D0 + D1) / 2), M["floor"]))
objs.append(cyl("floorRing", 1.6, 0.004, (0, 0.002, -0.4), "y", M["floorRing"], 96))
objs.append(box("wallBack", (W, H, 0.12), (0, H / 2, D0), M["wall"]))
objs.append(box("wallL", (0.12, H, D1 - D0), (-W / 2, H / 2, (D0 + D1) / 2), M["wall"]))
objs.append(box("wallR", (0.12, H, D1 - D0), (W / 2, H / 2, (D0 + D1) / 2), M["wall"]))
for i, z in enumerate((-3.4, -1.6, 0.2, 2.0)):
    objs.append(box(f"panelL{i}", (0.02, 2.2, 1.6), (-W / 2 + 0.07, 1.3, z), M["wallPanel"]))
    objs.append(box(f"panelR{i}", (0.02, 2.2, 1.6), (W / 2 - 0.07, 1.3, z), M["wallPanel"]))
objs.append(box("skirting", (W, 0.1, 0.03), (0, 0.05, D0 + 0.075), M["trim"]))
# cabinet and wall monitor
objs.append(box("cabinet", (0.6, 0.9, 1.8), (W / 2 - 0.4, 0.45, 2.2), M["cabinet"], 0.01))
objs.append(box("monitor", (0.04, 0.45, 0.75), (W / 2 - 0.08, 1.75, 0.9), M["dark"], 0.005))

# ---------------------------------------------------------------- linac (gantry 0°)
objs.append(box("stand", (2.1, 2.55, 1.05), (0, 1.275, -2.25), M["shell"], 0.06))
objs.append(box("standBase", (2.3, 0.08, 1.25), (0, 0.04, -2.25), M["trim"], 0.01))
objs.append(cyl("drum", 1.08, 0.5, (0, ISO, -1.5), "z_app", M["shell"], 96, 0.03))
objs.append(cyl("drumFace", 0.98, 0.02, (0, ISO, -1.245), "z_app", M["trim"], 96))
objs.append(cyl("hub", 0.22, 0.06, (0, ISO, -1.22), "z_app", M["metal"], 48))
# arm: from the drum face over the isocentre
objs.append(box("arm", (0.86, 0.62, 1.15), (0, ISO + 1.0, -0.78), M["shell"], 0.07))
objs.append(box("headHousing", (0.86, 0.62, 0.62), (0, ISO + 1.0, 0.0), M["shell"], 0.08))
objs.append(cyl("collimator", 0.34, 0.36, (0, ISO + 0.6, 0.0), "y", M["shell"], 72, 0.02, r2=0.38))
objs.append(cyl("collimatorRing", 0.36, 0.04, (0, ISO + 0.445, 0.0), "y", M["trim"], 72))
objs.append(box("faceplate", (0.32, 0.015, 0.32), (0, ISO + 0.42, 0.0), M["dark"]))
# imager arm and panel below the couch (opposite the head)
objs.append(box("imagerArm", (0.16, 0.12, 1.2), (0, ISO - 0.95, -0.85), M["trim"], 0.02))
objs.append(box("imager", (0.5, 0.05, 0.5), (0, ISO - 0.62, 0.0), M["shell"], 0.015))
objs.append(box("imagerFace", (0.43, 0.006, 0.43), (0, ISO - 0.592, 0.0), M["dark"]))

# ---------------------------------------------------------------- couch
objs.append(box("couchTop", (0.53, 0.05, 2.1), (0, COUCH_TOP - 0.025, 0.08), M["couch"], 0.012))
objs.append(box("couchRail", (0.56, 0.035, 2.0), (0, COUCH_TOP - 0.07, 0.12), M["trim"], 0.005))
objs.append(box("couchLift", (0.42, COUCH_TOP - 0.25, 0.5), (0, (COUCH_TOP - 0.1) / 2 + 0.05, 1.05), M["shell"], 0.03))
objs.append(box("couchBase", (0.9, 0.08, 1.2), (0, 0.04, 1.2), M["trim"], 0.02))
objs.append(cyl("couchTurntable", 0.75, 0.01, (0, 0.005, 1.1), "y", M["floorRing"], 96))

# ---------------------------------------------------------------- join into one mesh with one lightmap
bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = objs[0]
bpy.ops.object.join()
room = bpy.context.object
room.name = "room"
for p in room.data.polygons:
    p.use_smooth = False
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004, area_weight=1.0)
bpy.ops.uv.pack_islands(margin=0.003)
bpy.ops.object.mode_set(mode="OBJECT")

# lights for the bake: two soft ceiling panels, a warm wash on the back wall, a cool rim from the open side
def area(name, loc_app, size, energy, color, rot=(0, 0, 0)):
    d = bpy.data.lights.new(name, "AREA"); d.size = size[0]; d.shape = "RECTANGLE"; d.size_y = size[1]
    d.energy = energy; d.color = color
    o = bpy.data.objects.new(name, d); o.location = B(*loc_app); o.rotation_euler = rot
    scene.collection.objects.link(o)
area("ceil1", (0, H + 0.4, -0.6), (1.6, 0.8), 230, (1.0, 0.93, 0.84))
area("ceil2", (0, H + 0.4, 1.0), (1.2, 0.6), 110, (1.0, 0.93, 0.84))
area("backwash", (0, 0.2, D0 + 0.6), (5.0, 0.3), 90, (1.0, 0.7, 0.45), (math.radians(-60), 0, 0))
area("rim", (2.0, 2.2, 3.0), (2.0, 2.0), 70, (0.55, 0.7, 1.0), (math.radians(60), 0, math.radians(30)))
world = bpy.data.worlds.new("w"); world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.01, 0.012, 0.016, 1); world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
scene.world = world

# bake
img = bpy.data.images.new("room_light", BAKE_SIZE, BAKE_SIZE)
for m in room.data.materials:
    n = m.node_tree.nodes.new("ShaderNodeTexImage"); n.image = img
    m.node_tree.nodes.active = n
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = SAMPLES
scene.render.bake.margin = 4
bpy.context.view_layer.objects.active = room
room.select_set(True)
bpy.ops.object.bake(type="COMBINED")
img.filepath_raw = os.path.join(OUT, "room_light.png"); img.file_format = "PNG"; img.save()

# unlit export: base colour = baked image
for m in list(room.data.materials):
    m.node_tree.nodes.clear()
    out = m.node_tree.nodes.new("ShaderNodeOutputMaterial")
    bsdf = m.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    tex = m.node_tree.nodes.new("ShaderNodeTexImage"); tex.image = img
    m.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    m.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Roughness"].default_value = 1.0
# merge to one material so the glTF has one primitive
mat0 = room.data.materials[0]
for p in room.data.polygons:
    p.material_index = 0
while len(room.data.materials) > 1:
    room.data.materials.pop(index=1)
mat0.name = "room_baked"
for o in list(scene.objects):
    if o.type == "LIGHT":
        bpy.data.objects.remove(o)

# alignment lasers: thin green lines on the walls and floor that cross at the isocentre height
# (separate, unbaked object; the app draws it as pure emissive light)
lasers = []
lm = mat("laser", (0.2, 1.0, 0.45), 1.0, emit=((0.2, 1.0, 0.45), 4.0))
for sx in (-1, 1):
    x = sx * (W / 2 - 0.065)
    lasers.append(box(f"laserH{sx}", (0.004, 0.006, D1 - D0 - 0.2), (x, ISO, (D0 + D1) / 2), lm))
    lasers.append(box(f"laserV{sx}", (0.004, H - 0.2, 0.006), (x, H / 2, 0.0), lm))
    lasers.append(box(f"laserEmit{sx}", (0.05, 0.12, 0.12), (x + sx * -0.03, ISO, 0.0), M["dark"]))
lasers.append(box("laserBackV", (0.006, H - 0.2, 0.004), (0, H / 2, D0 + 0.065), lm))
lasers.append(box("laserFloor", (0.006, 0.002, D1 - 0.3 - (-1.2)), (0, 0.003, (D1 - 0.3 + -1.2) / 2), lm))
bpy.ops.object.select_all(action="DESELECT")
for o in lasers:
    o.select_set(True)
bpy.context.view_layer.objects.active = lasers[0]
bpy.ops.object.join()
bpy.context.object.name = "lasers"

bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "room.glb"), export_format="GLB", export_image_format="JPEG", export_jpeg_quality=86,
                          export_normals=False, export_texcoords=True, export_materials="EXPORT", use_selection=False, export_apply=True)
print("room triangles:", sum(len(p.vertices) - 2 for p in room.data.polygons))
