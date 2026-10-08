"""Map Geant4-DNA energy deposits onto DNA and find a double-strand break.

Chromatin model (nm, origin at the hand-off point, patient axes):
  - nucleosomes: all heavy atoms of PDB 1KX5 (147 bp on a histone octamer),
    as distributed in the nucleosome reference frame by pynucl (1KX5_NRF.pdb);
  - linker DNA: straight B-DNA built from PDB 1BNA (sim/lib/bdna.py), 30–50 bp;
  - chains grow nucleosome by nucleosome (exit → straight linker → entry, random
    rotation about the linker) inside a sphere around the delta track, rejecting
    steric clashes, up to ~0.7× the mean nuclear DNA density.
Damage model (direct effect only, no chemistry):
  - a deposit belongs to a nucleotide's backbone if it lies inside the van der
    Waals sphere of one of its sugar–phosphate atoms (nearest atom);
  - SSB: summed backbone deposit in one nucleotide > 17.5 eV;
  - DSB: two SSBs on opposite strands of the same DNA molecule within 10 bp.
Placements: each simulated delta history is aligned with the delta direction from
the patient-scale event and tried at several random rotations about that axis.
Writes sim/work/dsb.json and sim/work/chromatin.npz.
"""
import json, os, sys
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
from bdna import read_pdb, bdna_from_1bna, BACKBONE, ELEM  # noqa: E402
from run_dna import load  # noqa: E402

W = os.path.join(HERE, "work")
SSB_EV = 17.5
DSB_BP = 10
RISE = 0.338
VDW = np.array([0.170, 0.155, 0.152, 0.180, 0.110])  # C N O P H
NUC_DENSITY = 0.7 * 6.4e9 / (4 / 3 * np.pi * (4.9e3) ** 3) / 190  # nucleosomes per nm^3
rng = np.random.default_rng(20251008)


def rot_from_to(a, b):
    a = a / np.linalg.norm(a); b = b / np.linalg.norm(b)
    v = np.cross(a, b); c = float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-9:
        if c > 0:
            return np.eye(3)
        p = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 1.0, 0])
        return axis_angle(np.cross(a, p), np.pi)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K / (1 + c)


def axis_angle(ax, t):
    ax = ax / np.linalg.norm(ax)
    K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
    return np.eye(3) + np.sin(t) * K + (1 - np.cos(t)) * K @ K


def quat(R):
    t = np.trace(R)
    if t > 0:
        s = np.sqrt(t + 1) * 2
        return np.array([(R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s, 0.25 * s])
    i = int(np.argmax(np.diag(R)))
    j, k = (i + 1) % 3, (i + 2) % 3
    s = np.sqrt(1 + R[i, i] - R[j, j] - R[k, k]) * 2
    q = np.zeros(4)
    q[i] = 0.25 * s; q[j] = (R[j, i] + R[i, j]) / s; q[k] = (R[k, i] + R[i, k]) / s; q[3] = (R[k, j] - R[j, k]) / s
    return q


# ------------------------------------------------------------------ templates
def nucleosome_template():
    A = read_pdb(os.path.join(HERE, "inputs", "1KX5_NRF.pdb"))
    dna = [a for a in A if a["chain"] in "IJ" and a["res"] in ("DA", "DT", "DG", "DC")]
    pos = np.array([a["xyz"] for a in dna])
    strand = np.array([0 if a["chain"] == "I" else 1 for a in dna])
    bp = np.array([a["resi"] + 73 if a["chain"] == "I" else -a["resi"] + 73 for a in dna])  # pair index 0..146 along chain I
    elem = np.array([ELEM.get(a["el"][0], 0) for a in dna])
    bb = np.array([1 if a["name"] in BACKBONE else 0 for a in dna])
    c1 = {(s, b): p for p, s, b, a in zip(pos, strand, bp, dna) if a["name"] == "C1'"}
    centre = np.array([(c1[(0, k)] + c1[(1, k)]) / 2 for k in range(147)])
    hist = np.array([a["xyz"] for a in A if a["chain"] in "ABCDEFGH"])
    hist_elem = np.array([ELEM.get(a["el"][0], 0) for a in A if a["chain"] in "ABCDEFGH"])
    return dict(pos=pos, strand=strand, bp=bp, elem=elem, bb=bb, centre=centre, c1A=np.array([c1[(0, k)] for k in range(147)]),
                entry=centre[0], entry_in=unit(centre[3] - centre[0]), exit=centre[146], exit_out=unit(centre[146] - centre[143]),
                hist=hist, hist_elem=hist_elem)


def unit(v):
    return v / np.linalg.norm(v)


def linker_template():
    atoms, info = bdna_from_1bna(os.path.join(HERE, "inputs", "1BNA.pdb"), 1)
    pos = np.array([a["pos"] for a in atoms]); pos[:, 2] -= pos[:, 2].mean() * 0  # pair 0 sits at z≈0
    c1A = [a["pos"] for a in atoms if a["name"] == "C1'" and a["strand"] == 0][0]
    c1B = [a["pos"] for a in atoms if a["name"] == "C1'" and a["strand"] == 1][0]
    ctr = (c1A + c1B) / 2
    return dict(pos=pos - np.array([0, 0, ctr[2]]), strand=np.array([a["strand"] for a in atoms]), elem=np.array([a["el"] for a in atoms]),
                bb=np.array([a["backbone"] for a in atoms]), c1A=c1A - np.array([0, 0, ctr[2]]), twist=np.radians(info["twist_deg"]), rise=info["rise_nm"])


def build_linker(LT, start_centre, u, prev_c1A, prev_centre, n_bp):
    """n_bp pairs of B-DNA along u, starting one rise after start_centre, continuing the helical phase."""
    R0 = rot_from_to(np.array([0, 0, 1.0]), u)
    # phase: rotate template so its strand-A C1' points like the previous pair's, advanced by one twist
    want = prev_c1A - prev_centre; want -= u * np.dot(want, u); want = unit(want)
    have = R0 @ LT["c1A"]; have -= u * np.dot(have, u); have = unit(have)
    ang = np.arctan2(np.dot(np.cross(have, want), u), np.dot(have, want))
    out_pos, out_bp, centres, c1 = [], [], [], None
    for j in range(n_bp):
        R = axis_angle(u, ang + LT["twist"] * (j + 1)) @ R0
        c = start_centre + u * LT["rise"] * (j + 1)
        out_pos.append(LT["pos"] @ R.T + c); out_bp.append(np.full(len(LT["pos"]), j)); centres.append(c)
        c1 = R @ LT["c1A"] + c
    return np.concatenate(out_pos), np.concatenate(out_bp), np.array(centres), c1


# ------------------------------------------------------------------ chromatin growth
def grow_chromatin(NT, LT, centre, radius):
    target = int(NUC_DENSITY * 4 / 3 * np.pi * radius ** 3)
    nucs = []  # (R, t, chain, index_in_chain, bp_offset)
    linkers = []  # dict(chain, a, b, n_bp, bp_offset)
    grid = {}
    cell = 12.0

    def clash(p):
        k = tuple((p // cell).astype(int))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for q in grid.get((k[0] + dx, k[1] + dy, k[2] + dz), ()):
                        if np.linalg.norm(p - q) < 11.0:
                            return True
        return False

    def add(p):
        grid.setdefault(tuple((p // cell).astype(int)), []).append(p)

    nc_centre = NT["hist"].mean(0)
    chain = 0
    attempts = 0
    while len(nucs) < target and attempts < 4000:
        attempts += 1
        # seed a chain at a random point
        p0 = centre + rng.normal(size=3) * radius
        if np.linalg.norm(p0 - centre) > radius * 0.95:
            continue
        R = axis_angle(rng.normal(size=3), rng.uniform(0, 2 * np.pi))
        t = p0 - R @ nc_centre
        if clash(R @ nc_centre + t):
            continue
        k, bp_off = 0, 0
        nucs.append((R, t, chain, k, bp_off)); add(R @ nc_centre + t)
        while len(nucs) < target:
            ex = R @ NT["exit"] + t
            u = R @ NT["exit_out"]
            L = int(rng.integers(30, 51))
            ok = False
            for _ in range(24):
                ent = ex + u * RISE * (L + 1)
                R1 = rot_from_to(NT["entry_in"], u)
                R1 = axis_angle(u, rng.uniform(0, 2 * np.pi)) @ R1
                t1 = ent - R1 @ NT["entry"]
                c1 = R1 @ nc_centre + t1
                if np.linalg.norm(c1 - centre) < radius and not clash(c1):
                    ok = True
                    break
                L = int(rng.integers(30, 51))
            if not ok:
                break
            linkers.append(dict(chain=chain, R_prev=R, t_prev=t, n_bp=L, bp_offset=bp_off + 147, a=ex, b=ent, u=u))
            bp_off += 147 + L
            k += 1
            R, t = R1, t1
            nucs.append((R, t, chain, k, bp_off)); add(c1)
        chain += 1
    return nucs, linkers, target


def backbone_atoms(NT, LT, nucs, linkers):
    """All backbone atoms with (chain, strand, global bp, elem, kind, owner)."""
    m = NT["bb"] == 1
    tp, ts, tb, te = NT["pos"][m], NT["strand"][m], NT["bp"][m], NT["elem"][m]
    P, S, B, E, C, K, O = [], [], [], [], [], [], []
    for i, (R, t, ch, k, off) in enumerate(nucs):
        P.append(tp @ R.T + t); S.append(ts); B.append(tb + off); E.append(te)
        C.append(np.full(len(tp), ch)); K.append(np.zeros(len(tp), np.int8)); O.append(np.full(len(tp), i))
    lm = LT["bb"] == 1
    for j, L in enumerate(linkers):
        R, t = L["R_prev"], L["t_prev"]
        pos, bpi, _, _ = build_linker(LT, R @ NT["exit"] + t, L["u"], R @ NT["c1A"][146] + t, R @ NT["exit"] + t, L["n_bp"])
        mask = np.tile(lm, L["n_bp"])
        P.append(pos[mask]); S.append(np.tile(LT["strand"], L["n_bp"])[mask]); B.append(bpi[mask] + L["bp_offset"])
        E.append(np.tile(LT["elem"], L["n_bp"])[mask]); C.append(np.full(mask.sum(), L["chain"])); K.append(np.ones(mask.sum(), np.int8)); O.append(np.full(mask.sum(), j))
    return (np.concatenate(P).astype(np.float32), np.concatenate(S).astype(np.int8), np.concatenate(B).astype(np.int32),
            np.concatenate(E).astype(np.int8), np.concatenate(C).astype(np.int32), np.concatenate(K), np.concatenate(O).astype(np.int32))


# ------------------------------------------------------------------ damage scoring
def score(dep_pos, dep_e, dep_t, tree, S, B, E, C):
    d, idx = tree.query(dep_pos, distance_upper_bound=0.181)
    hit = np.isfinite(d)
    if hit.any():
        hit[hit] = d[hit] <= VDW[E[idx[hit]]]
    sums, first_t = {}, {}
    for i in np.nonzero(hit)[0]:
        a = idx[i]
        key = (int(C[a]), int(S[a]), int(B[a]))
        sums[key] = sums.get(key, 0.0) + float(dep_e[i])
        if sums[key] > SSB_EV and key not in first_t:
            first_t[key] = (float(dep_t[i]), i)
    ssb = [(k, v) for k, v in sums.items() if v > SSB_EV]
    dsb = []
    for i in range(len(ssb)):
        for j in range(i + 1, len(ssb)):
            (c1, s1, b1), (c2, s2, b2) = ssb[i][0], ssb[j][0]
            if c1 == c2 and s1 != s2 and abs(b1 - b2) <= DSB_BP:
                dsb.append((i, j))
    return ssb, dsb, sums, first_t, int(hit.sum())


def main():
    n_rot = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    st = json.load(open(os.path.join(W, "story.json")))
    ev = st["event"]
    d_dir = unit(np.array(ev["T"][str(st["delta_track"])]["dir"]))
    NT, LT = nucleosome_template(), linker_template()
    centre, radius = d_dir * 110.0, 230.0
    nucs, linkers, target = grow_chromatin(NT, LT, centre, radius)
    print(f"chromatin: {len(nucs)} nucleosomes (target {target}), {len(linkers)} linkers, {1 + max(n[2] for n in nucs)} chains")
    P, S, B, E, C, K, O = backbone_atoms(NT, LT, nucs, linkers)
    print(f"backbone atoms: {len(P):,}")
    tree = cKDTree(P)

    recs = load("dna_delta")
    order = np.argsort(recs["ev"], kind="stable")
    recs = recs[order]
    evs, starts = np.unique(recs["ev"], return_index=True)
    ends = np.r_[starts[1:], len(recs)]
    R_align = rot_from_to(np.array([0, 0, 1.0]), d_dir)
    trials = n_ssb = n_dsb = 0
    found = []
    for e, a, b in zip(evs, starts, ends):
        r = recs[a:b]
        dep = r["edep"] > 0
        p0 = np.c_[r["x"], r["y"], r["z"]][dep].astype(np.float64)
        for k in range(n_rot):
            phi = 2 * np.pi * k / n_rot + rng.uniform(0, 2 * np.pi / n_rot)
            R = R_align @ axis_angle(np.array([0, 0, 1.0]), phi)
            ssb, dsb, sums, first_t, nhit = score(p0 @ R.T, r["edep"][dep], r["t"][dep], tree, S, B, E, C)
            trials += 1
            n_ssb += bool(ssb); n_dsb += bool(dsb)
            if dsb:
                found.append(dict(ev=int(e), phi=float(phi), ssb=ssb, dsb=dsb, first_t=first_t, nhit=nhit))
    print(f"{trials} placements: {n_ssb} with ≥1 SSB ({100 * n_ssb / trials:.1f}%), {n_dsb} with a DSB ({100 * n_dsb / trials:.2f}%)")
    if not found:
        raise SystemExit("no DSB found; increase rotations or histories")

    # prefer a DSB in linker DNA (B-DNA from 1BNA), away from the very start of the track
    def info(f):
        i, j = f["dsb"][0]
        (c, s1, b1), (_, s2, b2) = f["ssb"][i][0], f["ssb"][j][0]
        sel = (C == c) & (B >= min(b1, b2)) & (B <= max(b1, b2))
        in_linker = bool(K[sel].all())
        site = P[sel].mean(0)
        return in_linker, float(np.linalg.norm(site)), site
    found.sort(key=lambda f: (not info(f)[0], -min(info(f)[1], 150)))
    best = found[0]
    in_linker, dist, site = info(best)
    print(f"chosen: history {best['ev']}, DSB {'in linker DNA' if in_linker else 'in nucleosomal DNA'}, {dist:.0f} nm from the hand-off point; {len(found)} DSB placements found")
    np.savez_compressed(os.path.join(W, "chromatin.npz"),
                        nuc_R=np.array([n[0] for n in nucs]), nuc_t=np.array([n[1] for n in nucs]), nuc_chain=np.array([n[2] for n in nucs]),
                        nuc_off=np.array([n[4] for n in nucs]),
                        lk_a=np.array([l["a"] for l in linkers]), lk_b=np.array([l["b"] for l in linkers]), lk_u=np.array([l["u"] for l in linkers]),
                        lk_n=np.array([l["n_bp"] for l in linkers]), lk_chain=np.array([l["chain"] for l in linkers]), lk_off=np.array([l["bp_offset"] for l in linkers]),
                        lk_Rprev=np.array([l["R_prev"] for l in linkers]), lk_tprev=np.array([l["t_prev"] for l in linkers]))
    out = dict(history=best["ev"], phi=best["phi"], delta_dir=d_dir.tolist(), in_linker=in_linker,
               ssb=[dict(chain=k[0], strand=k[1], bp=k[2], edep_eV=v, time_ns=best["first_t"][k][0]) for k, v in best["ssb"]],
               pair=list(best["dsb"][0]), trials=trials, trials_with_ssb=n_ssb, trials_with_dsb=n_dsb,
               n_histories=int(len(evs)), n_rotations=n_rot, n_nucleosomes=len(nucs), n_linkers=len(linkers),
               region_centre_nm=centre.tolist(), region_radius_nm=radius, density_per_nm3=NUC_DENSITY)
    json.dump(out, open(os.path.join(W, "dsb.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
