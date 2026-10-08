#!/usr/bin/env bash
# Compress the glTF models with meshoptimizer (gltfpack, EXT_meshopt_compression)
# into assets/models/. Requires: cd tests && npm install (provides gltfpack).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
GP="$ROOT/tests/node_modules/.bin/gltfpack"
mkdir -p "$ROOT/assets/models"
for f in room patient_body pelvis_organs nucleosome; do
  extra=""
  [ "$f" = room ] && extra="-kn"
  "$GP" -i "$HERE/../work/art/$f.glb" -o "$ROOT/assets/models/$f.glb" -cc -kn -km -noq $extra
done
ls -la "$ROOT/assets/models"
