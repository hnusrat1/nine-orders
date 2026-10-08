#!/usr/bin/env bash
# Everything that must pass before a push. Exits non-zero on the first failure.
set -euo pipefail
cd "$(dirname "$0")"
node run-desktop.mjs
node run-xr.mjs
python3 ../sim/check_physics.py
echo "ALL TESTS PASSED"
