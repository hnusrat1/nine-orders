"""Recompute every on-screen number from the committed data files.

Reads assets/data/index.json and the binary datasets, recomputes each entry
of index["numbers"] independently, and fails (exit 1) if any value differs
from what the app displays by more than the display rounding allows.
Numbers whose derivation is marked SYNTHETIC are reported but not checked.

Usage: python3 sim/check_physics.py
"""
import json, math, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "assets", "data")
ME = 0.51099895  # MeV, CODATA 2018
DT = {"f32": np.float32, "u8": np.uint8, "u16": np.uint16, "i32": np.int32, "u32": np.uint32}


def load():
    ix = json.load(open(os.path.join(DATA, "index.json")))
    sets = {}
    for name, d in ix["datasets"].items():
        buf = open(os.path.join(DATA, d["url"]), "rb").read()
        s = {"count": d["count"]}
        for f, spec in d["fields"].items():
            n = d["count"] * spec.get("size", 1)
            a = np.frombuffer(buf, dtype=DT[spec["type"]], count=n, offset=spec["offset"])
            s[f] = a.reshape(d["count"], spec["size"]) if spec.get("size", 1) > 1 else a
        sets[name] = s
    return ix, sets


def path_length(pos):
    return float(np.linalg.norm(np.diff(pos, axis=0), axis=1).sum()) if len(pos) > 1 else 0.0


def recompute(ix, S):
    """Return {key: (value, how)} for every number we can derive from data."""
    out = {}
    ph = ix["photon"]
    din, dout = np.array(ph["dirIn"]), np.array(ph["dirOut"])
    cos_t = float(np.dot(din, dout) / np.linalg.norm(din) / np.linalg.norm(dout))
    theta = math.degrees(math.acos(max(-1, min(1, cos_t))))
    E0 = ph["E0"]
    E1 = E0 / (1 + (E0 / ME) * (1 - cos_t))
    out["photonE0"] = (E0, "photon.E0 in index.json (sampled energy)")
    out["photonAngle"] = (theta, "angle between photon.dirIn and photon.dirOut")
    out["photonE1"] = (E1, "Compton formula E0/(1+(E0/mc²)(1−cosθ)) with θ from the directions")
    out["electronE0"] = (E0 - E1, "E0 − E1 (binding energy neglected)")
    pe = S["patientElectron"]
    prim = pe["pos"][pe["track"] == 0]
    out["electronPath"] = (path_length(prim), "sum of primary-electron step lengths in patientElectron.bin")
    if "ekin" in pe:
        out["electronE0_track"] = (float(pe["ekin"][pe["track"] == 0][0]) / 1000.0, "first ekin of the primary track (keV→MeV)")
    d = S["delta"]
    out["deltaRange"] = (path_length(d["pos"][d["track"] == 0]), "sum of delta-electron (track 0) step lengths in delta.bin")
    dsb = ix["dsb"]
    a, b = (dsb["ssb"][k] for k in dsb["pair"])
    out["dsbSeparation"] = (abs(a["bp"] - b["bp"]), "|bp(strand A break) − bp(strand B break)|")
    g = ix["geometry"]
    # depth: distance from skin entry to interaction along the incoming direction, if recorded
    if "skinEntry_mm" in g:
        out["depth"] = (float(np.linalg.norm(np.array(g["skinEntry_mm"]))), "|skin entry point − interaction point|")
    out["nucleusDiameter"] = (2 * ix["handoff"]["cell"]["nucleusRadius_um"], "2 × handoff.cell.nucleusRadius_um (model cell geometry)")
    cp = S["cellPrimary"]
    sel = cp["track"] == 0
    L = path_length(cp["pos"][sel])
    if L > 0:
        out["letPrimary"] = (float(cp["edep"][sel].sum()) / 1000.0 / L, "Σ edep of the fast electron (track 0) / its path length in cellPrimary.bin")
    return out


def check():
    ix, S = load()
    calc = recompute(ix, S)
    bad = 0
    rows = []
    for key, n in ix["numbers"].items():
        shown = n["value"]
        synthetic = "SYNTHETIC" in n.get("derivation", "")
        if key in calc:
            v, how = calc[key]
            digits = n.get("digits", 3)
            tol = max(abs(v) * 10 ** (-digits + 1) * 0.5, 1e-12)
            ok = abs(shown - v) <= tol
            status = "ok" if ok else ("SYNTHETIC" if synthetic else "MISMATCH")
            if not ok and not synthetic:
                bad += 1
            rows.append((key, f"{shown:.6g}", f"{v:.6g}", status, how))
        else:
            ext = n.get("check")
            if ext:
                rows.append((key, f"{shown:.6g}", "", "see " + ext, n.get("derivation", "")))
            else:
                rows.append((key, f"{shown:.6g}", "", "SYNTHETIC (not checked)" if synthetic else "NOT RECOMPUTED", n.get("derivation", "")))
                if not synthetic:
                    bad += 1
    # internal consistency
    if abs(ix["photon"]["E1"] - calc["photonE1"][0]) > 1e-3 * calc["photonE1"][0]:
        rows.append(("photon.E1", str(ix["photon"]["E1"]), f'{calc["photonE1"][0]:.6g}', "MISMATCH", "index photon.E1 vs Compton formula")); bad += 1
    if "electronE0_track" in calc and abs(calc["electronE0_track"][0] - calc["electronE0"][0]) > 0.01 * calc["electronE0"][0]:
        rows.append(("electron start", f'{calc["electronE0_track"][0]:.6g}', f'{calc["electronE0"][0]:.6g}', "MISMATCH", "first step energy vs E0−E1")); bad += 1
    w = max(len(r[0]) for r in rows)
    for r in rows:
        print(f"{r[0]:<{w}}  shown {r[1]:>10}  recomputed {r[2]:>10}  {r[3]:<24} {r[4]}")
    if ix.get("synthetic"):
        print("\nNOTE: data set is synthetic (skeleton build).")
    print(f"\n{bad} problem(s)")
    return bad


if __name__ == "__main__":
    sys.exit(1 if check() else 0)
