"""Turn the simulation outputs into the app's data files (assets/data/).

Inputs (sim/work/): story.json, pelvis_vox.json, anatomy.json/.npz, dna_runs.json,
runs/dna_delta_t*.bin, runs/dna_primary_t*.bin, dsb.json, chromatin.npz,
runs/patient_fluence.json. Every number shown on screen is computed here and
stored with its derivation in index.json "numbers"; the raw inputs to each
number are stored in index.json "runs" so sim/check_physics.py can recompute
them from committed files only.
"""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
from datafmt import write_dataset, write_index, num  # noqa: E402
from run_dna import load  # noqa: E402
from dnamap import (nucleosome_template, linker_template, build_linker, rot_from_to, axis_angle, quat, unit)  # noqa: E402

W = os.path.join(HERE, "work")
OUT = os.path.join(HERE, "..", "assets", "data")
ME = 0.51099895
MEV_J = 1.602176634e-13
NUCLEUS_D_UM = 9.0
SOFT_TISSUE_DENSITY = 1.03  # g/cm3, G4_TISSUE_SOFT_ICRP
G4_PROC = {10: 10, 11: 11, 12: 12, 13: 11}
rng = np.random.default_rng(5)


def main():
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith(".bin") or f == "index.json":
            os.remove(os.path.join(OUT, f))
    st = json.load(open(os.path.join(W, "story.json")))
    vox = json.load(open(os.path.join(W, "pelvis_vox.json")))
    runs = json.load(open(os.path.join(W, "dna_runs.json")))
    dsb = json.load(open(os.path.join(W, "dsb.json")))
    flu = json.load(open(os.path.join(W, "runs", "patient_fluence.json")))
    ev = st["event"]
    P = ev["P"]
    E0, cx, din, E1, dout, Ee, de, entry, t_int = P[0], np.array(P[1:4]), np.array(P[4:7]), P[7], np.array(P[8:11]), P[11], np.array(P[12:15]), np.array(P[15:18]), P[18]
    C = cx  # Compton point, patient frame (mm, origin at the isocentre)
    datasets = {}

    # ---------------------------------------------------------- patient-scale electron (mm, origin at the Compton point)
    T = {int(k): v for k, v in ev["T"].items()}
    ids = sorted(T)
    renum = {tid: i for i, tid in enumerate(ids)}  # Geant4 track 2 (recoil electron) → 0
    pos, edep, tm, typ, trk, ek, sl = [], [], [], [], [], [], []
    t0 = T[2]["t_ns"]
    for tid in ids:
        tr = T[tid]
        pos.append(np.array(tr["pos"]) - C); edep.append(0); tm.append(tr["t_ns"] - t0); typ.append(6); trk.append(renum[tid]); ek.append(tr["E_keV"]); sl.append(0)
        for s in ev["S"]:
            if s["track"] == tid:
                pos.append(np.array(s["pos"]) - C); edep.append(s["edep_keV"]); tm.append(s["t_ns"] - t0)
                typ.append(G4_PROC.get(s["proc"], 11)); trk.append(renum[tid]); ek.append(s["ekin_keV"]); sl.append(s["len_mm"])
    datasets["patientElectron"] = write_dataset(os.path.join(OUT, "patientElectron.bin"), {
        "pos": ("f32", 3, pos), "edep": ("f32", 1, edep), "time": ("f32", 1, tm), "type": ("u8", 1, typ),
        "track": ("u16", 1, trk), "ekin": ("f32", 1, ek), "step": ("f32", 1, sl)}, units={"pos": "mm", "edep": "keV", "time": "ns", "ekin": "keV", "step": "mm (true path length of the step ending here)"})
    tracks = [dict(id=renum[t], parent=renum.get(T[t]["parent"], -1), E0_keV=T[t]["E_keV"], creator=T[t]["proc"]) for t in ids]
    prim_steps = [s for s in ev["S"] if s["track"] == 2]
    e_path = float(sum(s["len_mm"] for s in prim_steps))
    e_end = np.array(prim_steps[-1]["pos"])
    e_range = float(np.linalg.norm(e_end - np.array(T[2]["pos"])))

    # ---------------------------------------------------------- hand-off point and the delta electron
    dtr = T[st["delta_track"]]
    ho = np.array(dtr["pos"]) - C
    k = st["primary_step_index"]
    p_dir = unit(np.array(prim_steps[k]["pos"]) - np.array(prim_steps[k - 1]["pos"] if k > 0 else T[2]["pos"]))
    d_dir = unit(np.array(dtr["dir"]))

    # ---------------------------------------------------------- cell scale: fast electron, 40 µm centred on the hand-off (µm)
    pr = load("dna_primary")
    segs = []
    for e in np.unique(pr["ev"]):
        r = pr[pr["ev"] == e]
        t1 = r[r["track"] == 1]
        tpos = np.c_[t1["x"], t1["y"], t1["z"]]
        path_um = float(np.linalg.norm(np.diff(tpos, axis=0), axis=1).sum()) / 1000
        segs.append(dict(ev=int(e), E_start_keV=float(t1["ekin"][0] / 1000), E_end_keV=float(t1["ekin"][-1] / 1000), path_um=path_um,
                         edep_keV=float(r["edep"].sum() / 1000), n_ion=int((r["proc"] == 2).sum()), n_exc=int((r["proc"] == 1).sum())))
    show = segs[0]["ev"]
    r = pr[pr["ev"] == show]
    t1 = r[r["track"] == 1]
    # shift so the primary crosses z = 0 at the origin, then align +z with the primary direction at the hand-off
    kz = int(np.argmax(t1["z"] >= 0))
    shift = np.array([t1["x"][kz], t1["y"][kz], 0.0])
    Rp = rot_from_to(np.array([0, 0, 1.0]), p_dir) @ axis_angle(np.array([0, 0, 1.0]), rng.uniform(0, 2 * np.pi))
    xyz = (np.c_[r["x"], r["y"], r["z"]] - shift) @ Rp.T / 1000.0  # nm → µm
    keep = np.zeros(len(r), bool)
    keep |= (r["proc"] == 1) | (r["proc"] == 2) | (r["proc"] == 6)
    # thin elastic points to ~50 nm spacing per track so the drawn path keeps its shape
    last = {}
    for i in range(len(r)):
        tkey = int(r["track"][i])
        if tkey not in last or np.linalg.norm(xyz[i] - xyz[last[tkey]]) > 0.05:
            keep[i] = True
        if keep[i]:
            last[tkey] = i
    sel = np.nonzero(keep)[0]
    sel = sel[np.lexsort((r["t"][sel], r["track"][sel]))]
    tracks_cp = {int(t): i for i, t in enumerate(np.unique(r["track"][sel]))}
    datasets["cellPrimary"] = write_dataset(os.path.join(OUT, "cellPrimary.bin"), {
        "pos": ("f32", 3, xyz[sel]), "edep": ("f32", 1, r["edep"][sel]), "time": ("f32", 1, r["t"][sel] - r["t"][kz]),
        "type": ("u8", 1, r["proc"][sel]), "track": ("u16", 1, [tracks_cp[int(t)] for t in r["track"][sel]])},
        units={"pos": "µm", "edep": "eV", "time": "ns"})

    # ---------------------------------------------------------- the delta electron (nm, origin at the hand-off)
    dr = load("dna_delta")
    dr = dr[dr["ev"] == dsb["history"]]
    dr = dr[np.lexsort((dr["t"], dr["track"]))]
    R = rot_from_to(np.array([0, 0, 1.0]), d_dir) @ axis_angle(np.array([0, 0, 1.0]), dsb["phi"])
    dxyz = np.c_[dr["x"], dr["y"], dr["z"]].astype(np.float64) @ R.T
    dtracks = {int(t): i for i, t in enumerate(np.unique(dr["track"]))}
    datasets["delta"] = write_dataset(os.path.join(OUT, "delta.bin"), {
        "pos": ("f32", 3, dxyz), "edep": ("f32", 1, dr["edep"]), "time": ("f32", 1, dr["t"]), "type": ("u8", 1, dr["proc"]),
        "track": ("u16", 1, [dtracks[int(t)] for t in dr["track"]]), "ekin": ("f32", 1, dr["ekin"])}, units={"pos": "nm", "edep": "eV", "time": "ns", "ekin": "eV (before the step)"})
    d1 = dxyz[dr["track"] == 1]
    delta_path = float(np.linalg.norm(np.diff(d1, axis=0), axis=1).sum())
    delta_ions = int((dr["proc"] == 2).sum()); delta_exc = int((dr["proc"] == 1).sum())

    # ---------------------------------------------------------- chromatin around the track, and DNA atoms at the break
    ch = np.load(os.path.join(W, "chromatin.npz"))
    NT, LT = nucleosome_template(), linker_template()
    dep = dxyz[dr["edep"] > 0]
    from scipy.spatial import cKDTree
    dtree = cKDTree(dep)
    pair = [dsb["ssb"][i] for i in dsb["pair"]]
    chain = pair[0]["chain"]
    nuc_c = np.array([Rn @ NT["hist"].mean(0) + tn for Rn, tn in zip(ch["nuc_R"], ch["nuc_t"])])
    dist, _ = dtree.query(nuc_c)
    show_n = np.nonzero(dist < 55)[0]
    # always include the nucleosomes adjacent to the break
    near_break = np.nonzero(ch["nuc_chain"] == chain)[0]
    bp_break = (pair[0]["bp"] + pair[1]["bp"]) / 2
    adj = near_break[np.abs(ch["nuc_off"][near_break] + 73 - bp_break) < 400]
    show_n = np.unique(np.r_[show_n, adj])
    datasets["nucleosomes"] = write_dataset(os.path.join(OUT, "nucleosomes.bin"), {
        "pos": ("f32", 3, ch["nuc_t"][show_n]), "quat": ("f32", 4, [quat(ch["nuc_R"][i]) for i in show_n])}, units={"pos": "nm (NRF origin of 1KX5)"})
    shown = set(int(i) for i in show_n)
    lpos, ltime, ltr = [], [], []
    for j in range(len(ch["lk_a"])):
        a, b = ch["lk_a"][j], ch["lk_b"][j]
        if min(dtree.query(a)[0], dtree.query(b)[0]) < 55 or (ch["lk_chain"][j] == chain and abs(ch["lk_off"][j] - bp_break) < 400):
            lpos += [a, b]; ltime += [0, 0]; ltr += [j, j]
    datasets["linkers"] = write_dataset(os.path.join(OUT, "linkers.bin"), {"pos": ("f32", 3, lpos), "time": ("f32", 1, ltime), "track": ("u16", 1, ltr)}, units={"pos": "nm"})

    # DNA atoms ±12 bp around the break (all heavy atoms), from the same templates used for the mapping
    win = (bp_break - 12, bp_break + 12)
    A_pos, A_el, A_st, A_bp, A_bb = [], [], [], [], []
    for i in np.nonzero(ch["nuc_chain"] == chain)[0]:
        off = ch["nuc_off"][i]
        m = (NT["bp"] + off >= win[0]) & (NT["bp"] + off <= win[1])
        if m.any():
            A_pos.append(NT["pos"][m] @ ch["nuc_R"][i].T + ch["nuc_t"][i]); A_el.append(NT["elem"][m]); A_st.append(NT["strand"][m]); A_bp.append(NT["bp"][m] + off); A_bb.append(NT["bb"][m])
    axis = None
    for j in np.nonzero(ch["lk_chain"] == chain)[0]:
        off, n = ch["lk_off"][j], ch["lk_n"][j]
        if off + n < win[0] or off > win[1]:
            continue
        Rprev, tprev = ch["lk_Rprev"][j], ch["lk_tprev"][j]
        posl, bpl, _, _ = build_linker(LT, Rprev @ NT["exit"] + tprev, ch["lk_u"][j], Rprev @ NT["c1A"][146] + tprev, Rprev @ NT["exit"] + tprev, int(n))
        nat = len(LT["pos"])
        bpg = bpl + off
        m = (bpg >= win[0]) & (bpg <= win[1])
        A_pos.append(posl[m]); A_el.append(np.tile(LT["elem"], n)[m]); A_st.append(np.tile(LT["strand"], n)[m]); A_bp.append(bpg[m]); A_bb.append(np.tile(LT["bb"], n)[m])
        if off <= bp_break <= off + n:
            axis = ch["lk_u"][j]
    A_pos = np.concatenate(A_pos); A_el = np.concatenate(A_el); A_st = np.concatenate(A_st); A_bp = np.concatenate(A_bp); A_bb = np.concatenate(A_bb)
    def nt_centre(s, b):
        m = (A_st == s) & (A_bp == b) & (A_bb == 1)
        return A_pos[m].mean(0)
    site = (nt_centre(pair[0]["strand"], pair[0]["bp"]) + nt_centre(pair[1]["strand"], pair[1]["bp"])) / 2
    if axis is None:
        axis = unit(nt_centre(0, int(bp_break) + 3) - nt_centre(0, int(bp_break) - 3))
    ref = int(round(bp_break))
    datasets["dnaAtoms"] = write_dataset(os.path.join(OUT, "dnaAtoms.bin"), {
        "pos": ("f32", 3, A_pos - site), "elem": ("u8", 1, A_el), "strand": ("u8", 1, A_st), "bp": ("i32", 1, A_bp - ref), "backbone": ("u8", 1, A_bb)}, units={"pos": "nm"})
    ssb_list = []
    for s in dsb["ssb"]:
        if s["chain"] == chain and win[0] <= s["bp"] <= win[1]:
            ssb_list.append(dict(strand=s["strand"], bp=s["bp"] - ref, edep_eV=round(s["edep_eV"], 2), time_ns=s["time_ns"],
                                 pos_nm=(nt_centre(s["strand"], s["bp"]) - site).round(4).tolist()))
    pair_idx = [next(i for i, s in enumerate(ssb_list) if s["strand"] == p["strand"] and s["bp"] == p["bp"] - ref) for p in pair]
    sep = abs(pair[0]["bp"] - pair[1]["bp"])

    # ---------------------------------------------------------- numbers
    cos_t = float(np.dot(din, dout))
    theta = float(np.degrees(np.arccos(np.clip(cos_t, -1, 1))))
    depth = float(np.linalg.norm(cx - entry))
    seg_loss = np.array([(s["E_start_keV"] - s["E_end_keV"]) / s["path_um"] for s in segs])
    ion_rate = np.array([s["n_ion"] / s["path_um"] for s in segs])
    V_cm3 = 4 / 3 * np.pi * (flu["radius_mm"] / 10) ** 3
    dose_per_photon = flu["edep_MeV"] * MEV_J / (SOFT_TISSUE_DENSITY * V_cm3 * 1e-3) / flu["events"]
    phi_per_photon_um2 = flu["lenPrimaryE_mm"] / (V_cm3 * 1000) / flu["events"] * 1e-6  # mm/mm³ → per mm² → per µm²
    tracks_2Gy = phi_per_photon_um2 / dose_per_photon * 2.0 * np.pi * (NUCLEUS_D_UM / 2) ** 2
    nrl = 147 + float(np.mean(ch["lk_n"]))

    n = {
        "photonE0": num(E0, "MeV", "Photon energy", "Sampled by Geant4 from the Mohan et al. (1985) 6 MV spectrum", 3),
        "photonE1": num(E1, "MeV", "Scattered photon energy", "Geant4 (option4) Compton scatter; equals E0/(1+(E0/mc²)(1−cosθ)) for the recorded angle", 3),
        "photonAngle": num(theta, "°", "Photon scattering angle", "Angle between the photon directions before and after the interaction (Geant4)", 2),
        "electronE0": num(Ee, "MeV", "Recoil electron energy", "Kinetic energy of the Compton electron (Geant4); E0 − E1 minus the electron's binding energy", 3),
        "depth": num(depth, "mm", "Tissue crossed before the interaction", "Distance from where the photon entered the body to the interaction point (Geant4)", 3),
        "electronPath": num(e_path, "mm", "Recoil electron path length", "Sum of the electron's true step lengths until it stopped (Geant4, 1 µm production cut)", 2),
        "electronRange": num(e_range, "mm", "Recoil electron start-to-end distance", "Straight-line distance between where the electron started and stopped", 2),
        "letPrimary": num(float(seg_loss.mean()), "keV/µm", "Energy loss of the fast electron", f"Mean kinetic-energy loss per µm of the {runs['primary_E_handoff_keV']:.0f} keV electron over {len(segs)} simulated 40 µm segments (Geant4-DNA option2)", 2),
        "ionsPerUm": num(float(ion_rate.mean()), "per µm", "Ionisations per µm along the fast electron", "Mean number of ionisations (all tracks) per µm of primary path, same segments", 2),
        "deltaE": num(st["delta_E_keV"], "keV", "Delta electron energy", "Kinetic energy of the secondary electron when created (Geant4, patient run)", 3),
        "deltaRange": num(delta_path, "nm", "Delta electron path length", "Sum of the delta electron's step lengths in the chosen Geant4-DNA (option4) history", 2),
        "deltaIons": num(delta_ions, "", "Ionisations by the delta electron and its secondaries", "Count of ionisation events in the chosen history", 3),
        "photonTime": num(t_int, "ns", "Photon flight time from the target to the interaction", "Geant4 global time at the Compton interaction", 2),
        "electronTime": num(float(max(s["t_ns"] for s in prim_steps) - T[2]["t_ns"]) * 1000, "ps", "Recoil electron slowing-down time", "Global time of the electron's last step minus its start (Geant4)", 2),
        "deltaTime": num(float(dr["t"].max() - dr["t"].min()) * 1e6, "fs", "Duration of the delta electron's track", "Time span of all records in the chosen Geant4-DNA history", 2),
        "nucleusDiameter": num(NUCLEUS_D_UM, "µm", "Nucleus diameter", "Model value for a tumour cell nucleus (illustrative)", 2),
        "nrl": num(nrl, "bp", "Nucleosome repeat length (model)", "147 bp per nucleosome plus the mean linker length of the chromatin model (30–50 bp)", 3),
        "dsbSeparation": num(sep, "bp", "Separation of the two strand breaks", "Base-pair distance between the strand A and strand B breaks", 2),
        "ssbFraction": num(100 * dsb["trials_with_ssb"] / dsb["trials"], "%", "Delta tracks giving at least one strand break", f"{dsb['trials_with_ssb']} of {dsb['trials']} placements ({dsb['n_histories']} histories × {dsb['n_rotations']} rotations) in the chromatin model", 2),
        "dsbFraction": num(100 * dsb["trials_with_dsb"] / dsb["trials"], "%", "Delta tracks giving a double-strand break", f"{dsb['trials_with_dsb']} of {dsb['trials']} placements; direct effect only", 2),
        "tracksPerNucleus2Gy": num(tracks_2Gy, "", "Electron tracks through one nucleus in 2 Gy",
                                   f"Fluence of photon-set-in-motion electrons per Gy in a {flu['radius_mm']:.0f} mm sphere in the prostate (Geant4, {flu['events']:,} photons) × 2 Gy × π({NUCLEUS_D_UM / 2:g} µm)²", 2),
    }
    sr = story_run()
    n["storyPhotons"] = num(sr["photons"], "", "Photons simulated in the patient-scale story run", "/run/beamOn in sim/macros/patient_story.mac", 6)
    n["storyEvents"] = num(sr["qualifying_events"], "", "Photons whose first interaction was a Compton scatter in the prostate (0.3–1.0 MeV electron)", "Events written by the story run", 4)
    n["deltaHistories"] = num(dsb["n_histories"], "", "Geant4-DNA histories of the delta electron", "Histories in the option4 run", 4)
    n["placements"] = num(dsb["trials"], "", "Placements of delta tracks in the chromatin model", "histories × rotations", 5)
    n["fluencePhotons"] = num(flu["events"], "", "Photons in the dose/fluence run", "/run/beamOn in sim/macros/patient_fluence.mac", 7)
    for i, s in enumerate(ssb_list):
        if i in pair_idx:
            key = "ssbA_eV" if s["strand"] == 0 else "ssbB_eV"
            n[key] = num(s["edep_eV"], "eV", f"Backbone deposit, strand {'A' if s['strand'] == 0 else 'B'} break", "Sum of Geant4-DNA deposits inside that nucleotide's sugar–phosphate atoms", 3)

    # ---------------------------------------------------------- anatomy summary for the app (meshes come from assets/models)
    an = json.load(open(os.path.join(W, "anatomy.json")))
    npz = np.load(os.path.join(W, "anatomy.npz"))
    anatomy = []
    colors = {"prostate": "#ffb35c", "bladder": "#6fd0c0", "rectum": "#c98a84", "bone": "#e8e2d0"}
    for oid, o in an.items():
        V = npz[f"{oid}_V"] - C
        anatomy.append(dict(id=oid, label=o["label"], center_mm=V.mean(0).round(2).tolist(), radii_mm=((V.max(0) - V.min(0)) / 2).round(2).tolist(),
                            color=colors.get(oid, colors["bone"] if o["material"] == "bone" else "#9fb4c8")))
    bV = npz["body_V"] - C
    pel = np.abs(bV[:, 2] - (-C[2])) < 160
    anatomy.insert(0, dict(id="body", label="Body surface (MakeHuman)", center_mm=((bV[pel].max(0) + bV[pel].min(0)) / 2).round(2).tolist(),
                           radii_mm=((bV[pel].max(0) - bV[pel].min(0)) / 2).round(2).tolist(), color="#7f9fb8", rim=2.8, strength=0.42))

    index = {
        "synthetic": False,
        "generator": "sim/process.py",
        "frames": {
            "patient": "mm; origin at the Compton interaction point; +x patient left, +y anterior (towards the gantry head at 0°), +z inferior",
            "tissue": "µm; same origin and axes as patient",
            "cell": "µm; origin at the hand-off point (where the delta electron is created); patient axes",
            "chromatin": "nm; origin at the hand-off point; patient axes",
            "dna": "nm; origin at the DSB site; patient axes",
        },
        "geometry": {"iso_mm": (-C).round(4).tolist(), "source_mm": (np.array([0, 1000.0, 0]) - C).round(4).tolist(), "isoHeight_mm": 1250,
                     "couchTop_mm": round(vox["couchTop_mm"] - C[1], 3), "field_mm": [100, 100], "skinEntry_mm": (entry - C).round(4).tolist()},
        "photon": {"E0": E0, "dirIn": din.tolist(), "E1": E1, "dirOut": dout.tolist(), "time_ns": t_int},
        "electron": {"E0": Ee, "dir": de.tolist(), "tracks": tracks},
        "handoff": {"kind": "delta", "origin_mm": ho.round(6).tolist(), "E_keV": st["delta_E_keV"], "parentE_keV": runs["primary_E_handoff_keV"],
                    "dir": d_dir.tolist(), "primaryDir": p_dir.tolist(), "pathFromStart_mm": st["delta_path_mm"],
                    "cell": {"centre_um": [2.2, -1.1, 1.6], "radius_um": 6.8, "nucleusCentre_um": [1.0, -0.5, 0.9], "nucleusRadius_um": NUCLEUS_D_UM / 2}},
        "dsb": {"site_nm": site.round(4).tolist(), "axis": unit(axis).round(6).tolist(), "ssb": ssb_list, "pair": pair_idx, "separation_bp": int(sep),
                "showRadius_nm": 4.0, "inLinker": dsb["in_linker"], "chain": int(chain)},
        "anatomy": anatomy,
        "models": {"room": "room.glb", "body": "patient_body.glb", "pelvis": "pelvis_organs.glb", "nucleosome": "nucleosome.glb"},
        "numbers": n,
        "runs": {
            "fluence": flu | {"soft_tissue_density_g_cm3": SOFT_TISSUE_DENSITY, "nucleus_diameter_um": NUCLEUS_D_UM},
            "primarySegments": segs,
            "dsbSearch": {k: dsb[k] for k in ("trials", "trials_with_ssb", "trials_with_dsb", "n_histories", "n_rotations", "n_nucleosomes", "n_linkers", "region_radius_nm", "density_per_nm3")},
            "linkerLengths_bp": [int(x) for x in ch["lk_n"]],
            "dna": runs,
            "story": story_run(),
        },
        "eventTypes": {"0": "elastic scattering", "1": "electronic excitation", "2": "ionisation", "3": "vibrational excitation", "4": "dissociative attachment",
                       "5": "thermalisation (solvation)", "6": "track start", "10": "condensed-history step (eIoni)", "11": "condensed-history step (msc / transport)", "12": "bremsstrahlung"},
        "notes": notes(n, dsb, runs, flu, segs),
        "sources": SOURCES,
        "datasets": datasets,
    }
    write_index(os.path.join(OUT, "index.json"), index)
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print("wrote", OUT, {k: v["count"] for k, v in datasets.items()}, f"{total / 1024:.0f} KiB")
    for k, v in n.items():
        print(f"  {k:20s} {v['value']:.5g} {v['unit']}")


def story_run():
    """Photons fired in the patient-scale story run and how many qualified."""
    mac = open(os.path.join(HERE, "macros", "patient_story.mac")).read()
    photons = int([l.split()[1] for l in mac.splitlines() if l.startswith("/run/beamOn")][-1])
    events = sum(1 for l in open(os.path.join(W, "runs", "patient_story.txt")) if l.startswith("E "))
    return {"photons": photons, "qualifying_events": events,
            "criteria": "first real interaction a Compton scatter within 15 mm of the isocentre, recoil electron 0.3–1.0 MeV"}


def notes(n, dsb, runs, flu, segs):
    f = lambda k, d=3: f"{n[k]['value']:.{d}g} {n[k]['unit']}".strip()
    return [
        {"h": "What you are seeing", "p": [
            "One photon from a 6 MV beam, followed from the treatment head to a break in DNA. Each scale is its own simulation, and the hand-offs between them carry the particle's type, energy and direction.",
            f"Time is slowed by a different factor at each scale: the photon reaches the interaction {f('photonTime', 2)} after leaving the target, the recoil electron stops {f('electronTime', 2)} later, and the delta electron's whole track takes {f('deltaTime', 2)}."]},
        {"h": "How the scales are stitched", "p": [
            f"Patient: Geant4 11.4 with G4EmStandardPhysics_option4 in a voxelised pelvis (2.5 mm voxels; soft tissue, bone, urine and air) built from the anatomy meshes. Photons start at the X-ray target 100 cm above the isocentre and are aimed over a 10 × 10 cm field, with energies drawn from the Mohan et al. (1985) 6 MV spectrum. We kept photons whose first interaction was a Compton scatter in the prostate and recorded the recoil electron and all its secondaries with a 1 µm production cut.",
            f"From that event we took one delta electron of {f('deltaE')} created {runs['primary_E_handoff_keV']:.0f} keV into the recoil electron's slowing-down, inside the prostate.",
            f"Cell and DNA scales: Geant4-DNA in liquid water. The fast electron at the hand-off energy was simulated over 40 µm with G4EmDNAPhysics_option2 (valid to 1 MeV). The delta electron, at the same energy and direction, was simulated {dsb['n_histories']} times with G4EmDNAPhysics_option4; each history records every elastic scatter, excitation and ionisation.",
            "The fast electron's cell-scale segment is placed so that it passes through the hand-off point; its exact path differs from the patient-scale one, which only resolved steps of several micrometres."]},
        {"h": "Strand breaks", "p": [
            f"The chromatin model is built from PDB 1KX5 nucleosomes joined by straight B-DNA linkers built from PDB 1BNA, packed around the track at about 0.7 of the average nuclear DNA density ({dsb['n_nucleosomes']} nucleosomes).",
            "A deposit counts towards a nucleotide's backbone if it falls inside the van der Waals sphere of one of its sugar or phosphate atoms. A strand break is scored when one nucleotide's backbone receives more than 17.5 eV (the threshold used by Nikjoo et al. 2001 for direct damage). Two breaks on opposite strands within 10 base pairs make a double-strand break.",
            f"We tried each delta history at {dsb['n_rotations']} rotations about its starting direction: {f('ssbFraction', 2)} of the {dsb['trials']} placements gave at least one strand break and {f('dsbFraction', 2)} gave a double-strand break. The one shown is a real history and placement from that search, chosen to fall in linker DNA."]},
        {"h": "Sparse tracks and dense ends", "p": [
            f"A {runs['primary_E_handoff_keV']:.0f} keV electron loses about {f('letPrimary', 2)} on average, about {f('ionsPerUm', 2)} ionisation per micrometre: across a 10 µm cell, a few dozen ionisations spread along a line. Clustered damage needs several ionisations within a few nanometres, which mostly happens along slow secondary electrons and at track ends, where the energy loss per unit length is much higher."]},
        {"h": "Tracks per nucleus", "p": [
            f"In a 1 cm-radius sphere of soft tissue in the prostate, Geant4 gives the dose and the track length of electrons set in motion by photons (Compton, photoelectric and pair production electrons, above the 0.1 mm production cut). Fluence per gray times 2 Gy times the cross-section of a {NUCLEUS_D_UM:g} µm nucleus gives about {n['tracksPerNucleus2Gy']['value']:,.0f} tracks. Delta electrons are not counted as separate tracks."]},
        {"h": "Known approximations", "p": [
            "DNA, histones and the cell are modelled as liquid water for the physics; only direct energy deposition is scored (no water radiolysis or radical attack, which in reality causes much of the damage from X-rays).",
            "The beam is a point source with a uniform 10 × 10 cm field and one spectrum everywhere (no flattening-filter softening off axis, no head scatter or electron contamination). The linac and room are generic and vendor-neutral.",
            "The anatomy combines two different people: a MakeHuman body surface and BodyParts3D organs and bones placed by matching the hip joints (translation only). Bone is one homogenised material (ICRP cortical bone composition at 1.40 g/cm³).",
            "The cell, nucleus and chromatin territories are illustrative; the chromatin packing is a simple self-avoiding chain model, not a measured structure.",
            "Strand-break yields depend strongly on the threshold and target-volume definitions; the percentages above apply to this model only."]},
    ]


SOURCES = [
    "Geant4: Agostinelli S et al. Nucl Instrum Methods A 506:250 (2003); Allison J et al. IEEE Trans Nucl Sci 53:270 (2006); Allison J et al. Nucl Instrum Methods A 835:186 (2016).",
    "Geant4-DNA: Incerti S et al. Med Phys 37:4692 (2010); Bernal MA et al. Phys Med 31:861 (2015); Incerti S et al. Med Phys 45:e722 (2018); Med Phys 51:5873 (2024) — as cited in the Geant4 dnaphysics example.",
    "6 MV spectrum: Mohan R, Chui C, Lidofsky L. Energy and angular distributions of photons from medical linear accelerators. Med Phys 12:592–597 (1985). doi:10.1118/1.595680. Values as tabulated in EGSnrc (mohan6.spectrum).",
    "Strand-break threshold: Nikjoo H, O'Neill P, Wilson WE, Goodhead DT. Computational approach for determining the spectrum of DNA damage induced by ionizing radiation. Radiat Res 156:577–583 (2001). doi:10.1667/0033-7587(2001)156[0577:CAFDTS]2.0.CO;2.",
    "B-DNA: Drew HR et al. Structure of a B-DNA dodecamer. PNAS 78:2179 (1981). PDB 1BNA.",
    "Nucleosome: Davey CA, Sargent DF, Luger K, Maeder AW, Richmond TJ. Solvent mediated interactions in the structure of the nucleosome core particle at 1.9 Å resolution. J Mol Biol 319:1097 (2002). PDB 1KX5.",
    "Anatomy: BodyParts3D, © The Database Center for Life Science, CC BY-SA 2.1 JP (Mitsuhashi N et al. Nucleic Acids Res 37:D782, 2009). Body surface: MakeHuman (CC0).",
]

if __name__ == "__main__":
    main()
