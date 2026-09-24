#!/usr/bin/env bash
# Build and inspect both PyPI distribution formats, then smoke-test the wheel in an isolated target directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT/dist"
TARGET_DIR="$(mktemp -d)"
trap 'rm -rf "$TARGET_DIR"' EXIT

# The packaged templates must match the deploy/ copies used by install.sh.
for template in casambi-bt-webui.service environment.template; do
  diff -u "$ROOT/deploy/$template" "$ROOT/src/casambi_bt_webui/templates/$template"
done

rm -rf "$DIST_DIR"
python3 -m build --outdir "$DIST_DIR" "$ROOT"
python3 -m twine check "$DIST_DIR"/*
python3 -m pip install --no-deps --target "$TARGET_DIR" "$DIST_DIR"/*.whl
PYTHONPATH="$TARGET_DIR" python3 -m casambi_bt_webui.cli --version
PYTHONPATH="$TARGET_DIR" python3 -m casambi_bt_webui.cli systemd-template | grep -F 'Description=Casambi BT WebUI local lighting bridge'
echo "Package validation completed successfully."
