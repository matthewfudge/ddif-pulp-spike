# Diagnostics for Daniel — 2026-06-08

Bundles authored to test interactive knob behavior. **None of them respond to
mouse drag** when mounted via `pulp_embed_create_from_ui_bundle`. See
`../Docs/PulpIntegration.md` "Standalone JSX bundles — Knob doesn't receive
drag" for the full writeup.

## Build chain

```bash
PULP_DIR=/Volumes/Areas/Development/SDK/Pulp/pulp
INSTALL=/Volumes/Areas/Development/SDK/Pulp/install

# 1. JSX → IIFE
node $PULP_DIR/tools/import-design/jsx-runtime/jsx-transform.mjs \
     --in <fixture>.jsx --out <fixture>-bundle.js

# 2. IIFE → embed-ready ui.js
PULP_BUILD_DIR=$PULP_DIR/build-release $INSTALL/bin/pulp-cpp import-design \
     --from jsx --file <fixture>-bundle.js --mode live --emit js \
     --output <bundle-dir>/ui.js

# 3. Mount in a host (DDIF Standalone via --pulp-bundle, or any other)
```

## Fixtures

| File | Pattern | Behavior |
|---|---|---|
| `minimal-knob.jsx` | Knob with id + style only (mirrors DDIF's converter emit) | Renders, no drag response |
| `animated-debug.jsx` | Knob + onChange + label readout + magenta SvgPath driven by transform | Renders, no drag response, label stays at v=0.500 |
| `animated-knob.jsx` | 3 knobs with invisible Pulp Knob + purple triangle SvgPath | Renders, no drag response |

## runtime-trace.json

`pulp-screenshot --runtime-trace` output for `animated-debug.jsx`. Shows the
JSX side wired three `change` callbacks. `native_registered` is empty (which
is expected — Knob's change events are wired in C++ inside `createKnob` →
`wire_callbacks`, not via prop-applier). So the wiring LOOKS correct from
the JS side; the drag must not be reaching the C++ Knob's mouse handler,
or `k->on_change` isn't firing.

## animated-debug-render.png

Initial state of the debug fixture, captured headlessly via pulp-screenshot.
