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

/**
 * "Tidy up" layout: infer the user's row structure from current positions,
 * then align items within each row and equalize spacing — minimal rearrangement.
 */
export function computeGridLayout(tastes: TasteLike[]): LayoutResult {
  if (tastes.length === 0) return { updates: [], bounds: { width: 0, height: 0 } };

  // 1. Cluster items into rows by Y proximity.
  //    Two items are in the same row if their vertical centers are within
  //    half the smaller item's height of each other.
  const items = [...tastes].sort((a, b) => {
    const dy = a.y - b.y;
    return Math.abs(dy) > 20 ? dy : a.x - b.x;
  });

  const rows: TasteLike[][] = [];
  for (const t of items) {
    const cy = t.y + t.height / 2;
    let placed = false;
    for (const row of rows) {
      const rowCy = row.reduce((s, r) => s + r.y + r.height / 2, 0) / row.length;
      const threshold = Math.min(...row.map((r) => r.height), t.height) * 0.6;
      if (Math.abs(cy - rowCy) < Math.max(threshold, 40)) {
        row.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([t]);
  }

  // Sort rows by average Y, and items within each row by X
  rows.sort((a, b) => {
    const ay = a.reduce((s, t) => s + t.y, 0) / a.length;
    const by = b.reduce((s, t) => s + t.y, 0) / b.length;
    return ay - by;
  });
  for (const row of rows) row.sort((a, b) => a.x - b.x);

  // 2. Compute adaptive gap from average item size
  const avgSize = items.reduce((s, t) => s + Math.max(t.width, t.height), 0) / items.length;
  const gap = Math.round(Math.min(80, Math.max(16, avgSize * 0.06)));

  // 3. Lay out: equalize horizontal spacing within each row, stack rows vertically
  const updates: Array<{ id: string; x: number; y: number }> = [];
  let currentY = 0;
  let totalWidth = 0;

  for (const row of rows) {
    let x = 0;
    const rowH = Math.max(...row.map((t) => t.height));
    for (const t of row) {
      const y = currentY + (rowH - t.height) / 2;
      updates.push({ id: t.id, x, y });
      x += t.width + gap;
    }
    totalWidth = Math.max(totalWidth, x - gap);
    currentY += rowH + gap;
  }

  const totalHeight = Math.max(0, currentY - gap);
  return { updates, bounds: { width: totalWidth, height: totalHeight } };
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
