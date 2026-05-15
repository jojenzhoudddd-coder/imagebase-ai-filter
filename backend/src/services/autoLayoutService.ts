// ─── Auto-layout service (ported from frontend/src/components/SvgCanvas/index.tsx) ───
//
// Two primitives:
//   1. computeGridLayout(tastes) — "tidy up" all tastes: infer row structure from
//      current Y, align items within each row, equalize spacing. Used by:
//        - User clicks "自动排列" in SvgCanvas (FE keeps its copy for UX latency)
//        - MCP `auto_layout_design` tool (this backend copy, canonical)
//
//   2. findEmptyPosition(existing, newSize) — pick a (x, y) for a single newly-
//      inserted taste that doesn't overlap existing ones. Used by MCP path of
//      `create_taste_from_svg` so Agent-generated SVGs land in a sensible spot
//      without invoking a full re-layout.
//
// Keep the FE copy (SvgCanvas) in sync for one release cycle. When we have
// confirmation that MCP path reliably triggers BE auto-layout, we can reduce
// FE's copy to just the interactive "reflow" button handler that hits REST.

export interface TasteLike {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  updates: Array<{ id: string; x: number; y: number }>;
  bounds: { width: number; height: number };
}

const ALIGN_THRESHOLD = 40; // px — max distance to consider "nearly aligned"

/**
 * "Tidy up" layout: snap-align nodes to shared horizontal/vertical center lines
 * WITHOUT changing their relative positions. Nodes that are roughly aligned
 * (within ALIGN_THRESHOLD) get nudged to a common center line.
 */
export function computeGridLayout(tastes: TasteLike[]): LayoutResult {
  if (tastes.length === 0) return { updates: [], bounds: { width: 0, height: 0 } };

  // Work on a mutable copy
  const nodes = tastes.map((t) => ({ ...t }));

  // 1. Cluster by horizontal center (vertical alignment lines)
  const hClusters = clusterByValue(nodes, (n) => n.x + n.width / 2, ALIGN_THRESHOLD);
  for (const cluster of hClusters) {
    if (cluster.length < 2) continue;
    const avgCx = cluster.reduce((s, n) => s + n.x + n.width / 2, 0) / cluster.length;
    for (const n of cluster) {
      n.x = avgCx - n.width / 2;
    }
  }

  // 2. Cluster by vertical center (horizontal alignment lines)
  const vClusters = clusterByValue(nodes, (n) => n.y + n.height / 2, ALIGN_THRESHOLD);
  for (const cluster of vClusters) {
    if (cluster.length < 2) continue;
    const avgCy = cluster.reduce((s, n) => s + n.y + n.height / 2, 0) / cluster.length;
    for (const n of cluster) {
      n.y = avgCy - n.height / 2;
    }
  }

  const updates: Array<{ id: string; x: number; y: number }> = nodes.map((n) => ({
    id: n.id,
    x: Math.round(n.x),
    y: Math.round(n.y),
  }));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }

  return {
    updates,
    bounds: { width: maxX - minX, height: maxY - minY },
  };
}

function clusterByValue<T>(items: T[], valueFn: (item: T) => number, threshold: number): T[][] {
  const sorted = [...items].sort((a, b) => valueFn(a) - valueFn(b));
  const clusters: T[][] = [];
  let current: T[] = [];

  for (const item of sorted) {
    if (current.length === 0) {
      current.push(item);
    } else {
      const lastVal = valueFn(current[current.length - 1]);
      if (Math.abs(valueFn(item) - lastVal) <= threshold) {
        current.push(item);
      } else {
        clusters.push(current);
        current = [item];
      }
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/**
 * Find an open slot for a newly-inserted taste of the given size.
 *
 * Strategy:
 *   1. Compute bounding box of existing tastes
 *   2. Try the cell immediately to the right of the rightmost item on the last row
 *   3. If that overflows a "comfortable" canvas width (2400px default), start a new row below
 *   4. If there are no existing tastes, return (0, 0)
 *
 * This is intentionally simpler than full re-layout — we do NOT disturb existing
 * positions. Agent can call `auto_layout_design` afterwards for a clean reflow.
 */
export function findEmptyPosition(
  existing: TasteLike[],
  newSize: { width: number; height: number },
  opts: { gap?: number; maxRowWidth?: number } = {},
): { x: number; y: number } {
  if (existing.length === 0) return { x: 0, y: 0 };

  const gap = opts.gap ?? 32;
  const maxRowWidth = opts.maxRowWidth ?? 2400;

  // Find the bottom-most row (items with max Y + height)
  let maxBottom = -Infinity;
  for (const t of existing) {
    const bottom = t.y + t.height;
    if (bottom > maxBottom) maxBottom = bottom;
  }

  // Items whose vertical center lies within the bottom row
  const bottomRowThreshold = 0.6; // 60% overlap heuristic
  const bottomRow = existing.filter((t) => {
    const tBottom = t.y + t.height;
    const overlap = Math.min(tBottom, maxBottom) - Math.max(t.y, maxBottom - t.height);
    return overlap > t.height * bottomRowThreshold;
  });

  if (bottomRow.length === 0) {
    // Fallback: place below everything
    return { x: 0, y: maxBottom + gap };
  }

  // Rightmost edge of the bottom row
  const rightmost = Math.max(...bottomRow.map((t) => t.x + t.width));
  const topOfRow = Math.min(...bottomRow.map((t) => t.y));

  // Proposed X: just to the right of the rightmost item
  const proposedX = rightmost + gap;

  if (proposedX + newSize.width <= maxRowWidth) {
    // Fits on the same row
    return { x: proposedX, y: topOfRow };
  }

  // Start a new row below everything
  return { x: 0, y: maxBottom + gap };
}
