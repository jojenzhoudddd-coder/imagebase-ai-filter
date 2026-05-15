/**
 * Block Layout Tree utilities — pure functions for manipulating
 * the recursive BlockLayoutNode tree used by IdeaEditor.
 *
 * Mirrors the MagicCanvas layoutAlgorithms pattern but scoped to
 * idea block layouts.
 */
import type { BlockLayoutNode } from "../../types";

const MAX_DEPTH = 4;

// ─── Queries ────────────────────────────────────────────────────────────

/** Collect all block IDs referenced as leaves in the tree. */
export function collectLeafIds(node: BlockLayoutNode | null): string[] {
  if (!node) return [];
  if (node.kind === "leaf") return [node.blockId];
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)];
}

/** Check if a specific blockId exists in the tree. */
export function hasBlock(node: BlockLayoutNode | null, blockId: string): boolean {
  if (!node) return false;
  if (node.kind === "leaf") return node.blockId === blockId;
  return hasBlock(node.first, blockId) || hasBlock(node.second, blockId);
}

/** Measure the depth of a tree. */
function treeDepth(node: BlockLayoutNode): number {
  if (node.kind === "leaf") return 0;
  return 1 + Math.max(treeDepth(node.first), treeDepth(node.second));
}

// ─── Mutations (immutable — return new tree) ────────────────────────────

/** Remove a leaf from the tree. If it's the root leaf, returns null.
 *  Otherwise collapses the parent split by promoting the sibling. */
export function removeFromLayout(
  node: BlockLayoutNode | null,
  blockId: string,
): BlockLayoutNode | null {
  if (!node) return null;
  if (node.kind === "leaf") return node.blockId === blockId ? null : node;
  const newFirst = removeFromLayout(node.first, blockId);
  const newSecond = removeFromLayout(node.second, blockId);
  if (newFirst === null) return newSecond;
  if (newSecond === null) return newFirst;
  if (newFirst === node.first && newSecond === node.second) return node;
  return { ...node, first: newFirst, second: newSecond };
}

/** Insert a new block adjacent to an existing block in the tree.
 *  direction: which side of the target the new block goes.
 *  Returns the same tree if target not found or max depth exceeded. */
export function insertIntoLayout(
  tree: BlockLayoutNode | null,
  targetBlockId: string,
  newBlockId: string,
  direction: "left" | "right" | "top" | "bottom",
): BlockLayoutNode {
  if (!tree) {
    // Empty tree — just create a leaf
    return { kind: "leaf", blockId: newBlockId };
  }

  // Check depth limit before inserting
  if (treeDepth(tree) >= MAX_DEPTH) {
    return tree;
  }

  return replaceLeaf(tree, targetBlockId, (oldLeaf) => {
    const orientation: "h" | "v" = direction === "left" || direction === "right" ? "h" : "v";
    const newFirst = direction === "left" || direction === "top";
    const newLeaf: BlockLayoutNode = { kind: "leaf", blockId: newBlockId };
    return {
      kind: "split",
      orientation,
      ratio: 0.5,
      first: newFirst ? newLeaf : oldLeaf,
      second: newFirst ? oldLeaf : newLeaf,
    };
  });
}

/** Move a block from its current position to a target block's side.
 *  Removes source first, then inserts at the target's specified side.
 *  If source === target, returns unchanged. */
export function moveBlockInLayout(
  tree: BlockLayoutNode | null,
  sourceId: string,
  targetId: string,
  direction: "left" | "right" | "top" | "bottom",
): BlockLayoutNode | null {
  if (!tree || sourceId === targetId) return tree;
  const without = removeFromLayout(tree, sourceId);
  if (!without) return tree;
  return insertIntoLayout(without, targetId, sourceId, direction);
}

/** Update the ratio at a specific path in the tree.
 *  Path is an array of "first" | "second" indicating which child to descend into.
 *  The path leads to the split node whose ratio should be updated. */
export function updateRatioAtPath(
  node: BlockLayoutNode,
  path: ("first" | "second")[],
  ratio: number,
): BlockLayoutNode {
  const clamped = Math.max(0.15, Math.min(0.85, ratio));
  if (path.length === 0) {
    if (node.kind !== "split") return node;
    return { ...node, ratio: clamped };
  }
  if (node.kind !== "split") return node;
  const [head, ...rest] = path;
  if (head === "first") {
    return { ...node, first: updateRatioAtPath(node.first, rest, clamped) };
  }
  return { ...node, second: updateRatioAtPath(node.second, rest, clamped) };
}

/** Swap two leaf block IDs in the tree. */
export function swapLeaves(
  node: BlockLayoutNode,
  idA: string,
  idB: string,
): BlockLayoutNode {
  if (idA === idB) return node;
  return mapLeaves(node, (id) => (id === idA ? idB : id === idB ? idA : id));
}

// ─── Migration: convert old column props to layout tree ─────────────────

interface BlockWithProps {
  id: string;
  props: Record<string, unknown>;
}

/** Convert old columnGroupId-based layout to a BlockLayoutNode tree.
 *  Returns null if no column groups found. */
export function migrateColumnPropsToLayout(
  blocks: BlockWithProps[],
): BlockLayoutNode | null {
  // Collect column groups
  const groupMap = new Map<string, BlockWithProps[]>();
  for (const b of blocks) {
    const groupId = b.props?.columnGroupId as string | undefined;
    if (groupId) {
      if (!groupMap.has(groupId)) groupMap.set(groupId, []);
      groupMap.get(groupId)!.push(b);
    }
  }

  // Filter to groups with 2+ members
  const validGroups = new Map<string, BlockWithProps[]>();
  for (const [gid, members] of groupMap) {
    if (members.length >= 2) validGroups.set(gid, members);
  }

  if (validGroups.size === 0) return null;

  // Build layout: for each group, create a horizontal split chain
  // Overall layout is vertical (top to bottom), with column groups inline
  const visited = new Set<string>();
  const rows: BlockLayoutNode[] = [];

  for (const b of blocks) {
    if (visited.has(b.id)) continue;
    const groupId = b.props?.columnGroupId as string | undefined;
    if (groupId && validGroups.has(groupId)) {
      const members = validGroups.get(groupId)!;
      members.forEach((m) => visited.add(m.id));
      // Sort by columnIndex
      members.sort((a, b) => {
        const ai = (a.props?.columnIndex as number) ?? 0;
        const bi = (b.props?.columnIndex as number) ?? 0;
        return ai - bi;
      });
      // Build horizontal split chain
      const widths = members.map((m) => (m.props?.columnWidth as number) ?? 1 / members.length);
      let node: BlockLayoutNode = { kind: "leaf", blockId: members[members.length - 1].id };
      for (let i = members.length - 2; i >= 0; i--) {
        const leftWidth = widths[i];
        const rightTotal = widths.slice(i + 1).reduce((s, w) => s + w, 0);
        const ratio = leftWidth / (leftWidth + rightTotal);
        node = {
          kind: "split",
          orientation: "h",
          ratio: Math.max(0.15, Math.min(0.85, ratio)),
          first: { kind: "leaf", blockId: members[i].id },
          second: node,
        };
      }
      rows.push(node);
    } else {
      visited.add(b.id);
      rows.push({ kind: "leaf", blockId: b.id });
    }
  }

  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  // Chain rows vertically with equal ratios
  let root: BlockLayoutNode = rows[rows.length - 1];
  for (let i = rows.length - 2; i >= 0; i--) {
    const topHeight = 1 / (rows.length - i);
    root = {
      kind: "split",
      orientation: "v",
      ratio: Math.max(0.15, Math.min(0.85, topHeight)),
      first: rows[i],
      second: root,
    };
  }
  return root;
}

// ─── Multi-tree (layouts: BlockLayoutNode[]) helpers ───────────────────

/** Find the tree in `layouts` that contains `blockId`, or null. */
export function findTreeForBlock(
  layouts: BlockLayoutNode[],
  blockId: string,
): BlockLayoutNode | null {
  for (const tree of layouts) {
    if (hasBlock(tree, blockId)) return tree;
  }
  return null;
}

/** Collect all block IDs across all trees in the array. */
export function allTreeBlockIds(layouts: BlockLayoutNode[]): Set<string> {
  const ids = new Set<string>();
  for (const tree of layouts) {
    for (const id of collectLeafIds(tree)) {
      ids.add(id);
    }
  }
  return ids;
}

/** Replace `oldTree` with `newTree` in the layouts array (by reference). */
export function updateTreeInLayouts(
  layouts: BlockLayoutNode[],
  oldTree: BlockLayoutNode,
  newTree: BlockLayoutNode | null,
): BlockLayoutNode[] {
  if (newTree === null) {
    return layouts.filter((t) => t !== oldTree);
  }
  return layouts.map((t) => (t === oldTree ? newTree : t));
}

/** Remove a tree from the layouts array (by reference). */
export function removeTreeFromLayouts(
  layouts: BlockLayoutNode[],
  tree: BlockLayoutNode,
): BlockLayoutNode[] {
  return layouts.filter((t) => t !== tree);
}

// ─── Internal helpers ───────────────────────────────────────────────────

function replaceLeaf(
  node: BlockLayoutNode,
  blockId: string,
  replacement: (oldLeaf: BlockLayoutNode) => BlockLayoutNode,
): BlockLayoutNode {
  if (node.kind === "leaf") {
    return node.blockId === blockId ? replacement(node) : node;
  }
  const newFirst = replaceLeaf(node.first, blockId, replacement);
  const newSecond = replaceLeaf(node.second, blockId, replacement);
  if (newFirst === node.first && newSecond === node.second) return node;
  return { ...node, first: newFirst, second: newSecond };
}

function mapLeaves(
  node: BlockLayoutNode,
  fn: (id: string) => string,
): BlockLayoutNode {
  if (node.kind === "leaf") {
    const next = fn(node.blockId);
    return next === node.blockId ? node : { kind: "leaf", blockId: next };
  }
  const newFirst = mapLeaves(node.first, fn);
  const newSecond = mapLeaves(node.second, fn);
  if (newFirst === node.first && newSecond === node.second) return node;
  return { ...node, first: newFirst, second: newSecond };
}
