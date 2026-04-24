/**
 * svgAnalyzer — extract design-token-like structured info from an SVG string.
 *
 * Purpose: give the chat Agent a compact, high-signal alternative to reading
 * the raw SVG source. The raw source carries everything but Claude has to
 * reason from markup; a summary like
 *   { colors: [{hex, usage}], typography: [{family, size, weight, usage}],
 *     regions: [{name, x, y, w, h}], texts: ["..."] }
 * is ~20× smaller and lets the model directly translate to React+Tailwind.
 *
 * The implementation is intentionally simple (no layout engine, no CSS
 * resolution). We walk the parsed tree and aggregate observations.
 */

import { XMLParser } from "fast-xml-parser";

export interface SvgReport {
  viewBox: { x: number; y: number; w: number; h: number } | null;
  nodeCount: number;
  /** Top colors by occurrence count, normalized to #RRGGBB. */
  colors: Array<{ hex: string; usage: number; role?: string }>;
  /** Font family / size / weight groupings extracted from <text> nodes. */
  typography: Array<{ family: string; size: number; weight?: string | number; usage: number }>;
  /** Visible text strings (capped, deduplicated). */
  texts: string[];
  /** Big rectangles clustered as likely layout regions (topbar / sidebar / main / card). */
  regions: Array<{ x: number; y: number; w: number; h: number; fill?: string; role?: string }>;
  /** Embedded <image> references (href). Often indicate bitmap portions. */
  images: Array<{ href: string; x?: number; y?: number; w?: number; h?: number }>;
  /** Total path geometry chars — a rough "complexity" proxy. */
  pathBytes: number;
}

const COLOR_TOP_K = 12;
const TYPO_TOP_K = 10;
const TEXT_MAX = 80;
const REGION_MIN_AREA = 2_000; // px² — filter out icon-sized rects
const REGION_TOP_K = 20;

function normalizeColor(raw?: string): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || s === "none" || s === "transparent") return null;
  // #rgb → #rrggbb
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toUpperCase();
  // #rrggbb(aa?)
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return `#${m[1].toUpperCase()}`;
  // rgb()/rgba()
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(s);
  if (m) {
    const hex = [m[1], m[2], m[3]]
      .map((x) => Math.max(0, Math.min(255, parseInt(x, 10))).toString(16).padStart(2, "0"))
      .join("");
    return `#${hex.toUpperCase()}`;
  }
  return null;
}

function parseViewBox(v: unknown): SvgReport["viewBox"] {
  if (typeof v !== "string") return null;
  const parts = v.trim().split(/\s+/).map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }
  return null;
}

// Very loose style attribute parser — SVGs rarely carry complex CSS inline
// but we want to catch `style="fill:#1456F0;stroke:..."`.
function parseStyleAttr(style: unknown): Record<string, string> {
  if (typeof style !== "string") return {};
  const out: Record<string, string> = {};
  for (const kv of style.split(";")) {
    const [k, ...rest] = kv.split(":");
    if (!k || !rest.length) continue;
    out[k.trim()] = rest.join(":").trim();
  }
  return out;
}

/**
 * Primary entry point. Doesn't throw — returns a partial report with best-
 * effort extraction when the SVG is malformed.
 */
export function analyzeSvg(
  svg: string,
  fallbackSize?: { w?: number; h?: number }
): SvgReport {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    preserveOrder: false,
    trimValues: true,
    // XMLParser treats HTML-ish self-closing as text if you don't flag; SVG
    // is well-formed XML so defaults are fine.
  });
  let root: any = {};
  try {
    root = parser.parse(svg);
  } catch {
    // parse failure — return bare minimum
    return {
      viewBox: null,
      nodeCount: 0,
      colors: [],
      typography: [],
      texts: [],
      regions: [],
      images: [],
      pathBytes: 0,
    };
  }

  const svgNode = root.svg ?? {};
  const svgAttrs = svgNode ?? {};
  const viewBox = parseViewBox(svgAttrs.viewBox) ?? (
    fallbackSize?.w && fallbackSize?.h
      ? { x: 0, y: 0, w: fallbackSize.w, h: fallbackSize.h }
      : null
  );

  const colorCount = new Map<string, number>();
  const typoCount = new Map<string, { family: string; size: number; weight?: string | number; count: number }>();
  const texts: string[] = [];
  const regions: SvgReport["regions"] = [];
  const images: SvgReport["images"] = [];
  let nodeCount = 0;
  let pathBytes = 0;

  function bumpColor(raw?: string) {
    const hex = normalizeColor(raw);
    if (!hex) return;
    colorCount.set(hex, (colorCount.get(hex) ?? 0) + 1);
  }

  function walk(node: any, parentFill?: string): void {
    if (node == null) return;
    if (typeof node !== "object") return;
    // Arrays: a same-tag sibling list in our parser config
    if (Array.isArray(node)) {
      for (const n of node) walk(n, parentFill);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("_")) continue;
      // Attributes show up flattened in the parent (attributeNamePrefix="").
      // Actual child elements are also siblings — distinguish by tag-ish keys.
      // Since we don't preserveOrder, each non-attribute key is either a
      // child-element name (then value is object/array) or a primitive attr.
      if (value === null || value === undefined) continue;

      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        // This is an attribute of `node`. Handle fills/strokes/style below
        // when we iterate attributes more directly.
        continue;
      }
      // It's a child element (or an array of same-tag children).
      nodeCount++;

      // Read attributes of node itself (they live as siblings but we can't
      // tell here; handle via a second pass on the parent). Easier: handle
      // attributes at the point we RECURSE INTO the node below. So we need
      // a different traversal — rewrite.
      // ... (see walkElement below)
      walkElement(key, value as any, parentFill);
    }
  }

  // For each concrete element, extract attrs + recurse into its children
  function walkElement(tag: string, nodeOrArr: any, parentFill?: string): void {
    const items = Array.isArray(nodeOrArr) ? nodeOrArr : [nodeOrArr];
    for (const node of items) {
      if (node == null || typeof node !== "object") continue;

      // Attributes
      const fill = String(node.fill ?? parseStyleAttr(node.style).fill ?? parentFill ?? "");
      const stroke = String(node.stroke ?? parseStyleAttr(node.style).stroke ?? "");
      bumpColor(fill);
      bumpColor(stroke);

      if (tag === "rect") {
        const x = Number(node.x ?? 0);
        const y = Number(node.y ?? 0);
        const w = Number(node.width ?? 0);
        const h = Number(node.height ?? 0);
        if (Number.isFinite(w) && Number.isFinite(h) && w * h >= REGION_MIN_AREA) {
          regions.push({ x, y, w, h, fill: normalizeColor(fill) ?? undefined });
        }
      }

      if (tag === "text" || tag === "tspan") {
        const content = typeof node["#text"] === "string" ? node["#text"].trim() : "";
        if (content) texts.push(content);
        const family = String(node["font-family"] ?? parseStyleAttr(node.style)["font-family"] ?? "default");
        const size = Number(node["font-size"] ?? parseStyleAttr(node.style)["font-size"] ?? 0) || 0;
        const weight = node["font-weight"] ?? parseStyleAttr(node.style)["font-weight"];
        if (size) {
          const key = `${family}|${size}|${weight ?? ""}`;
          const slot = typoCount.get(key);
          if (slot) slot.count++;
          else typoCount.set(key, { family, size, weight, count: 1 });
        }
      }

      if (tag === "path") {
        const d = String(node.d ?? "");
        pathBytes += d.length;
      }

      if (tag === "image") {
        const href = String(node.href ?? node["xlink:href"] ?? "");
        images.push({
          href: href.length > 80 ? href.slice(0, 60) + "…(truncated)" : href,
          x: Number(node.x ?? 0),
          y: Number(node.y ?? 0),
          w: Number(node.width ?? 0),
          h: Number(node.height ?? 0),
        });
      }

      // Recurse into children (any object-valued attr that's not a known string attr)
      for (const [childTag, childVal] of Object.entries(node)) {
        if (childVal === null || childVal === undefined) continue;
        if (typeof childVal !== "object") continue;
        // Skip pseudo-attrs like style's parsed object — we already consumed style
        if (childTag === "style") continue;
        walkElement(childTag, childVal, fill || parentFill);
      }
    }
  }

  // Kick off with the root <svg> node
  walkElement("svg", svgNode);

  // Try to label the biggest top-anchored rectangles as layout regions
  regions.sort((a, b) => b.w * b.h - a.w * a.h);
  const topRegions = regions.slice(0, REGION_TOP_K);
  if (viewBox && topRegions.length) {
    for (const r of topRegions) {
      // Top band full-width → topbar
      if (r.y < viewBox.h * 0.1 && r.w > viewBox.w * 0.85) r.role = "topbar";
      // Left column full-height → sidebar
      else if (r.x < viewBox.w * 0.1 && r.h > viewBox.h * 0.7 && r.w < viewBox.w * 0.35) r.role = "sidebar";
      // Very large (>60% of viewport) → main/canvas
      else if (r.w * r.h > viewBox.w * viewBox.h * 0.5) r.role = "main";
      // Small cards — explicit "card" label only if proportionally card-sized
      else if (r.w >= 100 && r.h >= 60) r.role = "card";
    }
  }

  // Top-K colors with "role" hints: largest-usage fills on a big region
  // become "primary"/"background", the rest are just "accent/neutral".
  const sortedColors = [...colorCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, COLOR_TOP_K)
    .map(([hex, usage]) => ({ hex, usage } as SvgReport["colors"][number]));
  // Heuristic role tagging — first color on a region becomes that region's
  // role name, and the 2nd most-used color tends to be text/border.
  if (topRegions[0]?.fill) {
    const bgIdx = sortedColors.findIndex((c) => c.hex === topRegions[0].fill);
    if (bgIdx >= 0) sortedColors[bgIdx].role = "background";
  }
  if (sortedColors[0] && !sortedColors[0].role) sortedColors[0].role = "primary";

  const sortedTypo = [...typoCount.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, TYPO_TOP_K)
    .map((t) => ({ family: t.family, size: t.size, weight: t.weight, usage: t.count }));

  // De-dupe texts + cap length
  const seen = new Set<string>();
  const uniqTexts: string[] = [];
  for (const t of texts) {
    if (seen.has(t) || !t) continue;
    seen.add(t);
    uniqTexts.push(t);
    if (uniqTexts.length >= TEXT_MAX) break;
  }

  return {
    viewBox,
    nodeCount,
    colors: sortedColors,
    typography: sortedTypo,
    texts: uniqTexts,
    regions: topRegions,
    images,
    pathBytes,
  };
}
