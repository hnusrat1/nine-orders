"""Treatment room, linear accelerator and couch, modelled in headless Blender.

Run: python sim/art/room.py   (Blender 4.x/5.x as a module: pip install bpy)
Output: sim/work/art/room.glb (then compressed by sim/art/pack.sh)

Frame: metres; origin on the floor directly below the isocentre; +y up,
+x patient left, +z towards the couch foot. Gantry at 0°: the head is above the
isocentre (1.25 m above the floor) with the X-ray target 1 m above it.
Vendor-neutral: proportions only, no logos or product shapes.

The room is seen life-size in VR, so it is built to be stood in: ceiling with
backlit sky panels and downlights, wainscoted walls, a maze entrance, wall
lasers, in-room monitors; a ring-gantry linac with folded imaging arms; a
carbon-fibre couch with the patient's head rest, knee and foot supports, a
gown and a leg blanket. The patient's body (anatomy.npz) is in the scene while
baking, so it casts contact shadows, but it is not exported (the app draws it).

Lighting is baked with Cycles (diffuse + emission, no gloss) into one atlas and
denoised with OpenImageDenoise. The app draws it as emission and adds view-
dependent reflections in real time, so glossy surfaces keep their sheen.
"""
import math, os, sys
import numpy as np
import bpy
import bmesh

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, "..", "work")
OUT = os.path.join(WORK, "art")
os.makedirs(OUT, exist_ok=True)
ISO = 1.25
COUCH_TOP = float(sys.argv[1]) if len(sys.argv) > 1 else ISO - 0.103  # top surface of the couch (m above floor)
BAKE_SIZE = int(os.environ.get("BAKE_SIZE", 3072))
SAMPLES = int(os.environ.get("BAKE_SAMPLES", 40))
BAKE_EXPOSURE = -1.3  # stops; src/levels/room.js multiplies the baked atlas by 2^1.3

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# Blender is z-up; we model in Blender coordinates (x, y_b, z_b) = (x, -z_app, y_app)
# and let the glTF exporter convert to y-up.
def B(x, y_app, z_app):
    return (x, -z_app, y_app)


# ---------------------------------------------------------------- materials
def mat(name, rgb, rough=0.6, metal=0.0, emit=None, tex=None):
    """Principled material; `tex` adds procedural albedo detail in world space."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*emit[0], 1)
        bsdf.inputs["Emission Strength"].default_value = emit[1]
    if tex:
        tc = nt.nodes.new("ShaderNodeTexCoord")
        col = tex(nt, tc.outputs["Object"], rgb)
        nt.links.new(col, bsdf.inputs["Base Color"])
    return m


def speckle(nt, co, rgb):   # terrazzo-like vinyl: fine flecks on a light base
    n1 = nt.nodes.new("ShaderNodeTexNoise"); n1.inputs["Scale"].default_value = 140; n1.inputs["Detail"].default_value = 2
    nt.links.new(co, n1.inputs["Vector"])
    v = nt.nodes.new("ShaderNodeTexVoronoi"); v.inputs["Scale"].default_value = 60
    nt.links.new(co, v.inputs["Vector"])
    r = nt.nodes.new("ShaderNodeValToRGB"); r.color_ramp.elements[0].position = 0.0; r.color_ramp.elements[1].position = 0.06
    r.color_ramp.elements[0].color = (0.22, 0.22, 0.23, 1); r.color_ramp.elements[1].color = (*rgb, 1)
    nt.links.new(v.outputs["Distance"], r.inputs["Fac"])
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"; mix.inputs["Factor"].default_value = 0.12
    nt.links.new(r.outputs["Color"], mix.inputs[6]); nt.links.new(n1.outputs["Color"], mix.inputs[7])
    return mix.outputs[2]


def wood(nt, co, rgb):      # light oak veneer: fine, low-contrast vertical grain
    mp = nt.nodes.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 1.0, 0.08)  # stretch along the height
    nt.links.new(co, mp.inputs["Vector"])
    w = nt.nodes.new("ShaderNodeTexNoise"); w.inputs["Scale"].default_value = 38; w.inputs["Detail"].default_value = 6
    w.inputs["Distortion"].default_value = 0.6
    nt.links.new(mp.outputs["Vector"], w.inputs["Vector"])
    r = nt.nodes.new("ShaderNodeValToRGB")
    r.color_ramp.elements[0].color = (rgb[0] * 0.88, rgb[1] * 0.86, rgb[2] * 0.84, 1); r.color_ramp.elements[1].color = (*rgb, 1)
    nt.links.new(w.outputs["Fac"], r.inputs["Fac"])
    return r.outputs["Color"]


def tiles(nt, co, rgb):     # 60 cm acoustic ceiling tiles
    b = nt.nodes.new("ShaderNodeTexBrick"); b.inputs["Scale"].default_value = 1.0 / 0.6
    b.inputs["Mortar Size"].default_value = 0.008; b.inputs["Brick Width"].default_value = 1.0; b.inputs["Row Height"].default_value = 1.0
    b.offset = 0.0
    b.inputs["Color1"].default_value = (*rgb, 1); b.inputs["Color2"].default_value = (*rgb, 1)
    b.inputs["Mortar"].default_value = (rgb[0] * 0.55, rgb[1] * 0.55, rgb[2] * 0.56, 1)
    nt.links.new(co, b.inputs["Vector"])
    return b.outputs["Color"]


def weave(nt, co, rgb):     # carbon-fibre couch top
    c = nt.nodes.new("ShaderNodeTexChecker"); c.inputs["Scale"].default_value = 180
    c.inputs["Color1"].default_value = (*rgb, 1); c.inputs["Color2"].default_value = (rgb[0] * 1.9, rgb[1] * 1.9, rgb[2] * 2.0, 1)
    nt.links.new(co, c.inputs["Vector"])
    return c.outputs["Color"]


def sky_panel(name):        # backlit sky ceiling: clouds on blue, emissive
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    n = nt.nodes.new("ShaderNodeTexNoise"); n.inputs["Scale"].default_value = 1.6; n.inputs["Detail"].default_value = 8; n.inputs["Roughness"].default_value = 0.62
    nt.links.new(tc.outputs["Object"], n.inputs["Vector"])
    r = nt.nodes.new("ShaderNodeValToRGB")
    r.color_ramp.elements[0].position = 0.45; r.color_ramp.elements[0].color = (0.22, 0.45, 0.95, 1)
    r.color_ramp.elements[1].position = 0.72; r.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1)
    nt.links.new(n.outputs["Fac"], r.inputs["Fac"])
    nt.links.new(r.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(r.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 3.2
    return m


def screen_image(name, w, h):  # in-room monitor: an abstract treatment display (no text)
    img = bpy.data.images.new(name, w, h)
    px = np.zeros((h, w, 4), np.float32); px[..., 3] = 1
    px[..., :3] = (0.015, 0.025, 0.05)
    def rect(x0, y0, x1, y1, c): px[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w), :3] = c
    rect(0.03, 0.08, 0.48, 0.86, (0.05, 0.06, 0.07))
    yy, xx = np.mgrid[0:h, 0:w] / np.array([h, w])[:, None, None]
    blob = np.exp(-(((xx - 0.255) / 0.15) ** 2 + ((yy - 0.47) / 0.25) ** 2) * 2.2)   # a soft grey "image" pane
    m = (xx > 0.03) & (xx < 0.48) & (yy > 0.08) & (yy < 0.86)
    px[m, :3] += (blob[m] * 0.35)[:, None]
    rect(0.52, 0.08, 0.97, 0.86, (0.05, 0.06, 0.07))
    for i in range(6):
        rect(0.55, 0.14 + i * 0.11, 0.55 + 0.38 * (0.5 + 0.5 * math.sin(i * 1.7)), 0.18 + i * 0.11, (0.18, 0.32, 0.45))
    rect(0.03, 0.9, 0.97, 0.95, (0.08, 0.42, 0.22))
    img.pixels.foreach_set(px.ravel())
    return img


M = {
    "floor": mat("floor", (0.46, 0.46, 0.45), 0.35, tex=speckle),
    "floorInlay": mat("floorInlay", (0.30, 0.31, 0.32), 0.4),
    "wall": mat("wall", (0.58, 0.57, 0.55), 0.9),
    "wood": mat("wood", (0.50, 0.36, 0.22), 0.5, tex=wood),
    "ceiling": mat("ceiling", (0.72, 0.72, 0.70), 0.95, tex=tiles),
    "sky": sky_panel("sky"),
    "lightTrim": mat("lightTrim", (0.75, 0.75, 0.74), 0.4),
    "downlight": mat("downlight", (1, 1, 1), 0.3, emit=((1.0, 0.92, 0.8), 6.0)),
    "cove": mat("cove", (1, 1, 1), 0.3, emit=((1.0, 0.82, 0.6), 4.0)),
    "shell": mat("shell", (0.78, 0.79, 0.80), 0.25),
    "shellGrey": mat("shellGrey", (0.46, 0.48, 0.50), 0.35),
    "accent": mat("accent", (0.08, 0.30, 0.40), 0.3),
    "dark": mat("dark", (0.025, 0.027, 0.03), 0.4),
    "glass": mat("glass", (0.01, 0.012, 0.015), 0.05),
    "metal": mat("metal", (0.55, 0.56, 0.58), 0.3, 0.6),
    "couchTop": mat("couchTop", (0.022, 0.023, 0.026), 0.4, tex=weave),
    "couchFrame": mat("couchFrame", (0.80, 0.80, 0.80), 0.3),
    "foam": mat("foam", (0.42, 0.52, 0.62), 0.8),
    "sheet": mat("sheet", (0.55, 0.66, 0.74), 0.9),
    "cabinet": mat("cabinet", (0.70, 0.70, 0.69), 0.5),
    "red": mat("red", (0.6, 0.03, 0.02), 0.3),
    "yellow": mat("yellow", (0.75, 0.6, 0.05), 0.4),
    "maze": mat("maze", (0.42, 0.41, 0.39), 0.9),
}


# ---------------------------------------------------------------- primitives
objs = []      # baked
groups = {}    # name → texel weight (UV island scale)


def finish(o, material, weight, smooth=None):
    o.data.materials.append(material)
    if smooth is not None:
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(smooth))
        o.select_set(False)
    groups[o.name] = weight
    objs.append(o)
    return o


def box(name, size, centre, material, bevel=0.0, segs=3, weight=1.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=B(*centre))
    o = bpy.context.object
    o.name = name
    o.scale = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        mod = o.modifiers.new("bevel", "BEVEL"); mod.width = bevel; mod.segments = segs
        bpy.ops.object.modifier_apply(modifier="bevel")
    return finish(o, material, weight, 35 if bevel else None)


def cyl(name, r, depth, centre, axis, material, verts=64, bevel=0.0, r2=None, weight=1.0, segs=3):
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
        mod = o.modifiers.new("bevel", "BEVEL"); mod.width = bevel; mod.segments = segs; mod.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier="bevel")
    return finish(o, material, weight, 40)


def torus(name, R, r, centre, axis, material, weight=1.0):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=96, minor_segments=12, location=B(*centre))
    o = bpy.context.object
    o.name = name
    if axis == "z_app":
        o.rotation_euler = (math.pi / 2, 0, 0)
        bpy.ops.object.transform_apply(rotation=True)
    return finish(o, material, weight, 60)


# ---------------------------------------------------------------- room shell
W, Z0, Z1, H = 7.2, -4.8, 4.0, 3.0
XL, XR = -W / 2, W / 2
box("floor", (W, 0.04, Z1 - Z0), (0, -0.02, (Z0 + Z1) / 2), M["floor"], weight=0.55)
cyl("turntableInlay", 0.95, 0.003, (0, 0.0015, 1.05), "y", M["floorInlay"], 128, weight=0.6)
box("ceiling", (W, 0.04, Z1 - Z0), (0, H + 0.02, (Z0 + Z1) / 2), M["ceiling"], weight=0.4)
box("wallBack", (W, H, 0.14), (0, H / 2, Z0 - 0.07), M["wall"], weight=0.45)
box("wallFront", (W, H, 0.14), (0, H / 2, Z1 + 0.07), M["wall"], weight=0.35)
# left wall (−x) with the maze opening near the front corner
MZ0, MZ1 = 2.2, 3.5
box("wallL_a", (0.14, H, MZ0 - Z0), (XL - 0.07, H / 2, (Z0 + MZ0) / 2), M["wall"], weight=0.45)
box("wallL_b", (0.14, H, Z1 - MZ1), (XL - 0.07, H / 2, (MZ1 + Z1) / 2), M["wall"], weight=0.45)
box("wallL_lintel", (0.14, H - 2.3, MZ1 - MZ0), (XL - 0.07, 2.3 + (H - 2.3) / 2, (MZ0 + MZ1) / 2), M["wall"], weight=0.45)
# maze: a short corridor turning away, lit warm
box("mazeFloor", (2.0, 0.04, MZ1 - MZ0 + 1.6), (XL - 1.0, -0.02, (MZ0 + MZ1) / 2), M["floor"], weight=0.25)
box("mazeWallOuter", (0.14, H, MZ1 - MZ0 + 1.6), (XL - 2.0, H / 2, (MZ0 + MZ1) / 2), M["maze"], weight=0.25)
box("mazeWallInner", (2.0, H, 0.14), (XL - 1.0, H / 2, MZ0 - 0.85), M["maze"], weight=0.25)
box("mazeCeil", (2.0, 0.04, MZ1 - MZ0 + 1.6), (XL - 1.0, H + 0.02, (MZ0 + MZ1) / 2), M["ceiling"], weight=0.2)
box("mazeEnd", (2.0, H, 0.14), (XL - 1.0, H / 2, MZ1 + 0.8), M["maze"], weight=0.2)
box("wallR", (0.14, H, Z1 - Z0), (XR + 0.07, H / 2, (Z0 + Z1) / 2), M["wall"], weight=0.45)
# wood wainscot (1.1 m) with a top rail, on all walls but the maze opening
for nm, sx, z0, z1 in (("R", 1, Z0, Z1), ("La", -1, Z0, MZ0), ("Lb", -1, MZ1, Z1)):
    x = sx * (W / 2 - 0.012)
    box(f"wains{nm}", (0.024, 1.1, z1 - z0 - 0.02), (x, 0.55, (z0 + z1) / 2), M["wood"], weight=0.5)
    box(f"rail{nm}", (0.04, 0.03, z1 - z0 - 0.02), (x, 1.115, (z0 + z1) / 2), M["lightTrim"], 0.006, weight=0.3)
box("wainsBack", (W - 0.06, 1.1, 0.024), (0, 0.55, Z0 + 0.012), M["wood"], weight=0.5)
box("railBack", (W - 0.06, 0.03, 0.04), (0, 1.115, Z0 + 0.02), M["lightTrim"], 0.006, weight=0.3)
# skirting
box("skirtR", (0.02, 0.08, Z1 - Z0), (XR - 0.01, 0.04, (Z0 + Z1) / 2), M["dark"], weight=0.2)
box("skirtBack", (W, 0.08, 0.02), (0, 0.04, Z0 + 0.01), M["dark"], weight=0.2)

# ceiling: a 2 × 3 field of backlit sky panels over the couch, framed; downlights; warm coves along the walls
for i, x in enumerate((-0.62, 0.62)):
    for j, z in enumerate((-0.35, 0.85, 2.05)):
        box(f"skyFrame{i}{j}", (1.22, 0.05, 1.22), (x, H - 0.02, z), M["lightTrim"], 0.01, weight=0.6)
        box(f"sky{i}{j}", (1.14, 0.012, 1.14), (x, H - 0.05, z), M["sky"], weight=1.2)
for x, z in ((-2.0, -2.8), (2.0, -2.8), (-2.0, -0.4), (2.0, -0.4), (-2.0, 2.2), (2.0, 2.2), (0, 3.3), (0, -3.9)):
    cyl(f"dlRing{x}{z}", 0.11, 0.02, (x, H - 0.005, z), "y", M["lightTrim"], 40, weight=0.3)
    cyl(f"dl{x}{z}", 0.085, 0.006, (x, H - 0.017, z), "y", M["downlight"], 40, weight=0.3)
for sx in (-1, 1):
    box(f"cove{sx}", (0.06, 0.04, Z1 - Z0 - 0.4), (sx * (W / 2 - 0.12), H - 0.12, (Z0 + Z1) / 2), M["cove"], weight=0.2)
    box(f"coveLip{sx}", (0.2, 0.12, Z1 - Z0 - 0.4), (sx * (W / 2 - 0.16), H - 0.08, (Z0 + Z1) / 2), M["lightTrim"], 0.01, weight=0.3)

# right wall: counter with cabinets and two in-room monitors; emergency-off buttons; CCTV
box("counterBase", (0.62, 0.86, 2.4), (XR - 0.31, 0.43, 2.2), M["cabinet"], 0.01, weight=0.7)
for k in range(4):
    box(f"cabDoor{k}", (0.012, 0.72, 0.56), (XR - 0.625, 0.47, 1.1 + k * 0.6 + 0.3), M["wood"], 0.004, weight=0.7)
    box(f"cabHandle{k}", (0.02, 0.012, 0.16), (XR - 0.64, 0.74, 1.1 + k * 0.6 + 0.3), M["metal"], 0.003, weight=0.6)
box("counterTop", (0.66, 0.035, 2.44), (XR - 0.33, 0.88, 2.2), M["shell"], 0.006, weight=0.7)
box("upperCab", (0.36, 0.7, 2.4), (XR - 0.18, 2.1, 2.2), M["cabinet"], 0.01, weight=0.6)
for k, z in enumerate((-1.5, -0.4)):
    box(f"monitorBezel{k}", (0.05, 0.62, 1.05), (XR - 0.12, 1.85, z), M["dark"], 0.01, weight=0.8)
    box(f"monitorArm{k}", (0.07, 0.07, 0.12), (XR - 0.05, 1.85, z), M["metal"], weight=0.4)
for x, z in ((XR - 0.02, -2.6), (XL + 0.02, -2.6)):
    sgn = -1 if x > 0 else 1
    box(f"eoPlate{z}{x}", (0.01, 0.16, 0.16), (x, 1.5, z), M["yellow"], weight=0.6)
    cyl(f"eoButton{z}{x}", 0.04, 0.03, (x + sgn * 0.02, 1.5, z), "x", M["red"], 32, 0.005, weight=0.6)
for x, z in ((XR - 0.25, Z0 + 0.25), (XL + 0.25, Z1 - 0.25)):
    box(f"cctv{x}", (0.1, 0.08, 0.16), (x, H - 0.25, z), M["shell"], 0.01, weight=0.5)
    cyl(f"cctvLens{x}", 0.025, 0.03, (x, H - 0.27, z + (0.09 if z < 0 else -0.09)), "z_app", M["glass"], 24, weight=0.4)

# lasers: housings on both side walls at isocentre height and on the ceiling above it
for sx in (-1, 1):
    box(f"laserBox{sx}", (0.09, 0.22, 0.16), (sx * (W / 2 - 0.045), ISO, 0.0), M["shellGrey"], 0.01, weight=0.7)
    box(f"laserWin{sx}", (0.004, 0.16, 0.05), (sx * (W / 2 - 0.092), ISO, 0.0), M["glass"], weight=0.5)
box("laserCeil", (0.16, 0.08, 0.22), (0, H - 0.04, 0.6), M["shellGrey"], 0.01, weight=0.6)

# ---------------------------------------------------------------- linac (gantry 0°)
GZ = -1.25  # drum front face
box("standBase", (2.4, 0.06, 1.5), (0, 0.03, -2.35), M["dark"], 0.01, weight=0.6)
box("stand", (2.2, 2.62, 1.2), (0, 1.31 + 0.06, -2.35), M["shell"], 0.09, 6, weight=1.6)
box("standSideL", (0.03, 2.3, 1.0), (-1.115, 1.25, -2.35), M["shellGrey"], 0.01, weight=1.2)
box("standSideR", (0.03, 2.3, 1.0), (1.115, 1.25, -2.35), M["shellGrey"], 0.01, weight=1.2)
box("standStripe", (0.05, 2.2, 0.02), (0.78, 1.25, -1.745), M["accent"], 0.005, weight=1.2)
cyl("drum", 1.12, 0.48, (0, ISO, GZ - 0.25), "z_app", M["shell"], 128, 0.05, weight=1.6, segs=5)
torus("drumLip", 1.1, 0.03, (0, ISO, GZ), "z_app", M["shellGrey"], weight=1.2)
cyl("drumFace", 1.04, 0.02, (0, ISO, GZ + 0.002), "z_app", M["shellGrey"], 128, weight=1.4)
cyl("bore", 0.42, 0.03, (0, ISO, GZ + 0.012), "z_app", M["dark"], 96, weight=1.2)
torus("boreRing", 0.43, 0.02, (0, ISO, GZ + 0.02), "z_app", M["shell"], weight=1.2)
# arm: from the drum, over the couch, to the head
box("arm", (0.9, 0.7, 1.22), (0, ISO + 1.05, GZ + 0.48), M["shell"], 0.14, 6, weight=1.8)
box("armUnder", (0.82, 0.04, 1.1), (0, ISO + 0.70, GZ + 0.5), M["shellGrey"], 0.01, weight=1.4)
box("head", (0.86, 0.66, 0.74), (0, ISO + 1.06, 0.0), M["shell"], 0.09, 6, weight=2.0)
box("headCap", (0.78, 0.08, 0.66), (0, ISO + 1.42, 0.0), M["shellGrey"], 0.03, 4, weight=1.6)
box("headSeam", (0.88, 0.012, 0.76), (0, ISO + 0.86, 0.0), M["shellGrey"], 0.004, weight=1.6)
box("headStripe", (0.92, 0.03, 0.5), (0, ISO + 1.0, 0.0), M["accent"], 0.01, weight=1.6)
cyl("collimator", 0.36, 0.30, (0, ISO + 0.6, 0.0), "y", M["shell"], 96, 0.03, r2=0.40, weight=2.0)
torus("collRing", 0.385, 0.018, (0, ISO + 0.47, 0.0), "y", M["shellGrey"], weight=1.6)
cyl("collFace", 0.33, 0.02, (0, ISO + 0.445, 0.0), "y", M["shellGrey"], 96, weight=1.8)
box("trayMount", (0.36, 0.03, 0.36), (0, ISO + 0.425, 0.0), M["dark"], 0.005, weight=1.6)
box("fieldWindow", (0.2, 0.006, 0.2), (0, ISO + 0.408, 0.0), M["glass"], weight=1.6)
# folded kV imaging arms on the drum face, and the MV panel tucked below
for sx in (-1, 1):
    box(f"kvArm{sx}", (0.14, 0.7, 0.12), (sx * 0.78, ISO - 0.2, GZ + 0.08), M["shellGrey"], 0.02, weight=1.4)
    box(f"kvHousing{sx}", (0.42 if sx > 0 else 0.5, 0.42 if sx > 0 else 0.5, 0.2), (sx * 0.78, ISO - 0.62, GZ + 0.14), M["shell"], 0.05, 5, weight=1.6)
box("mvArm", (0.16, 0.12, 0.9), (0, 0.42, GZ + 0.45), M["shellGrey"], 0.02, weight=1.2)
box("mvPanel", (0.58, 0.06, 0.5), (0, 0.48, GZ + 0.92), M["shell"], 0.02, weight=1.4)
# control pendant cradle on the stand
box("standPanel", (0.5, 0.32, 0.03), (-0.55, 1.4, -1.745), M["dark"], 0.01, weight=1.2)

# ---------------------------------------------------------------- couch
CT = COUCH_TOP
box("couchTop", (0.53, 0.05, 2.15), (0, CT - 0.025, 0.1), M["couchTop"], 0.018, 5, weight=2.2)
box("couchRailL", (0.025, 0.04, 2.0), (0.28, CT - 0.04, 0.15), M["couchFrame"], 0.006, weight=1.4)
box("couchRailR", (0.025, 0.04, 2.0), (-0.28, CT - 0.04, 0.15), M["couchFrame"], 0.006, weight=1.4)
for k in range(9):  # indexing notches along the rails
    for sx in (-1, 1):
        box(f"notch{k}{sx}", (0.006, 0.02, 0.02), (sx * 0.294, CT - 0.035, -0.5 + k * 0.14), M["dark"], weight=0.8)
box("couchUnder", (0.46, 0.12, 1.4), (0, CT - 0.11, 0.55), M["couchFrame"], 0.03, weight=1.4)
box("couchColumn", (0.46, CT - 0.4, 0.5), (0, 0.2 + (CT - 0.4) / 2, 1.05), M["couchFrame"], 0.04, weight=1.4)
for k in range(5):  # bellows
    box(f"bellow{k}", (0.48, 0.035, 0.52), (0, 0.24 + k * 0.08, 1.05), M["shellGrey"], 0.012, weight=1.0)
box("couchBase", (0.95, 0.12, 1.25), (0, 0.06, 1.15), M["couchFrame"], 0.04, weight=1.2)
cyl("turntable", 0.92, 0.012, (0, 0.006, 1.05), "y", M["shellGrey"], 128, weight=0.8)
# patient immobilisation: head rest, knee and foot supports (heights fit the body mesh)
box("headRest", (0.3, 0.06, 0.26), (0, CT + 0.03, -0.73), M["foam"], 0.02, 5, weight=1.6)
cyl("kneeSupport", 0.05, 0.42, (0, CT + 0.045, 0.40), "x", M["foam"], 48, 0.01, weight=1.4)
box("feetSupport", (0.36, 0.07, 0.2), (0, CT + 0.035, 0.73), M["foam"], 0.02, 5, weight=1.4)
# hand pendant hanging off the couch side, and its cable
box("pendant", (0.05, 0.16, 0.08), (0.33, CT - 0.32, 0.6), M["shellGrey"], 0.01, weight=1.2)
curve = bpy.data.curves.new("cable", "CURVE"); curve.dimensions = "3D"; curve.bevel_depth = 0.004; curve.bevel_resolution = 3
sp = curve.splines.new("BEZIER"); sp.bezier_points.add(1)
for bp, p, h1, h2 in ((sp.bezier_points[0], (0.30, CT - 0.04, 0.55), (0.30, CT - 0.04, 0.45), (0.33, CT - 0.15, 0.6)),
                      (sp.bezier_points[1], (0.33, CT - 0.24, 0.6), (0.36, CT - 0.12, 0.62), (0.33, CT - 0.3, 0.6))):
    bp.co = B(*p); bp.handle_left = B(*h1); bp.handle_right = B(*h2)
co = bpy.data.objects.new("cable", curve); scene.collection.objects.link(co)
bpy.context.view_layer.objects.active = co; co.select_set(True)
bpy.ops.object.convert(target="MESH"); co = bpy.context.object; co.select_set(False)
finish(co, M["dark"], 0.6)

# ---------------------------------------------------------------- the patient (bake-only) and their covers
A = np.load(os.path.join(WORK, "anatomy.npz"))
V = A["body_V"] / 1000.0
Vr = np.c_[V[:, 0], V[:, 1] + ISO, V[:, 2]]   # app frame, metres
F = A["body_F"]
body_me = bpy.data.meshes.new("bodyBake")
body_me.from_pydata([B(*v) for v in Vr], [], F.tolist())
body_me.validate()
body = bpy.data.objects.new("bodyBake", body_me)
scene.collection.objects.link(body)
for p in body.data.polygons:
    p.use_smooth = True
body.data.materials.append(mat("skinBake", (0.62, 0.45, 0.38), 0.5))


def cover(name, xhalf, zmin, zmax, lift, material, weight):
    """A sheet laid over the patient: a grid dropped onto the body from above
    (ray casts), draped down to the couch beyond it, then smoothed."""
    from mathutils.bvhtree import BVHTree
    from mathutils import Vector
    deps = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body, deps)
    nx, nz = 72, max(8, int((zmax - zmin) / 0.008))
    xs = np.linspace(-xhalf, xhalf, nx); zs = np.linspace(zmin, zmax, nz)
    base = np.full((nz, nx), CT + 0.012)
    for j, z in enumerate(zs):
        for i, x in enumerate(xs):
            hit = bvh.ray_cast(Vector(B(x, 2.5, z)), Vector((0, 0, -1)))
            if hit[0] is not None:
                base[j, i] = hit[0].z + lift
    h = base.copy()
    # never closer than `lift` to the body anywhere in a cell: take the max of the neighbourhood
    p0 = np.pad(base, 1, mode="edge")
    base = np.maximum.reduce([p0[1:-1, 1:-1], p0[:-2, 1:-1], p0[2:, 1:-1], p0[1:-1, :-2], p0[1:-1, 2:]])
    for _ in range(24):  # drape: relax, but never sink into the body
        p = np.pad(h, 1, mode="edge")
        h = np.maximum(base, 0.2 * (p[1:-1, 1:-1] + p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]))
    verts = [B(x, h[j, i], z) for j, z in enumerate(zs) for i, x in enumerate(xs)]
    faces = [(j * nx + i, j * nx + i + 1, (j + 1) * nx + i + 1, (j + 1) * nx + i) for j in range(nz - 1) for i in range(nx - 1)]
    me = bpy.data.meshes.new(name); me.from_pydata(verts, [], faces); me.validate()
    o = bpy.data.objects.new(name, me); scene.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o; o.select_set(True)
    md = o.modifiers.new("solid", "SOLIDIFY"); md.thickness = 0.005; md.offset = 1.0
    bpy.ops.object.modifier_apply(modifier="solid")
    for p_ in o.data.polygons:
        p_.use_smooth = True
    o.select_set(False)
    return finish(o, material, weight)


CT = COUCH_TOP
cover("gown", 0.29, -0.6, -0.16, 0.02, M["sheet"], 1.4)
cover("blanket", 0.27, 0.27, 0.66, 0.025, M["sheet"], 1.4)

# ---------------------------------------------------------------- UVs: one atlas, more texels where you look closely
# Each object's faces carry its texel weight; after one smart projection the islands
# are brought to a uniform density, then scaled by that weight before packing.
weights = sorted(set(groups.values()))
for o in objs:
    att = o.data.attributes.new("grp", "INT", "FACE")
    att.data.foreach_set("value", [weights.index(groups[o.name])] * len(o.data.polygons))
bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = objs[0]
bpy.ops.object.join()
room = bpy.context.object
room.name = "room"
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0, scale_to_bounds=False)
bpy.ops.uv.select_all(action="SELECT")
bpy.ops.uv.average_islands_scale()
bpy.ops.object.mode_set(mode="OBJECT")
grp = np.zeros(len(room.data.polygons), np.int64); room.data.attributes["grp"].data.foreach_get("value", grp)
uv = room.data.uv_layers.active.data
a = np.zeros(len(uv) * 2); uv.foreach_get("uv", a); a = a.reshape(-1, 2)
for p in room.data.polygons:
    k = weights[grp[p.index]]
    a[p.loop_start:p.loop_start + p.loop_total] *= k
uv.foreach_set("uv", a.ravel())
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.select_all(action="SELECT")
bpy.ops.uv.pack_islands(margin=0.0015, rotate=True, scale=True)
bpy.ops.object.mode_set(mode="OBJECT")
room.data.attributes.remove(room.data.attributes["grp"])

if os.environ.get("PREVIEW"):
    # quick look at the design: a Cycles render from where a visitor stands, no bake
    def look(name, eye, target):
        cam = bpy.data.cameras.new(name); cam.lens = 18
        c = bpy.data.objects.new(name, cam); scene.collection.objects.link(c)
        c.location = B(*eye)
        d = np.array(B(*target)) - np.array(B(*eye))
        import mathutils
        c.rotation_euler = mathutils.Vector(d).to_track_quat("-Z", "Y").to_euler()
        return c
    views = [("pv_side", (1.0, 1.62, 0.25), (-0.4, 1.2, -0.6)), ("pv_foot", (0.5, 1.75, 2.6), (0, 1.1, -0.8)), ("pv_up", (0.9, 1.6, 0.6), (-0.3, 2.9, -0.2))]
# ---------------------------------------------------------------- lighting for the bake (dimmed for treatment)
def area(name, loc_app, size, energy, color, rot=(0, 0, 0)):
    d = bpy.data.lights.new(name, "AREA"); d.size = size[0]; d.shape = "RECTANGLE"; d.size_y = size[1]
    d.energy = energy; d.color = color
    o = bpy.data.objects.new(name, d); o.location = B(*loc_app); o.rotation_euler = rot
    scene.collection.objects.link(o)


def spot(name, loc_app, energy, color, size=0.12, angle=100):
    d = bpy.data.lights.new(name, "SPOT"); d.energy = energy; d.color = color; d.shadow_soft_size = size
    d.spot_size = math.radians(angle); d.spot_blend = 0.6
    o = bpy.data.objects.new(name, d); o.location = B(*loc_app)
    scene.collection.objects.link(o)


# the sky panels light the couch (emission does the look; these area lights do the light)
for x in (-0.62, 0.62):
    for z in (-0.35, 0.85, 2.05):
        area(f"skyL{x}{z}", (x, H - 0.07, z), (1.1, 1.1), 55, (0.82, 0.9, 1.0))
for x, z in ((-2.0, -2.8), (2.0, -2.8), (-2.0, -0.4), (2.0, -0.4), (-2.0, 2.2), (2.0, 2.2), (0, 3.3), (0, -3.9)):
    spot(f"dlS{x}{z}", (x, H - 0.03, z), 70, (1.0, 0.86, 0.68))
for sx in (-1, 1):
    area(f"coveL{sx}", (sx * (W / 2 - 0.14), H - 0.14, (Z0 + Z1) / 2), (0.05, Z1 - Z0 - 0.4), 120, (1.0, 0.78, 0.55),
         (0, math.radians(-sx * 70), 0))
area("mazeLight", (XL - 1.0, H - 0.1, (MZ0 + MZ1) / 2), (1.2, 1.6), 90, (1.0, 0.8, 0.58))
world = bpy.data.worlds.new("w"); world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.004, 0.005, 0.007, 1)
scene.world = world

if os.environ.get("PREVIEW"):
    scene.render.engine = "CYCLES"; scene.cycles.device = "CPU"; scene.cycles.samples = int(os.environ.get("PREVIEW_SAMPLES", 40))
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1280; scene.render.resolution_y = 720; scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    for name, eye, tgt in views:
        scene.camera = look(name, eye, tgt)
        scene.render.filepath = os.path.join(os.environ.get("PREVIEW"), name + ".png")
        bpy.ops.render.render(write_still=True)
    sys.exit(0)

# ---------------------------------------------------------------- bake: diffuse light × albedo + emission
img = bpy.data.images.new("room_light", BAKE_SIZE, BAKE_SIZE, float_buffer=True)
for m in room.data.materials:
    n = m.node_tree.nodes.new("ShaderNodeTexImage"); n.image = img
    uvn = m.node_tree.nodes.new("ShaderNodeUVMap"); uvn.uv_map = room.data.uv_layers[0].name
    m.node_tree.links.new(uvn.outputs["UV"], n.inputs["Vector"])
    m.node_tree.nodes.active = n
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = SAMPLES
scene.cycles.max_bounces = 6
scene.cycles.diffuse_bounces = 3
bk = scene.render.bake
bk.margin = 8
bk.use_pass_direct = True; bk.use_pass_indirect = True
bk.use_pass_diffuse = True; bk.use_pass_glossy = False; bk.use_pass_transmission = False; bk.use_pass_emit = True
bpy.ops.object.select_all(action="DESELECT")
bpy.context.view_layer.objects.active = room
room.select_set(True)
bpy.ops.object.bake(type="COMBINED")

# denoise with OpenImageDenoise through the compositor, then save as an 8-bit sRGB PNG
tree = bpy.data.node_groups.new("denoise", "CompositorNodeTree")
scene.compositing_node_group = tree
n_img = tree.nodes.new("CompositorNodeImage"); n_img.image = img
dn = tree.nodes.new("CompositorNodeDenoise")
out = tree.nodes.new("NodeGroupOutput")
tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
tree.links.new(n_img.outputs[0], dn.inputs[0])
tree.links.new(dn.outputs[0], out.inputs[0])
scene.render.engine = "BLENDER_WORKBENCH"
scene.render.resolution_x = BAKE_SIZE; scene.render.resolution_y = BAKE_SIZE; scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.view_settings.view_transform = "Standard"
scene.view_settings.exposure = BAKE_EXPOSURE   # keep lit white surfaces below 1.0; the app scales back by 2^-BAKE_EXPOSURE
scene.render.filepath = os.path.join(OUT, "room_light.png")
bpy.ops.render.render(write_still=True)
baked = bpy.data.images.load(os.path.join(OUT, "room_light.png"))

# ---------------------------------------------------------------- export: every material samples the baked atlas
for m in list(room.data.materials):
    m.node_tree.nodes.clear()
    o_ = m.node_tree.nodes.new("ShaderNodeOutputMaterial")
    bsdf = m.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    tex = m.node_tree.nodes.new("ShaderNodeTexImage"); tex.image = baked
    uvn = m.node_tree.nodes.new("ShaderNodeUVMap"); uvn.uv_map = room.data.uv_layers[0].name
    m.node_tree.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
    m.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    m.node_tree.links.new(bsdf.outputs["BSDF"], o_.inputs["Surface"])
while len(room.data.uv_layers) > 1:
    room.data.uv_layers.remove(room.data.uv_layers[-1])
for o in list(scene.objects):
    if o.type == "LIGHT" or o.name == "bodyBake":
        bpy.data.objects.remove(o)

# in-room monitors: their own emissive display image (not baked)
scr_img = screen_image("screen_display", 512, 288)
scr_img.filepath_raw = os.path.join(OUT, "screen_display.png"); scr_img.file_format = "PNG"; scr_img.save()
scr_mat = bpy.data.materials.new("screen"); scr_mat.use_nodes = True
nt = scr_mat.node_tree; bsdf = nt.nodes["Principled BSDF"]
t = nt.nodes.new("ShaderNodeTexImage"); t.image = scr_img
nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
for k, z in enumerate((-1.5, -0.4)):
    me = bpy.data.meshes.new(f"monitorScreen{k}")
    x = XR - 0.147; y0, y1 = 1.85 - 0.28, 1.85 + 0.28; z0, z1 = z - 0.495, z + 0.495
    me.from_pydata([B(x, y0, z0), B(x, y0, z1), B(x, y1, z1), B(x, y1, z0)], [], [(0, 1, 2, 3)])
    uvl = me.uv_layers.new(name="UVMap")
    for li, (u, v) in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))):
        uvl.data[li].uv = (u, v)
    o = bpy.data.objects.new(f"monitorScreen{k}", me); scene.collection.objects.link(o)
    o.data.materials.append(scr_mat)

# alignment lasers: thin green lines on the walls, ceiling and floor that cross at the isocentre
# (separate, unbaked object; the app draws it as pure emissive light)
lasers = []
lm = mat("laser", (0.2, 1.0, 0.45), 1.0, emit=((0.2, 1.0, 0.45), 4.0))
def lbox(name, size, centre):
    bpy.ops.mesh.primitive_cube_add(size=1, location=B(*centre))
    o = bpy.context.object; o.name = name; o.scale = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(scale=True); o.data.materials.append(lm); lasers.append(o)
for sx in (-1, 1):
    x = sx * (W / 2 - 0.026)
    lbox(f"laserH{sx}", (0.003, 0.004, Z1 - Z0 - 0.3), (x, ISO, (Z0 + Z1) / 2) if sx > 0 else (x, ISO, (Z0 + MZ0) / 2 - 0.1))
    lbox(f"laserV{sx}", (0.003, H - 0.1, 0.004), (x, H / 2, 0.0))
lbox("laserCeilLine", (0.004, 0.003, Z1 - Z0 - 0.3), (0, H - 0.003, (Z0 + Z1) / 2))
lbox("laserBackV", (0.004, H - 0.1, 0.003), (0, H / 2, Z0 + 0.026))
lbox("laserFloor", (0.004, 0.002, Z1 - 0.3 - 1.7), (0, 0.003, (Z1 - 0.3 + 1.7) / 2))
bpy.ops.object.select_all(action="DESELECT")
for o in lasers:
    o.select_set(True)
bpy.context.view_layer.objects.active = lasers[0]
bpy.ops.object.join()
bpy.context.object.name = "lasers"

bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "room.glb"), export_format="GLB", export_image_format="JPEG", export_jpeg_quality=88,
                          export_normals=True, export_texcoords=True, export_materials="EXPORT", use_selection=False, export_apply=True)
print("room triangles:", sum(len(p.vertices) - 2 for p in room.data.polygons))
print("materials:", [m.name for m in room.data.materials])
