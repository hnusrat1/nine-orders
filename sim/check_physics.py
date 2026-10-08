"""Recompute every on-screen number from the committed data files.

Reads assets/data/index.json and the binary datasets and recomputes each entry
of index["numbers"] independently (from the datasets, or from the raw run
summaries stored in index["runs"]). Fails (exit 1) if any value differs from
what the app shows by more than the display rounding allows, or if a number
has no independent check. Synthetic data sets are reported but not enforced.

Usage: python3 sim/check_physics.py
"""
import json, math, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "assets", "data")
ME = 0.51099895        # MeV, CODATA 2018
MEV_J = 1.602176634e-13
DT = {"f32": np.float32, "u8": np.uint8, "u16": np.uint16, "i32": np.int32, "u32": np.uint32}


def load():
    ix = json.load(open(os.path.join(DATA, "index.json")))
    sets = {}
    for name, d in ix["datasets"].items():
        buf = open(os.path.join(DATA, d["url"]), "rb").read()
        s = {"count": d["count"]}
        for f, spec in d["fields"].items():
            n = d["count"] * spec.get("size", 1)
            a = np.frombuffer(buf, dtype=DT[spec["type"]], count=n, offset=spec["offset"]).astype(np.float64 if spec["type"] == "f32" else np.int64)
            s[f] = a.reshape(d["count"], spec["size"]) if spec.get("size", 1) > 1 else a
        sets[name] = s
    return ix, sets


def path_length(pos):
    return float(np.linalg.norm(np.diff(pos, axis=0), axis=1).sum()) if len(pos) > 1 else 0.0


def recompute(ix, S):
    """{key: (value, how, rel_tol)}; rel_tol None → display rounding."""
    out = {}
    ph = ix["photon"]
    din, dout = np.array(ph["dirIn"]), np.array(ph["dirOut"])
    cos_t = float(np.dot(din, dout) / np.linalg.norm(din) / np.linalg.norm(dout))
    E0 = ph["E0"]
    out["photonAngle"] = (math.degrees(math.acos(max(-1, min(1, cos_t)))), "angle between photon.dirIn and photon.dirOut", None)
    kn = E0 / (1 + (E0 / ME) * (1 - cos_t))
    # Geant4's Compton model scatters on bound, moving electrons (Doppler broadening):
    # E1 may differ from the free-electron formula by a little.
    out["photonE1"] = (kn, "Klein–Nishina kinematics E0/(1+(E0/mc²)(1−cosθ)); Doppler broadening allowed (≤1%)", 0.01)
    pe = S["patientElectron"]
    prim = pe["track"] == 0
    out["photonE0"] = (ph["E1"] + float(pe["ekin"][prim][0]) / 1000.0, "scattered photon + recoil electron energy (+ binding ≤ 1 keV)", 0.001)
    out["electronE0"] = (float(pe["ekin"][prim][0]) / 1000.0, "first kinetic energy of the primary track in patientElectron.bin", None)
    if "step" in pe:
        out["electronPath"] = (float(pe["step"][prim].sum()), "sum of true step lengths of track 0 in patientElectron.bin", None)
    else:
        out["electronPath"] = (path_length(pe["pos"][prim]), "sum of distances between track-0 points", None)
    pp = pe["pos"][prim]
    out["electronRange"] = (float(np.linalg.norm(pp[-1] - pp[0])), "distance between first and last track-0 points", None)
    g = ix["geometry"]
    if "skinEntry_mm" in g:
        out["depth"] = (float(np.linalg.norm(np.array(g["skinEntry_mm"]))), "|skin entry point − interaction point| (interaction is the origin)", None)
    d = S["delta"]
    d0 = d["track"] == 0
    out["deltaRange"] = (path_length(d["pos"][d0]), "sum of track-0 step lengths in delta.bin", None)
    if "ekin" in d:
        out["deltaE"] = (float(d["ekin"][d0][0]) / 1000.0, "kinetic energy at the first point of track 0 in delta.bin (eV → keV)", None)
    out["deltaIons"] = (int((d["type"] == 2).sum()), "count of ionisation records (type 2) in delta.bin", None)
    dsb = ix["dsb"]
    a, b = (dsb["ssb"][k] for k in dsb["pair"])
    out["dsbSeparation"] = (abs(a["bp"] - b["bp"]), "|bp(strand A break) − bp(strand B break)|", None)
    for s in (a, b):
        out["ssbA_eV" if s["strand"] == 0 else "ssbB_eV"] = (s["edep_eV"], "edep_eV of the break in index.dsb.ssb", None)
    out["nucleusDiameter"] = (2 * ix["handoff"]["cell"]["nucleusRadius_um"], "2 × handoff.cell.nucleusRadius_um (model cell geometry)", None)
    R = ix.get("runs", {})
    if "primarySegments" in R:
        segs = R["primarySegments"]
        out["letPrimary"] = (float(np.mean([(s["E_start_keV"] - s["E_end_keV"]) / s["path_um"] for s in segs])), f"mean (E_start − E_end)/path over {len(segs)} segments in index.runs.primarySegments", None)
        out["ionsPerUm"] = (float(np.mean([s["n_ion"] / s["path_um"] for s in segs])), "mean ionisations per µm over the same segments", None)
    if "dsbSearch" in R:
        q = R["dsbSearch"]
        out["ssbFraction"] = (100 * q["trials_with_ssb"] / q["trials"], "100 × trials_with_ssb / trials (index.runs.dsbSearch)", None)
        out["dsbFraction"] = (100 * q["trials_with_dsb"] / q["trials"], "100 × trials_with_dsb / trials", None)
    if "linkerLengths_bp" in R:
        out["nrl"] = (147 + float(np.mean(R["linkerLengths_bp"])), "147 + mean of index.runs.linkerLengths_bp", None)
    if "fluence" in R:
        f = R["fluence"]
        V_cm3 = 4 / 3 * math.pi * (f["radius_mm"] / 10) ** 3
        D = f["edep_MeV"] * MEV_J / (f["soft_tissue_density_g_cm3"] * V_cm3 * 1e-3) / f["events"]     # Gy per photon
        phi = f["lenPrimaryE_mm"] / (V_cm3 * 1000) / f["events"] * 1e-6                                 # electrons per µm² per photon
        out["tracksPerNucleus2Gy"] = (phi / D * 2 * math.pi * (f["nucleus_diameter_um"] / 2) ** 2, "(track length / volume) / (energy / mass) × 2 Gy × π r² from index.runs.fluence", None)
    cp = S["cellPrimary"]
    out["_cellPrimary_ions_per_um"] = (float((cp["type"] == 2).sum()) / max(path_length(cp["pos"][cp["track"] == 0]), 1e-9), "shown segment only (information)", None)
    return out


def check():
    ix, S = load()
    calc = recompute(ix, S)
    synthetic = bool(ix.get("synthetic"))
    bad, rows = 0, []
    for key, n in ix["numbers"].items():
        shown = n["value"]
        if key in calc:
            v, how, tol = calc[key]
            digits = n.get("digits", 3)
            if tol is None:
                tol_abs = max(abs(v) * 10 ** (-digits + 1) * 0.5, 1e-9)
            else:
                tol_abs = abs(v) * tol
            ok = abs(shown - v) <= tol_abs
            if not ok and not synthetic:
                bad += 1
            rows.append((key, f"{shown:.6g}", f"{v:.6g}", "ok" if ok else ("SYNTHETIC" if synthetic else "MISMATCH"), how))
        else:
            rows.append((key, f"{shown:.6g}", "", "not checked (synthetic)" if synthetic else "NO CHECK", n.get("derivation", "")))
            if not synthetic:
                bad += 1
    # consistency checks between index fields and datasets
    pe = S["patientElectron"]
    e_track = float(pe["ekin"][pe["track"] == 0][0]) / 1000.0
    if not synthetic:
        if abs(e_track - ix["electron"]["E0"]) > 1e-4:
            rows.append(("electron.E0", f'{ix["electron"]["E0"]:.6g}', f"{e_track:.6g}", "MISMATCH", "index electron.E0 vs dataset")); bad += 1
        binding = (ix["photon"]["E0"] - ix["photon"]["E1"] - e_track) * 1e3
        rows.append(("binding energy", f"{binding:.3g} keV", "", "ok" if -1e-3 <= binding < 1.0 else "MISMATCH", "E0 − E1 − Ee must be a small positive binding energy"))
        if not (-1e-3 <= binding < 1.0):
            bad += 1
        if abs(ix["handoff"]["E_keV"] - calc["deltaE"][0]) > 1e-3:
            rows.append(("handoff.E_keV", str(ix["handoff"]["E_keV"]), f'{calc["deltaE"][0]:.6g}', "MISMATCH", "delta energy, patient run vs Geant4-DNA start")); bad += 1
    w = max(len(r[0]) for r in rows)
    for r in rows:
        print(f"{r[0]:<{w}}  shown {r[1]:>12}  recomputed {r[2]:>10}  {r[3]:<10} {r[4]}")
    print(f"(info) ionisations per µm in the shown cell-scale segment: {calc['_cellPrimary_ions_per_um'][0]:.3g}")
    if synthetic:
        print("\nNOTE: data set is synthetic (skeleton build).")
    print(f"\n{bad} problem(s)")
    return bad


if __name__ == "__main__":
    sys.exit(1 if check() else 0)
