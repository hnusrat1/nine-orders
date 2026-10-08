# Simulation and asset pipeline

Everything the app shows at runtime comes from `assets/data/` and `assets/models/`, which this directory regenerates. Raw simulation output lives in `sim/work/` and is not committed.

## One-time setup

Geant4 from conda-forge (with its data packages), plus the few development packages its CMake config needs:

```
micromamba create -p /opt/g4 -c conda-forge "geant4=11.4.3=noqt*" geant4-examples \
  cxx-compiler cmake make expat zlib freetype xorg-libx11 xorg-libxmu xorg-libxext xorg-libxt \
  libgl-devel libglu libopengl-devel
```

Python 3.11 for the processing and for Blender as a module:

```
micromamba create -p /opt/py311 -c conda-forge python=3.11 numpy scipy pip
/opt/py311/bin/pip install bpy scikit-image
cd tests && npm install        # provides gltfpack (and the test tools)
```

`sim/env.sh` sources the Geant4 data paths from the conda environment (`G4_PREFIX`, default `/opt/g4`).

## Regenerate

```
sim/regenerate.sh            # inputs → simulations → assets/data → models → physics check
sim/regenerate.sh --no-art   # skip the Blender models
```

About 6 minutes on 4 cores, about half of it the Cycles light bake for the room. All runs use fixed seeds.

| Step | Script | What it does |
|---|---|---|
| Inputs | `fetch_inputs.py` | Downloads MakeHuman (CC0), BodyParts3D (CC BY-SA) meshes and the Mohan 6 MV spectrum; checks SHA-256. PDB files are in `inputs/`. |
| Phantom | `anatomy.py` | Poses the MakeHuman body (arms down), places BodyParts3D organs and bones by the femoral heads, puts everything in the patient frame and voxelises the pelvis (2.5 mm: air, soft tissue, bone, urine). |
| Patient scale | `g4/patient.cc`, `macros/patient_story.mac` | Geant4 11.4.3, `G4EmStandardPhysics_option4`. Point source 100 cm above the isocentre, 10 × 10 cm field, Mohan spectrum. Keeps photons whose first real interaction is a Compton scatter within 15 mm of the isocentre giving a 0.3–1.0 MeV electron; records the photon and every step of the electron and its secondaries (1 µm production cut). |
| Story choice | `select_event.py` | Picks the event: a 2–5 keV delta electron created 0.15–0.8 mm along the recoil electron's path, inside the prostate. |
| Fluence | `macros/patient_fluence.mac` | 4 × 10⁶ photons, 0.1 mm cut: dose and track length of photon-generated electrons in a 10 mm sphere in the prostate. |
| Cell / DNA scale | `g4/dna.cc`, `run_dna.py` | Geant4-DNA in liquid water. Fast electron at the hand-off energy over 40 µm segments (`G4EmDNAPhysics_option2`, 400 segments). Delta electron at its energy, 1000 histories (`G4EmDNAPhysics_option4`). Every step recorded. |
| Strand breaks | `dnamap.py` | Builds a chromatin model (1KX5 nucleosomes, 1BNA linkers), aligns each delta history with the delta direction, tries 24 rotations, maps deposits to backbone atoms (van der Waals spheres), scores SSB (> 17.5 eV per nucleotide) and DSB (opposite strands within 10 bp). Picks a real history/placement with a DSB, preferring linker DNA. |
| App data | `process.py` | Writes `assets/data/*.bin` and `index.json` (numbers with derivations and the raw run summaries they come from). |
| Models | `art/room.py`, `art/anatomy_models.py`, `art/nucleosome.py`, `art/pack.sh` | Headless Blender: room and generic linac with baked lighting; body and organ meshes; 1KX5 nucleosome surfaces. gltfpack with meshopt compression. |
| Check | `check_physics.py` | Recomputes every on-screen number from the committed data files. |
| Placeholder | `synthetic.py` | The skeleton build's random-walk data, same format. Not used for the real build. |

## Data format

`assets/data/index.json` lists each dataset: one little-endian binary file per dataset, fields stored one after the other, each 4-byte aligned. For each field: byte `offset`, element `type` (`f32`, `u8`, `u16`, `i32`) and `size` (components per item). Track datasets have `pos` (Float32 ×3), `edep` (Float32), `time` (Float32, ns), `type` (Uint8) and `track` (Uint16), grouped by track and in step order.

Event types: 0 elastic, 1 electronic excitation, 2 ionisation, 3 vibrational excitation, 4 dissociative attachment, 5 thermalisation, 6 track start (Geant4-DNA); 10 eIoni step, 11 msc/transport step, 12 bremsstrahlung (condensed history).

Frames: the patient frame is mm with the origin at the Compton point, +x patient left, +y anterior (towards the gantry head), +z inferior. Tissue is the same in µm. Cell (µm) and chromatin (nm) are centred on the hand-off point, where the delta electron starts; DNA (nm) on the double-strand-break site. All use the patient axes.
