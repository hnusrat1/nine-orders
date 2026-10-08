"""Pick the story event from the patient-scale run.

Criteria (all from the simulation output, sim/work/runs/patient_story.txt):
  - the photon's first interaction is a Compton scatter within 15 mm of the
    isocentre (enforced in the run) and the recoil electron has 0.3–1.0 MeV;
  - the recoil electron sets a delta electron of 2–5 keV in motion, between
    0.15 and 0.8 mm along its path, inside the prostate (voxel label);
  - among those, prefer a more energetic recoil electron and a delta near 3 keV.
Writes sim/work/story.json.
"""
import json, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
W = os.path.join(HERE, "work")


def parse(path):
    evs, cur = [], None
    for line in open(path):
        t = line.split()
        if t[0] == "E":
            cur = {"id": int(t[1]), "T": {}, "S": []}
        elif t[0] == "P":
            cur["P"] = [float(x) for x in t[1:]]
        elif t[0] == "T":
            cur["T"][int(t[1])] = dict(parent=int(t[2]), proc=t[3], E_keV=float(t[4]), pos=[float(x) for x in t[5:8]],
                                       dir=[float(x) for x in t[8:11]], t_ns=float(t[11]))
        elif t[0] == "S":
            cur["S"].append(dict(track=int(t[1]), pos=[float(x) for x in t[2:5]], edep_keV=float(t[5]), ekin_keV=float(t[6]),
                                 t_ns=float(t[7]), proc=int(t[8]), mat=t[9], len_mm=float(t[10])))
        elif t[0] == "EE":
            evs.append(cur)
    return evs


def label_at(p, vox, lab):
    o = np.array(vox["origin_mm"]); v = vox["voxel_mm"]; nx, ny, nz = vox["n"]
    i, j, k = ((np.array(p) - o) / v).astype(int)
    if not (0 <= i < nx and 0 <= j < ny and 0 <= k < nz):
        return "air"
    return vox["labels"][str(int(lab[k, j, i]))]


def main():
    vox = json.load(open(os.path.join(W, "pelvis_vox.json")))
    nx, ny, nz = vox["n"]
    lab = np.fromfile(os.path.join(W, "pelvis_labels.bin"), np.uint8).reshape(nz, ny, nx)
    evs = parse(os.path.join(W, "runs", "patient_story.txt"))
    cands = []
    for e in evs:
        prim = [s for s in e["S"] if s["track"] == 2]
        start = e["T"][2]
        s_path = np.cumsum([s["len_mm"] for s in prim])
        for tid, tr in e["T"].items():
            if tr["parent"] != 2 or tr["proc"] != "eIoni" or not (2.0 <= tr["E_keV"] <= 5.0):
                continue
            # the primary step that created it: the step whose post point is the delta's start
            d = [np.linalg.norm(np.array(s["pos"]) - tr["pos"]) for s in prim]
            k = int(np.argmin(d))
            if d[k] > 1e-6:
                continue
            path = s_path[k]
            if not (0.15 <= path <= 0.8):
                continue
            if label_at(tr["pos"], vox, lab) != "prostate":
                continue
            e_before = prim[k - 1]["ekin_keV"] if k > 0 else start["E_keV"]
            score = e["P"][11] * 2 - abs(tr["E_keV"] - 3.0) * 0.15 - abs(path - 0.4)
            cands.append((score, e["id"], tid, path, tr["E_keV"], e_before, k))
    cands.sort(reverse=True)
    print(f"{len(evs)} events, {len(cands)} candidate deltas")
    for c in cands[:8]:
        print("  score %.2f event %d delta track %d at %.3f mm, %.2f keV (primary %.1f keV before)" % c[:6])
    if not cands:
        raise SystemExit("no candidate: run more photons")
    _, eid, tid, path, Ed, Epre, k = cands[0]
    e = next(x for x in evs if x["id"] == eid)
    json.dump({"event": e, "delta_track": tid, "delta_path_mm": path, "delta_E_keV": Ed, "primary_E_before_keV": Epre,
               "primary_step_index": k, "label_at_delta": "prostate"}, open(os.path.join(W, "story.json"), "w"))
    print("chosen: event", eid, "delta track", tid)


if __name__ == "__main__":
    main()
