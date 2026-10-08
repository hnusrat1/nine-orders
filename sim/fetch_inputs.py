"""Download the raw, openly licensed inputs into sim/work/inputs/ and verify them.

Raw inputs are not committed (some are large; all are re-downloadable). Every
file is pinned by SHA-256. See CREDITS.md for licences and citations.
"""
import hashlib, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DST = os.path.join(HERE, "work", "inputs")
MH = "https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data/"
BP = "https://raw.githubusercontent.com/Kevin-Mattheus-Moerman/BodyParts3D/f0eeb6e843380cfe6b83797cf8c3e1af74de5e61/assets/BodyParts3D_data/stl/"
EGS = "https://raw.githubusercontent.com/nrc-cnrc/EGSnrc/master/HEN_HOUSE/spectra/egsnrc/"

FILES = {
    # MakeHuman 1.x base mesh and default skeleton/weights (CC0)
    "base.obj": (MH + "3dobjs/base.obj", "8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c"),
    "default.mhskel": (MH + "rigs/default.mhskel", "99f179bce0aa850b45d4191a1d0d234c5851f881c057439470ded3bddf729a24"),
    "default_weights.mhw": (MH + "rigs/default_weights.mhw", "0f3641d651ae3d00ad6b4ccee43142edb109d3bd909d27d9e4139ef1beed8625"),
    # BodyParts3D 3.0 (CC BY-SA 2.1 JP), as STL
    "FMA13076.stl": (BP + "FMA13076.stl", "244f54f1388b1cb02014a6de9c1b32ef40d398967bc8e17ed56b46c637fe11c1"),  # fifth lumbar vertebra
    "FMA14544.stl": (BP + "FMA14544.stl", "dcbca766ae18f7404082fa34a7a33ed805dd07917ef28097e01e78b4c531df4f"),  # rectum
    "FMA15900.stl": (BP + "FMA15900.stl", "7a6badc84de63ac6c62acc8c2de1084c19885df1cbceb17ae02354c000a45b68"),  # urinary bladder
    "FMA16202.stl": (BP + "FMA16202.stl", "d52dac1add057e05699c3c767736ab45c9c426ab0eebd438e20cd4f0768ee3d8"),  # sacrum
    "FMA16586.stl": (BP + "FMA16586.stl", "8e039b8dc53d82fda8d89045a97f0ee28022f1906b2c285204417859d9027693"),  # right hip bone
    "FMA16587.stl": (BP + "FMA16587.stl", "456552349a088b72f8e1b06660b93e005b7ffcebe713a0e38ea88f806535dbc7"),  # left hip bone
    "FMA24474.stl": (BP + "FMA24474.stl", "a47d03f9a1064bab3db90876e05729924e8c4667c78c1e6373fb42d191cd5563"),  # right femur
    "FMA24475.stl": (BP + "FMA24475.stl", "31a0bc2939b51bca3edec6704702cebe9f9119f8d7fdbdae67c3417777bbe47e"),  # left femur
    "FMA9600.stl": (BP + "FMA9600.stl", "5d7c40ff0761ea8f467cff6e07391436ff8d0ae875d65badb50b5cee4a0c223b"),  # prostate
    # Mohan, Chui & Lidofsky (1985) 6 MV spectrum as tabulated in EGSnrc
    "mohan6.spectrum": (EGS + "mohan6.spectrum", "9c1b6fa481637667bb12555c4f8cd8540c88978d14f7c0543a806de48ce57be9"),
}


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main():
    os.makedirs(DST, exist_ok=True)
    for name, (url, digest) in FILES.items():
        p = os.path.join(DST, name)
        if not os.path.exists(p) or (digest and sha(p) != digest):
            print("fetch", url)
            urllib.request.urlretrieve(url, p)
        if digest and sha(p) != digest:
            sys.exit(f"checksum mismatch for {name}")
    print("inputs ok:", DST)


if __name__ == "__main__":
    main()
