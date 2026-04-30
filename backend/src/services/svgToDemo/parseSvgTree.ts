/**
 * parseSvgTree — turn an SVG string into a typed, ordered tree of nodes.
 *
 * Why we don't reuse `services/design/svgAnalyzer.ts`:
 *   svgAnalyzer aggregates an SVG into a flat report (top colors, regions,
 *   etc.) for the Agent's reasoning. svg-to-demo needs the OPPOSITE — a
 *   structure-preserving tree so we can later split on `<g>` boundaries,
 *   convert each subtree to HTML, and stitch back together.
 *
 * Output contract (see SvgNode below):
 *   - Stable id per node (sha1 of path-index + tag + attrs[:8]). Stable
 *     across re-parses of the same SVG byte-for-byte. Survives whitespace
 *     edits because we don't include child positions in the hash key —
 *     just the node's own attrs and its position in the parent's child
 *     list. NOT a content hash (that would invalidate every time the
 *     user edits the file).
 *   - figmaName: Figma exports put layer names in `id="..."` (with spaces
 *     replaced by underscores) and sometimes `<title>` children. We keep
 *     the original verbatim under figmaName so the LLM (path C) sees
 *     "Login_Button" not just "el-04ad".
 *   - bbox: best-effort. For `<rect>` / `<circle>` / `<ellipse>` /
 *     `<image>` we have exact coords. For `<path>` we estimate from the
 *     `d` attribute's M/L/C/Q endpoints (no curve sampling — within
 *     bezier hull is "good enough" for chunking decisions). For `<g>`
 *     the bbox is the union of children's bboxes, after applying the
 *     group's own transform. NOT 100% accurate when transforms include
 *     rotation/skew that takes children outside their AABB; we accept
 *     that for now since bbox is only used by chunking + Diff overlays
 *     and never by the converter to position elements.
 *   - byteSize / tokenEstimate: serialized SVG bytes for THIS subtree.
 *     Used by splitSvgTree to greedy-pack chunks under a token budget.
 *
 * `<use href>` resolution: SVG can reference symbols via `<use>` and the
 * referenced subtree lives elsewhere in the document. The converter
 * needs the full DOM at each location, not refs. We inline `<use>` here
 * during parse — the resulting tree has zero `<use>` nodes. (We DO
 * remember the original ref id in node.attrs.dataOriginalUseRef for
 * debug.)
 */

import { XMLParser } from "fast-xml-parser";
import { createHash } from "crypto";

export interface SvgNode {
  /** Stable hash-based id, e.g. "n-9f2c1b04". */
  id: string;
  /** Lowercased tag name (svg / g / rect / path / text / image / ...). */
  tag: string;
  /** Original Figma layer name when available, else undefined. */
  figmaName?: string;
  /** All XML attributes verbatim, normalized to strings. Includes "style". */
  attrs: Record<string, string>;
  /** Inner text content (only meaningful on <text> / <tspan> / <title> / <desc>). */
  text?: string;
  /** Best-effort bounding box in the SVG's user-coordinate space.
   *  Null for definitions-only nodes (<defs>, <clipPath>, ...). */
  bbox: [x: number, y: number, w: number, h: number] | null;
  /** Approximate byte count of this subtree's serialization (re-emitted SVG). */
  byteSize: number;
  /** Same as byteSize / 4. */
  tokenEstimate: number;
  /** Children in document order. */
  children: SvgNode[];
}

interface ParseOpts {
  /** Drop nodes that wouldn't paint anything visible (defs metadata is kept,
   *  but title/desc/script are stripped from the tree). Default true. */
  pruneNonVisual?: boolean;
}

/**
 * Public entry. Throws on malformed XML — caller decides how to recover
 * (typically by surfacing "unsupported SVG" to user). svgAnalyzer's
 * "best-effort partial report" pattern doesn't fit here because the
 * downstream pipeline assumes a complete tree.
 */
export function parseSvgTree(svg: string, opts: ParseOpts = {}): SvgNode {
  const { pruneNonVisual = true } = opts;
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    preserveOrder: true,
    // We want both <rect/> and <rect></rect> to parse the same way.
    trimValues: false,
    // Some Figma exports declare the SVG namespace with prefix. Don't
    // mangle attribute keys.
    removeNSPrefix: false,
  });

  // preserveOrder=true returns an array of {tagName: [children...], ":@": attrs}
  // The root array typically has [{ ?xml: [], ":@": {...} }, { svg: [...] }]
  // when there's a <?xml … ?> declaration, or just [{ svg: [...] }] otherwise.
  let parsed: any[];
  try {
    parsed = parser.parse(svg) as any[];
  } catch (err) {
    throw new Error(
      `parseSvgTree: malformed XML — ${err instanceof Error ? err.message : err}`,
    );
  }

  const svgEntry = parsed.find((entry) => entry && Object.keys(entry).some((k) => k === "svg"));
  if (!svgEntry) {
    throw new Error("parseSvgTree: no <svg> root element found");
  }

  // First pass: build a temporary, non-id'd tree to resolve <use> references.
  // Second pass: walk that tree assigning stable ids + computing bboxes.
  // This split is necessary because <use href> can refer forward-declared
  // <defs> elements in the SVG; we need the full document available before
  // we can inline.
  const rawRoot = buildRawNode(svgEntry, /*childIndex*/ 0, /*parentPath*/ "");
  const refMap = collectRefMap(rawRoot);
  const inlinedRoot = inlineUses(rawRoot, refMap);
  const finalRoot = walkAndFinalize(inlinedRoot, /*parentTransform*/ identityMatrix(), pruneNonVisual);
  return finalRoot;
}

// ─── Phase 1: raw tree construction (no ids, no bboxes) ─────────────────

interface RawNode {
  tag: string;
  attrs: Record<string, string>;
  text?: string;
  children: RawNode[];
  /** Position in parent's child list. Used to seed the stable-id hash so
   *  two sibling <rect/>s with identical attrs still get different ids. */
  childIndex: number;
  /** Slash-joined path of ancestor child indices, "0/2/1" — purely for id stability. */
  pathInTree: string;
}

function buildRawNode(entry: any, childIndex: number, parentPath: string): RawNode {
  // entry shape from preserveOrder=true: { tagName: [child entries], ":@": attrs }
  // OR { "#text": "string" } for text nodes.
  if ("#text" in entry) {
    return {
      tag: "#text",
      attrs: {},
      text: String(entry["#text"] ?? ""),
      children: [],
      childIndex,
      pathInTree: parentPath ? `${parentPath}/${childIndex}` : String(childIndex),
    };
  }
  const tagName = Object.keys(entry).find((k) => k !== ":@");
  if (!tagName) {
    return {
      tag: "#unknown",
      attrs: {},
      children: [],
      childIndex,
      pathInTree: parentPath ? `${parentPath}/${childIndex}` : String(childIndex),
    };
  }
  const attrsRaw = (entry[":@"] ?? {}) as Record<string, unknown>;
  const attrs: Record<string, string> = {};
  for (const k of Object.keys(attrsRaw)) {
    attrs[k] = String(attrsRaw[k]);
  }
  const childrenRaw = (entry[tagName] ?? []) as any[];
  const myPath = parentPath ? `${parentPath}/${childIndex}` : String(childIndex);
  const children: RawNode[] = [];
  childrenRaw.forEach((c, i) => {
    const child = buildRawNode(c, i, myPath);
    // Keep #text nodes ONLY if they carry non-whitespace (so we don't pollute
    // the tree with formatting whitespace; SVG renders ignore it anyway).
    if (child.tag === "#text" && (child.text ?? "").trim() === "") return;
    children.push(child);
  });
  return {
    tag: tagName.toLowerCase(),
    attrs,
    children,
    childIndex,
    pathInTree: myPath,
  };
}

// ─── Phase 2: <use> inlining ────────────────────────────────────────────

/** Map from id="..." → the RawNode that declares it. */
type RefMap = Map<string, RawNode>;

function collectRefMap(root: RawNode): RefMap {
  const map: RefMap = new Map();
  function walk(n: RawNode) {
    const id = n.attrs.id;
    if (id) map.set(id, n);
    for (const c of n.children) walk(c);
  }
  walk(root);
  return map;
}

function inlineUses(node: RawNode, refMap: RefMap, depth = 0): RawNode {
  // Defensive: avoid infinite loops if a <use> chain cycles. SVG spec
  // technically forbids this but malformed exports happen.
  if (depth > 8) return node;

  if (node.tag === "use") {
    const ref = node.attrs.href ?? node.attrs["xlink:href"] ?? "";
    const targetId = ref.startsWith("#") ? ref.slice(1) : "";
    const target = targetId ? refMap.get(targetId) : null;
    if (target && target !== node) {
      // Clone the target subtree, recursively inlining further <use>s.
      const cloned = cloneNodeDeep(target);
      const inlinedClone = inlineUses(cloned, refMap, depth + 1);
      // Carry over the <use>'s positioning attrs (x/y/transform) by
      // wrapping in a synthetic <g>. Otherwise we'd lose where the
      // referenced symbol was placed.
      const wrapperTransform = composeUseTransform(node.attrs);
      if (wrapperTransform) {
        return {
          tag: "g",
          attrs: {
            transform: wrapperTransform,
            "data-original-use-ref": ref,
          },
          children: [inlinedClone],
          childIndex: node.childIndex,
          pathInTree: node.pathInTree,
        };
      }
      // No positioning needed — just substitute the cloned subtree.
      inlinedClone.childIndex = node.childIndex;
      inlinedClone.pathInTree = node.pathInTree;
      inlinedClone.attrs = { ...inlinedClone.attrs, "data-original-use-ref": ref };
      return inlinedClone;
    }
    // Couldn't resolve — leave as-is so converter can decide. Still recurse
    // children (technically <use> shouldn't have any but be defensive).
  }
  return {
    ...node,
    children: node.children.map((c) => inlineUses(c, refMap, depth)),
  };
}

function composeUseTransform(useAttrs: Record<string, string>): string | null {
  const x = parseFloat(useAttrs.x ?? "0");
  const y = parseFloat(useAttrs.y ?? "0");
  const t = useAttrs.transform ?? "";
  const parts: string[] = [];
  if (t) parts.push(t);
  if (x !== 0 || y !== 0) parts.push(`translate(${x}, ${y})`);
  return parts.length ? parts.join(" ") : null;
}

function cloneNodeDeep(n: RawNode): RawNode {
  return {
    tag: n.tag,
    attrs: { ...n.attrs },
    text: n.text,
    children: n.children.map(cloneNodeDeep),
    childIndex: n.childIndex,
    pathInTree: n.pathInTree,
  };
}

// ─── Phase 3: id assignment, bbox, byteSize, finalization ───────────────

function walkAndFinalize(
  raw: RawNode,
  parentTransform: Matrix,
  pruneNonVisual: boolean,
): SvgNode {
  // Drop non-visual nodes (script, metadata) early. We KEEP <defs>,
  // <linearGradient>, <clipPath>, <mask>, etc — converter / chunker need
  // them. Also keep <title> and <desc> so we can extract figmaName from
  // the latter when id attr is missing.
  const drop = pruneNonVisual && (raw.tag === "script" || raw.tag === "metadata");
  if (drop) {
    // Replace with empty placeholder so id stability of siblings stays correct.
    return {
      id: stableId(raw.pathInTree, raw.tag, raw.attrs),
      tag: raw.tag,
      attrs: {},
      bbox: null,
      byteSize: 0,
      tokenEstimate: 0,
      children: [],
    };
  }

  const myTransform = composeMatrix(parentTransform, parseTransform(raw.attrs.transform ?? ""));

  const children: SvgNode[] = [];
  for (const c of raw.children) {
    if (c.tag === "#text") continue; // text content goes into parent.text
    const childNode = walkAndFinalize(c, myTransform, pruneNonVisual);
    children.push(childNode);
  }

  // Inner text (for <text>, <tspan>, <title>, <desc>): aggregate raw children
  // that were #text. Note we strip those from `children` above.
  const textBits: string[] = [];
  for (const c of raw.children) {
    if (c.tag === "#text" && (c.text ?? "").trim()) {
      textBits.push((c.text ?? "").trim());
    }
  }
  const text = textBits.join(" ") || undefined;

  // figmaName extraction:
  //   1. Prefer id attr if present and looks like a Figma name (has letters
  //      or unusual punctuation; pure-uuid ids from random tooling skipped).
  //   2. Fall back to first <title> child text.
  let figmaName: string | undefined;
  const idAttr = raw.attrs.id;
  if (idAttr && /[A-Za-z]/.test(idAttr) && !/^el-[0-9a-f]{4,}$/i.test(idAttr)) {
    figmaName = idAttr;
  }
  if (!figmaName) {
    const titleChild = raw.children.find((c) => c.tag === "title");
    if (titleChild) {
      // Title's text lives in its own #text child.
      const tText = titleChild.children
        .filter((c) => c.tag === "#text")
        .map((c) => c.text ?? "")
        .join(" ")
        .trim();
      if (tText) figmaName = tText;
    }
  }

  // bbox computation. Order matters: shape primitives know their own bbox;
  // groups union their children's. <defs> / <linearGradient> / <clipPath>
  // — these declare references but don't paint, so bbox is null.
  let bbox = computeBbox(raw, children, myTransform);

  // Serialize bytes for this subtree. We approximate by re-emitting from
  // attrs + child bytes. Cheaper than re-running the parser.
  const byteSize = estimateByteSize(raw, children);
  const tokenEstimate = Math.ceil(byteSize / 4);

  return {
    id: stableId(raw.pathInTree, raw.tag, raw.attrs),
    tag: raw.tag,
    figmaName,
    attrs: raw.attrs,
    text,
    bbox,
    byteSize,
    tokenEstimate,
    children,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function stableId(pathInTree: string, tag: string, attrs: Record<string, string>): string {
  // Hash the path + tag + sorted attrs. Don't include children — that
  // would change the id whenever the user edits a leaf, propagating
  // instability up the ancestor chain.
  const sortedAttrs = Object.keys(attrs)
    .sort()
    .map((k) => `${k}=${attrs[k]}`)
    .join("|");
  const h = createHash("sha1");
  h.update(`${pathInTree}::${tag}::${sortedAttrs}`);
  return `n-${h.digest("hex").slice(0, 8)}`;
}

// — Transform + bbox math —

type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number];

function identityMatrix(): Matrix {
  return [1, 0, 0, 1, 0, 0];
}

function multiply(m1: Matrix, m2: Matrix): Matrix {
  // 2D affine: m1 then m2, written as a single matrix.
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function composeMatrix(parent: Matrix, mine: Matrix): Matrix {
  return multiply(parent, mine);
}

/** Parse a SVG transform attribute: matrix(...), translate(x,y), rotate(...),
 *  scale(...), skewX(...), skewY(...). Returns identity for empty / unparseable. */
function parseTransform(t: string): Matrix {
  if (!t || !t.trim()) return identityMatrix();
  let m: Matrix = identityMatrix();
  const re = /([a-zA-Z]+)\s*\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(t))) {
    const fn = match[1].toLowerCase();
    const args = match[2].split(/[\s,]+/).map(Number).filter(Number.isFinite);
    let step: Matrix = identityMatrix();
    switch (fn) {
      case "matrix":
        if (args.length === 6) step = [args[0], args[1], args[2], args[3], args[4], args[5]];
        break;
      case "translate":
        step = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case "scale": {
        const sx = args[0] ?? 1;
        const sy = args[1] ?? sx;
        step = [sx, 0, 0, sy, 0, 0];
        break;
      }
      case "rotate": {
        const r = ((args[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        if (args.length === 3) {
          // Rotate around (cx, cy).
          const [_a, cx, cy] = args;
          step = multiply(
            [1, 0, 0, 1, cx, cy],
            multiply([cos, sin, -sin, cos, 0, 0], [1, 0, 0, 1, -cx, -cy]),
          );
        } else {
          step = [cos, sin, -sin, cos, 0, 0];
        }
        break;
      }
      case "skewx": {
        const k = Math.tan(((args[0] ?? 0) * Math.PI) / 180);
        step = [1, 0, k, 1, 0, 0];
        break;
      }
      case "skewy": {
        const k = Math.tan(((args[0] ?? 0) * Math.PI) / 180);
        step = [1, k, 0, 1, 0, 0];
        break;
      }
      default:
        // Unknown function — leave identity.
        break;
    }
    m = multiply(m, step);
  }
  return m;
}

function applyMatrix(m: Matrix, px: number, py: number): [number, number] {
  const [a, b, c, d, e, f] = m;
  return [a * px + c * py + e, b * px + d * py + f];
}

function transformBbox(bb: [number, number, number, number], m: Matrix): [number, number, number, number] {
  // Transform 4 corners and take the union AABB.
  const [x, y, w, h] = bb;
  const corners: [number, number][] = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ];
  const transformed = corners.map(([px, py]) => applyMatrix(m, px, py));
  const xs = transformed.map((c) => c[0]);
  const ys = transformed.map((c) => c[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return [minX, minY, maxX - minX, maxY - minY];
}

function computeBbox(
  raw: RawNode,
  children: SvgNode[],
  myTransform: Matrix,
): [number, number, number, number] | null {
  const a = raw.attrs;
  switch (raw.tag) {
    case "rect": {
      const x = parseFloat(a.x ?? "0");
      const y = parseFloat(a.y ?? "0");
      const w = parseFloat(a.width ?? "0");
      const h = parseFloat(a.height ?? "0");
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
      return transformBbox([x, y, w, h], myTransform);
    }
    case "circle": {
      const cx = parseFloat(a.cx ?? "0");
      const cy = parseFloat(a.cy ?? "0");
      const r = parseFloat(a.r ?? "0");
      if (!Number.isFinite(r) || r <= 0) return null;
      return transformBbox([cx - r, cy - r, 2 * r, 2 * r], myTransform);
    }
    case "ellipse": {
      const cx = parseFloat(a.cx ?? "0");
      const cy = parseFloat(a.cy ?? "0");
      const rx = parseFloat(a.rx ?? "0");
      const ry = parseFloat(a.ry ?? "0");
      if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx <= 0 || ry <= 0) return null;
      return transformBbox([cx - rx, cy - ry, 2 * rx, 2 * ry], myTransform);
    }
    case "line": {
      const x1 = parseFloat(a.x1 ?? "0");
      const y1 = parseFloat(a.y1 ?? "0");
      const x2 = parseFloat(a.x2 ?? "0");
      const y2 = parseFloat(a.y2 ?? "0");
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);
      return transformBbox([x, y, w, h], myTransform);
    }
    case "image": {
      const x = parseFloat(a.x ?? "0");
      const y = parseFloat(a.y ?? "0");
      const w = parseFloat(a.width ?? "0");
      const h = parseFloat(a.height ?? "0");
      if (w <= 0 || h <= 0) return null;
      return transformBbox([x, y, w, h], myTransform);
    }
    case "path": {
      // Approximate from M / L / C / Q / A endpoints. Not exact (a curve
      // can extend beyond its endpoints) but good enough for chunking.
      const d = a.d;
      if (!d) return null;
      const points = extractPathEndpoints(d);
      if (points.length === 0) return null;
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      return transformBbox([minX, minY, maxX - minX, maxY - minY], myTransform);
    }
    case "polyline":
    case "polygon": {
      const pts = (a.points ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter(Number.isFinite);
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) {
        xs.push(pts[i]);
        ys.push(pts[i + 1]);
      }
      if (xs.length === 0) return null;
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      return transformBbox([minX, minY, maxX - minX, maxY - minY], myTransform);
    }
    case "text":
    case "tspan": {
      // Text bbox is hard without font metrics. Best we have is x/y +
      // a heuristic width based on character count and font-size.
      const x = parseFloat(a.x ?? "0");
      const y = parseFloat(a.y ?? "0");
      const fs = parseFloat(a["font-size"] ?? "16");
      const text = (raw.children.find((c) => c.tag === "#text")?.text ?? "").trim();
      const w = Math.max(fs * 0.5 * text.length, fs * 0.5);
      const h = fs * 1.2;
      return transformBbox([x, y - h, w, h], myTransform);
    }
    case "svg": {
      const vb = a.viewBox?.split(/[\s,]+/).map(Number);
      if (vb && vb.length === 4) return [vb[0], vb[1], vb[2], vb[3]];
      const w = parseFloat(a.width ?? "0");
      const h = parseFloat(a.height ?? "0");
      if (w > 0 && h > 0) return [0, 0, w, h];
      return null;
    }
    case "g":
    case "symbol": {
      // Union of children's bboxes. They're already in our coordinate
      // space (transforms cascade through children).
      const cbboxes = children.map((c) => c.bbox).filter((b): b is [number, number, number, number] => b !== null);
      if (cbboxes.length === 0) return null;
      const xs = cbboxes.map((b) => b[0]);
      const ys = cbboxes.map((b) => b[1]);
      const xs2 = cbboxes.map((b) => b[0] + b[2]);
      const ys2 = cbboxes.map((b) => b[1] + b[3]);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs2);
      const maxY = Math.max(...ys2);
      return [minX, minY, maxX - minX, maxY - minY];
    }
    default:
      // <defs>, <linearGradient>, <clipPath>, <mask>, <filter>, <title>, <desc>:
      // these declare references and have no paint area. Bbox null is
      // intentional — caller (splitSvgTree, BlockOverlays) treats null
      // bbox as "definition node, doesn't ship to manifest".
      return null;
  }
}

/** Extract the endpoint AND control point coordinates from a path's `d`
 *  attribute. Including control points gives a LOOSE bbox bound (the
 *  curve never extends beyond its control polygon's hull, which we
 *  approximate with the AABB of all control + endpoint coords). This
 *  overestimates by ~10-30% for typical curves but never undershoots —
 *  exactly what we want for chunking + visual-diff alignment. The pure-
 *  endpoint version we used initially undershot by ~50% for tall
 *  bezier swoops, e.g. a leaf path d="M40 60 C 60 80, 70 110, 50 140"
 *  gave bbox h=80 when the actual visible extent is ~110.
 */
function extractPathEndpoints(d: string): [number, number][] {
  const out: [number, number][] = [];
  // Split on command letters; capture each command + its number list.
  const re = /([MLHVCSQTAZmlhvcsqtaz])\s*([^MLHVCSQTAZmlhvcsqtaz]*)/g;
  let cur: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  let match: RegExpExecArray | null;
  const pushPair = (x: number, y: number) => {
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  };
  while ((match = re.exec(d))) {
    const cmd = match[1];
    const numsRaw = match[2].trim();
    const nums = numsRaw ? numsRaw.split(/[\s,]+/).map(Number).filter(Number.isFinite) : [];
    const isAbs = cmd === cmd.toUpperCase();
    const c = cmd.toLowerCase();
    if (c === "z") {
      cur = [...start];
      out.push(cur);
      continue;
    }
    let i = 0;
    while (i < nums.length) {
      let nx = cur[0];
      let ny = cur[1];
      switch (c) {
        case "m":
        case "l":
        case "t":
          nx = isAbs ? nums[i] : cur[0] + nums[i];
          ny = isAbs ? nums[i + 1] : cur[1] + nums[i + 1];
          i += 2;
          break;
        case "h":
          nx = isAbs ? nums[i] : cur[0] + nums[i];
          ny = cur[1];
          i += 1;
          break;
        case "v":
          nx = cur[0];
          ny = isAbs ? nums[i] : cur[1] + nums[i];
          i += 1;
          break;
        case "c": {
          // Cubic: control1, control2, endpoint. Add ALL three so bbox
          // covers the full hull.
          const c1x = isAbs ? nums[i] : cur[0] + nums[i];
          const c1y = isAbs ? nums[i + 1] : cur[1] + nums[i + 1];
          const c2x = isAbs ? nums[i + 2] : cur[0] + nums[i + 2];
          const c2y = isAbs ? nums[i + 3] : cur[1] + nums[i + 3];
          pushPair(c1x, c1y);
          pushPair(c2x, c2y);
          nx = isAbs ? nums[i + 4] : cur[0] + nums[i + 4];
          ny = isAbs ? nums[i + 5] : cur[1] + nums[i + 5];
          i += 6;
          break;
        }
        case "s":
        case "q": {
          // Quadratic / smooth-cubic: 1 control + endpoint.
          const cx = isAbs ? nums[i] : cur[0] + nums[i];
          const cy = isAbs ? nums[i + 1] : cur[1] + nums[i + 1];
          pushPair(cx, cy);
          nx = isAbs ? nums[i + 2] : cur[0] + nums[i + 2];
          ny = isAbs ? nums[i + 3] : cur[1] + nums[i + 3];
          i += 4;
          break;
        }
        case "a":
          // Arc: rx, ry, xAxisRot, largeArc, sweep, endX, endY. The
          // arc may extend beyond the line between cur and end (up to
          // a full ellipse). Approximate by adding cur ± rx/ry as
          // bbox-extending corners — over-conservative but bounded.
          {
            const rx = Math.abs(nums[i] ?? 0);
            const ry = Math.abs(nums[i + 1] ?? 0);
            pushPair(cur[0] + rx, cur[1] + ry);
            pushPair(cur[0] - rx, cur[1] - ry);
          }
          nx = isAbs ? nums[i + 5] : cur[0] + nums[i + 5];
          ny = isAbs ? nums[i + 6] : cur[1] + nums[i + 6];
          i += 7;
          break;
        default:
          i = nums.length; // bail
          break;
      }
      if (Number.isFinite(nx) && Number.isFinite(ny)) {
        cur = [nx, ny];
        out.push(cur);
        if (c === "m" && out.length === 1) start = [...cur];
      }
    }
  }
  return out;
}

function estimateByteSize(raw: RawNode, children: SvgNode[]): number {
  // Approximation: tag name + attrs + children's bytes + closing tag.
  // Don't bother re-running XML serializer; that's expensive and the
  // estimate just needs to be monotonic with the real size.
  let bytes = raw.tag.length * 2 + 5; // <tag></tag>
  for (const k of Object.keys(raw.attrs)) {
    bytes += k.length + (raw.attrs[k]?.length ?? 0) + 4; // ` k="v"`
  }
  if (raw.text) bytes += raw.text.length;
  for (const c of children) bytes += c.byteSize;
  // Original-text children that we collapsed into raw.text aren't accounted
  // for in `children`; they're in `raw.children` only.
  for (const c of raw.children) {
    if (c.tag === "#text") bytes += (c.text ?? "").length;
  }
  return bytes;
}
