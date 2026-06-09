#!/usr/bin/env node
// ddif-jsx-from-export.mjs — convert yss::UIExporter dump → @pulp/react JSX.
//
// Input  (default /tmp/ddif-ui-export):
//   - ComponentTree.json   recursive class/bounds dump of the live editor
//
// Output (default /tmp/ddif-jsx/ddif-fx.jsx):
//   - single-file React JSX using @pulp/react intrinsics, positioned by
//     absolute bounds. Suitable for tools/import-design/jsx-runtime/
//     jsx-transform.mjs → pulp import-design --from jsx.
//
// Usage:
//   node Scripts/ddif-jsx-from-export.mjs \
//     [--in /tmp/ddif-ui-export] \
//     [--out /tmp/ddif-jsx/ddif-fx.jsx]
//
// Classification model (loose, deliberately): for now every visible JUCE/YSS/
// DDIF class is mapped to the nearest @pulp/react widget by name. Bounds use
// the manifest's `bounds` field (parent-local), which the prop-applier-layout
// in @pulp/react converts to absolute placement when we set position:absolute.
// The output is a placeholder — Knob/Fader values are 0.5, labels are blank,
// no event handlers — because we haven't done parameter binding yet. The
// goal is to prove the round-trip (JUCE editor → manifest → JSX → Pulp
// bundle → rendered) and iterate from there.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
function arg(name, def) {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const IN_DIR  = arg('--in',  '/tmp/ddif-ui-export');
const OUT_PATH = arg('--out', '/tmp/ddif-jsx/ddif-fx.jsx');

// ── Class → widget mapping ─────────────────────────────────────────────
// With the q1 host-param-bridge ctor (pulp-embed-juce 1704f10, 2026-06-08),
// emitting real widgets makes the embed mouse-interactive AND lets Pulp bind
// to JUCE APVTS parameters when widget ids match. The id mapping is
// PulpEmbedComponent's contract: `widget id == APVTS ParameterID`.
//
// The SVG chrome layer (extracted from JUCE's paint via SVGGraphicsContext)
// stays underneath for visual fidelity of the custom-painted look. Pulp's
// default <Knob> appearance differs from DDIF's LookAndFeel, so widgets +
// SVG overlap means slight double-render — acceptable for the interactivity
// gain. WIDGETS_TRANSPARENT_OVERLAY=true keeps widgets invisible but still
// clickable so the SVG carries the visuals and widgets only catch input.
const WIDGETS_TRANSPARENT_OVERLAY = false;

function classify(cls) {
    // Knobs / rotary sliders — value-bearing controls.
    if (/(::|^)Knob\b/.test(cls))     return { kind: 'Knob' };
    if (cls === 'yss::SaturnRingKnob') return { kind: 'Knob' };
    if (cls === 'juce::Slider')        return { kind: 'Knob' };  // most DDIF sliders are rotary
    if (cls === 'instrument::LFODepthSliders::RangeSlider') return { kind: 'Fader', orientation: 'horizontal' };
    if (cls === 'yss::LevelMeterFader') return { kind: 'Meter' };

    // Buttons (mostly icon-only in DDIF; still emit so clicks register).
    if (cls === 'juce::TextButton')                     return { kind: 'Button' };
    if (cls === 'juce::HyperlinkButton')                return { kind: 'Button' };
    if (/Button$/.test(cls))                            return { kind: 'Button' };
    if (cls === 'yss::VectorIconButton')                return { kind: 'Button' };
    if (cls === 'yss::ToggleTextButton')                return { kind: 'Toggle' };

    // Containers — emit as plain <View> so children inherit absolute positioning.
    return { kind: 'View' };
}

// Should this node be skipped? Hidden subtrees, JUCE accessibility-only nodes,
// the Pulp embed itself (we don't want to recurse into the very thing we're
// generating), the resize corner, the standalone-mode plumbing.
function skip(node) {
    if (!node.visible) return true;
    const cls = node.class;
    if (cls === 'pulp_juce::PulpEmbedComponent') return true;
    if (cls === 'juce::NSViewComponent')          return true;
    if (cls === 'juce::Viewport::AccessibilityIgnoredComponent') return true;
    if (cls === 'juce::TextEditor::TextEditorViewport')          return true;
    if (cls === 'juce::TextEditor::TextHolderComponent')         return true;
    if (cls === 'juce::CaretComponent')                          return true;
    if (cls === 'yss::ResizeCorner')                             return true;
    if (cls === 'yss::ScalableEditorMixin::ContentWrapper')      return false;  // its children are the editor
    return false;
}

// ── SVG chrome extraction ──────────────────────────────────────────────
// Pull every <rect> and <path> out of MainEditor.svg. Each becomes one
// <SvgRect>/<SvgPath> JSX element spanning the full editor canvas in the
// SVG's coordinate space, stacked beneath the widgets. Drops the SVG's
// clip-paths (Pulp's primitives don't expose <clipPath>) — most chrome
// shapes are self-clipping so this is usually fine; over-bleed shows up
// at the edges only on small clipped paths.
function extractSvgPrimitives(svgPath, viewW, viewH) {
    let svg;
    try { svg = readFileSync(svgPath, 'utf-8'); }
    catch { return []; }   // no svg, no chrome
    const out = [];
    // Quick + dirty attribute extraction. The SVG comes from SVGGraphicsContext
    // and is well-formed enough for a regex (no nested CDATA / oddities).
    const rectRe = /<rect\b([^>]*?)\/?>/g;
    const pathRe = /<path\b([^>]*?)\/?>/g;
    const attr = (s, name) => {
        const m = s.match(new RegExp(`\\b${name}="([^"]*)"`));
        return m ? m[1] : null;
    };
    for (const m of svg.matchAll(rectRe)) {
        const a = m[1];
        const x = +(attr(a, 'x') ?? 0), y = +(attr(a, 'y') ?? 0);
        const w = +(attr(a, 'width') ?? 0), h = +(attr(a, 'height') ?? 0);
        const fill = attr(a, 'fill');
        if (w <= 0 || h <= 0) continue;
        out.push({ kind: 'rect', x, y, w, h, fill, _bbox: { w, h } });
    }
    for (const m of svg.matchAll(pathRe)) {
        const a = m[1];
        const d = attr(a, 'd');
        if (!d) continue;
        const fill = attr(a, 'fill');
        const stroke = attr(a, 'stroke');
        // Cheap bbox: extract numeric pairs from d= and find min/max.
        const nums = (d.match(/-?\d+\.?\d*/g) || []).map(Number);
        let xs = [], ys = [];
        for (let i = 0; i + 1 < nums.length; i += 2) { xs.push(nums[i]); ys.push(nums[i + 1]); }
        const bbox = xs.length === 0 ? { x: 0, y: 0, w: 0, h: 0 } : {
            x: Math.min(...xs),
            y: Math.min(...ys),
            w: Math.max(...xs) - Math.min(...xs),
            h: Math.max(...ys) - Math.min(...ys),
        };
        out.push({ kind: 'path', d, fill, stroke, _bbox: bbox });
    }
    return out;
}

// Skip paths whose bounding box is below MIN_PRIM_SIZE on both axes.
// Catches the resize-corner zigzag (4-pt paths ~3px wide) and other
// near-invisible artifacts that would burn element budget for no
// visible benefit. Pixel-perfect target so we err small.
const MIN_PRIM_SIZE = 4;
function isLargeEnough(p) {
    return p._bbox.w >= MIN_PRIM_SIZE || p._bbox.h >= MIN_PRIM_SIZE;
}

// JUCE's SVGGraphicsContext emits clip-path definitions as plain <path>
// elements with no `fill` and no `stroke` — they're meant to be referenced
// by `clip-path="url(#cpN)"` on subsequent paths. Without that machinery
// they render as invisible no-ops but still occupy element budget. Drop
// them so the cap can accommodate more visible content.
function isVisible(p) {
    if (p.kind === 'rect') return p.fill && p.fill !== 'none';
    return (p.fill && p.fill !== 'none') || (p.stroke && p.stroke !== 'none');
}

// Pulp's @pulp/react silently fails to render anything when the *total* widget
// count crosses ~152 (bisected 2026-06-07 — same parent or split across child
// Views makes no difference; reproduces with chrome-only fixtures too).
//
// Workaround: merge consecutive same-style path/rect primitives into compound
// paths. JUCE's SVGGraphicsContext emits one <path> per draw call, including
// per-glyph for text — so a single "MASTER" label is ~6 paths all sharing
// fill=#a19b92. Merging by (fill, stroke, strokeWidth) collapses those into
// one compound <SvgPath> with concatenated d= data, recovering pixel parity
// at a fraction of the element count.
//
// HARD_PRIMS is a final safety net after merging — set high enough that
// well-merged input shouldn't hit it.
const HARD_PRIMS = 1000;

function mergeByStyle(prims) {
    // Group consecutive primitives sharing fill/stroke/strokeWidth into one
    // compound <SvgPath>. Rects break the chain (they have a different
    // intrinsic shape — width/height attrs — and can't be expressed as path
    // data without manual rect→path conversion, which is fine to skip).
    const out = [];
    let cur = null;
    const styleKey = (p) =>
        `${p.fill ?? ''}|${p.stroke ?? ''}|${p.strokeWidth ?? ''}`;
    for (const p of prims) {
        if (p.kind !== 'path') {
            if (cur) { out.push(cur); cur = null; }
            out.push(p);
            continue;
        }
        const k = styleKey(p);
        if (cur && cur.kind === 'path' && cur._k === k) {
            cur.d = cur.d + ' ' + p.d;
        } else {
            if (cur) out.push(cur);
            cur = { ...p, _k: k };
        }
    }
    if (cur) out.push(cur);
    return out;
}

// ── Coordinate-space scaling ───────────────────────────────────────────
// JUCE captured the editor at whatever size the Standalone window was
// when --ui-export ran (typically the wrapper's resized 1430×766). DDIF FX's
// design coordinate system is 1000×536 — that's the bounds the in-DDIF
// PulpEmbedComponent gives the bundle. If we leave widget positions in the
// captured space, the live embed clips to its viewport. Scale everything to
// DDIF's design size so the bundle fits any plugin instance natively.
const TARGET_W = 1000, TARGET_H = 536;
let SX = 1, SY = 1;
{
    // Read editor bounds from the manifest below — defer until manifest loads
}

const _rawPrims  = extractSvgPrimitives(`${IN_DIR}/MainEditor.svg`, 1430, 766);
const _sizeOk    = _rawPrims.filter(isLargeEnough);   // drop tiny resize-corner glyphs etc.
const _filtered  = _sizeOk.filter(isVisible);          // drop no-fill clip-path rectangles
// Document order — empirically, Pulp's SvgPathWidget silently fails to render
// certain individual paths (which we haven't isolated yet), and re-ordering
// them via area-sort surfaces those bad paths in the kept set. Sticking with
// JUCE's emission order keeps a known-good prefix.
const svgPrims  = _filtered.slice(0, HARD_PRIMS);

// ── Load + index ───────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(`${IN_DIR}/ComponentTree.json`, 'utf-8'));
const byIndex  = new Map(manifest.components.map(c => [c.index, c]));
const childrenOf = new Map();
for (const c of manifest.components) {
    if (c.parent < 0) continue;
    if (!childrenOf.has(c.parent)) childrenOf.set(c.parent, []);
    childrenOf.get(c.parent).push(c);
}

const editor = manifest.editor;
const rootIndex = manifest.components[0]?.index ?? 0;

// Scale captured-coord space (editor.width × editor.height) → design space
// (TARGET_W × TARGET_H). DDIF FX is 1000×536 by design; the Standalone may
// have captured at 1430×766 because its wrapper resized. Apply uniform scale
// so positions land in DDIF's design coordinate system.
SX = TARGET_W / editor.width;
SY = TARGET_H / editor.height;

// ── Pair Knobs to their purple indicator triangles ─────────────────────
// Each macro/threshold knob in DDIF has a small #7b6896 purple triangle
// painted by JUCE's LookAndFeel as the value indicator. JUCE captures it
// as a static SvgPath — when the user drags the Pulp Knob the indicator
// doesn't follow. Pair each Knob to its triangle, strip it from the static
// chrome, and re-emit it inside a per-knob React-state-driven wrapper so a
// `transform: [{rotate: ...}]` reads off the Knob's onChange.
const PURPLE_FILL = '#7b6896';     // macro indicator (juce::Slider + DDDTheme)
const MED_BROWN_FILL = '#a19b92';  // threshold indicator (SaturnRingKnob)
const INDICATOR_FILLS = new Set([PURPLE_FILL, MED_BROWN_FILL]);
const TRIANGLE_MAX_PX = 80;        // editor coords; indicators are ~6-24px

// Triangles drawn by DDIF's knob LookAndFeels are exact `Path::addTriangle`
// shapes — three points + close = "M x,y L x,y L x,y Z". Text glyphs sit in
// the same fill colour and bbox range but use many more curve points, so
// numPts == 3 cleanly disambiguates indicator from label letter.
function isIndicatorTriangle(p) {
    if (p.kind !== 'path') return false;
    if (!INDICATOR_FILLS.has((p.fill ?? '').toLowerCase())) return false;
    if (p._bbox.w <= 0 || p._bbox.w > TRIANGLE_MAX_PX) return false;
    if (p._bbox.h <= 0 || p._bbox.h > TRIANGLE_MAX_PX) return false;
    const nums = (p.d.match(/-?\d+\.?\d*/g) || []);
    return nums.length === 6;   // exactly 3 (x,y) pairs
}

// JUCE's macro-slot LookAndFeel paints the cream knob ring at the TOP of
// the slot's parent View, then positions the juce::Slider child 30px below
// it (so the slot's lower portion shows the value label). The Slider's
// reported bounds are at the Slider's true rect, NOT the visual ring. If
// we render the Pulp native Knob at the Slider's global bounds, it lands
// 30px below the cream ring and the two visuals don't overlap. To make the
// native Knob, the chrome ring, and the rotating triangle all align,
// resolve the ring's actual bbox from the SVG chrome and render the Knob
// there.
const RING_FILL = '#e8e1d5';        // macro cream ring (DDDTheme rotary)
const SATURN_RING_FILL = '#a19b92'; // threshold/saturn knob ring
const RING_FILLS = new Set([RING_FILL, SATURN_RING_FILL]);
function findRingFor(tri, prims) {
    const triCx = tri._bbox.x + tri._bbox.w / 2;
    const triCy = tri._bbox.y + tri._bbox.h / 2;
    let best = null, bestArea = Infinity;
    for (const p of prims) {
        if (p.kind !== 'path' || !RING_FILLS.has((p.fill ?? '').toLowerCase())) continue;
        const b = p._bbox;
        if (b.w < 30 || b.h < 30) continue;             // too small to be a knob ring
        if (b.w > 120 || b.h > 120) continue;            // too large — different art
        if (triCx < b.x || triCx > b.x + b.w) continue; // triangle center must sit inside
        if (triCy < b.y || triCy > b.y + b.h) continue;
        const area = b.w * b.h;
        if (area < bestArea) { bestArea = area; best = p; }
    }
    return best;
}

const reservedTriangles = new Set();   // triangles claimed by a Knob
const reservedRings     = new Set();   // rings hoisted into K* (for hover)
const knobToTriangle    = new Map();   // node.index → { tri, ring }
{
    const triangles = svgPrims.filter(isIndicatorTriangle);
    for (const node of manifest.components) {
        if (classify(node.class).kind !== 'Knob') continue;
        const [nx, ny, nw, nh] = node.global ?? node.bounds;
        const knobCx = nx + nw / 2;
        const knobCy = ny + nh / 2;
        const PAD = 8;
        let best = null, bestDist = Infinity;
        for (const tri of triangles) {
            if (reservedTriangles.has(tri)) continue;
            const triCx = tri._bbox.x + tri._bbox.w / 2;
            const triCy = tri._bbox.y + tri._bbox.h / 2;
            if (triCx < nx - PAD || triCx > nx + nw + PAD) continue;
            if (triCy < ny - PAD || triCy > ny + nh + PAD) continue;
            const dist = Math.hypot(triCx - knobCx, triCy - knobCy);
            if (dist < bestDist) { bestDist = dist; best = tri; }
        }
        if (best) {
            const ring = findRingFor(best, svgPrims);
            knobToTriangle.set(node.index, { tri: best, ring });
            reservedTriangles.add(best);
            if (ring) reservedRings.add(ring);
        }
    }
}

// Strip reserved triangles + rings from the static chrome — both are
// re-emitted inside their per-knob wrapper component (rings need to react
// to hover state; triangles need to rotate on drag).
const chromeSvgPrims = svgPrims.filter(p =>
    !reservedTriangles.has(p) && !reservedRings.has(p));

// DDIF's `DDDTheme::drawRotarySlider` paints the cream ring as a SINGLE
// stroked circle:
//   g.setColour(0xffe8e1d5);
//   g.drawEllipse(cx-r, cy-r, 2r, 2r, /*strokeWidth*/ 6.0f);
// JUCE's `SVGGraphicsContext` lowers `drawEllipse(stroke=N)` into a FILLED
// annular path (two concentric sub-paths in a compound `M…Z M…Z`). Without
// `fill-rule="evenodd"` (which Pulp's @pulp/react `<SvgPath>` doesn't yet
// expose) the inner sub-path doesn't subtract, so Pulp paints a solid disk
// with a visible inner-edge ring — the "double knob" the user reported.
// Fix on the converter side: collapse each annular cream ring back into the
// original stroked-only single ellipse — keep just the outer sub-path, set
// fill="none", stroke=#e8e1d5, strokeWidth=6. Same color as JUCE intended.
for (const p of chromeSvgPrims) {
    if (p.kind !== 'path') continue;
    const fill = (p.fill ?? '').toLowerCase();
    if (!RING_FILLS.has(fill)) continue;
    if (!/\bZ\s+M/.test(p.d)) continue;          // compound = annular
    if (p._bbox.w < 30 || p._bbox.w > 120) continue;
    if (p._bbox.h < 30 || p._bbox.h > 120) continue;
    // Keep the outer sub-path only (up to and including the first Z).
    const firstZ = p.d.indexOf('Z');
    if (firstZ < 0) continue;
    p.d = p.d.slice(0, firstZ + 1);
    p.stroke = fill;             // same colour DDIF originally used for the stroke
    p.fill = 'none';
    // DDDTheme macros use strokeWidth=6; SaturnRingKnob declares
    // `kStrokeWidth = 2.0f`. Match by ring size — small rings get the
    // thinner stroke.
    p.strokeWidth = (p._bbox.w < 50) ? 2 : 6;
}

// ── Emit ───────────────────────────────────────────────────────────────
let out = '';
out += `// AUTO-GENERATED by Scripts/ddif-jsx-from-export.mjs — do not edit by hand.\n`;
out += `// Source: ${IN_DIR}/ComponentTree.json (${manifest.components.length} components)\n`;
out += `// Editor logical size: ${editor.width}x${editor.height}\n\n`;
out += `import { useState } from 'react';\n`;
out += `import { View, Row, Col, Panel, Label, Button, TextEditor,\n`;
out += `         Knob, Fader, Meter, Toggle, Canvas,\n`;
out += `         SvgPath, SvgRect } from '@pulp/react';\n\n`;

// Per-knob wrapper components — one <K${index}> per paired knob. Each owns
// its own useState and rotates its SvgPath indicator with the knob value.
// Emitted between imports and the main DDIF() default export.
function emitAnimatedKnobComponent(node, pair) {
    // Prefer the cream ring's bbox over the Slider's reported global bounds.
    // JUCE paints the cream ring 30px above the Slider's rect in DDIF's
    // macro-slot LookAndFeel; rendering the Pulp Knob at the ring position
    // makes the native Knob, the static chrome ring, and the rotating
    // triangle all align as the user expects.
    const { tri, ring } = pair;
    const ringBbox = ring?._bbox;
    const sliderBounds = node.global ?? node.bounds;
    const [bx, by, bw, bh] = ringBbox
        ? [ringBbox.x, ringBbox.y, ringBbox.w, ringBbox.h]
        : sliderBounds;
    const kx = Math.round(bx * SX), ky = Math.round(by * SY);
    const kw = Math.round(bw * SX), kh = Math.round(bh * SY);
    // transform-origin in WIDGET (SvgPath) bounds coords. SvgPath spans
    // full editor (TARGET_W × TARGET_H), so the knob center as a fraction
    // of the full editor IS the transform origin we need.
    const ringCx = bx + bw / 2;
    const ringCy = by + bh / 2;
    const originXPct = (ringCx / editor.width) * 100;
    const originYPct = (ringCy / editor.height) * 100;
    // Infer the editor's captured value for THIS knob from the triangle's
    // angle relative to the ring center. Standard knob arc spans -135° (min,
    // 7 o'clock) to +135° (max, 5 o'clock) clockwise from 12 o'clock-up.
    // atan2(dx, -dy) puts 0° at 12 o'clock and increases clockwise.
    const triCx = tri._bbox.x + tri._bbox.w / 2;
    const triCy = tri._bbox.y + tri._bbox.h / 2;
    const captureAngleDeg = Math.atan2(triCx - ringCx, -(triCy - ringCy)) * 180 / Math.PI;
    const captureV = Math.max(0, Math.min(1, (captureAngleDeg + 135) / 270));
    const id = `n${node.index}`;
    const compName = `K${node.index}`;
    const fill = tri.fill ?? PURPLE_FILL;
    const stroke = tri.stroke && tri.stroke !== 'none' ? ` stroke="${tri.stroke}"` : '';
    // Initial v = captureV so the triangle starts at its captured pose
    // (rotation = 0). Drag CW → angle increases up to +135°, drag CCW →
    // down to -135°, both relative to the captured rest position.
    // Knob is opacity:0 — invisible but still receives mouse drag so the
    // user only sees the DDIF SVG chrome + rotating purple triangle.
    // Reconstruct the stroked-circle ring from the captured annular path
    // (same conversion as the chrome pipeline does for un-hoisted rings).
    // Carrying it inside the per-knob component lets us toggle its stroke
    // colour on hover — DDIF's SaturnRingKnob brightens the ring when the
    // mouse is over the knob; macros do the same via `getKnobColour()`.
    let ringJsx = '';
    let ringRadius = 0;
    if (ring) {
        const ringColor = (ring.fill ?? RING_FILL).toLowerCase();
        const ringStrokeW = (ring._bbox.w < 50) ? 2 : 6;
        ringRadius = (ring._bbox.w - ringStrokeW) / 2;
        const firstZ = ring.d.indexOf('Z');
        const ringD = firstZ >= 0 ? ring.d.slice(0, firstZ + 1) : ring.d;
        ringJsx =
            `      <SvgPath d="${ringD}" viewBox={[${editor.width},${editor.height}]} ` +
            `fill="none" stroke={hover ? '#bfb8aa' : '${ringColor}'} strokeWidth={${ringStrokeW}} ` +
            `style={{position:'absolute', left:0, top:0, width:${TARGET_W}, height:${TARGET_H}, ` +
            `pointerEvents:'none'}} />\n`;
    }
    // Saturn-ring modulation-depth arc. Drawn from the value position around
    // the ring by `modDepth × 270°` (full knob arc span). Mirrors DDIF's
    // `SaturnRingKnob::drawSaturnRing()` / `MacroSlot::paintOverChildren()`
    // visualization — sweeps from value → value+modDepth in the accent colour.
    // Visible only on hover, and only when modDepth > kMinVisibleDepth.
    //
    // modDepth is currently hardcoded as a placeholder (0.3) so the arc
    // renders visibly even from an editor capture with no modulation set.
    // Real per-knob modDepth capture is a follow-up yssUI patch — Slider
    // properties or a SaturnRingKnob getter, surfaced through UIExporter.
    const arcRadius = (ring && ring._bbox)
        ? (Math.min(ring._bbox.w, ring._bbox.h) - ((ring._bbox.w < 50) ? 2 : 6)) / 2
        : 33;
    const arcStrokeWidth = (ring && ring._bbox && ring._bbox.w < 50) ? 2 : 6;
    const arcColour = '#7b6896';    // DDIF accent (control-accent purple)
    const saturnArc =
        `      {hover && Math.abs(modDepth) > 0.01 && (() => {\n` +
        `        const baseAngle = (-135 + v * 270) * Math.PI / 180;\n` +
        `        const endVal    = Math.max(0, Math.min(1, v + modDepth));\n` +
        `        const endAngle  = (-135 + endVal * 270) * Math.PI / 180;\n` +
        `        const r         = ${arcRadius};\n` +
        `        const cx        = ${ringCx};\n` +
        `        const cy        = ${ringCy};\n` +
        `        const baseX = cx + r * Math.sin(baseAngle);\n` +
        `        const baseY = cy - r * Math.cos(baseAngle);\n` +
        `        const endX  = cx + r * Math.sin(endAngle);\n` +
        `        const endY  = cy - r * Math.cos(endAngle);\n` +
        `        const sweep = (endAngle - baseAngle) > 0 ? 1 : 0;\n` +
        `        const large = Math.abs(endAngle - baseAngle) > Math.PI ? 1 : 0;\n` +
        `        const d = \`M \${baseX.toFixed(2)},\${baseY.toFixed(2)} A \${r},\${r} 0 \${large},\${sweep} \${endX.toFixed(2)},\${endY.toFixed(2)}\`;\n` +
        `        return (\n` +
        `          <SvgPath d={d} viewBox={[${editor.width},${editor.height}]} ` +
        `fill="none" stroke="${arcColour}" strokeWidth={${arcStrokeWidth}} ` +
        `style={{position:'absolute', left:0, top:0, width:${TARGET_W}, height:${TARGET_H}, ` +
        `pointerEvents:'none'}} />\n` +
        `        );\n` +
        `      })()}\n`;
    // Hover value-readout label, positioned where the static slot label
    // ("LFO", "---", "MASTER") sits in the captured chrome. The panel
    // background colour (#fbf4e6) masks the underlying static label so the
    // value overlays cleanly. Matches DDIF's SaturnRingKnob::paint behaviour
    // — when isHovered_, the label text is replaced with the formatted value.
    // Format defaults to "NN%" (DDIF's fallback when no valueFormatter is
    // wired). Per-product value formatters are a future yssUI capture.
    const labelX  = Math.max(0, kx - 10);
    const labelY  = ky + kh + 14;  // sit ON the static slot label (y≈465 in DDIF)
    const labelW  = kw + 20;
    const labelH  = 14;
    // Conditional render keyed on hover state. If onMouseEnter doesn't fire
    // on the opacity:0 Knob (Pulp may skip hit-test for invisible widgets),
    // we'll add a transparent <View> overlay that explicitly handles hover.
    const valueOverlay =
        `      {hover && (\n` +
        `        <View style={{position:'absolute', left:${labelX}, top:${labelY}, ` +
        `width:${labelW}, height:${labelH}, backgroundColor:'#fbf4e6', pointerEvents:'none'}}>\n` +
        `          <Label text={\`\${Math.round(v * 100)}%\`} ` +
        `style={{position:'absolute', left:0, top:0, width:${labelW}, height:${labelH}, ` +
        `color:'#7b6896', textAlign:'center', fontSize:11, pointerEvents:'none'}} />\n` +
        `        </View>\n` +
        `      )}\n`;
    return (
        `function ${compName}() {\n` +
        `  const [v, setV] = useState(${captureV.toFixed(4)});\n` +
        `  const [hover, setHover] = useState(false);\n` +
        `  const angle = (v - ${captureV.toFixed(4)}) * 270;\n` +
        `  const modDepth = 0.3;  // TODO: capture per-knob modDepth via UIExporter\n` +
        `  const handleChange = (e) => setV(typeof e === 'number' ? e : e?.value);\n` +
        `  return (\n` +
        `    <>\n` +
        `      <Knob id="${id}" value={v} onChange={handleChange} ` +
        `onMouseEnter={() => setHover(true)} ` +
        `onMouseLeave={() => setHover(false)} ` +
        `style={{position:'absolute', left:${kx}, top:${ky}, width:${kw}, height:${kh}, opacity:0}} />\n` +
        ringJsx +
        saturnArc +
        valueOverlay +
        `      <SvgPath d="${tri.d}" viewBox={[${editor.width},${editor.height}]} ` +
        `fill="${fill}"${stroke} ` +
        `style={{position:'absolute', left:0, top:0, width:${TARGET_W}, height:${TARGET_H}, ` +
        `transform:[{rotate: \`\${angle}deg\`}], ` +
        `transformOrigin: \`${originXPct.toFixed(2)}% ${originYPct.toFixed(2)}%\`, ` +
        `pointerEvents:'none'}} />\n` +
        `    </>\n` +
        `  );\n` +
        `}\n\n`
    );
}
for (const [idx, pair] of knobToTriangle) {
    out += emitAnimatedKnobComponent(byIndex.get(idx), pair);
}


function emit(node, indent, isRoot = false) {
    if (skip(node)) return '';
    const c = classify(node.class);
    let [x, y, w, h] = node.bounds;
    // The root InstrumentEditor's local bounds include the Standalone window
    // toolbar offset (typically y=30). Pin the root to (0,0) so child
    // positioning is relative to the plugin editor's own origin.
    if (isRoot) { x = 0; y = 0; w = TARGET_W; h = TARGET_H; }
    else { x = Math.round(x * SX); y = Math.round(y * SY); w = Math.round(w * SX); h = Math.round(h * SY); }
    if (w <= 0 || h <= 0) return '';   // collapsed/zero-size, no point emitting

    // For interactive widgets, opacity:0 keeps the SVG chrome visible underneath
    // while the widget itself stays click-capturing. For container Views, no
    // opacity override (transparent View doesn't paint anything by default).
    const styleProps = [`position:'absolute'`, `left:${x}`, `top:${y}`,
                        `width:${w}`, `height:${h}`];
    const isInteractive = c.kind !== 'View';
    if (isInteractive && WIDGETS_TRANSPARENT_OVERLAY) styleProps.push(`opacity:0`);
    const style = `style={{${styleProps.join(', ')}}}`;
    const id = `n${node.index}`;
    const titleAttr = node.class.replace(/"/g, '\\"');

    const kids = (childrenOf.get(node.index) ?? [])
        .map(k => emit(k, indent + '  ', /*isRoot*/ false))
        .filter(s => s.length > 0);

    const pad = indent;
    // JSX attribute-safe text: trim, drop newlines, escape quotes + braces.
    // Empty text → omit the attr (Pulp's Label/Button render fine without).
    const escapeAttr = (s) => (s ?? '').replace(/\s+/g, ' ').trim()
        .replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[{}]/g, '');
    const text = escapeAttr(node.text);

    if (c.kind === 'Knob') {
        // Paired knobs (with a purple-triangle indicator) are emitted at the
        // ROOT level via their per-knob <K${index}> wrapper component. Both
        // the inner <Knob> AND the rotating <SvgPath> use editor-global
        // coords; if we emitted the wrapper here (inside a deep parent View),
        // the Knob's "absolute" left/top would be parent-relative, not
        // editor-relative — landing it in the wrong place.
        if (knobToTriangle.has(node.index)) return '';
        const props = [`id="${id}"`, style];
        return `${pad}<Knob ${props.join(' ')} />\n`;
    }
    if (c.kind === 'Fader' || c.kind === 'Meter') {
        const props = [`id="${id}"`, style];
        if (c.kind === 'Fader') props.push(`orientation="${c.orientation ?? 'horizontal'}"`);
        return `${pad}<${c.kind} ${props.join(' ')} />\n`;
    }
    if (c.kind === 'Label') {
        return text
            ? `${pad}<Label id="${id}" text="${text}" ${style} />\n`
            : `${pad}<Label id="${id}" ${style} />\n`;
    }
    if (c.kind === 'Button' || c.kind === 'Toggle') {
        // Pulp #1006 — `registerClick(id)` only wires through when JS subscribes
        // to a click event. Without `onClick`, native NSEvent reaches View::on_mouse_down
        // but never dispatches the press → no visual press feedback. A noop
        // handler is enough to enable the press registration.
        const handler = `onClick={() => {}}`;
        return text
            ? `${pad}<${c.kind} id="${id}" ${handler} ${style}>${text}</${c.kind}>\n`
            : `${pad}<${c.kind} id="${id}" ${handler} ${style} />\n`;
    }
    if (c.kind === 'TextEditor') {
        return text
            ? `${pad}<TextEditor id="${id}" value="${text}" ${style} />\n`
            : `${pad}<TextEditor id="${id}" ${style} />\n`;
    }
    if (c.kind === 'Canvas') {
        return `${pad}<Canvas id="${id}" ${style} />\n`;
    }
    // View / container
    if (kids.length === 0) {
        return `${pad}<View id="${id}" ${style} />\n`;
    }
    return `${pad}<View id="${id}" ${style}>\n${kids.join('')}${pad}</View>\n`;
}

// jsx-runtime expects `export default <Component>`; the runtime wraps it
// in a render() call. Re-running `render(<DDIF />)` from user code would
// double-mount.
// SVG chrome elements — emitted as siblings beneath the widget tree so JUCE's
// static paint (panel bg, decorative frames, glyph outlines) sits underneath
// the @pulp/react controls. SvgPath/SvgRect get the FULL TARGET viewport;
// path d= data is in the source SVG's coordinate space, and `viewBox` tells
// Pulp how to scale the paths into the widget bounds.
function emitSvg(p) {
    // pointerEvents:'none' so the chrome paints but doesn't block clicks from
    // reaching the @pulp/react widgets layered on top. Verified empirically
    // 2026-06-08: without this, every chrome path at full editor bounds
    // catches the mouse and swallows knob drag.
    const sty = `style={{position:'absolute', left:0, top:0, width:${TARGET_W}, height:${TARGET_H}, pointerEvents:'none'}}`;
    if (p.kind === 'rect') {
        // Rects' x/y/w/h are in widget-local space — scale them.
        const x = Math.round(p.x * SX), y = Math.round(p.y * SY);
        const w = Math.round(p.w * SX), h = Math.round(p.h * SY);
        const props = [`x={${x}}`, `y={${y}}`, `width={${w}}`, `height={${h}}`];
        if (p.fill)   props.push(`fill="${p.fill}"`);
        return `        <SvgRect ${props.join(' ')} ${sty} />\n`;
    }
    // path: keep d= data in source space and use the SVG's native dimensions as
    // the viewBox. Pulp scales viewBox→widget bounds at paint, so the path
    // lands at the right place in the TARGET_W×TARGET_H viewport.
    const props = [`d="${p.d}"`, `viewBox={[${editor.width},${editor.height}]}`];
    // Emit fill=none explicitly when set — Pulp's SvgPath defaults to a
    // solid black fill when no fill attr is provided, NOT transparent.
    if (p.fill === 'none') props.push(`fill="none"`);
    else if (p.fill)        props.push(`fill="${p.fill}"`);
    if (p.stroke && p.stroke !== 'none') {
        props.push(`stroke="${p.stroke}"`);
        if (p.strokeWidth)  props.push(`strokeWidth={${p.strokeWidth}}`);
    }
    return `        <SvgPath ${props.join(' ')} ${sty} />\n`;
}

// Bisecting under @pulp/react shows direct sibling count above ~152 silently
// fails to render anything at all. Buckets keep us safely below that — each
// holds at most CHROME_BUCKET_SIZE primitives, and the JSX root holds a small
// number of bucket Views plus the widget tree.
const CHROME_BUCKET_SIZE = 100;

// Z-order: SVG chrome first (bottom, pointerEvents:'none'), then widgets on top.
// SVG renders the DDIF look-and-feel for static decoration (cream panel,
// LFO frame, module slots, "No Preset", MASTER strip, etc.) while interactive
// widgets sit ABOVE with their default Pulp visuals. The trade-off:
//
//   widgets on top  → visible drag/press feedback (cream Pulp Knob rotates,
//                     dark Pulp Button shows press state), but Pulp's default
//                     widget style is visible over the SVG's custom art
//   chrome on top   → DDIF style everywhere, but invisible widget feedback
//
// Until Pulp's intrinsics expose per-widget skinning (e.g. custom <SvgPath>
// children that re-paint per knob value), we can't have both. Choosing
// "visible feedback" because the user was already adapted to seeing the
// Pulp-default knob rotation when dragging.
out += `export default function DDIF() {\n`;
out += `  return (\n`;
out += `    <View id="root" style={{position:'absolute', left:0, top:0, width:${TARGET_W}, height:${TARGET_H}}}>\n`;
for (let i = 0; i < chromeSvgPrims.length; i += CHROME_BUCKET_SIZE) {
    const slice = chromeSvgPrims.slice(i, i + CHROME_BUCKET_SIZE);
    out += `      <View id="chrome${i / CHROME_BUCKET_SIZE}" style={{position:'absolute', left:0, top:0, width:${TARGET_W}, height:${TARGET_H}, pointerEvents:'none'}}>\n`;
    for (const p of slice) out += emitSvg(p);
    out += `      </View>\n`;
}
out += emit(byIndex.get(rootIndex), '      ', /*isRoot*/ true);
// Animated knobs are rendered at root level so their inner <Knob>'s absolute
// coords are relative to the editor (not the deep parent View their original
// node lives in). Each <K${index}> contains both the Knob and its rotating
// SvgPath indicator — emitted on top of the static chrome and the deep tree.
for (const idx of knobToTriangle.keys()) {
    out += `      <K${idx} />\n`;
}
out += `    </View>\n`;
out += `  );\n`;
out += `}\n`;

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, out, 'utf-8');

// ── Summary ────────────────────────────────────────────────────────────
const visible = manifest.components.filter(c => !skip(c)).length;
const counts = {};
for (const c of manifest.components) {
    if (skip(c)) continue;
    const k = classify(c.class).kind;
    counts[k] = (counts[k] ?? 0) + 1;
}
console.log(`Wrote ${OUT_PATH}`);
console.log(`  ${visible}/${manifest.components.length} components emitted (rest hidden/skipped)`);
console.log(`  Widget mix:`, counts);
console.log(`  SVG primitives: ${_rawPrims.length} raw → ${_sizeOk.length} after size filter (<${MIN_PRIM_SIZE}px) → ${_filtered.length} after visibility filter → ${svgPrims.length} emitted (cap ${HARD_PRIMS})`);
