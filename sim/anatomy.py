"""Build the patient: MakeHuman exterior + BodyParts3D pelvic anatomy.

1. MakeHuman base mesh (CC0), arms rotated down to the sides and legs brought
   together with the default MakeHuman skinning weights (linear blend, one
   rotation per limb about the shoulder or hip joint).
2. BodyParts3D organs and bones (CC BY-SA 2.1 JP) placed in the MakeHuman
   body by translation only: the midpoint of the two femoral-head centres
   (sphere fits on the BP3D femurs) is put at the midpoint of the MakeHuman hip
   joints. BP3D keeps its true anatomical size (the MakeHuman hip markers sit
   lateral to the femoral heads, so scaling by them would inflate the organs).
3. Everything is put in the patient frame used by the app and Geant4:
   mm, origin at the isocentre (prostate centroid), +x patient left,
   +y anterior (up, towards the gantry head at 0°), +z inferior (towards the feet).
4. A voxel phantom (2.5 mm) of the pelvis for Geant4: air / soft tissue / bone / urine,
   plus an organ-label grid.

Outputs (sim/work/): anatomy.npz, pelvis_vox.bin, pelvis_vox.json
"""
import json, os, struct
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
IN = os.path.join(HERE, "work", "inputs")
OUT = os.path.join(HERE, "work")
VOXEL = 2.5  # mm
EXTENT = {"x": (-230.0, 230.0), "y": (-150.0, 170.0), "z": (-230.0, 210.0)}  # around the isocentre

ORGANS = {  # id: (FMA file, label, material)
    "hip_r": ("FMA16586.stl", "Right hip bone", "bone"),
    "hip_l": ("FMA16587.stl", "Left hip bone", "bone"),
    "sacrum": ("FMA16202.stl", "Sacrum", "bone"),
    "l5": ("FMA13076.stl", "Fifth lumbar vertebra", "bone"),
    "femur_r": ("FMA24474.stl", "Right femur", "bone"),
    "femur_l": ("FMA24475.stl", "Left femur", "bone"),
    "bladder": ("FMA15900.stl", "Bladder", "urine"),
    "prostate": ("FMA9600.stl", "Prostate (the target)", "soft"),
    "rectum": ("FMA14544.stl", "Rectum", "soft"),
}
LABEL_IDS = {"air": 0, "body": 1, "bone": 2, "bladder": 3, "prostate": 4, "rectum": 5}
MAT_IDS = {"air": 0, "soft": 1, "bone": 2, "urine": 3}


# ------------------------------------------------------------------ readers
def read_obj(path):
    V, faces, groups, cur = [], [], {}, None
    for line in open(path):
        if line.startswith("v "):
            V.append([float(x) for x in line.split()[1:4]])
        elif line.startswith("g "):
            cur = line.split()[1]
        elif line.startswith("f "):
            idx = [int(t.split("/")[0]) - 1 for t in line.split()[1:]]
            for k in range(1, len(idx) - 1):
                groups.setdefault(cur, []).append([idx[0], idx[k], idx[k + 1]])
    return np.array(V), {k: np.array(v) for k, v in groups.items()}


def read_stl(path):
    b = open(path, "rb").read()
    n = struct.unpack("<I", b[80:84])[0]
    a = np.frombuffer(b[84:84 + n * 50], dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    tri = a["v"].reshape(-1, 3).astype(np.float64)
    # weld duplicate vertices
    key = np.round(tri, 4)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    return uniq, inv.reshape(-1, 3)


# ------------------------------------------------------------------ geometry helpers
def rot_between(a, b):
    a = a / np.linalg.norm(a); b = b / np.linalg.norm(b)
    v = np.cross(a, b); c = np.dot(a, b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K * (1 / (1 + c))


def fit_sphere(P):
    A = np.c_[2 * P, np.ones(len(P))]
    f = (P ** 2).sum(1)
    c, *_ = np.linalg.lstsq(A, f, rcond=None)
    centre = c[:3]
    r = np.sqrt(c[3] + centre @ centre)
    return centre, r


def femoral_head(V, side):
    """Sphere fit to the femoral head: superior 12% of the femur, medial half."""
    z = V[:, 2]
    top = V[z > z.max() - 0.12 * (z.max() - z.min())]
    medial = top[np.abs(top[:, 0]) < np.median(np.abs(top[:, 0]))]
    c, r = fit_sphere(medial)
    return c, r


MH_TO_PATIENT = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float)   # (x, y_up, z_fwd) → (left, anterior, inferior)
BP_TO_PATIENT = np.array([[1, 0, 0], [0, -1, 0], [0, 0, -1]], float)  # (left, posterior, superior) → (left, anterior, inferior)


# ------------------------------------------------------------------ MakeHuman body
def makehuman_body():
    V, G = read_obj(os.path.join(IN, "base.obj"))
    skel = json.load(open(os.path.join(IN, "default.mhskel")))
    W = json.load(open(os.path.join(IN, "default_weights.mhw")))["weights"]
    joint = {k: V[np.array(v)].mean(0) for k, v in skel["joints"].items()}
    bones = skel["bones"]

    def chain(root):
        out = []
        for k in bones:
            p = k
            while p:
                if p == root:
                    out.append(k); break
                p = bones[p]["parent"]
        return out

    V = V.copy()
    for side, sgn in (("L", 1), ("R", -1)):
        w = np.zeros(len(V))
        for b in chain(f"upperarm01.{side}"):
            for vi, wt in W.get(b, []):
                w[vi] += wt
        w = np.clip(w, 0, 1)
        piv = joint[f"upperarm01.{side}____head"]
        cur = joint[f"wrist.{side}____head"] - piv
        tgt = np.array([sgn * 0.17, -1.0, 0.06])
        R = rot_between(cur, tgt)
        moved = (V - piv) @ R.T + piv
        V = V + w[:, None] * (moved - V)
    # legs: bring the feet together (MakeHuman's default stance is wide), rotating about the hip joints
    for side, sgn in (("L", 1), ("R", -1)):
        w = np.zeros(len(V))
        for b in chain(f"upperleg01.{side}"):
            for vi, wt in W.get(b, []):
                w[vi] += wt
        w = np.clip(w, 0, 1)
        piv = joint[f"upperleg01.{side}____head"]
        cur = joint[f"foot.{side}____head"] - piv
        tgt = np.array([-sgn * 0.045, -1.0, -0.01])
        R = rot_between(cur, tgt)
        V = V + w[:, None] * (((V - piv) @ R.T + piv) - V)
    faces = G["body"]
    used = np.unique(faces)
    remap = -np.ones(len(V), int); remap[used] = np.arange(len(used))
    Vb = V[used] * 100.0  # decimetres → mm
    Fb = remap[faces]
    hips = {s: joint[f"upperleg01.{s}____head"] * 100.0 for s in ("L", "R")}
    return Vb @ MH_TO_PATIENT.T, Fb, {s: h @ MH_TO_PATIENT.T for s, h in hips.items()}


# ------------------------------------------------------------------ voxelisation (ray parity along y)
def voxelise(V, F, grid):
    (x0, nx), (y0, ny), (z0, nz) = grid
    xs = x0 + (np.arange(nx) + 0.5) * VOXEL
    zs = z0 + (np.arange(nz) + 0.5) * VOXEL
    hits_col, hits_y = [], []
    T = V[F]  # (n,3,3)
    for tri in T:
        a, b, c = tri
        xmin, xmax = tri[:, 0].min(), tri[:, 0].max()
        zmin, zmax = tri[:, 2].min(), tri[:, 2].max()
        i0 = max(int(np.ceil((xmin - x0) / VOXEL - 0.5)), 0); i1 = min(int(np.floor((xmax - x0) / VOXEL - 0.5)), nx - 1)
        k0 = max(int(np.ceil((zmin - z0) / VOXEL - 0.5)), 0); k1 = min(int(np.floor((zmax - z0) / VOXEL - 0.5)), nz - 1)
        if i1 < i0 or k1 < k0:
            continue
        X, Z = np.meshgrid(xs[i0:i1 + 1], zs[k0:k1 + 1], indexing="ij")
        # barycentric in xz
        d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
        if abs(d) < 1e-12:
            continue
        l1 = ((b[2] - c[2]) * (X - c[0]) + (c[0] - b[0]) * (Z - c[2])) / d
        l2 = ((c[2] - a[2]) * (X - c[0]) + (a[0] - c[0]) * (Z - c[2])) / d
        l3 = 1 - l1 - l2
        m = (l1 >= 0) & (l2 >= 0) & (l3 >= 0)
        if not m.any():
            continue
        y = l1 * a[1] + l2 * b[1] + l3 * c[1]
        I, K = np.meshgrid(np.arange(i0, i1 + 1), np.arange(k0, k1 + 1), indexing="ij")
        hits_col.append((K[m] * nx + I[m]))
        hits_y.append(y[m])
    inside = np.zeros((nz, ny, nx), bool)
    if not hits_col:
        return inside
    col = np.concatenate(hits_col); yy = np.concatenate(hits_y)
    order = np.lexsort((yy, col))
    col, yy = col[order], yy[order]
    ys = y0 + (np.arange(ny) + 0.5) * VOXEL
    starts = np.r_[0, np.nonzero(np.diff(col))[0] + 1, len(col)]
    for s, e in zip(starts[:-1], starts[1:]):
        c = col[s]; k, i = divmod(c, nx)
        h = yy[s:e]
        if len(h) % 2:  # tolerate one bad crossing: drop the duplicate-closest pair
            h = h[:-1]
        for j in range(0, len(h) - 1, 2):
            inside[k, (ys >= h[j]) & (ys < h[j + 1]), i] = True
    return inside


def main():
    body_V, body_F, mh_hips = makehuman_body()
    organs = {}
    for oid, (f, label, mat) in ORGANS.items():
        V, F = read_stl(os.path.join(IN, f))
        organs[oid] = [V, F, label, mat]
    # femoral heads in BP3D frame
    cR, rR = femoral_head(organs["femur_r"][0], "R")
    cL, rL = femoral_head(organs["femur_l"][0], "L")
    bpL, bpR = cL @ BP_TO_PATIENT.T, cR @ BP_TO_PATIENT.T
    s = 1.0  # see docstring
    t = (mh_hips["L"] + mh_hips["R"]) / 2 - s * (bpL + bpR) / 2
    for o in organs.values():
        o[0] = s * (o[0] @ BP_TO_PATIENT.T) + t
    iso = organs["prostate"][0].mean(0)
    body_V = body_V - iso
    for o in organs.values():
        o[0] = o[0] - iso
    pel = np.abs(body_V[:, 2]) < 150
    couch_top = body_V[pel, 1].min()
    stature = body_V[:, 2].max() - body_V[:, 2].min()
    print(f"MakeHuman stature {stature:.0f} mm; femoral heads {np.linalg.norm(bpL - bpR):.0f} mm apart (BP3D), radii {rR:.1f}/{rL:.1f} mm")
    print(f"couch top at y = {couch_top:.1f} mm below the isocentre; pelvis AP thickness {body_V[pel,1].max()-couch_top:.0f} mm")

    # voxel grid
    nx = int(round((EXTENT["x"][1] - EXTENT["x"][0]) / VOXEL))
    ny = int(round((EXTENT["y"][1] - EXTENT["y"][0]) / VOXEL))
    nz = int(round((EXTENT["z"][1] - EXTENT["z"][0]) / VOXEL))
    grid = ((EXTENT["x"][0], nx), (EXTENT["y"][0], ny), (EXTENT["z"][0], nz))
    label = np.zeros((nz, ny, nx), np.uint8)
    mat = np.zeros((nz, ny, nx), np.uint8)
    inside = voxelise(body_V, body_F, grid)
    label[inside] = LABEL_IDS["body"]; mat[inside] = MAT_IDS["soft"]
    for oid, (V, F, lab, m) in organs.items():
        ins = voxelise(V, F, grid) & inside
        lid = LABEL_IDS.get(oid, LABEL_IDS["bone"] if m == "bone" else LABEL_IDS["body"])
        label[ins] = lid; mat[ins] = MAT_IDS[m]
        full = voxelise(V, F, grid).sum()
        frac = (full - ins.sum()) / max(full, 1)
        print(f"  {oid:9s} {ins.sum() * VOXEL ** 3 / 1000:8.1f} cm³  ({frac*100:.1f}% outside the body surface)")
    vox = {"voxel_mm": VOXEL, "n": [nx, ny, nz], "origin_mm": [grid[0][0], grid[1][0], grid[2][0]], "order": "C order (z, y, x); copyNo = ix + nx*(iy + ny*iz)",
           "materials": {str(v): k for k, v in MAT_IDS.items()}, "labels": {str(v): k for k, v in LABEL_IDS.items()},
           "iso_in_bp3d_frame_note": "origin is the prostate centroid", "couchTop_mm": float(couch_top),
           "prostate_centroid_mm": [0.0, 0.0, 0.0]}
    mat.tofile(os.path.join(OUT, "pelvis_vox.bin"))
    label.tofile(os.path.join(OUT, "pelvis_labels.bin"))
    json.dump(vox, open(os.path.join(OUT, "pelvis_vox.json"), "w"), indent=1)
    np.savez_compressed(os.path.join(OUT, "anatomy.npz"), body_V=body_V, body_F=body_F,
                        **{f"{k}_V": v[0] for k, v in organs.items()}, **{f"{k}_F": v[1] for k, v in organs.items()},
                        couch_top=couch_top, scale=s)
    json.dump({k: {"label": v[2], "material": v[3]} for k, v in organs.items()}, open(os.path.join(OUT, "anatomy.json"), "w"), indent=1)
    counts = {k: int((mat == v).sum()) for k, v in MAT_IDS.items()}
    print("voxels", nx, ny, nz, counts)


if __name__ == "__main__":
    main()
