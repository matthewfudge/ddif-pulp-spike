#!/usr/bin/env bash
# ddif-pulp-pipeline.sh — full DDIF → Pulp UI conversion pipeline in one shot.
#
# Steps:
#   1. Re-export the live DDIF editor via --ui-export (writes ComponentTree.json
#      + MainEditor.svg + MainEditor.png + index.html to /tmp/ddif-ui-export)
#   2. Convert manifest → @pulp/react JSX
#   3. Compile JSX → IIFE bundle (esbuild via Pulp's jsx-runtime)
#   4. Import bundle → embed-ready ui.js (pulp import-design --from jsx)
#   5. Render headless via pulp-embed-bundle-render
#   6. Diff against the captured JUCE reference, emit metrics
#
# After this you can mount the bundle live in DDIF Standalone:
#   "Build/.../Dream Date FX.app/Contents/MacOS/Dream Date FX" --pulp-bundle /tmp/ddif-bundle
#
# Or with capture:
#   ... --pulp-bundle /tmp/ddif-bundle --pulp-capture /tmp/live.png

set -euo pipefail

DDIF_ROOT="/Volumes/Projects/Dream Date Designs/Dream Date Instrument Framework"
STANDALONE="$DDIF_ROOT/Build/DreamDateFX-Pulp-Rel/DreamDateFX_artefacts/Release/Standalone/Dream Date FX.app/Contents/MacOS/Dream Date FX"
EXPORT=/tmp/ddif-ui-export
JSX=/tmp/ddif-jsx
BUNDLE=/tmp/ddif-bundle

step() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

step "1. Re-export DDIF editor"
rm -rf "$EXPORT"
"$STANDALONE" --ui-export "$EXPORT" 2>&1 | grep -E "UI export ->" || { echo "  ✗ export failed"; exit 1; }

step "2-5. Convert → JSX → bundle → ui.js → render → diff"
"$DDIF_ROOT/Scripts/ddif-pulp-diff.sh"

step "6. Done"
echo "  Bundle ready at: $BUNDLE/ui.js"
echo "  Mount in DDIF:   \"$STANDALONE\" --pulp-bundle $BUNDLE"
