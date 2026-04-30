/**
 * svgConverter — deterministic SVG-subtree → HTML+CSS conversion.
 *
 * This is the **rule-based** converter (no LLM). It runs as the baseline
 * for all three paths:
 *   A) MCP create_demo_from_taste — converter is the entire pipeline.
 *   B) UI Make-interactive — same as A.
 *   C) faithful workflow — runs first as baseline; LLM only re-tries
 *      chunks whose pixel-diff exceeded threshold.
 *
 * Strategy: walk the SvgNode tree, emit one HTML element per node. Use
 * absolute positioning anchored at (bbox[0], bbox[1]) so the stitched
 * result reproduces the SVG's coordinate space inside an HTML container.
 * The container itself is a `<div class="canvas-svg-host">` sized to
 * the original viewBox.
 *
 * Anything we can't map cleanly (curves, complex masks, etc.) gets
 * preserved as inline `<svg>` islands. The island spans exactly its
 * own bbox so it sits in flow with the surrounding HTML elements.
 *
 * Why absolute positioning everywhere?
 *   SVG's painter model is "elements draw at exact coords in user
 *   space, ignoring siblings". The closest HTML equivalent is
 *   `position: absolute` against a relative-positioned parent. Trying
 *   to use flex / grid would require inferring layout intent from
 *   coordinates, which is the LLM's job in path C — the deterministic
 *   converter just preserves geometry.
 */

import type { SvgNode } from "./parseSvgTree.js";

export interface ConvertOpts {
  /** When set, the converter will use this as the prefix for generated
   *  CSS class names so multiple chunks don't collide at stitch time.
   *  E.g. `"c001-"` → `class="c001-rect-1"`. Default `""` (no prefix).
   *  Path A uses no prefix (single-pass). Path C sets per-chunk prefix. */
  classPrefix?: string;
  /** When set, also stamp `data-md-svg-id="<node.id>"` on every emitted
   *  HTML element for downstream Agent reasoning ("the rect at id n-XXX").
   *  Default true. */
  stampSvgIds?: boolean;
}

export interface ConvertResult {
  /** Inner HTML for the canvas — does NOT include the wrapping
   *  `<div class="canvas-svg-host">` (caller adds that with appropriate
   *  width/height inferred from viewBox). */
  html: string;
  /** Concatenated CSS rules. Includes :root vars for repeated colors /
   *  fonts. Caller writes to a separate `style.css`. */
  css: string;
  /** Original SVG viewBox passed through, useful for sizing the host. */
  viewBox: [number, number, number, number] | null;
  /** Manifest of HTML-converted elements (filtered to interactive
   *  candidates: rects, texts, named groups). Used by Agent to attach
   *  scripts. */
  manifest: ManifestElement[];
  /** Subtrees we couldn't convert and shipped as inline SVG islands.
   *  Reported back so callers can show "3 features kept as SVG"
   *  warnings to the user. */
  islands: { nodeId: string; reason: string; bbox: [number, number, number, number] }[];
  /** Token-level breakdown for debugging. */
  stats: { rules: number; islands: number; cssVars: number };
}

export interface ManifestElement {
  /** Stable HTML id, set on the emitted element. */
  htmlId: string;
  /** SVG node id (n-XXXXXXXX) — same as data-md-svg-id. */
  svgNodeId: string;
  /** Coarse type label: "rect" | "text" | "image" | "group" | "island". */
  type: "rect" | "text" | "image" | "group" | "island" | "shape";
  /** Original Figma name when known. */
  figmaName?: string;
  /** bbox in viewBox space — useful when the Agent needs a position-
   *  driven query (e.g. "the button in the top-right corner"). */
  bbox: [number, number, number, number];
  /** Plain-text content (for `<text>` elements only). */
  text?: string;
}

export function convertSvgToHtml(root: SvgNode, opts: ConvertOpts = {}): ConvertResult {
  // Pre-pass: find linearGradient / radialGradient definitions anywhere
  // in the tree (typically inside <defs>) so we can resolve `fill="url(#x)"`
  // references to CSS gradient strings during emission. Without this,
  // gradients ship as the literal `url(#x)` string in CSS, which is
  // invalid (only `<svg>` understands that syntax) and the rect renders
  // with no background — was a 70% pixel-diff regression on the
  // illustration fixture.
  const gradientDefs = collectGradientDefs(root);

  const ctx: ConvertCtx = {
    classPrefix: opts.classPrefix ?? "",
    stampSvgIds: opts.stampSvgIds ?? true,
    htmlIdCounter: 0,
    cssRules: [],
    cssVarPool: new Map(),
    manifest: [],
    islands: [],
    gradientDefs,
  };

  // The root is typically <svg>. Its children are what we want to render.
  // We don't render <svg>'s own attributes (viewBox is passed back in
  // result.viewBox; width/height come from the host element).
  const childHtmlPieces: string[] = [];
  const childrenToWalk = root.tag === "svg" ? root.children : [root];
  for (const c of childrenToWalk) {
    childHtmlPieces.push(walkAndConvert(c, ctx));
  }
  const html = childHtmlPieces.filter(Boolean).join("\n");

  // Lift repeated colors / fonts to :root CSS vars at the top of css.
  const cssVarBlock = renderCssVars(ctx.cssVarPool);
  const css = (cssVarBlock ? cssVarBlock + "\n" : "") + ctx.cssRules.join("\n");

  return {
    html,
    css,
    viewBox: root.bbox && root.tag === "svg" ? root.bbox : null,
    manifest: ctx.manifest,
    islands: ctx.islands,
    stats: { rules: ctx.cssRules.length, islands: ctx.islands.length, cssVars: ctx.cssVarPool.size },
  };
}

// ─── Internal: walker ───────────────────────────────────────────────────

interface ConvertCtx {
  classPrefix: string;
  stampSvgIds: boolean;
  htmlIdCounter: number;
  cssRules: string[];
  /** Pool of repeated values eligible for CSS variables. Key = unique
   *  string (e.g. "color:#1456F0"); value = the var name we emit
   *  ("--color-1"). */
  cssVarPool: Map<string, { varName: string; rawValue: string; usageCount: number }>;
  manifest: ManifestElement[];
  islands: ConvertResult["islands"];
  /** Resolved gradient definitions, keyed by id. Pre-computed at the start
   *  of conversion so per-element fill resolution is O(1). */
  gradientDefs: Map<string, GradientDef>;
}

interface GradientDef {
  type: "linear" | "radial";
  /** Already-formatted CSS gradient string, e.g.
   *  "linear-gradient(135deg, #A78BFA 0%, #1456F0 100%)". */
  css: string;
}

function walkAndConvert(node: SvgNode, ctx: ConvertCtx): string {
  // Island check: if a chunk-splitter (or something else upstream) already
  // tagged this subtree, OR if the converter doesn't have a rule for the
  // tag, ship as inline SVG.
  if (isIslandTag(node.tag)) {
    return emitIsland(node, ctx, "untranslatable-tag");
  }

  switch (node.tag) {
    case "rect":
      return emitRect(node, ctx);
    case "circle":
      return emitCircle(node, ctx);
    case "ellipse":
      return emitEllipse(node, ctx);
    case "line":
      return emitLine(node, ctx);
    case "image":
      return emitImage(node, ctx);
    case "text":
      return emitText(node, ctx);
    case "g":
    case "symbol":
      return emitGroup(node, ctx);
    case "path":
      return emitPath(node, ctx);
    case "polygon":
    case "polyline":
      return emitPoly(node, ctx);
    case "defs":
    case "linearGradient":
    case "radialGradient":
    case "stop":
    case "title":
    case "desc":
    case "metadata":
      // Definition / metadata — don't paint anything.
      return "";
    case "use":
      // parseSvgTree should have inlined these. If we still see one,
      // treat as island.
      return emitIsland(node, ctx, "unresolved-use");
    default:
      return emitIsland(node, ctx, `unknown-tag-${node.tag}`);
  }
}

// ─── Element emitters ──────────────────────────────────────────────────

function emitRect(node: SvgNode, ctx: ConvertCtx): string {
  const bbox = node.bbox;
  if (!bbox) return "";
  const a = node.attrs;
  const htmlId = nextHtmlId(ctx, "rect");
  const styleProps: StyleProp[] = [
    ["position", "absolute"],
    ["left", `${bbox[0]}px`],
    ["top", `${bbox[1]}px`],
    ["width", `${bbox[2]}px`],
    ["height", `${bbox[3]}px`],
  ];
  const fill = resolveFill(a, ctx);
  if (fill) styleProps.push(["background", fill]);
  const stroke = resolveStroke(a, ctx);
  if (stroke) {
    styleProps.push(["border", `${a["stroke-width"] ?? "1"}px solid ${stroke}`]);
    // Account for border in box sizing — without this the visible
    // rect is wider than the SVG's was.
    styleProps.push(["box-sizing", "border-box"]);
  }
  const rx = parseFloat(a.rx ?? a.ry ?? "0");
  const ry = parseFloat(a.ry ?? a.rx ?? "0");
  if (rx > 0 || ry > 0) styleProps.push(["border-radius", rxRyToCss(rx, ry, bbox[2], bbox[3])]);
  const op = parseFloat(a.opacity ?? "1");
  if (op !== 1 && Number.isFinite(op)) styleProps.push(["opacity", String(op)]);
  const filter = a.filter ?? "";
  if (/drop-shadow|blur/.test(filter)) {
    // Naive — Figma sometimes inlines these as inline-style filter:.
    styleProps.push(["filter", filter]);
  }
  ctx.manifest.push({
    htmlId,
    svgNodeId: node.id,
    type: "rect",
    figmaName: node.figmaName,
    bbox,
  });
  return openTag("div", htmlId, node, ctx, styleProps) + "</div>";
}

function emitCircle(node: SvgNode, ctx: ConvertCtx): string {
  const bbox = node.bbox;
  if (!bbox) return "";
  const a = node.attrs;
  const htmlId = nextHtmlId(ctx, "circle");
  const styleProps: StyleProp[] = [
    ["position", "absolute"],
    ["left", `${bbox[0]}px`],
    ["top", `${bbox[1]}px`],
    ["width", `${bbox[2]}px`],
    ["height", `${bbox[3]}px`],
    ["border-radius", "50%"],
  ];
  const fill = resolveFill(a, ctx);
  if (fill) styleProps.push(["background", fill]);
  const stroke = resolveStroke(a, ctx);
  if (stroke) {
    styleProps.push(["border", `${a["stroke-width"] ?? "1"}px solid ${stroke}`]);
    styleProps.push(["box-sizing", "border-box"]);
  }
  const op = parseFloat(a.opacity ?? "1");
  if (op !== 1 && Number.isFinite(op)) styleProps.push(["opacity", String(op)]);
  ctx.manifest.push({ htmlId, svgNodeId: node.id, type: "shape", figmaName: node.figmaName, bbox });
  return openTag("div", htmlId, node, ctx, styleProps) + "</div>";
}

function emitEllipse(node: SvgNode, ctx: ConvertCtx): string {
  // Same as circle in HTML — 50% border-radius scales to bbox aspect.
  return emitCircle(node, ctx);
}

function emitLine(node: SvgNode, ctx: ConvertCtx): string {
  const bbox = node.bbox;
  if (!bbox) return "";
  const a = node.attrs;
  const htmlId = nextHtmlId(ctx, "line");
  const stroke = resolveStroke(a, ctx) ?? "currentColor";
  const sw = parseFloat(a["stroke-width"] ?? "1");
  // Two cases: horizontal/vertical lines map cleanly to a thin div.
  // Diagonal lines need rotation — for now we ship as island so we don't
  // miscompute the math (CSS rotation around midpoint is trivial but we'd
  // rather deliver fidelity than approximate).
  const x1 = parseFloat(a.x1 ?? "0");
  const y1 = parseFloat(a.y1 ?? "0");
  const x2 = parseFloat(a.x2 ?? "0");
  const y2 = parseFloat(a.y2 ?? "0");
  const isHorizontal = Math.abs(y2 - y1) < 0.5;
  const isVertical = Math.abs(x2 - x1) < 0.5;
  if (!isHorizontal && !isVertical) return emitIsland(node, ctx, "diagonal-line");
  const styleProps: StyleProp[] = [
    ["position", "absolute"],
    ["left", `${Math.min(x1, x2)}px`],
    ["top", `${Math.min(y1, y2) - sw / 2}px`],
    ["width", `${isHorizontal ? Math.abs(x2 - x1) : sw}px`],
    ["height", `${isHorizontal ? sw : Math.abs(y2 - y1)}px`],
    ["background", stroke],
  ];
  ctx.manifest.push({ htmlId, svgNodeId: node.id, type: "shape", figmaName: node.figmaName, bbox });
  return openTag("div", htmlId, node, ctx, styleProps) + "</div>";
}

function emitImage(node: SvgNode, ctx: ConvertCtx): string {
  const bbox = node.bbox;
  if (!bbox) return "";
  const a = node.attrs;
  const href = a.href ?? a["xlink:href"] ?? "";
  const htmlId = nextHtmlId(ctx, "image");
  const styleProps: StyleProp[] = [
    ["position", "absolute"],
    ["left", `${bbox[0]}px`],
    ["top", `${bbox[1]}px`],
    ["width", `${bbox[2]}px`],
    ["height", `${bbox[3]}px`],
  ];
  ctx.manifest.push({ htmlId, svgNodeId: node.id, type: "image", figmaName: node.figmaName, bbox });
  // <img> doesn't allow children — emit self-closing.
  const attrs = openTag("img", htmlId, node, ctx, styleProps, { src: href, alt: node.figmaName ?? "" });
  // Strip the trailing `>` and re-add as self-closing for HTML5.
  return attrs.slice(0, -1) + " />";
}

function emitText(node: SvgNode, ctx: ConvertCtx): string {
  const bbox = node.bbox;
  if (!bbox) return "";
  const a = node.attrs;
  const htmlId = nextHtmlId(ctx, "text");
  // Translate SVG text positioning to HTML.
  //   SVG: <text x y> — y is the BASELINE.
  //   HTML: position:absolute top:Y — Y is the BOX TOP.
  // bbox in parseSvgTree was computed as [x, y - fontSize*1.2, width,
  // fontSize*1.2] which is a coarse "box around the text". The real
  // baseline-to-top distance is the font's ascent, which for most
  // sans-serif fonts is ~0.83 of font-size. So we shift `top` by
  // (1.2 - 0.83) * fontSize ≈ 0.37 * fontSize compared to the bbox top.
  // Without this correction, HTML text rendered ~6px LOWER than SVG
  // for 16px font.
  const fontSize = parseFloat(a["font-size"] ?? "16");
  const baselineOffset = Number.isFinite(fontSize) ? fontSize * 0.83 : 13.3;
  const yBaseline = parseFloat(a.y ?? "0");
  const topPx = Number.isFinite(yBaseline) ? yBaseline - baselineOffset : bbox[1];
  const styleProps: StyleProp[] = [
    ["position", "absolute"],
    ["left", `${bbox[0]}px`],
    ["top", `${topPx}px`],
    // Match SVG's no-wrap default — without this, narrow containers
    // would wrap our text differently from how the SVG rasterized.
    ["white-space", "nowrap"],
    // Use the same line-height baseline rule as the SVG renderer.
    ["line-height", "1"],
  ];
  const fontFamily = a["font-family"];
  const fontSizeAttr = a["font-size"];
  const fontWeight = a["font-weight"];
  const lineHeight = a["line-height"];
  const letterSpacing = a["letter-spacing"];
  const textAnchor = a["text-anchor"];
  if (fontFamily) styleProps.push(["font-family", maybeCssVar(`font-family:${fontFamily}`, fontFamily, ctx)]);
  if (fontSizeAttr) styleProps.push(["font-size", normalizeLength(fontSizeAttr)]);
  if (fontWeight) styleProps.push(["font-weight", fontWeight]);
  if (lineHeight) styleProps.push(["line-height", lineHeight]);
  if (letterSpacing) styleProps.push(["letter-spacing", normalizeLength(letterSpacing)]);
  if (textAnchor === "middle") styleProps.push(["text-align", "center"]);
  if (textAnchor === "end") styleProps.push(["text-align", "right"]);
  const fill = resolveFill(a, ctx);
  if (fill) styleProps.push(["color", fill]);
  // Aggregate text from <text> + nested <tspan>s.
  const textContent = collectTextContent(node);
  ctx.manifest.push({
    htmlId,
    svgNodeId: node.id,
    type: "text",
    figmaName: node.figmaName,
    bbox,
    text: textContent,
  });
  return openTag("span", htmlId, node, ctx, styleProps) + escapeHtml(textContent) + "</span>";
}

function emitGroup(node: SvgNode, ctx: ConvertCtx): string {
  // Group — wrapper div carrying transform + opacity + clip. Children
  // recurse normally. Coordinate space is shared with parent (we baked
  // transforms into bbox during parse), so in HTML we DON'T need to
  // re-apply the transform — just emit a positioning anchor at the
  // group's own bbox top-left.
  const a = node.attrs;
  const htmlId = nextHtmlId(ctx, "group");
  const bbox = node.bbox ?? [0, 0, 0, 0];

  // We DO emit a wrapper div so opacity / filter / clip can scope its
  // children. If the group has no styling attrs we can flatten the
  // wrapper into nothing — saves a useless div per group. Only Figma's
  // top-level groups usually carry these.
  const styleProps: StyleProp[] = [];
  const op = parseFloat(a.opacity ?? "1");
  if (op !== 1 && Number.isFinite(op)) styleProps.push(["opacity", String(op)]);
  const filter = a.filter ?? "";
  if (/drop-shadow|blur/.test(filter)) styleProps.push(["filter", filter]);
  const wrapNeeded = styleProps.length > 0 || node.figmaName;
  const childrenHtml = node.children.map((c) => walkAndConvert(c, ctx)).filter(Boolean).join("\n");
  if (!wrapNeeded) return childrenHtml;

  // Group wrapper IS positioned absolutely (so it has a frame inside
  // .canvas-svg-host) but its children are also abs-positioned at their
  // OWN coords (because transforms were baked in during parse). Net
  // visual effect: identical placement.
  styleProps.unshift(
    ["position", "absolute"],
    ["left", "0px"],
    ["top", "0px"],
    ["width", "100%"],
    ["height", "100%"],
    ["pointer-events", "none"], // children re-enable individually if needed
  );
  ctx.manifest.push({ htmlId, svgNodeId: node.id, type: "group", figmaName: node.figmaName, bbox });
  return openTag("div", htmlId, node, ctx, styleProps) + "\n" + childrenHtml + "\n</div>";
}

function emitPath(node: SvgNode, ctx: ConvertCtx): string {
  // splitSvgTree's island rule already flagged paths with curves; if we
  // get here, the path is straight-line only.
  const d = node.attrs.d ?? "";
  if (/[CcSsQqTtAa]/.test(d)) return emitIsland(node, ctx, "bezier-path-leaked-through");
  // Straight-line path — not worth implementing a polygon mapper here
  // either (paths often have multiple subpaths, holes, fill-rule,
  // stroke-linejoin etc.). Ship as island. Path C's LLM can refine.
  return emitIsland(node, ctx, "straight-path-as-island");
}

function emitPoly(node: SvgNode, ctx: ConvertCtx): string {
  // Same reasoning as emitPath — not worth a CSS polygon mapper for
  // arbitrary point lists. Ship as island.
  return emitIsland(node, ctx, "polygon-as-island");
}

function emitIsland(node: SvgNode, ctx: ConvertCtx, reason: string): string {
  const bbox = node.bbox ?? [0, 0, 0, 0];
  const htmlId = nextHtmlId(ctx, "island");
  ctx.islands.push({ nodeId: node.id, reason, bbox });
  ctx.manifest.push({
    htmlId,
    svgNodeId: node.id,
    type: "island",
    figmaName: node.figmaName,
    bbox,
  });
  // Re-serialize this subtree as inline SVG. Wrap in an <svg> that's
  // sized & positioned at this node's bbox, with viewBox set to the
  // bbox so the island's coords look unchanged.
  const innerSvg = serializeNodeAsSvg(node);
  const islandStyle = [
    ["position", "absolute"],
    ["left", `${bbox[0]}px`],
    ["top", `${bbox[1]}px`],
    ["width", `${bbox[2]}px`],
    ["height", `${bbox[3]}px`],
    ["overflow", "visible"],
  ] as StyleProp[];
  // The wrapper <svg> needs a viewBox matching the node's bbox so the
  // inner coords stay as-is.
  const viewBox = `${bbox[0]} ${bbox[1]} ${bbox[2]} ${bbox[3]}`;
  return (
    openTag("svg", htmlId, node, ctx, islandStyle, {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox,
    }) +
    innerSvg +
    "</svg>"
  );
}

// ─── Tag emission helpers ──────────────────────────────────────────────

type StyleProp = [string, string];

function openTag(
  tag: string,
  htmlId: string,
  node: SvgNode,
  ctx: ConvertCtx,
  styleProps: StyleProp[],
  extraAttrs: Record<string, string> = {},
): string {
  const className = `${ctx.classPrefix}${tag}-${htmlId.split("-").pop()}`;
  // Generate a CSS rule for this element's style. Inline styles would
  // be simpler but they bloat HTML and prevent rule de-dup; CSS class
  // gives us a hook for theme overrides too.
  const cssBody = styleProps.map(([k, v]) => `  ${k}: ${v};`).join("\n");
  ctx.cssRules.push(`#${htmlId} {\n${cssBody}\n}`);
  const attrParts: string[] = [`id="${htmlId}"`, `class="${escapeAttr(className)}"`];
  if (ctx.stampSvgIds) attrParts.push(`data-md-svg-id="${node.id}"`);
  if (node.figmaName) attrParts.push(`data-figma-name="${escapeAttr(node.figmaName)}"`);
  for (const k of Object.keys(extraAttrs)) {
    attrParts.push(`${k}="${escapeAttr(extraAttrs[k])}"`);
  }
  return `<${tag} ${attrParts.join(" ")}>`;
}

function nextHtmlId(ctx: ConvertCtx, kind: string): string {
  return `${ctx.classPrefix}el-${kind}-${++ctx.htmlIdCounter}`;
}

// ─── Style helpers ─────────────────────────────────────────────────────

function resolveFill(attrs: Record<string, string>, ctx: ConvertCtx): string | null {
  const fill = pickPaint(attrs, "fill");
  if (!fill) return null;
  if (fill === "none") return null;
  // Gradient reference? Look it up and substitute the CSS gradient string.
  // url(#bg-gradient) → linear-gradient(...) — see collectGradientDefs.
  const gradMatch = /^url\(#([^)]+)\)$/.exec(fill.trim());
  if (gradMatch) {
    const def = ctx.gradientDefs.get(gradMatch[1]);
    if (def) return def.css; // gradients are NEVER pooled to vars (unique strings)
    // Unresolved ref — fall through to raw (will render as nothing,
    // but at least won't crash). Should be rare; would mean the def
    // is in a parent SVG that wasn't included in this convert call.
    return null;
  }
  return maybeCssVar(`color:${fill}`, fill, ctx);
}

function resolveStroke(attrs: Record<string, string>, ctx: ConvertCtx): string | null {
  const stroke = pickPaint(attrs, "stroke");
  if (!stroke || stroke === "none") return null;
  const gradMatch = /^url\(#([^)]+)\)$/.exec(stroke.trim());
  if (gradMatch) {
    // CSS borders can't be gradients without `border-image`. Best we can
    // do for stroke is fall back to the FIRST stop color of the gradient,
    // which usually visually approximates Figma's intent.
    const def = ctx.gradientDefs.get(gradMatch[1]);
    if (def) {
      const m = /,\s*([^,]+?)\s+0(?:\.0)?%/.exec(def.css);
      if (m) return m[1];
    }
    return null;
  }
  return maybeCssVar(`color:${stroke}`, stroke, ctx);
}

function pickPaint(attrs: Record<string, string>, key: "fill" | "stroke"): string | null {
  // Direct attr.
  if (attrs[key]) return attrs[key];
  // Inline style.
  const style = attrs.style ?? "";
  const m = new RegExp(`(?:^|;)\\s*${key}\\s*:\\s*([^;]+)`).exec(style);
  if (m) return m[1].trim();
  return null;
}

/** Walk the tree once, find all <linearGradient>/<radialGradient>
 *  definitions, translate each to a CSS gradient string. The CSS
 *  gradient is approximate — SVG's coordinate-based gradients
 *  (gradientUnits="userSpaceOnUse" with absolute x1/y1/x2/y2) don't
 *  map perfectly to CSS's percentage-based linear-gradient. We
 *  compute an angle from the (x1,y1)→(x2,y2) vector, which works
 *  for "objectBoundingBox" units (the default) and approximates for
 *  userSpaceOnUse when the gradient runs across the bounding box.
 *  Out-of-bbox gradients drift visibly; LLM (path C) refines those.
 */
function collectGradientDefs(root: SvgNode): Map<string, GradientDef> {
  const out = new Map<string, GradientDef>();
  function walk(n: SvgNode) {
    if (n.tag === "lineargradient" || n.tag === "linearGradient") {
      const id = n.attrs.id;
      if (id) out.set(id, { type: "linear", css: linearGradientToCss(n) });
    } else if (n.tag === "radialgradient" || n.tag === "radialGradient") {
      const id = n.attrs.id;
      if (id) out.set(id, { type: "radial", css: radialGradientToCss(n) });
    }
    for (const c of n.children) walk(c);
  }
  walk(root);
  return out;
}

function linearGradientToCss(n: SvgNode): string {
  const a = n.attrs;
  // Parse x1/y1/x2/y2 (default 0%/0%/100%/0% — horizontal left to right).
  const x1 = parseGradientCoord(a.x1, 0);
  const y1 = parseGradientCoord(a.y1, 0);
  const x2 = parseGradientCoord(a.x2, 1);
  const y2 = parseGradientCoord(a.y2, 0);
  // Convert SVG (right=x+, down=y+) into CSS angle. CSS angle 0deg
  // points up, increases clockwise. So a vector pointing right (1,0)
  // = 90deg in CSS; pointing down (0,1) = 180deg.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const angleRad = Math.atan2(dx, -dy); // 0 = up, π/2 = right
  const angleDeg = ((angleRad * 180) / Math.PI + 360) % 360;
  const stops = collectStops(n);
  if (stops.length === 0) return "transparent";
  return `linear-gradient(${angleDeg.toFixed(1)}deg, ${stops.join(", ")})`;
}

function radialGradientToCss(n: SvgNode): string {
  // SVG radial gradients have cx/cy/r and an optional fx/fy focal point.
  // CSS radial-gradient supports `at <pos>` for the center and `circle`
  // / `ellipse` shape but doesn't do focal-point eccentricity.
  // For most Figma exports the focal point matches the center, so this
  // approximation is exact for that common case.
  const a = n.attrs;
  const cx = parseGradientCoord(a.cx, 0.5) * 100;
  const cy = parseGradientCoord(a.cy, 0.5) * 100;
  const stops = collectStops(n);
  if (stops.length === 0) return "transparent";
  return `radial-gradient(circle at ${cx.toFixed(1)}% ${cy.toFixed(1)}%, ${stops.join(", ")})`;
}

function parseGradientCoord(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const trimmed = v.trim();
  if (trimmed.endsWith("%")) {
    const n = parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : fallback;
  }
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : fallback;
}

function collectStops(n: SvgNode): string[] {
  const stops: string[] = [];
  for (const c of n.children) {
    if (c.tag !== "stop") continue;
    const offset = parseGradientCoord(c.attrs.offset, 0) * 100;
    const colorRaw = c.attrs["stop-color"] ?? pickPaint(c.attrs, "fill") ?? "black";
    const opacity = parseFloat(c.attrs["stop-opacity"] ?? "1");
    let color = colorRaw;
    if (Number.isFinite(opacity) && opacity < 1) {
      // Wrap as rgba if it's a hex.
      const rgb = hexToRgb(colorRaw);
      if (rgb) color = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
    }
    stops.push(`${color} ${offset.toFixed(1)}%`);
  }
  return stops;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/** Pool a value if it appears 2+ times globally; emit raw on the first
 *  occurrence so we don't reference a not-yet-declared var.
 *
 *  Originally we promoted at usageCount ≥ 3, but emitted `var(...)` on
 *  the second hit — leaving the var undefined whenever a color was used
 *  exactly twice. That manifested as the second occurrence rendering
 *  with NO color: e.g. "Primary_Button" (the second user of #1456F0
 *  after "Avatar") rendered with default-black background, ~6% pixel
 *  diff for a tiny fixture. Bumped both thresholds to 2 so the var IS
 *  declared the moment we start referencing it. */
function maybeCssVar(key: string, raw: string, ctx: ConvertCtx): string {
  if (raw.startsWith("url(")) return raw;
  const existing = ctx.cssVarPool.get(key);
  if (existing) {
    existing.usageCount++;
    return `var(${existing.varName})`;
  }
  ctx.cssVarPool.set(key, {
    varName: `--svg-${key.split(":")[0]}-${ctx.cssVarPool.size + 1}`,
    rawValue: raw,
    usageCount: 1,
  });
  return raw;
}

function renderCssVars(pool: Map<string, { varName: string; rawValue: string; usageCount: number }>): string {
  const promoted = Array.from(pool.values()).filter((v) => v.usageCount >= 2);
  if (promoted.length === 0) return "";
  const decls = promoted.map((v) => `  ${v.varName}: ${v.rawValue};`).join("\n");
  return `:root {\n${decls}\n}`;
}

function rxRyToCss(rx: number, ry: number, w: number, h: number): string {
  // SVG rx/ry are absolute lengths; CSS border-radius can take separate
  // x/y radii via "rx / ry".
  const fx = Math.min(rx, w / 2);
  const fy = Math.min(ry, h / 2);
  if (Math.abs(fx - fy) < 0.5) return `${fx}px`;
  return `${fx}px / ${fy}px`;
}

function normalizeLength(v: string): string {
  // Already has unit? Pass through.
  if (/[a-z%]/i.test(v)) return v.trim();
  return `${v}px`;
}

function collectTextContent(node: SvgNode): string {
  if (node.text) return node.text;
  // Recurse into <tspan>s.
  const parts: string[] = [];
  for (const c of node.children) {
    if (c.tag === "tspan" || c.tag === "text") {
      parts.push(collectTextContent(c));
    } else if (c.text) {
      parts.push(c.text);
    }
  }
  return parts.join(" ");
}

// ─── Island serialization (SvgNode → <svg> string) ────────────────────

function serializeNodeAsSvg(node: SvgNode): string {
  // Re-emit the subtree as XML. We don't need ::TODO-perfect formatting,
  // just round-trippable bytes.
  const attrParts: string[] = [];
  for (const k of Object.keys(node.attrs)) {
    attrParts.push(`${k}="${escapeAttr(node.attrs[k])}"`);
  }
  const attrStr = attrParts.length ? " " + attrParts.join(" ") : "";
  const childPieces: string[] = [];
  for (const c of node.children) childPieces.push(serializeNodeAsSvg(c));
  const text = node.text ? escapeXml(node.text) : "";
  if (childPieces.length === 0 && !text && isVoidSvgTag(node.tag)) {
    return `<${node.tag}${attrStr} />`;
  }
  return `<${node.tag}${attrStr}>${text}${childPieces.join("")}</${node.tag}>`;
}

function isVoidSvgTag(tag: string): boolean {
  return ["rect", "circle", "ellipse", "line", "path", "use", "image", "polygon", "polyline", "stop"].includes(tag);
}

// ─── Escaping ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Tag taxonomy ──────────────────────────────────────────────────────

function isIslandTag(tag: string): boolean {
  // These are tags where even a "deterministic" attempt is worse than
  // shipping as inline SVG. We DON'T list <path>/<polygon> here — those
  // are in switch() above with their own logic.
  return ["foreignobject", "textpath", "mask", "clippath", "filter", "pattern", "marker", "symbol"].includes(tag);
}
