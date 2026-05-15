// ─── Auto-layout service ───
//
// Two primitives:
//   1. computeGridLayout(tastes) — returns current positions unchanged + bounding
//      rect. The frontend handles viewport fitting (pan + zoom) client-side.
//      No taste positions are modified.
//
//   2. findEmptyPosition(existing, newSize) — pick a (x, y) for a single newly-
//      inserted taste that doesn't overlap existing ones.

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
 * "Fit to view" layout: returns all positions unchanged. The frontend adjusts
 * canvas pan + zoom to fit the bounding rect with 40px padding on top/left/right.
 */
export function computeGridLayout(tastes: TasteLike[]): LayoutResult {
  if (tastes.length === 0) return { updates: [], bounds: { width: 0, height: 0 } };

  const updates = tastes.map((t) => ({ id: t.id, x: t.x, y: t.y }));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tastes) {
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + t.width);
    maxY = Math.max(maxY, t.y + t.height);
  }

  return {
    updates,
    bounds: { width: maxX - minX, height: maxY - minY },
  };
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
