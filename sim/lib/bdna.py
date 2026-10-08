"""B-DNA built from the atomic coordinates of PDB 1BNA (Drew et al. 1981).

1BNA is a 12-bp dodecamer. To get longer straight B-DNA we take the central
base pair (both nucleotides, all heavy atoms), express it in the helix frame,
and repeat it with the mean rise and twist measured from 1BNA itself.
"""
import numpy as np

ELEM = {"C": 0, "N": 1, "O": 2, "P": 3, "H": 4}
BACKBONE = {"P", "OP1", "OP2", "O1P", "O2P", "O5'", "C5'", "C4'", "O4'", "C3'", "O3'", "C2'", "C1'"}


def read_pdb(path):
    atoms = []
    for line in open(path):
        if not line.startswith(("ATOM", "HETATM")):
            continue
        res = line[17:20].strip()
        if res == "HOH":
            continue
        name = line[12:16].strip()
        el = line[76:78].strip() or name[0]
        atoms.append(dict(name=name, res=res, chain=line[21], resi=int(line[22:26]),
                          xyz=np.array([float(line[30:38]), float(line[38:46]), float(line[46:54])]) / 10.0,  # Å → nm
                          el=el))
    return atoms


def _axis(atoms):
    # helix axis: principal component of all atom positions
    X = np.array([a["xyz"] for a in atoms])
    c = X.mean(0)
    _, _, vt = np.linalg.svd(X - c)
    ax = vt[0] / np.linalg.norm(vt[0])
    return c, ax


def _frame(ax):
    t = np.array([1.0, 0, 0]) if abs(ax[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(ax, t); e1 /= np.linalg.norm(e1)
    e2 = np.cross(ax, e1)
    return e1, e2


def bdna_from_1bna(pdb_path, n_bp, centre_pair=6):
    atoms = read_pdb(pdb_path)
    c, ax = _axis(atoms)
    # orient axis from chain A 5' to 3'
    a1 = np.mean([a["xyz"] for a in atoms if a["chain"] == "A" and a["resi"] == 1], 0)
    a12 = np.mean([a["xyz"] for a in atoms if a["chain"] == "A" and a["resi"] == 12], 0)
    if np.dot(a12 - a1, ax) < 0:
        ax = -ax
    e1, e2 = _frame(ax)

    def cyl(p):
        d = p - c
        return np.dot(d, ax), np.arctan2(np.dot(d, e2), np.dot(d, e1))

    # rise and twist from C1' of chain A, pairs 3..10
    hz, ang = [], []
    for i in range(3, 11):
        p = [a["xyz"] for a in atoms if a["chain"] == "A" and a["resi"] == i and a["name"] == "C1'"][0]
        h, t = cyl(p)
        hz.append(h); ang.append(t)
    rise = float(np.mean(np.diff(hz)))
    tw = np.unwrap(ang)
    twist = float(np.mean(np.diff(tw)))
    # template pair: chain A residue k and its partner on chain B (25-k)
    k = centre_pair
    tpl = [a for a in atoms if (a["chain"] == "A" and a["resi"] == k) or (a["chain"] == "B" and a["resi"] == 25 - k)]
    h0, t0 = cyl([a["xyz"] for a in tpl if a["chain"] == "A" and a["name"] == "C1'"][0])
    out = []
    for j in range(n_bp):
        dh = (j - (n_bp - 1) / 2) * rise
        dt = (j - (n_bp - 1) / 2) * twist
        R = _rot(ax, dt)
        for a in tpl:
            p = a["xyz"] - c - ax * h0
            p = R @ p + ax * dh
            p = np.array([np.dot(p, e1), np.dot(p, e2), np.dot(p, ax)])  # helix frame: axis = +z
            out.append(dict(pos=p, el=ELEM.get(a["el"][0], 0), strand=0 if a["chain"] == "A" else 1, bp=j,
                            backbone=1 if a["name"] in BACKBONE else 0, name=a["name"]))
    return out, dict(rise_nm=rise, twist_deg=float(np.degrees(twist)), axis=[0.0, 0.0, 1.0])


def _rot(ax, t):
    ax = ax / np.linalg.norm(ax)
    K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
    return np.eye(3) + np.sin(t) * K + (1 - np.cos(t)) * K @ K

