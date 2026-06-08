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
const WIDGETS_TRANSPARENT_OVERLAY = true;

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
        const bbox = xs.length === 0 ? { w: 0, h: 0 } : {
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

// ── Emit ───────────────────────────────────────────────────────────────
let out = '';
out += `// AUTO-GENERATED by Scripts/ddif-jsx-from-export.mjs — do not edit by hand.\n`;
out += `// Source: ${IN_DIR}/ComponentTree.json (${manifest.components.length} components)\n`;
out += `// Editor logical size: ${editor.width}x${editor.height}\n\n`;
out += `import { View, Row, Col, Panel, Label, Button, TextEditor,\n`;
out += `         Knob, Fader, Meter, Toggle, Canvas,\n`;
out += `         SvgPath, SvgRect } from '@pulp/react';\n\n`;

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

    if (c.kind === 'Knob' || c.kind === 'Fader' || c.kind === 'Meter') {
        const props = [`id="${id}"`, `value={0.5}`, style];
        if (c.kind === 'Fader') props.push(`orientation="${c.orientation ?? 'horizontal'}"`);
        return `${pad}<${c.kind} ${props.join(' ')} />\n`;
    }
    if (c.kind === 'Label') {
        return text
            ? `${pad}<Label id="${id}" text="${text}" ${style} />\n`
            : `${pad}<Label id="${id}" ${style} />\n`;
    }
    if (c.kind === 'Button' || c.kind === 'Toggle') {
        return text
            ? `${pad}<${c.kind} id="${id}" ${style}>${text}</${c.kind}>\n`
            : `${pad}<${c.kind} id="${id}" ${style} />\n`;
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
    const sty = `style={{position:'absolute', left:0, top:0, width:${TARGET_W}, height:${TARGET_H}}}`;
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
    if (p.fill && p.fill !== 'none') props.push(`fill="${p.fill}"`);
    if (p.stroke && p.stroke !== 'none') props.push(`stroke="${p.stroke}"`);
    return `        <SvgPath ${props.join(' ')} ${sty} />\n`;
}

// Bisecting under @pulp/react shows direct sibling count above ~152 silently
// fails to render anything at all. Buckets keep us safely below that — each
// holds at most CHROME_BUCKET_SIZE primitives, and the JSX root holds a small
// number of bucket Views plus the widget tree.
const CHROME_BUCKET_SIZE = 100;

out += `export default function DDIF() {\n`;
out += `  return (\n`;
out += `    <View id="root" style={{position:'absolute', left:0, top:0, width:${TARGET_W}, height:${TARGET_H}}}>\n`;
for (let i = 0; i < svgPrims.length; i += CHROME_BUCKET_SIZE) {
    const slice = svgPrims.slice(i, i + CHROME_BUCKET_SIZE);
    out += `      <View id="chrome${i / CHROME_BUCKET_SIZE}" style={{position:'absolute', left:0, top:0, width:1430, height:766}}>\n`;
    for (const p of slice) out += emitSvg(p);
    out += `      </View>\n`;
}
out += emit(byIndex.get(rootIndex), '      ', /*isRoot*/ true);
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
