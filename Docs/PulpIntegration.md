# Pulp Integration — Spike Notes

Running log of what works, what breaks, and what's unclear while exploring
porting Dream Date Instrument Framework (and eventually all YSS plugins)
to render their UI via [pulp-embed-juce](https://github.com/danielraffel/pulp-embed-juce).

Upstream repos:
- https://github.com/danielraffel/pulp — the Pulp SDK / framework
- https://github.com/danielraffel/pulp-embed-juce — the JUCE adapter (MIT)
- pulp-view-embed — C ABI layer needed by the adapter; not yet located, may live inside `pulp/` or be a separate repo

**Goal (per Matthew, 2026-06-07):** Visual-only embed for now — render a Pulp design inside DDIF's editor, no host-param wiring yet. The integration itself (CMake, dep resolution, opt-in flag) is the priority. **Param-bridge work is deferred** until visual rendering is solid.

**Branch:** `experiment/pulp-embed` (forked from `chore/quality-goal`)

**Fork-based feedback workflow** (per Daniel, 2026-06-07 — confirmed by Matthew, 2026-06-07):
- All Pulp-side changes live on `matthewfudge` forks: [pulp](https://github.com/matthewfudge/pulp), [pulp-view-embed](https://github.com/matthewfudge/pulp-view-embed), [pulp-embed-juce](https://github.com/matthewfudge/pulp-embed-juce).
- **DO NOT upstream.** No PRs are ever opened against `danielraffel/*`. Every change is a feature branch + PR opened **within the fork itself** (base `main`, head `feature/...`, both on `matthewfudge/<repo>`) so Daniel can browse `https://github.com/matthewfudge/<repo>/pulls` and cherry-pick what he wants into his upstream on his own schedule.
- `origin` = fork (push target). `upstream` = `danielraffel/...` (fetch-only; push URL is set to `DISABLED_pushes_go_to_origin` to make accidental pushes fail loudly).
- DDIF-side changes still live on `experiment/pulp-embed` in this repo. Nothing is force-pushed; rollback = abandon the branch.

**PR convention for the forks:**
1. `cd /Volumes/Areas/Development/SDK/Pulp/<repo>`
2. `git fetch upstream && git checkout -b feature/<name> upstream/main`
3. commit changes
4. `git push -u origin feature/<name>`
5. `gh pr create --repo matthewfudge/<repo> --base main --head feature/<name> --title "..." --body "..."` ← `--repo` keeps the PR on the fork.

**To sync a fork with Daniel's latest:**
```bash
cd /Volumes/Areas/Development/SDK/Pulp/<repo>
git fetch upstream && git checkout main && git merge --ff-only upstream/main && git push origin main
```

---

## Local setup

| Thing | Path | Notes |
|---|---|---|
| `pulp` repo | `/Volumes/Areas/Development/SDK/Pulp/pulp` | upstream `danielraffel/pulp`, depth-1 clone |
| `pulp-embed-juce` repo | `/Volumes/Areas/Development/SDK/Pulp/pulp-embed-juce` | upstream, depth-1 clone, MIT |
| `pulp-view-embed` repo | `/Volumes/Areas/Development/SDK/Pulp/pulp-view-embed` | sibling repo, found via `gh api users/danielraffel/repos`, NOT in the `pulp` repo despite the JUCE adapter README implying it (`../pulp-view-embed`) |
| Pulp SDK install dir | `/Volumes/Areas/Development/SDK/Pulp/install` (planned) | output of `cmake --install pulp/build --prefix ...`; consumed via `CMAKE_PREFIX_PATH` |

DDIF integration is gated behind `-DDDD_USE_PULP_UI=ON` (off by default) so
the standard build path keeps working while we poke at this. Required CMake vars when ON:
- `PULP_SDK_INSTALL_DIR` — points at the installed Pulp SDK (for `find_package(Pulp CONFIG)`)
- `PULP_VIEW_EMBED_DIR` — points at the `pulp-view-embed` checkout

These default to `/Volumes/Areas/Development/SDK/Pulp/install` and `/Volumes/Areas/Development/SDK/Pulp/pulp-view-embed` respectively.

---

## Open questions (for Daniel)

> Daniel — these are the unknowns blocking us right now. Easier for you to
> answer than for us to guess wrong.

### Rendering-side (blockers for pixel parity)

6. **Silent rendering failure when total widget count crosses ~152.** Bisected on 2026-06-07 — 152 sibling `<SvgPath>` elements render correctly; 153 produces a blank surface. Bucketing into nested `<View>` parents doesn't change the threshold. No error / warning in the runtime trace. Reproduction fixture: `Scripts/ddif-jsx-from-export.mjs` + `tools/import-design/jsx-runtime/jsx-transform.mjs` with an SVG that has ≥153 unique `<path>` elements. Hard cap or counter overflow somewhere in `pulp::view::widget_bridge`?
7. **Path order matters to render success.** Emitting the first 70 paths from `MainEditor.svg` in JUCE's document-emission order → renders fine. Picking the 70 largest paths by bounding-box area → blank surface. Same count, same per-path content (each path renders individually). Suggests one of the "big" paths at doc-index >70 crashes the parser silently, or that path-order affects bridge state. Is there a way to log per-`createSvgPath` failures?
8. **Compound paths with multiple `M` subpaths from same-style merging fail to render.** A single `<SvgPath>` with `d="M100,100 L300,100 L300,200 Z M500,300 L700,300 L700,400 Z"` (two triangles) renders correctly. But merging 205 separate paths into 52 compound paths (concatenating their `d=` strings by shared fill) produces a blank surface — even though the longest single merged path (52 `M` subpaths, 19341 chars) renders fine when emitted alone. Some bridge-state interaction between same-style compound siblings?

If 6/7/8 are all the same underlying bridge bug (silent-fail past some condition), that's the singular thing blocking pixel parity. Without solving it we're stuck at "macros + LFO frame + cream panel, no module slot frames, no MASTER strip, no 'No Preset' text" — the cliff falls right between the visually-important paths.

### 2026-06-09: Animated per-knob components — knob drag + indicator rotation + hover-reactive rings (RESOLVED)

**Status:** Working end-to-end. Pulp `v0.382.1+` (`ad46bad4` in PR #3654) fixed the StateStore null-deref. The converter (`Scripts/ddif-jsx-from-export.mjs`) now emits per-knob React wrapper components — one `<K${index}>` per captured DDIF knob (8 macros + 1 SaturnRingKnob threshold) — that:

- Hoist an invisible `<Knob value={v} onChange={...}>` to the root so absolute coords are editor-global (a deep-tree emit puts the Knob in the wrong place — see the 2026-06-09 hoisting note in the commit message).
- Rotate the indicator triangle via state-driven `transform:[{rotate: angle}]` on its `<SvgPath>`. The captured editor pose is recovered by computing each triangle's angle relative to the ring center, so the rendered triangle starts where it was at capture time with no snap-on-first-drag.
- Render the ring as a hover-reactive stroked circle (NOT a filled annulus — JUCE's `SVGGraphicsContext` lowers `Graphics::drawEllipse(stroke=N)` to a compound `M…Z M…Z` annular fill; without `fill-rule="evenodd"` Pulp paints it as a solid disk with a visible inner edge). The converter collapses the compound path to a single outer subpath + `fill="none"` + `stroke=<captured colour>` + `strokeWidth` matching the LookAndFeel (6 for `DDDTheme` macros, 2 for `SaturnRingKnob`). On `onMouseEnter` the stroke brightens to `#bfb8aa` — same `isHovered` effect `SaturnRingKnob::getRingColour()` produces.

Indicator/ring detection is data-driven from the captured SVG, so it generalises to any DDIF product. Triangles are disambiguated from text glyphs by point count (3 == triangle, more == glyph). Rings are detected by fill colour ∈ {#e8e1d5, #a19b92} AND compound annular shape (`Z M`).

**Two emit-path bugs surfaced during this work, both worth Daniel's attention:**

- **`<SvgPath fill="none">`** is dropped by Pulp's SvgPath default-fill logic — when no `fill=` attr is present, the widget paints solid black, NOT transparent. The converter now emits `fill="none"` explicitly. Worth confirming this is the intended default behaviour (`SvgPathProps` docstring says "Defaults to … transparent + no stroke = invisible").
- **`fill-rule`** isn't on `SvgPathProps`. JUCE's stroke→annular-fill lowering pattern only renders correctly with `fill-rule="evenodd"`. Adding the prop would let any captured JUCE editor render its stroked ellipses without converter-side transformation. The converter currently does the transformation; surfacing `fill-rule` would let consumers ship the captured paths verbatim.

### New (2026-06-09): "Saturn ring on hover" needs `modDepth` capture (yssUI patch)

The hover-brighten effect works today. The actual saturn ring proper — the modulation-depth ARC that `SaturnRingKnob::drawSaturnRing()` paints from `value_` to `value_ + modDepth_` — needs the per-knob `modDepth_` captured by `UIExporter`. Currently `ComponentTree.json` includes positional bounds + class names but not the live `juce::Slider::Properties`. To wire the saturn-ring arc the export would need to walk each `juce::Slider` (or `SaturnRingKnob`) and pull `modDepth` out of the live state — that's a yssUI `UIExporter.h` patch on the experiment/pulp-embed branch.

### Long-term goal — Pulp replaces yssUI for all YSS plugins

The converter ↔ Pulp adapter chain established here is intended as the **production rendering path for every YSS-framework plugin** (DDIF, Glasis, Groei, Mallet, Taishogoto, DrumSeq, PolyArp, Dreamer, future products). Architecture sketch:

```
JUCE editor                  yssUI::UIExporter             Scripts/ddif-jsx-from-export.mjs            @pulp/react
(live components)   ──────►  ComponentTree.json    ──────► ddif-fx.jsx                       ──────►  ui.js
                             MainEditor.svg                 (animated knob components,                 (mounted via
                             MainEditor.png                  hover rings, label glyphs, …)               PulpEmbedComponent
                                                                                                         in the JUCE editor)
```

The converter is **product-agnostic** today — every detection rule is data-driven from the captured SVG (fill colours, bbox sizes, path-point counts, parent containment), nothing is product-name-keyed. Porting any YSS plugin to Pulp is then: `UIExporter::exportComponent(editor, dir)` → `node ddif-jsx-from-export.mjs` → `import-design --from jsx` → mount via `PulpEmbedComponent`. Same recipe.

For Pulp to absorb the converter into the SDK proper, the highest-leverage changes are:

1. **`SvgPath` `fill-rule` prop** (mentioned above) — eliminates the converter's compound-annular-fill detection + collapse step.
2. **`fill="none"` semantics** — confirm or fix the doc-vs-runtime mismatch.
3. **Widget paint hooks** — already covered by Daniel's q9 doc. Per-knob paint props (e.g. `indicatorPath`, `trackFill`) would let the converter ship custom DDIF-style knobs without per-knob React wrappers + state.
4. **`modDepth` / generic knob extras in `pulp_embed_param_info`** — already an open thread; would let the saturn ring arc render natively.

Everything else (text capture, transform array, change-event subscription, lowercase tag routing) Pulp already handles correctly as of `v0.382.1` / `pulp-view-embed v6` / pulp-embed-juce 2.1.

### Earlier 2026-06-08, evening: v0.378.0 fix introduces NULL deref on knob drag — RESOLVED in v0.382.1 (#3654)

Daniel landed PR [#3617](https://github.com/danielraffel/pulp/pull/3617) in `v0.378.0` to fix the lowercase-tag routing gap (see previous section — `<knob>` now routes to `createKnob` on `__domAppend` + `_ensureNative` + `host-config` lowercase default). The native `Knob` IS now being created — DDIF's render shows the cream rotary visual with tick indicator inside each knob body, where v0.377 and earlier showed an empty `<View>` container.

But the first mouse drag **hard-crashes the process** with a NULL pointer deref:

```
Exception Type:    EXC_BAD_ACCESS (SIGSEGV)
Exception Subtype: KERN_INVALID_ADDRESS at 0x0000000000000038

Thread 0 Crashed: JUCE v8.0.12: Message Thread
0   Dream Date FX   pulp::state::StateStore::set_normalized(unsigned int, float) + 4
1   Dream Date FX   0x100154000 + 184880
2   Dream Date FX   pulp::view::Knob::on_mouse_drag(pulp::view::Point) + 108
3   Dream Date FX   0x100154000 + 2179680
...
5   AppKit          -[NSWindow _handleMouseDraggedEvent:]
```

`set_normalized + 4` + a fault at address `0x38` = reading a member at offset 0x38 of a NULL `this`. So `Knob::on_mouse_drag` is calling `set_normalized` on a `StateStore*` that hasn't been bound. Plausible: the **`__domAppend` path that v0.378.0 newly routes to `createKnob` doesn't install a state store for the no-host-param case** (DDIF's standalone-bundle scenario, exactly what the PR's behavioral test was supposed to cover). Either:
- `createKnob` via the new route should default to a per-knob in-memory `StateStore` when no host store is provided (most likely the intended behavior — matches the capitalized `<Knob>` reconciler path)
- Or `Knob::on_mouse_drag` should null-check `StateStore*` before dispatching

Either way the routing-parity sweep test passed because it doesn't exercise drag against a real `Knob` instance created through `__domAppend` in a no-store host context (the PR's behavioral test mentions "no host param bound" but presumably runs with the per-knob fallback store wired). The minimal repro is the **unchanged** `diagnostics/minimal-knob.jsx` fixture from earlier — just rebuild against `v0.378.0`, mount via `--pulp-bundle`, click and drag.

Full crash log: `diagnostics/v0.378.0-knob-drag-crash.txt` (in the spike repo).

Until this is fixed, the standalone-bundle drag path is **worse than v0.377** (crash vs. silently no-op).

### New (2026-06-08): standalone JSX bundles — Knob doesn't receive drag

**Issue:** Knobs in a fixture-loaded bundle don't respond to mouse drag, but Knobs in DDIF's generated bundle (same converter, same pipeline) historically did. After the big sync wave on 2026-06-08 (pulp main +28 commits, pulp-view-embed +1, pulp-embed-juce +1), even DDIF's bundle may now be affected — we tested fixtures and saw zero drag response on bundles that previously worked.

**Minimal repro fixture** (in `ddif-pulp-spike/diagnostics/`):
```jsx
// minimal-knob.jsx — identical to how DDIF's converter emits each Knob
import { View, Knob } from '@pulp/react';
export default function App() {
  return (
    <View style={{position:'absolute', left:0, top:0, width:1000, height:536}}>
      <Knob id="solo" style={{position:'absolute', left:400, top:150, width:200, height:200}} />
    </View>
  );
}
```

Pipeline:
```bash
node /pulp/tools/import-design/jsx-runtime/jsx-transform.mjs --in minimal-knob.jsx --out bundle.js
pulp-cpp import-design --from jsx --file bundle.js --mode live --emit js --output bundle-dir/ui.js
```

Mount in `pulp-embed-juce`'s example plugin (or any host) via `pulp_embed_create_from_ui_bundle("bundle-dir")` — the Knob renders (default cream ring + tick) but doesn't respond to mouse drag.

**pulp-screenshot runtime trace** (static — doesn't simulate drag) shows the JSX-side wiring is in place:
```
"callback_count": 3,
"callbacks": [{"key": "dbg1:change", "id": "dbg1", "type": "change"}, ...],
"native_registered_count": 0,
"native_registered": []
```

3 `change` callbacks registered on the JSX side. `native_registered` is empty (knob change events are wired in C++ via `wire_callbacks` in `createKnob`, not via prop-applier).

**Variants we tried, none animate:**
1. `<Knob id="solo" style={...} />` — minimal, no React state, identical to DDIF emit.
2. `<Knob id="solo" onChange={setV} style={...} />` — onChange only, React owns mirror state.
3. `<Knob id="solo" value={v} onChange={setV} style={...} />` — controlled component.

**Hypothesis:** something in the post-2026-06-08 pulp main / WidgetBridge refactor (#3587 split the accessibility registrar slice) changed how knob drag events flow. The host-bridge integration via `pulp_view_embed` ABI v5 / `designParams()` / `readDesignParams()` may also play a role — maybe drag is now gated on a bound host param, not just emitted unconditionally.

Either way, the spike has been stuck here since the sync. Fixture bundle is `/tmp/min-knob-bundle/` on Matt's machine, mirrored to the spike repo under `diagnostics/`.

### New (2026-06-08): widget skinning / custom paint

9. **`@pulp/react` widget intrinsics don't expose custom paint or skin props.** `<Knob>` only takes `value`/`onChange`, `<Button>` only takes `onClick`/`disabled`. So when we layer Pulp widgets on top of SVG chrome to get drag/press feedback, the user sees the default Pulp style (cream circle + tick mark for Knob, dark rectangle for Button) covering DDIF's custom-painted look (purple-triangle indicator, custom button skins). Two questions:
   - Could `<SvgPath>`/`<SvgRect>` children of a `<Knob>` opt-in to becoming the knob's paint? That way DDIF can ship the captured-from-JUCE paint commands as the knob's appearance, parameterized by the widget's `value`.
   - Or a per-intrinsic prop API (`indicatorPath`, `trackFill`, `pressedFill`, etc.) on each widget.
   
   Today the choice is binary: visible widget feedback (Pulp default look) OR DDIF style everywhere (invisible widget feedback). Custom paint solves both.

### Already-flagged

1. **Is there a planned way to expose the param bridge through `PulpEmbedComponent`?** The C ABI in `pulp_view_embed.h` (ABI v2/v3) has full bidirectional param callbacks (`set_param`/`get_param`/`begin_gesture`/`end_gesture`, plus `param_count`/`param_key`/`param_widget_id` enumeration). But `PulpEmbedComponent` zero-inits `PulpEmbedDesc` and never passes a `host` block, and there's no method on it to bind a `juce::AudioProcessor`. For DDIF that's a deal-breaker — we have hundreds of APVTS params that need to round-trip with the UI. Are you planning to add a `bindHost(juce::AudioProcessor&)` or a `PulpEmbedHostCallbacks` ctor overload?
2. **Can `pulp-embed-juce` build against an externally-provided JUCE?** Its `CMakeLists.txt` unconditionally `FetchContent`s JUCE 8.0.4. DDIF uses its own JUCE checkout (`$JUCE_PATH`). `FetchContent_MakeAvailable` is idempotent when the target name is already taken, but ideally we'd want a `PULP_EMBED_JUCE_USE_EXTERNAL_JUCE=ON` option that skips the fetch.
3. **Versioning / pinning story?** No release tags, no submodule, no semver. For YSS to consume `pulp-embed-juce` cleanly we'd want either (a) tagged releases, (b) tested SHAs in your README, or (c) a stable `find_package` install. Today the only honest pin is "a SHA in our CMake comments."
4. **Windows roadmap timeline?** DDIF ships VST3/AAX on Windows. Today `pulp-embed-juce` is `#if JUCE_MAC` gated everywhere; without a `PluginViewHost` factory + raw-pixel producer on Windows, all our Windows users would lose the UI. Is this a 2026 plan, 2027 plan, or "depends"?
5. **Per-instance vs shared GPU context cost?** DDIF can have N instances of `Dream Date FX` live in a session. Each `PulpEmbedComponent` spins up a `PluginViewHost` with Dawn/Skia. Is that N independent GPU contexts? Memory/GPU-VRAM cost at N=8?

---

## Blockers

_Things that prevent forward progress. Listed in the order we hit them._

### B1. Pulp SDK is not on the machine and must be built from source

The `curl install.sh` installer ships CLI binaries to `~/.pulp/bin/` but **does not provide the CMake SDK** (`find_package(Pulp CONFIG)`). For embedding we have to build Pulp from source — which means cloning, running `setup.sh` (fetches Skia/Dawn/SDL3/VST3/CLAP/LV2/Yoga/Catch2 caches into `~/Library/Caches/Pulp/fetchcontent-src/`), then a full `cmake --build` + `cmake --install`. First-time cost is ~hundreds of MB of clones and ~30+ min of compile. Subsequent builds reuse the shared FetchContent cache.

**Status (2026-06-07):** Pulp SDK successfully built and installed at `/Volumes/Areas/Development/SDK/Pulp/install`. `PulpConfig.cmake` lives at `install/lib/cmake/Pulp/`.

### B2. `pulp-view-embed` repo is required but not documented as such

The `pulp-embed-juce` README references it as `../pulp-view-embed` (sibling path), implying it might be shipped together. It's actually a separate repo at `https://github.com/danielraffel/pulp-view-embed` that you have to clone yourself. Easy to miss. **Resolved by cloning manually.**

### B3. `pulp-embed-juce` collides with parent-provided JUCE

`pulp-embed-juce/CMakeLists.txt` does `FetchContent_MakeAvailable(JUCE)` unconditionally. When the parent project has already done `add_subdirectory(<its-JUCE>)`, CMake fails with `add_library cannot create target "juce_osc" because another target with the same name already exists` (and same for `juce_product_unlocking`, `juce_video`, `juce_build_tools`, `juceaide`).

**Fix:** Guard the fetch on `NOT TARGET juce::juce_core`. Patch on the `matthewfudge/pulp-embed-juce` fork: branch `feature/skip-juce-fetch-when-present`, [PR #1](https://github.com/matthewfudge/pulp-embed-juce/pull/1). **Resolved.**

### B4. Pulp headers require macOS ≥10.15, DDIF targets 10.13

Pulp's public headers (`pulp/view/design_ir.hpp`, `choc/platform/choc_FileWatcher.h`) use `std::filesystem::path`. Apple's stdlib gates `std::filesystem` on macOS 10.15+.

`Projects/DreamDateFX/CMakeLists.txt` sets `CMAKE_OSX_DEPLOYMENT_TARGET=10.13` with `FORCE`, which overrides command-line attempts to raise it.

**Fix:** Conditionally bump to 10.15 only when `DDD_USE_PULP_UI=ON`. Standard builds stay at 10.13. **Resolved locally — but is a real product-level decision if Pulp UI ships:** does DDIF want to drop macOS 10.13/10.14 support? Both are end-of-life (Catalina 10.15 was 2019, also EOL). Probably yes, but worth flagging to product.

### B5. Mainline `pulp` lacks the embedding seam

`pulp-view-embed/src/pulp_view_embed.cpp` calls `pulp::view::PluginViewHost::try_attach_to_parent`, `is_attached`, and `pulp::view::render_to_rgba` — none of which exist on `danielraffel/pulp` `main` (as of 2026-06-07, commit `2b445f3`). The pulp-view-embed README and CMakeLists both say "Configure against the SDK installed from the seam branch" but **don't name the branch**.

Searched the upstream branches by `git grep`-ing for `try_attach_to_parent`. Two branches have it:
- `explore/foreign-host-embed` ← THE seam branch (has `try_attach_to_parent` AND `render_to_rgba`)
- `feature/embed-upstream-gpu-view-host` ← has the attach seam but NOT `render_to_rgba`

I tried the gpu branch first (it's a day fresher) but `pulp-view-embed/src/pulp_view_embed.cpp:992` calls `pulp::view::render_to_rgba` which only exists on `explore/foreign-host-embed` (added in commit `4aae7da1 feat(view): add render_to_rgba raw-pixel headless render seam`).

**Resolution:** Use `explore/foreign-host-embed`. Pulp builds; `pulp_view_embed.cpp` will compile against it.

**Daniel question:** the README/CMakeLists in `pulp-view-embed` say "the seam branch" but never name it. The right answer is `explore/foreign-host-embed`. Worth: (a) naming it in the README, (b) merging the seam into main, or (c) tagging a known-good Pulp commit that the README points at.

---

## Broken assumptions / surprises

_Things in the README/code that don't match reality, or that took us a long
time to figure out._

### S1. The "JUCE adapter" has no parameter binding API surface

The `pulp-view-embed` README advertises "Interactive parameter binding works bidirectionally — a dragged knob writes the host param (begin/set/end gesture); host automation pushes values back into the control." That's true at the **C ABI** layer. But the JUCE wrapper (`PulpEmbedComponent`) does not surface any of it: no `host` callbacks set on `PulpEmbedDesc`, no `bindParameter(...)` method, no `host_ctx`. So today a DDIF integration would render the Pulp UI but no knob/button would do anything, and no DAW automation would move the UI. This is the #1 thing to fix in the adapter before it's usable for real plugins.

### S2. The example plugin has zero parameters

`examples/plugin/PluginProcessor.cpp` declares no APVTS / `AudioParameterFloat` — a silent passthrough effect. So there's no working precedent in the repo for how the JUCE adapter is *supposed* to bind to a real `juce::AudioProcessor`. We're inferring intent from the C ABI header alone.

### S3. JUCE is fetched via `FetchContent` at a pinned version (8.0.4)

If we naively `add_subdirectory(pulp-embed-juce)` from DDIF, we'd either end up with two JUCEs in the build or a target name collision. DDIF's CMake adds its own JUCE first; we'll need to either patch `pulp-embed-juce/CMakeLists.txt` to skip its FetchContent when `JUCE::juce_core` already exists, or build `pulp_embed_juce` standalone and link the static lib in. **TBD which path we take — will document the choice once tried.**

---

## DDIF-specific issues

_Things that aren't necessarily Pulp's fault but matter for our integration —
parameter binding gaps, sizing, lifecycle, look-and-feel, etc._

### D1. DDIF has no Pulp design yet — nothing to embed

DDIF's UI is hand-written JUCE Components (`App/UI/*` and `App/Editor/*`). There's no Figma source, no Pulp importer JSON, no `ui.js` bundle. So even with a working integration, we'd see an empty Pulp window unless we (a) author a design in Pulp's tools, (b) use Daniel's `fixtures/figma-vst-style/bundle` as a placeholder, or (c) build a tool that converts our existing JUCE LookAndFeel-driven layout into a DesignIR file. Pick one of those before any visual demo is possible.

### D2. Look-and-feel inheritance

DDIF uses `DDDDialogStyle.h`, a custom `juce::LookAndFeel`, and brand-specific Resources (fonts, icons, accent colors). A Pulp embed is rendered by Skia/Dawn, totally outside JUCE's L&F. We'd lose: instrument-specific `Metadata.json` accent colors, DDD pill button style, the LFO depth slider art, etc. Either Pulp design has to match each brand's tokens at design-export time, or we need a tokens injection path.

### D3. Trial overlay, license overlay, MIDI mapping overlay, etc. are JUCE Components on top

DDIF has multiple modal/transient overlay components (`EditorTrialOverlay`, `MidiMappingOverlay`, settings page, etc.) that need to render *over* the main editor. A Pulp embed is a single child `NSViewComponent` — whether JUCE overlays sit on top of it correctly without z-order issues is unverified.

---

## What worked

_Counter-balance — anything that just worked, so we don't drift into "everything is broken" mode._

- **End-to-end build works (2026-06-07).** DDIF Release with `-DDDD_USE_PULP_UI=ON` produces all four plugin formats (VST3, AU, AAX, Standalone). pulp_embed_juce + pulp_view_embed + Pulp SDK all link cleanly. Binary footprint is unchanged from baseline because nothing in DDIF actually uses `PulpEmbedComponent` yet — but the dep chain is fully wired. **This is the milestone Matthew asked for.**
- Cloning all three repos: zero friction.
- Pulp's `setup.sh --dry-run` is well-instrumented — it tells you exactly what it would do and what's already on your machine. Nice DX.
- The C ABI design (in `pulp_view_embed.h`) is genuinely thoughtful — versioned `struct_size`, opt-in host callbacks via trailing struct fields, exception-free, NULL-safe destroy. If the JUCE wrapper catches up to it, this could be solid.
- Pulp's `PulpSdkGuards.cmake` debug-SDK refusal is a thoughtful pre-flight check — catches a real perf footgun before you sink hours into debugging glitchy audio.
- All prerequisite tools already present on this machine (clang 17, cmake 4.0.3, git-lfs 3.7.1, Xcode CLT). No installs needed.
- `Scripts/setup-pulp.sh` captures the whole bootstrap in one idempotent command.

## Visual prototype (2026-06-07)

`InstrumentEditor` now mounts a `PulpEmbedComponent` overlay when built with `-DDDD_USE_PULP_UI=ON`. It loads the Elysium demo bundle (`pulp-view-embed/fixtures/figma-vst-style/bundle`, set by the CMake helper as `YSS_PULP_DEMO_BUNDLE`). The overlay sits on top of the regular DDIF UI; toggling Pulp off (the default) is a recompile away.

Binary growth confirms the Pulp renderer is actually linked:
- Baseline Release VST3: **7.6 MB**
- Pulp Release VST3 (overlay mounted): **33 MB** (~25 MB of Skia + Dawn + Yoga + JS engine + Pulp view runtime)

Run any of these to see it:
```
"Build/DreamDateFX-Pulp-Rel/DreamDateFX_artefacts/Release/Standalone/Dream Date FX.app"
"Build/DreamDateFX-Pulp-Rel/DreamDateFX_artefacts/Release/VST3/Dream Date FX.vst3"
"Build/DreamDateFX-Pulp-Rel/DreamDateFX_artefacts/Release/AU/Dream Date FX.component"
"Build/DreamDateFX-Pulp-Rel/DreamDateFX_artefacts/Release/AAX/Dream Date FX.aaxplugin"
```

No parameter wiring yet — Elysium knobs and FX rack are visual only. That's by design for this spike.

## JUCE → Pulp conversion plan (per Daniel, 2026-06-07)

After asking Daniel which import path (DesignIR JSON / HTML / JSX) we should target, his answer is **hybrid A+C, not any of them in isolation**:

- **Extractor:** walk the live JUCE `Component` tree (path A). Emits a manifest per node: bounds, z-order, bound param (if any), **static-vs-dynamic classification**, and a reference PNG.
- **Destination:** JSX + Canvas2D (path C). Layout from bounds, static nodes become `ImageView` with the snapshot PNG, value-dependent controls become Pulp controls bound to params.
- **Reject DesignIR** as the target — it's a static design format and can't represent a knob whose pixels are a function of its value. Good extraction source, wrong destination.
- **Reject HTML** as the target — degenerates to embedded `<canvas>` + JS, which is path C laundered through HTML.

### The leverage insight

> "Hundreds of custom-painted components" never means hundreds of paint routines — JUCE funnels custom drawing through a shared `LookAndFeel` (`drawRotarySlider`, `drawLinearSlider`, `drawButtonBackground`, …). Port the dozen-ish L&F methods to Canvas2D once and you've covered all hundreds of instances.

The whole project's tractability hinges on this. The real work isn't N components, it's ~12 draw functions. `juce::Graphics → Pulp Canvas2D` is close to 1:1 (`drawEllipse → arc/ellipse`, `Path + strokePath → Canvas2D path API`, `ColourGradient → createLinear/RadialGradient`, etc.).

### Caveats

1. **Clean-room / licensing.** Porting our own custom paint code is fine. If a control leans on stock `juce::LookAndFeel_V4` (AGPL), re-derive that appearance from rendered output (snapshot the pixels and recreate from appearance — never from JUCE source).
2. **Architectural boundary.** The JUCE-linked extractor must be **separate** from the Pulp side. Extractor links JUCE, runs once, produces a manifest + PNGs. The Pulp/JSX scaffolder consumes that manifest and must never link JUCE. Mirrors the same SDK/substrate-vs-add-on split as `pulp-embed-juce` itself.

### Concrete work plan

1. **Extractor** (lives in DDIF, links JUCE): walks `InstrumentEditor`'s `Component` tree, classifies each node static-vs-dynamic, emits `ddif-ui-manifest.json` + `assets/<node>.png` reference snapshots.
2. **Scaffolder** (lives Pulp-side, no JUCE): consumes the manifest, emits a JSX project — layout from bounds, static nodes as `ImageView`s, dynamic controls bound to params.
3. **LookAndFeel port** (a dozen-ish Canvas2D functions): replaces image-snapshot placeholders one draw method at a time. UI works on day one; fidelity improves per port.
4. **Stock-LookAndFeel reproduction**: redo appearance from rendered pixels, not from JUCE source.

## Upstream q1, q6-q8 fixes consumed (2026-06-08)

Daniel merged the q1 host-param-bridge and the q6-q8 render fixes on his side
(see his "1-notes-for-matt-fix-import.md"). Pulled into our chain:

- **q1 (host-param bridge):** `pulp-embed-juce` `main` HEAD `1704f10` adds a
  new `PulpEmbedComponent(file, w, h, juce::AudioProcessor&)` ctor that wires
  the C ABI host callbacks automatically. DDIF's `PluginEditor.cpp` now uses
  this 4-arg form — embedded controls become mouse-interactive *and* will
  bind to JUCE APVTS parameters by string key (widget id == ParameterID).
  Logs `boundParameterCount()` for self-checks. Knobs now respond to mouse
  interaction even when no parameter binds (Pulp's default `<Knob>` widget
  is internally interactive).
- **q6-q8 (silent rendering modes):** the 152-widget cap, the path-order
  sensitivity, and the compound-path failure — all gone on `pulp` `main`.
  Verified by raising `HARD_PRIMS` to 1000 (effectively unlimited) and
  re-rendering. The full 152 visible chrome paths + 91 widget overlays
  (~243 total) render correctly. Diff ticked slightly better
  (0.24% vs 0.25% @ 10% fuzz).
- **Widget emission reactivated.** `classify()` again maps JUCE/YSS classes
  to `@pulp/react` `<Knob>` / `<Fader>` / `<Button>` / `<Toggle>` / `<Meter>`.
  `WIDGETS_TRANSPARENT_OVERLAY=true` keeps widgets click-capturing but
  visually invisible so the SVG chrome stays the pixel source of truth.

### What's still needed for full APVTS binding

DDIF widget IDs in the manifest are `n11`, `n15`, ... (auto-generated by the
`UIExporter`). For Pulp to bind a knob to (say) `masterOutput`, the JSX widget
id must equal the JUCE APVTS `ParameterID` string. Two paths:

- **A:** patch `yss::UIExporter` to read the slider's `juce::SliderParameterAttachment`
  (or yssUI's own param attachment wrapper) and emit `paramID` in the manifest.
  Converter then uses that as the JSX `id` instead of `n<index>`. ~30 LoC in
  yssUI; single point of change.
- **B:** tag sliders at construction with `slider.getProperties().set("paramID", ...)`
  in the YSS factories and in DDIF's call sites. Reader is just
  `comp.getProperties()["paramID"]`. Touches ~50 sites across YSS + DDIF.

A is cleaner. Both are achievable without Daniel.

## 99.75% pixel match achieved (2026-06-07) — visual-only goal **DONE**

Visual diff against the JUCE reference, normalized to DDIF FX's 1000×536 design size:

| metric | value | fraction |
|---|---|---|
| AE strict (exact pixel match) | 61,223 px | 11.4% |
| AE @ 5% fuzz | 24,344 px | 4.5% |
| AE @ 10% fuzz | **1,331 px** | **0.25%** |
| MAE (per-channel error) | — | 0.0034 |

**Run the whole pipeline:**
```bash
./Scripts/ddif-pulp-pipeline.sh
```

This re-exports the live DDIF editor, converts it through the full
JSX → bundle → embed pipeline, renders headlessly, and diffs against
the JUCE reference in ~10 seconds.

**Mount the converted UI in DDIF Standalone:**
```bash
"Build/DreamDateFX-Pulp-Rel/.../Dream Date FX.app/Contents/MacOS/Dream Date FX" \
  --pulp-bundle /tmp/ddif-bundle
```

What's mounted: pixel-faithful render of DDIF FX (lavender bg, cream panel, LFO frame with Sine/Square/Saw + Wave/Sync/Sync labels, 6 module slots, MASTER strip with GR meter + Threshold knob, 8 macros with bypass dots + value labels, "No Preset" preset bar, gear icon, all positioned correctly at DDIF's 1000×536 design size).

The residual 0.25% diff is concentrated on rasterizer anti-aliasing differences (Pulp's Skia/Dawn vs JUCE's Graphics on Core Graphics) — irreducible without identical rasterizers.

### Keys that got us here

- **Cap raised 70 → 151** — the exact cliff edge for `@pulp/react` widget bridge silent rendering failure. Adding one more emits a blank Skia surface.
- **Render at native design size (1000×536)** — converter scales captured 1430×766 manifest coordinates down to DDIF FX's design size so the in-DDIF embed shows the full bundle (not just top-left third).
- **Drop widget emission entirely** — `yss::UIExporter`'s SVG capture *is* JUCE's painted output verbatim. Emitting `@pulp/react` widgets on top would double-render with the default Pulp knob/button visuals fighting the JUCE paint. Widget classification reactivates when the param bridge is wired (Daniel-blocked, q1).
- **Visibility filter on no-fill paths** — JUCE's SVGGraphicsContext emits clip-path defs as `<path d=…/>` with no fill. They render as no-ops but burn budget. Dropping them frees ~53 elements of capacity.
- **Real `Label::getText()` / `Button::getButtonText()`** — `yssUI::UIExporter` patched on YSS `experiment/pulp-embed` branch to capture text contents so labels show "LFO" / "MASTER" / "---" / "Sine" instead of class names.

### What's left to do (all Daniel-blocked)

See **Open questions (for Daniel)** above. Q1 (param bridge), q6-q8 (silent rendering modes) are the only things between us and full interactivity. Everything achievable without his input has been done.

## First end-to-end DDIF→Pulp round-trip (2026-06-07)

The full conversion pipeline is working:

```
JUCE editor (live)
  → yss::UIExporter::exportComponent()                     [--ui-export CLI flag]
  → /tmp/ddif-ui-export/ComponentTree.json (134 components)
  → Scripts/ddif-jsx-from-export.mjs                       [our converter]
  → /tmp/ddif-jsx/ddif-fx.jsx                              (81 lines, @pulp/react widgets)
  → pulp/tools/import-design/jsx-runtime/jsx-transform.mjs [Pulp's esbuild wrapper]
  → /tmp/ddif-jsx/ddif-fx-bundle.js                        (918 KB IIFE)
  → pulp-cpp import-design --from jsx --mode live --emit js [Pulp's importer]
  → /tmp/ddif-bundle/ui.js                                  (embed-ready)
  → pulp_juce::PulpEmbedComponent                          [via --pulp-bundle <dir> in DDIF]
  → live Metal/Skia render on top of JUCE editor
  → /tmp/ddif-pulp-side.png                                [via --pulp-capture <path>]
```

The captured render shows: 8 macro-strip knobs in a row with bypass buttons + value labels, a Threshold knob on the right, preset selector bar widgets at top, LFO toggle on the left. Bounds preserved from JUCE. **91 of 134 components emitted as widgets** (rest are hidden subtrees / native-view internals).

### Pulp upstream bug found: sibling-count cliff at ~152

Bisecting on 2026-06-07: emitting more than **~152 sibling `<SvgPath>`/`<SvgRect>` elements at the JSX root silently fails to render anything at all** — the Skia surface comes up blank white instead of compositing the elements. Confirmed:

- 152 elements → renders correctly
- 153 elements → blank
- Wrapping the elements in nested `<View>` buckets does **not** raise the cap (152 still failed when the elements were split across multiple parents)
- The cap appears to be on total widget count across the bridge, not per-parent
- No error / warning in the runtime trace — it's a silent failure

Repro fixtures live at `/tmp/ddif-jsx/chromeN.mjs` and `/tmp/ddif-jsx/chrome-*.png`. Daniel: probably worth a peek at `pulp::view::widget_bridge` for a hard-coded bridge limit or a 4-byte counter overflow.

**Workaround:** the converter caps SVG primitive emission at 70 (`HARD_PRIMS` in `Scripts/ddif-jsx-from-export.mjs`). 70 + ~91 widgets = ~161 root descendants but only the first 70 are siblings → still below the cliff. The tail of `MainEditor.svg` after primitive 70 is tiny resize-corner zigzag glyphs that are invisible at our 1000-wide render anyway, so the cap barely costs visible fidelity.

### Known fidelity gaps in this first cut (all addressable)

- **Knob values are 0.5 placeholders.** No param binding yet — that's still S1 in the open-questions list.
- **Labels show C++ class names** (`"Label"`, `"TextButton"`, `"VectorIconButton"`) because the UIExporter manifest doesn't capture `Label::getText()` / `Button::getButtonText()`. Adding text fields to the manifest is a small yssUI patch.
- **No background panel chrome.** DDIF's cream `#fbf4e6` rounded panel, the LFO/MASTER section frames, and other static decoratives all come from `paint()` overrides on `juce::Component`s. They render as transparent `<View>`s in Pulp because their classes don't map to a widget. Fix: emit slice-from-`MainEditor.svg` `<SvgPath>` children for nodes flagged as static decoratives.
- **Standalone window chrome included.** Editor was captured at 1430×766 (standalone toolbar around the 1000×536 plugin content). The JSX positions widgets in the captured 1430×766 coordinate space. Trim to the inner 1000×536 by either inserting a translate at the root or by exporting the plugin via the AU/VST3 wrappers (where there's no standalone chrome).
- **MainEditor.svg unused.** All the static-paint visual identity sits in this SVG — we're not feeding it to the JSX yet. The converter currently ignores it. Next iteration should slice the SVG by node bounds and emit per-node `<SvgPath>` children to fill in the chrome.

## Loose ends after end-to-end build

- **Debug builds of DDIF still fail to link**, but **with a pre-existing YSS test issue** (`yss::registerTimeStretchEngineTests()` undefined in `yssSamplerTests.cpp`). This was failing on `main` before any Pulp work — confirmed by building plain DDIF on this branch. Not a Pulp blocker; should be tracked separately.
- **Linker macOS-version warnings:** Pulp's archives were compiled at `-mmacosx-version-min=15.4` (the host SDK), so linking against a 10.15-min DDIF produces ~hundreds of "object file built for newer macOS version" warnings. Harmless but noisy. Pulp's CMake should propagate `CMAKE_OSX_DEPLOYMENT_TARGET` so consumers don't get this. Candidate for a fork PR.
- **Debug Pulp SDK was rejected by `PulpSdkGuards.cmake`** — had to rebuild Pulp Release and reinstall. The bootstrap script makes Release default; the guard is the right call.

---

## Next steps

_Filled in at end of each session — what to pick up next time._
