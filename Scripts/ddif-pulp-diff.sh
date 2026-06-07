#!/usr/bin/env bash
# Visual diff harness: regenerate the JSX, build bundle, render, and compare
# pixel-by-pixel against MainEditor.png (the JUCE-rendered reference).
#
# Outputs:
#   /tmp/iter-current.png   the new Pulp render
#   /tmp/iter-diff.png      red-marked pixel diff
#   stdout                  AE (absolute pixel diff count), MAE, fuzziness
set -euo pipefail

OUT_DIR=/tmp
REF=/tmp/ddif-ui-export/MainEditor.png
DDIF_ROOT="/Volumes/Projects/Dream Date Designs/Dream Date Instrument Framework"
PULP_DIR=/Volumes/Areas/Development/SDK/Pulp/pulp
INSTALL=/Volumes/Areas/Development/SDK/Pulp/install
RENDER=$DDIF_ROOT/Build/DreamDateFX-Pulp-Rel/pulp-embed-juce-build/pulp-view-embed-build/pulp-embed-bundle-render

cd "$DDIF_ROOT"
node Scripts/ddif-jsx-from-export.mjs >/dev/null
cd $PULP_DIR/tools/import-design/jsx-runtime
node jsx-transform.mjs --in /tmp/ddif-jsx/ddif-fx.jsx --out /tmp/ddif-jsx/ddif-fx-bundle.js >/dev/null
PULP_BUILD_DIR=$PULP_DIR/build-release $INSTALL/bin/pulp-cpp import-design \
  --from jsx --file /tmp/ddif-jsx/ddif-fx-bundle.js --mode live --emit js \
  --output /tmp/ddif-bundle/ui.js >/dev/null

# Render Pulp at DDIF FX's design size (1000×536). The converter scales the
# captured 1430×766 manifest down to design space, so the bundle is natively
# 1000×536 (renders cleanly without clipping in both this harness and the
# in-DDIF embed). The captured JUCE reference is at 2× retina (2860×1532) —
# downsize with Lanczos to 1000×536 to match Pulp's pixel grid.
W=1000; H=536
"$RENDER" /tmp/ddif-bundle $W $H $OUT_DIR/iter-current.png >/dev/null
magick "$REF" -filter Lanczos -resize ${W}x${H}\! $OUT_DIR/iter-ref-1x.png
REF=$OUT_DIR/iter-ref-1x.png
CMP=$OUT_DIR/iter-current.png

TOTAL=$((W*H))

# `compare` returns 1 when images differ; don't let set -e kill us.
set +e

TOTAL=$((W*H))

echo "=== AE strict (max=${TOTAL}px×3 channels) ==="
compare -metric AE "$REF" $CMP $OUT_DIR/iter-diff.png 2>&1
echo ""
echo "=== AE @ 5% fuzz (subpixel/AA tolerance) ==="
compare -metric AE -fuzz 5% "$REF" $CMP $OUT_DIR/iter-diff-fuzzy.png 2>&1
echo ""
echo "=== AE @ 10% fuzz ==="
compare -metric AE -fuzz 10% "$REF" $CMP /dev/null 2>&1
echo ""
echo "=== MAE (mean per-channel absolute error, 0..1) ==="
compare -metric MAE "$REF" $CMP /dev/null 2>&1
