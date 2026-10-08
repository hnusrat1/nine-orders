# Source this to get the Geant4 (conda-forge) toolchain and data paths.
# Assumes the environment created as in sim/README.md at $G4_PREFIX (default /opt/g4).
export G4_PREFIX=${G4_PREFIX:-/opt/g4}
export CONDA_PREFIX=$G4_PREFIX
_nine_opts=$(set +o)
set +eu
for f in "$G4_PREFIX"/etc/conda/activate.d/*.sh; do . "$f" >/dev/null 2>&1 || true; done
eval "$_nine_opts"; unset _nine_opts
export PATH="$G4_PREFIX/bin:$PATH"
export LD_LIBRARY_PATH="$G4_PREFIX/lib:${LD_LIBRARY_PATH:-}"
