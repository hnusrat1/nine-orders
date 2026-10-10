#!/usr/bin/env bash
# Regenerate every data file and model the app uses, from raw inputs.
#
#   sim/regenerate.sh            # everything (about 6 min on 4 CPU cores)
#   sim/regenerate.sh --no-art   # simulations and data only
#
# Needs: the Geant4 conda environment (G4_PREFIX, default /opt/g4) and a Python
# 3.11 with numpy, scipy, scikit-image and bpy (PY, default /opt/py311/bin/python).
# See sim/README.md for the one-time setup. Raw outputs go to sim/work/ (not
# committed); processed outputs go to assets/data/ and assets/models/.
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-/opt/py311/bin/python}
ART=1
if [ "${1:-}" = "--no-art" ]; then ART=0; fi
. ./env.sh

step() { printf '\n== %s\n' "$*"; }

step "inputs (downloaded and checksummed)"
$PY fetch_inputs.py

step "anatomy and voxel phantom"
$PY anatomy.py

step "build Geant4 applications"
mkdir -p build
cmake -S g4 -B build -DCMAKE_PREFIX_PATH="$G4_PREFIX" -DCMAKE_CXX_COMPILER="$G4_PREFIX/bin/x86_64-conda-linux-gnu-c++" > build/cmake.log
make -C build -j"$(nproc)" > build/make.log

mkdir -p work/runs
step "patient scale: Compton events in the prostate (G4EmStandardPhysics_option4)"
rm -f work/runs/patient_story.txt
./build/nine_patient macros/patient_story.mac > work/runs/patient_story.log 2>&1
$PY select_event.py

step "patient scale: dose and electron fluence at the target"
./build/nine_patient macros/patient_fluence.mac > work/runs/patient_fluence.log 2>&1

step "patient scale: dose in every voxel (about 18 minutes on 4 cores)"
./build/nine_patient macros/patient_dose.mac > work/runs/patient_dose.log 2>&1

step "cell and DNA scale (Geant4-DNA)"
$PY run_dna.py 1000

step "strand-break mapping"
$PY dnamap.py 24

step "processed data → assets/data"
$PY process.py

if [ "$ART" = 1 ]; then
  step "models (headless Blender) → assets/models"
  $PY art/room.py
  $PY art/anatomy_models.py
  $PY art/nucleosome.py
  bash art/pack.sh
fi

step "physics check"
python3 check_physics.py
