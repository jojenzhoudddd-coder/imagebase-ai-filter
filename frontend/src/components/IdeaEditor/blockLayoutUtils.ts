/**
 * Block Layout utilities — recursive alternating-direction model.
 *
 * Rules:
 *   - Adjacent layers MUST alternate: h → v → h → v …
 *   - Top-level rows are always direction "h".
 *   - All splits are equal-width by default.
 */
import type { ColumnRow, ColumnCell } from "../../types";

// ─── Helpers ───────────────────────────────────────────────────────────

function genRowId(): string {
  return `row_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function equalWidths(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

function oppositeDir(d: "h" | "v"): "h" | "v" {
  return d === "h" ? "v" : "h";
}

// ─── Queries ────────────────────────────────────────────────────────────

/** Collect all block IDs across all rows (recursive). */
export function allRowBlockIds(rows: ColumnRow[]): Set<string> {
  const ids = new Set<string>();
  function walk(cell: ColumnCell) {
    if (cell.type === "block") ids.add(cell.blockId);
    else for (const c of cell.row.columns) walk(c);
  }
  for (const row of rows)
    for (const col of row.columns) walk(col);
  return ids;
}

/** Find the ColumnRow that directly contains blockId as a child cell. */
export function findRowForBlock(rows: ColumnRow[], blockId: string): ColumnRow | null {
  for (const row of rows) {
    for (const col of row.columns) {
      if (col.type === "block" && col.blockId === blockId) return row;
      if (col.type === "row") {
        const found = findRowForBlock([col.row], blockId);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Find a ColumnRow by its id, searching recursively. */
export function findRowById(rows: ColumnRow[], rowId: string): ColumnRow | null {
  for (const row of rows) {
    if (row.id === rowId) return row;
    for (const col of row.columns) {
      if (col.type === "row") {
        const found = findRowById([col.row], rowId);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Find the top-level row that (recursively) contains blockId. */
export function findTopRowForBlock(rows: ColumnRow[], blockId: string): ColumnRow | null {
  for (const row of rows) {
    if (rowContainsBlock(row, blockId)) return row;
  }
  return null;
}

function rowContainsBlock(row: ColumnRow, blockId: string): boolean {
  for (const col of row.columns) {
    if (col.type === "block" && col.blockId === blockId) return true;
    if (col.type === "row" && rowContainsBlock(col.row, blockId)) return true;
  }
  return false;
}

// ─── Mutations (immutable) ──────────────────────────────────────────────

/**
 * Add newBlockId next to targetBlockId at the SAME level (sibling).
 *
 * - If target is in a row and the requested side matches the row's direction
 *   (left/right for "h", top/bottom for "v"), insert as sibling.
 * - If target is not in any row, create a new top-level "h" row.
 */
export function addSibling(
  rows: ColumnRow[],
  targetBlockId: string,
  newBlockId: string,
  side: "left" | "right" | "top" | "bottom",
): ColumnRow[] {
  // Try inserting within existing rows
  const result = rows.map((row) => addSiblingInRow(row, targetBlockId, newBlockId, side));
  if (result.some((r, i) => r !== rows[i])) return result;

  // Target not in any row — create new top-level "h" row
  const before = side === "left" || side === "top";
  const cells: ColumnCell[] = before
    ? [{ type: "block", blockId: newBlockId }, { type: "block", blockId: targetBlockId }]
    : [{ type: "block", blockId: targetBlockId }, { type: "block", blockId: newBlockId }];
  return [...rows, { id: genRowId(), direction: "h", columns: cells, widths: [0.5, 0.5] }];
}

function addSiblingInRow(
  row: ColumnRow,
  targetBlockId: string,
  newBlockId: string,
  side: "left" | "right" | "top" | "bottom",
): ColumnRow {
  const idx = row.columns.findIndex(
    (c) => c.type === "block" && c.blockId === targetBlockId,
  );
  if (idx >= 0) {
    const before = side === "left" || side === "top";
    const insertIdx = before ? idx : idx + 1;
    const newCols = [...row.columns];
    newCols.splice(insertIdx, 0, { type: "block", blockId: newBlockId });
    return { ...row, columns: newCols, widths: equalWidths(newCols.length) };
  }

  // Recurse
  let changed = false;
  const newCols = row.columns.map((col) => {
    if (col.type !== "row" || changed) return col;
    const updated = addSiblingInRow(col.row, targetBlockId, newBlockId, side);
    if (updated !== col.row) { changed = true; return { type: "row" as const, row: updated }; }
    return col;
  });
  return changed ? { ...row, columns: newCols, widths: row.widths } : row;
}

/**
 * Nest: wrap targetBlockId and newBlockId into a sub-row of the
 * OPPOSITE direction within target's current column.
 *
 * e.g. target is in an "h" row → nest creates a "v" sub-row.
 */
export function nestBlock(
  rows: ColumnRow[],
  targetBlockId: string,
  newBlockId: string,
  side: "left" | "right" | "top" | "bottom",
): ColumnRow[] {
  return rows.map((row) => nestInRow(row, targetBlockId, newBlockId, side));
}

function nestInRow(
  row: ColumnRow,
  targetBlockId: string,
  newBlockId: string,
  side: "left" | "right" | "top" | "bottom",
): ColumnRow {
  const newCols = row.columns.map((col) => {
    if (col.type === "block" && col.blockId === targetBlockId) {
      const childDir = oppositeDir(row.direction);
      const before = side === "left" || side === "top";
      const cells: ColumnCell[] = before
        ? [{ type: "block", blockId: newBlockId }, { type: "block", blockId: targetBlockId }]
        : [{ type: "block", blockId: targetBlockId }, { type: "block", blockId: newBlockId }];
      return { type: "row" as const, row: { id: genRowId(), direction: childDir, columns: cells, widths: [0.5, 0.5] } };
    }
    if (col.type === "row") {
      const updated = nestInRow(col.row, targetBlockId, newBlockId, side);
      if (updated !== col.row) return { type: "row" as const, row: updated };
    }
    return col;
  });
  const changed = newCols.some((c, i) => c !== row.columns[i]);
  return changed ? { ...row, columns: newCols, widths: row.widths } : row;
}

/**
 * Remove a block from any row (recursive). If a row has ≤1 remaining
 * cell, dissolve it (promote the single cell to parent).
 */
export function removeFromRows(rows: ColumnRow[], blockId: string): ColumnRow[] {
  const result: ColumnRow[] = [];
  for (const row of rows) {
    const cleaned = removeFromRow(row, blockId);
    if (cleaned === null) continue;
    // Top-level row with ≤1 child → dissolve (blocks return to normal flow)
    if (cleaned.columns.length <= 1) continue;
    result.push(cleaned);
  }
  return result;
}

function removeFromRow(row: ColumnRow, blockId: string): ColumnRow | null {
  let changed = false;
  const newCols: ColumnCell[] = [];

  for (const col of row.columns) {
    if (col.type === "block" && col.blockId === blockId) {
      changed = true;
      continue;
    }
    if (col.type === "row") {
      const cleaned = removeFromRow(col.row, blockId);
      if (cleaned === null) { changed = true; continue; }
      if (cleaned !== col.row) {
        changed = true;
        if (cleaned.columns.length === 1) {
          newCols.push(cleaned.columns[0]); // unwrap single-child row
        } else {
          newCols.push({ type: "row", row: cleaned });
        }
        continue;
      }
    }
    newCols.push(col);
  }

  if (!changed) return row;
  if (newCols.length === 0) return null;
  // 1 child: return as-is — caller (parent row or removeFromRows) handles unwrap/dissolve
  return { ...row, columns: newCols, widths: equalWidths(newCols.length) };
}

/**
 * Resize two adjacent cells in a row identified by rowId (recursive search).
 */
export function resizeRow(
  rows: ColumnRow[],
  rowId: string,
  dividerIndex: number,
  newLeftWidth: number,
  newRightWidth: number,
): ColumnRow[] {
  return rows.map((r) => resizeInRow(r, rowId, dividerIndex, newLeftWidth, newRightWidth));
}

function resizeInRow(
  row: ColumnRow,
  rowId: string,
  dividerIndex: number,
  newLeftW: number,
  newRightW: number,
): ColumnRow {
  if (row.id === rowId) {
    if (dividerIndex < 0 || dividerIndex + 1 >= row.widths.length) return row;
    const w = [...row.widths];
    w[dividerIndex] = newLeftW;
    w[dividerIndex + 1] = newRightW;
    return { ...row, widths: w };
  }
  let changed = false;
  const newCols = row.columns.map((col) => {
    if (col.type !== "row" || changed) return col;
    const updated = resizeInRow(col.row, rowId, dividerIndex, newLeftW, newRightW);
    if (updated !== col.row) { changed = true; return { type: "row" as const, row: updated }; }
    return col;
  });
  return changed ? { ...row, columns: newCols, widths: row.widths } : row;
}
