"""Synthetic placeholder data for the skeleton build.

Writes assets/data/ in exactly the format the Geant4 pipeline (sim/process.py)
writes, but with random-walk tracks and textbook-style numbers. index.json is
flagged "synthetic": true and the app says so on screen. Not physics.
"""
import os, sys, math
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
from datafmt import write_dataset, write_index, num  # noqa: E402
from bdna import bdna_from_1bna  # noqa: E402

OUT = os.path.join(HERE, "..", "assets", "data")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(3)
ME = 0.51099895  # MeV
C_MM_NS = 299.792458


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def perp(v):
    t = np.array([1.0, 0, 0]) if abs(v[0]) < 0.9 else np.array([0, 1.0, 0])
    a = unit(np.cross(v, t))
    return a, np.cross(v, a)


def rotate_towards(d, theta, phi):
    a, b = perp(d)
    return unit(math.cos(theta) * d + math.sin(theta) * (math.cos(phi) * a + math.sin(phi) * b))


def beta(ekin_mev, m=ME):
    g = 1 + max(ekin_mev, 1e-9) / m
    return math.sqrt(1 - 1 / g ** 2)


# ---------------------------------------------------------------- geometry & Compton kinematics
iso = np.array([-8.0, 5.0, -12.0])            # isocentre relative to the interaction point (mm)
source = iso + np.array([0, 1000.0, 0])
dir_in = unit(-source)
E0 = 2.0
theta = math.radians(35.0)
E1 = E0 / (1 + (E0 / ME) * (1 - math.cos(theta)))
Ee = E0 - E1
phi = 1.1
dir_out = rotate_towards(dir_in, theta, phi)
p_e = E0 * dir_in - E1 * dir_out
dir_e = unit(p_e)

# ---------------------------------------------------------------- patient-scale electron (random walk)
pts, edep, tm, typ, trk, ek = [], [], [], [], [], []
pos = np.zeros(3); d = dir_e.copy(); E = Ee * 1000.0; t = 0.0  # keV, ns
ds = 0.05  # mm
deltas = []
while E > 10:
    pts.append(pos.copy()); edep.append(0 if not pts[:-1] else ds * 200.0); tm.append(t); typ.append(10); trk.append(0); ek.append(E)
    loss = ds * 1000 * 0.2 * (1 + 3 * (300 / max(E, 30)) ** 0.7)  # keV
    E -= loss
    t += ds / (C_MM_NS * beta(max(E, 1) / 1000))
    d = rotate_towards(d, abs(rng.normal(0, 0.05 + 0.4 * (60 / max(E, 60)))), rng.uniform(0, 2 * math.pi))
    pos = pos + d * ds
    if rng.random() < 0.04 and E > 200:
        deltas.append((pos.copy(), t, rotate_towards(d, 1.0, rng.uniform(0, 6.28)), rng.uniform(2, 30)))
for k, (p0, t0, dd, Ed) in enumerate(deltas, start=1):
    p = p0.copy(); e = Ed
    pts.append(p.copy()); edep.append(0); tm.append(t0); typ.append(6); trk.append(k); ek.append(e)
    tt = t0
    while e > 1:
        step = 0.002 * e ** 1.4 / 10
        p = p + dd * max(step, 0.0005); dd = rotate_towards(dd, 0.5, rng.uniform(0, 6.28))
        e -= max(e * 0.3, 0.5); tt += 1e-4
        pts.append(p.copy()); edep.append(max(e, 0.5)); tm.append(tt); typ.append(10); trk.append(k); ek.append(max(e, 0))
pts = np.array(pts)
primary = np.array(trk) == 0
seg = np.linalg.norm(np.diff(pts[primary], axis=0), axis=1)
path_len = seg.sum()
iho = int(np.searchsorted(np.cumsum(seg), 0.6))  # hand-off ~0.6 mm along the track
ho = pts[primary][iho]
E_at_ho = np.array(ek)[primary][iho]
dir_at_ho = unit(pts[primary][iho + 1] - pts[primary][iho])

datasets = {}
datasets["patientElectron"] = write_dataset(os.path.join(OUT, "patientElectron.bin"), {
    "pos": ("f32", 3, pts), "edep": ("f32", 1, edep), "time": ("f32", 1, tm), "type": ("u8", 1, typ),
    "track": ("u16", 1, trk), "ekin": ("f32", 1, ek)}, units={"pos": "mm", "edep": "keV", "time": "ns", "ekin": "keV"})

# ---------------------------------------------------------------- cell-scale primary (µm, through the hand-off point)
cp, ce, ct, cty, ctr = [], [], [], [], []
s = -22.0
while s < 22.0:
    s += rng.exponential(0.25)
    p = dir_at_ho * s + rng.normal(0, 0.02, 3)
    cp.append(p); ce.append(rng.uniform(8, 40)); ct.append((s + 22) * 1e-3 / (C_MM_NS * beta(E_at_ho / 1000)));
    cty.append(2 if rng.random() < 0.7 else 1); ctr.append(0)
datasets["cellPrimary"] = write_dataset(os.path.join(OUT, "cellPrimary.bin"), {
    "pos": ("f32", 3, cp), "edep": ("f32", 1, ce), "time": ("f32", 1, ct), "type": ("u8", 1, cty), "track": ("u16", 1, ctr)},
    units={"pos": "µm", "edep": "eV", "time": "ns"})

# ---------------------------------------------------------------- delta electron (nm, origin at hand-off)
Ed = 2.5  # keV
dd = rotate_towards(dir_at_ho, 1.1, 0.4)
dp, de, dt_, dty, dtr = [np.zeros(3)], [0.0], [0.0], [6], [0]
p = np.zeros(3); e = Ed * 1000; t = 0.0
while e > 20:
    mfp = 0.4 + 2.0 * (e / 2500) ** 1.2
    p = p + dd * rng.exponential(mfp)
    dd = rotate_towards(dd, abs(rng.normal(0, 0.35 + 0.8 * (200 / max(e, 200)))), rng.uniform(0, 6.28))
    r = rng.random()
    k = 2 if r < 0.55 else (1 if r < 0.85 else 0)
    w = rng.uniform(10, 60) if k == 2 else (rng.uniform(7, 14) if k == 1 else 0)
    e -= w + (rng.uniform(5, 40) if k == 2 else 0)
    t += 1e-6 * mfp / max(beta(e / 1e6), 0.01)
    dp.append(p.copy()); de.append(w); dt_.append(t); dty.append(k); dtr.append(0)
dp = np.array(dp)
datasets["delta"] = write_dataset(os.path.join(OUT, "delta.bin"), {
    "pos": ("f32", 3, dp), "edep": ("f32", 1, de), "time": ("f32", 1, dt_), "type": ("u8", 1, dty), "track": ("u16", 1, dtr)},
    units={"pos": "nm", "edep": "eV", "time": "ns"})

# DSB site: near the delta's track end
site = dp[int(len(dp) * 0.85)]
seg_dir = unit(dp[int(len(dp) * 0.85) + 1] - dp[int(len(dp) * 0.85) - 1])
dna_axis = unit(np.cross(seg_dir, [0.3, 1, 0.2]))

# ---------------------------------------------------------------- chromatin (nm)
npos, nq, lpos, lt, ltr = [], [], [], [], []
c = site - dna_axis * 120
prev = None
for i in range(26):
    c = c + unit(dna_axis * 0.8 + rng.normal(0, 0.6, 3)) * 18.0
    if np.linalg.norm(c - site) < 9:
        c = c + unit(np.cross(dna_axis, [0, 0, 1])) * 10
    q = rng.normal(0, 1, 4); q /= np.linalg.norm(q)
    npos.append(c.copy()); nq.append(q)
    if prev is not None:
        a, b = prev + unit(c - prev) * 5.5, c - unit(c - prev) * 5.5
        for u in np.linspace(0, 1, 6):
            lpos.append(a + (b - a) * u); lt.append(0); ltr.append(i)
    prev = c.copy()
# straight linker through the break site, matching the DNA level's helix
for u in np.linspace(-6, 6, 7):
    lpos.append(site + dna_axis * u); lt.append(0); ltr.append(1000)
datasets["nucleosomes"] = write_dataset(os.path.join(OUT, "nucleosomes.bin"), {"pos": ("f32", 3, npos), "quat": ("f32", 4, nq)}, units={"pos": "nm"})
datasets["linkers"] = write_dataset(os.path.join(OUT, "linkers.bin"), {
    "pos": ("f32", 3, lpos), "time": ("f32", 1, lt), "track": ("u16", 1, ltr)}, units={"pos": "nm"})

# ---------------------------------------------------------------- DNA atoms around the site (nm, origin at site)
atoms, info = bdna_from_1bna(os.path.join(HERE, "inputs", "1BNA.pdb"), 24)
z = np.array([0, 0, 1.0])
v = np.cross(z, dna_axis); sang = np.linalg.norm(v); cang = np.dot(z, dna_axis)
K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
R = np.eye(3) + K + K @ K * ((1 - cang) / max(sang ** 2, 1e-12))
P = np.array([R @ a["pos"] for a in atoms])
datasets["dnaAtoms"] = write_dataset(os.path.join(OUT, "dnaAtoms.bin"), {
    "pos": ("f32", 3, P), "elem": ("u8", 1, [a["el"] for a in atoms]), "strand": ("u8", 1, [a["strand"] for a in atoms]),
    "bp": ("i32", 1, [a["bp"] for a in atoms]), "backbone": ("u8", 1, [a["backbone"] for a in atoms])}, units={"pos": "nm"})

bb = [i for i, a in enumerate(atoms) if a["backbone"] and a["name"] == "C4'"]
sA = [i for i in bb if atoms[i]["strand"] == 0 and atoms[i]["bp"] == 11][0]
sB = [i for i in bb if atoms[i]["strand"] == 1 and atoms[i]["bp"] == 13][0]
ssb = [
    {"strand": 0, "bp": 11, "edep_eV": 24.0, "pos_nm": P[sA].tolist(), "time_ns": float(dt_[int(len(dp) * 0.85)])},
    {"strand": 1, "bp": 13, "edep_eV": 31.0, "pos_nm": P[sB].tolist(), "time_ns": float(dt_[int(len(dp) * 0.85) + 2])},
]

numbers = {
    "photonE0": num(E0, "MeV", "Photon energy", "SYNTHETIC placeholder"),
    "photonE1": num(E1, "MeV", "Scattered photon energy", "SYNTHETIC: Compton formula at θ = 35°"),
    "photonAngle": num(35, "°", "Photon scattering angle", "SYNTHETIC placeholder", 2),
    "electronE0": num(Ee, "MeV", "Recoil electron energy", "SYNTHETIC: E0 − E1"),
    "depth": num(np.linalg.norm(iso - source) - 1000 + 110, "mm", "Depth of the interaction", "SYNTHETIC placeholder", 2),
    "electronPath": num(path_len, "mm", "Electron path length", "SYNTHETIC random walk", 2),
    "letPrimary": num(0.2, "keV/µm", "Energy loss of the fast electron", "SYNTHETIC placeholder (textbook value)", 2),
    "deltaE": num(Ed, "keV", "Delta electron energy", "SYNTHETIC placeholder", 2),
    "deltaRange": num(np.linalg.norm(np.diff(dp, axis=0), axis=1).sum(), "nm", "Delta electron path length", "SYNTHETIC random walk", 2),
    "nucleusDiameter": num(9, "µm", "Nucleus diameter", "Illustrative model cell", 2),
    "nrl": num(187, "bp", "Nucleosome repeat length", "SYNTHETIC placeholder", 3),
    "dsbSeparation": num(2, "bp", "Separation of the two strand breaks", "SYNTHETIC placeholder", 2),
    "tracksPerNucleus2Gy": num(2000, "", "Electron tracks through one nucleus in 2 Gy", "SYNTHETIC placeholder", 2),
}

index = {
    "synthetic": True,
    "generator": "sim/synthetic.py",
    "frames": {
        "patient": "mm; origin at the Compton interaction point; +y anterior (towards the gantry head at 0°), -z superior (towards the gantry)",
        "tissue": "µm; same origin and axes as patient",
        "cell": "µm; origin at the hand-off point (delta electron production); patient axes",
        "chromatin": "nm; origin at the hand-off point; patient axes",
        "dna": "nm; origin at the DSB site; patient axes",
    },
    "geometry": {"iso_mm": iso.tolist(), "source_mm": source.tolist(), "isoHeight_mm": 1250, "couchTop_mm": float(iso[1] - 110), "field_mm": [100, 100]},
    "photon": {"E0": E0, "dirIn": dir_in.tolist(), "E1": E1, "dirOut": dir_out.tolist()},
    "electron": {"E0": Ee, "dir": dir_e.tolist()},
    "handoff": {"kind": "delta", "origin_mm": ho.tolist(), "E_keV": Ed, "parentE_keV": float(E_at_ho), "dir": dd.tolist(),
                "cell": {"centre_um": [2.0, -1.0, 1.5], "radius_um": 6.5, "nucleusCentre_um": [1.0, -0.5, 0.8], "nucleusRadius_um": 4.5}},
    "dsb": {"site_nm": site.tolist(), "axis": dna_axis.tolist(), "ssb": ssb, "pair": [0, 1], "separation_bp": 2, "showRadius_nm": 5.0},
    "anatomy": [
        {"id": "body", "label": "Body outline", "center_mm": iso.tolist(), "radii_mm": [180, 115, 210], "color": "#7f9fb8", "rim": 2.6, "strength": 0.7},
        {"id": "prostate", "label": "Prostate (the target)", "center_mm": iso.tolist(), "radii_mm": [22, 17, 20], "color": "#ffb35c", "rim": 1.6, "base": 0.08},
        {"id": "bladder", "label": "Bladder", "center_mm": (iso + [0, 25, -38]).tolist(), "radii_mm": [40, 30, 34], "color": "#6fd0c0"},
        {"id": "rectum", "label": "Rectum", "center_mm": (iso + [0, -36, 6]).tolist(), "radii_mm": [17, 17, 45], "color": "#c78a8a"},
        {"id": "femur_r", "label": "Femoral head", "center_mm": (iso + [-92, 0, 12]).tolist(), "radii_mm": [24, 24, 24], "color": "#e8e2d0"},
        {"id": "femur_l", "label": "Femoral head", "center_mm": (iso + [92, 0, 12]).tolist(), "radii_mm": [24, 24, 24], "color": "#e8e2d0"},
        {"id": "hip_r", "label": "Hip bone", "center_mm": (iso + [-95, 15, -60]).tolist(), "radii_mm": [22, 60, 55], "color": "#e8e2d0"},
        {"id": "hip_l", "label": "Hip bone", "center_mm": (iso + [95, 15, -60]).tolist(), "radii_mm": [22, 60, 55], "color": "#e8e2d0"},
    ],
    "numbers": numbers,
    "eventTypes": {"0": "elastic", "1": "electronic excitation", "2": "ionisation", "3": "vibrational excitation", "4": "dissociative attachment", "6": "track start", "10": "condensed-history step"},
    "notes": [
        {"h": "Skeleton build", "p": ["Geometry here is placeholder and every track is a random walk. The structure of the journey, controls and data format are final; the physics is not yet in."]},
    ],
    "sources": ["Drew HR, et al. Structure of a B-DNA dodecamer. PNAS 78:2179 (1981). PDB 1BNA."],
    "datasets": datasets,
}
write_index(os.path.join(OUT, "index.json"), index)
print("wrote", OUT, {k: v["count"] for k, v in datasets.items()})
