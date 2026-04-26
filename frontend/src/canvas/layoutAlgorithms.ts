/**
 * LayoutNode 树操作 —— 不可变（每个函数返回新树）,纯函数。
 */
import type { LayoutNode, AdjacencyEdges } from "./types";

export function collectLeaves(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.kind === "leaf") return [node.blockId];
  return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

export function countLeaves(node: LayoutNode | null): number {
  return collectLeaves(node).length;
}

/** 找叶子的父节点（用于 swap 时定位),返回 [parent, "first"|"second"] 或 null。 */
function findParent(
  node: LayoutNode,
  blockId: string,
): { parent: LayoutNode & { kind: "split" }; side: "first" | "second" } | null {
  if (node.kind === "leaf") return null;
  if (node.first.kind === "leaf" && node.first.blockId === blockId) return { parent: node, side: "first" };
  if (node.second.kind === "leaf" && node.second.blockId === blockId) return { parent: node, side: "second" };
  return findParent(node.first, blockId) ?? findParent(node.second, blockId);
}

/** 移除某个 block 的叶子。如果是根叶子 → 返回 null;否则把兄弟节点提升到父位置。 */
export function removeLeaf(node: LayoutNode | null, blockId: string): LayoutNode | null {
  if (!node) return null;
  if (node.kind === "leaf") return node.blockId === blockId ? null : node;
  // 内部节点：递归处理两侧
  const newFirst = removeLeaf(node.first, blockId);
  const newSecond = removeLeaf(node.second, blockId);
  // 如果某侧整个被移除,提升另一侧
  if (newFirst === null) return newSecond;
  if (newSecond === null) return newFirst;
  // 两侧都还在,但内部可能已重写
  if (newFirst === node.first && newSecond === node.second) return node;
  return { ...node, first: newFirst, second: newSecond };
}

/** 在树中交换两个 leaf 的 blockId(swap)。 */
export function swapLeaves(node: LayoutNode, idA: string, idB: string): LayoutNode {
  if (idA === idB) return node;
  return mapLeaves(node, (leafId) => (leafId === idA ? idB : leafId === idB ? idA : leafId));
}

/** drop side —— 拖拽落位时,源块要插到目标块的哪一边。center 表示与目标交换。 */
export type DropSide = "top" | "right" | "bottom" | "left" | "center";

/** Canvas 外缘 drop —— 把 source 全宽/全高放在整个 layout 树的某一侧。 */
export type CanvasEdge = "top" | "right" | "bottom" | "left";

/**
 * 在 layout 根的 canvas 外缘(top/right/bottom/left)插入 source。
 * source 占 30%(top/left)或 70%(bottom/right 时新 source 占外侧 30%),
 * 现有整棵树缩到剩余 70%。这样新 block 直观"贴边",占地不喧宾夺主。
 */
export function moveBlockToCanvasEdge(
  layout: LayoutNode,
  sourceId: string,
  edge: CanvasEdge,
): LayoutNode {
  // 摘出 source
  const without = removeLeaf(layout, sourceId);
  if (!without) return layout;
  const sourceLeaf: LayoutNode = { kind: "leaf", blockId: sourceId };
  const orientation: "h" | "v" = edge === "top" || edge === "bottom" ? "v" : "h";
  const sourceFirst = edge === "top" || edge === "left";
  // ratio 默认 0.3 给 source(让现有树占 70%);一致 first 占比表示
  return {
    kind: "split",
    orientation,
    ratio: sourceFirst ? 0.3 : 0.7,
    first: sourceFirst ? sourceLeaf : without,
    second: sourceFirst ? without : sourceLeaf,
  };
}

/**
 * 把 source block 从当前位置移动到 target block 指定边/中心。
 *   - center → 与 target 交换位置(swap)
 *   - top/bottom/left/right → 在 target 的该边切一刀,source 落在该边一侧,
 *                              target 占另一侧,新 split 替代 target 的位置。
 *
 * `preserveRatio` 参数:source 落位时尽量保持原大小。传入 source 在拖拽前的矩形
 * 和 target 矩形,用 source 与 target 的对应方向尺寸算出 split ratio。
 * 不传则默认 0.5(对半分)。
 */
export function moveBlockToTarget(
  layout: LayoutNode,
  sourceId: string,
  targetId: string,
  side: DropSide,
  preserveRatio?: { sourceW: number; sourceH: number; targetW: number; targetH: number },
): LayoutNode {
  if (sourceId === targetId) return layout;
  if (side === "center") return swapLeaves(layout, sourceId, targetId);

  // 1) 从树里摘掉 source(兄弟提升)
  const without = removeLeaf(layout, sourceId);
  if (!without) return layout;

  // 2) 把 source 作为新 leaf 插到 target 的指定边
  const orientation: "h" | "v" = side === "top" || side === "bottom" ? "v" : "h";
  const sourceFirst = side === "top" || side === "left";

  // ratio 计算 —— 优先保持 source 原尺寸:
  //   - h-split(左右切): source 应占 target.w 的 source.w / target.w
  //   - v-split(上下切): source 应占 target.h 的 source.h / target.h
  //   sourceFirst 表示 source 在 first 位,ratio = source 占比;否则 ratio = target 占比 = 1 - source 占比。
  let ratio = 0.5;
  if (preserveRatio && preserveRatio.targetW > 0 && preserveRatio.targetH > 0) {
    const sourceFraction =
      orientation === "h"
        ? preserveRatio.sourceW / preserveRatio.targetW
        : preserveRatio.sourceH / preserveRatio.targetH;
    const clamped = Math.max(0.15, Math.min(0.85, sourceFraction));
    ratio = sourceFirst ? clamped : 1 - clamped;
  }

  const sourceLeaf: LayoutNode = { kind: "leaf", blockId: sourceId };
  return replaceLeaf(without, targetId, (oldTarget) => ({
    kind: "split",
    orientation,
    ratio,
    first: sourceFirst ? sourceLeaf : oldTarget,
    second: sourceFirst ? oldTarget : sourceLeaf,
  }));
}

function mapLeaves(node: LayoutNode, fn: (id: string) => string): LayoutNode {
  if (node.kind === "leaf") {
    const next = fn(node.blockId);
    if (next === node.blockId) return node;
    return { kind: "leaf", blockId: next };
  }
  return { ...node, first: mapLeaves(node.first, fn), second: mapLeaves(node.second, fn) };
}

/** 找面积最大的叶子,返回其 blockId 和宽高。用于"新增 block"时找最大块切一刀。
 *  bounds 是 0~1 归一化坐标,其相对面积就是 width * height。 */
function findLargestLeaf(
  node: LayoutNode,
  width: number,
  height: number,
): { blockId: string; width: number; height: number } | null {
  if (node.kind === "leaf") return { blockId: node.blockId, width, height };
  let firstW = width, firstH = height, secondW = width, secondH = height;
  if (node.orientation === "h") {
    firstW = width * node.ratio;
    secondW = width * (1 - node.ratio);
  } else {
    firstH = height * node.ratio;
    secondH = height * (1 - node.ratio);
  }
  const a = findLargestLeaf(node.first, firstW, firstH);
  const b = findLargestLeaf(node.second, secondW, secondH);
  if (!a) return b;
  if (!b) return a;
  return a.width * a.height >= b.width * b.height ? a : b;
}

/**
 * 在「面积最大的叶子」处插入一个新 block。
 * 切割方向：长边切（横长方形垂直切 → 新 block 在右；竖长方形水平切 → 新 block 在下）。
 * 如果整树为空,新 block 成为根叶子。
 */
export function insertNewBlock(node: LayoutNode | null, newBlockId: string): LayoutNode {
  if (!node) return { kind: "leaf", blockId: newBlockId };
  const target = findLargestLeaf(node, 1, 1);
  if (!target) return { kind: "leaf", blockId: newBlockId };
  return replaceLeaf(node, target.blockId, (oldLeaf) => ({
    kind: "split",
    orientation: target.width >= target.height ? "h" : "v",
    ratio: 0.5,
    first: oldLeaf,
    second: { kind: "leaf", blockId: newBlockId },
  }));
}

function replaceLeaf(
  node: LayoutNode,
  blockId: string,
  replacement: (oldLeaf: LayoutNode) => LayoutNode,
): LayoutNode {
  if (node.kind === "leaf") {
    return node.blockId === blockId ? replacement(node) : node;
  }
  const newFirst = replaceLeaf(node.first, blockId, replacement);
  const newSecond = replaceLeaf(node.second, blockId, replacement);
  if (newFirst === node.first && newSecond === node.second) return node;
  return { ...node, first: newFirst, second: newSecond };
}

/** 修改某个 split 的 ratio。用 path（"L"|"R" 串）定位。 */
export function updateRatioByPath(
  node: LayoutNode,
  path: ("L" | "R")[],
  ratio: number,
): LayoutNode {
  if (path.length === 0) {
    if (node.kind !== "split") return node;
    return { ...node, ratio: Math.max(0.15, Math.min(0.85, ratio)) };
  }
  if (node.kind !== "split") return node;
  const [head, ...rest] = path;
  if (head === "L") return { ...node, first: updateRatioByPath(node.first, rest, ratio) };
  return { ...node, second: updateRatioByPath(node.second, rest, ratio) };
}

/** 计算每个叶子的四边邻接关系（"page" 贴页面 / "neighbor" 贴另一 block）。 */
export function computeAdjacency(
  node: LayoutNode | null,
  inherited: AdjacencyEdges = { top: "page", right: "page", bottom: "page", left: "page" },
  out: Record<string, AdjacencyEdges> = {},
): Record<string, AdjacencyEdges> {
  if (!node) return out;
  if (node.kind === "leaf") {
    out[node.blockId] = { ...inherited };
    return out;
  }
  if (node.orientation === "h") {
    // 垂直分隔线，左 first / 右 second
    computeAdjacency(node.first, { ...inherited, right: "neighbor" }, out);
    computeAdjacency(node.second, { ...inherited, left: "neighbor" }, out);
  } else {
    // 水平分隔线，上 first / 下 second
    computeAdjacency(node.first, { ...inherited, bottom: "neighbor" }, out);
    computeAdjacency(node.second, { ...inherited, top: "neighbor" }, out);
  }
  return out;
}

/** 计算每个叶子的"区域 px 矩形"(给 drag-to-swap 用)。 */
export function computeRects(
  node: LayoutNode | null,
  containerWidth: number,
  containerHeight: number,
  containerLeft = 0,
  containerTop = 0,
  out: Record<string, { x: number; y: number; w: number; h: number }> = {},
): Record<string, { x: number; y: number; w: number; h: number }> {
  if (!node) return out;
  if (node.kind === "leaf") {
    out[node.blockId] = { x: containerLeft, y: containerTop, w: containerWidth, h: containerHeight };
    return out;
  }
  if (node.orientation === "h") {
    const firstW = containerWidth * node.ratio;
    computeRects(node.first, firstW, containerHeight, containerLeft, containerTop, out);
    computeRects(
      node.second,
      containerWidth - firstW,
      containerHeight,
      containerLeft + firstW,
      containerTop,
      out,
    );
  } else {
    const firstH = containerHeight * node.ratio;
    computeRects(node.first, containerWidth, firstH, containerLeft, containerTop, out);
    computeRects(
      node.second,
      containerWidth,
      containerHeight - firstH,
      containerLeft,
      containerTop + firstH,
      out,
    );
  }
  return out;
}
