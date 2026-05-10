/**
 * MagicCanvas —— 多 block 的可拖拽画布主体。
 *
 * State preservation across layout changes (Solution A · Stable-slot Portal)
 * ─────────────────────────────────────────────────────────────────────────────
 * 问题:LayoutNode 是二叉树,关闭/新增/移动 block 让某 block 在 React tree 里
 * 的祖先链变化(SplitNode 节点出现 / 消失),即使 BlockShell 用 key={blockId},
 * React 跨 parent 不能保住组件身份 → unmount + remount → ChatSidebar 内
 * streaming / messages / cancelRef 等 useState/useRef 全丢。
 *
 * 解法 (final · 稳定 slot DOM + portal):
 *   1. 每个 blockId 有一个**永久稳定的 slot DOM 元素**,在 useRef Map 里 lazy
 *      创建,这辈子不会被销毁。
 *   2. LayoutRenderer 渲染**轻量 anchor div**(带 data-mc-anchor=blockId 标识),
 *      在 layout tree 的对应位置上。
 *   3. useLayoutEffect 用 appendChild 把稳定 slot DOM 移动到当前 anchor 下面。
 *      因为 appendChild 是 DOM-level move(不重建),slot 内的所有 portal 子节点
 *      跟着 slot 一起被 reparent,React 组件实例完全不感知 DOM 树位置变化。
 *   4. BlockShell + 业务组件通过 createPortal 渲染进**稳定 slot**,portal target
 *      永远是同一个 DOM 节点,根本没有 "container 切换" 这个动作 → 无任何 race。
 *
 * 为什么这比之前的 "靠 useLayoutEffect 同步 slot ref" 强:之前 anchor 就是 slot,
 * layout 重建时 anchor 整个被 React unmount + 新 anchor mount,中间 portal 内容
 * 暂时挂在已被卸载的 detached DOM 上 → 视觉上闪。现在 anchor 只是"宿主标记位",
 * 真实容器 slot DOM 永远稳定,只是被 reparent 到不同 anchor。
 */

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useCanvas } from "../../contexts/canvasContext";
import { computeAdjacency, computeRects } from "../../canvas/layoutAlgorithms";
import LayoutRenderer from "./LayoutRenderer";
import BlockShell from "./BlockShell";
import ArtifactBlock from "./ArtifactBlock";
import AgencyBlock from "../AgencyBlock";
import ChatBlock from "./ChatBlock";
import AgentBlock from "../AgentBlock";
import AdminBlock from "../AdminBlock";
import DropIndicator from "./DropIndicator";
import type { AdjacencyEdges, Block } from "../../canvas/types";
import "./MagicCanvas.css";

interface Props {
  /** 全局 active table id —— 仅 table 类型的 block 共享(V2 限制),其它类型 per-block */
  globalActiveTableId: string;
  /** Block 内 sidebar 选中 table 时,把 global active 同步过去(table render 仍走全局) */
  onPickGlobalTable: (id: string) => void;
}

export default function MagicCanvas({ globalActiveTableId, onPickGlobalTable }: Props) {
  const { state, visibleBlockIds, dragging, dropTarget } = useCanvas();
  const containerRef = useRef<HTMLDivElement>(null);

  // ─── Stable slot DOM per blockId ─────────────────────────────────────
  // 每个 blockId 一个永久 slot div,first-time lazy 创建,blockId 仍存在的
  // 期间永不销毁。Portal 把 BlockShell + 业务组件渲染进 slot,layout 变化
  // 时 useLayoutEffect 用 appendChild 把 slot move 到新 anchor 下面。
  // appendChild = DOM move(不是 remove + insert),slot 内的所有子节点
  // (含 React portal 渲染出的 BlockShell DOM)跟着一起被 reparent,React
  // 组件实例完全不动。
  const slotsRef = useRef(new Map<string, HTMLDivElement>());

  const getOrCreateSlot = (blockId: string): HTMLDivElement => {
    let slot = slotsRef.current.get(blockId);
    if (!slot) {
      slot = document.createElement("div");
      slot.dataset.mcSlot = blockId;
      // 占满父级 anchor + 自己也是 flex column —— BlockShell 的 .mc-block-shell
      // 用 flex:1 占空间,需要 slot / anchor 是 flex 容器才能让 flex:1 生效。
      // 旧架构里 BlockShell 直接是 mc-pane 的子节点,被 `.mc-pane > *` 给上
      // flex:1。现在中间多了 anchor + slot 两层,flex 链断了,BlockShell 收缩
      // 成 auto 高度 → 边框被"吞"。这里显式让 slot/anchor 都是 flex column 把
      // 链接回去。
      slot.style.cssText =
        "width:100%;height:100%;display:flex;flex-direction:column;min-width:0;min-height:0;";
      slotsRef.current.set(blockId, slot);
    }
    return slot;
  };

  // 在 commit 后、paint 前同步把每个稳定 slot 移到对应 anchor 下面。
  // useLayoutEffect 保证不在 paint 之间留下"anchor 空着 / slot 在旧位置"的
  // 中间帧,视觉上完全无感。
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const anchors = root.querySelectorAll<HTMLDivElement>("[data-mc-anchor]");
    anchors.forEach((anchor) => {
      const blockId = anchor.getAttribute("data-mc-anchor");
      if (!blockId) return;
      const slot = getOrCreateSlot(blockId);
      if (slot.parentElement !== anchor) {
        anchor.appendChild(slot); // 移动 DOM(不重建),slot 内所有节点跟随
      }
    });
  });

  // 删除已不存在的 block 的稳定 slot,避免内存累积。layout 改变(visibleBlockIds
  // 变化)时 sweep 一次。这里走 useEffect(paint 后)不影响视觉。
  useEffect(() => {
    const visible = new Set(visibleBlockIds);
    for (const [blockId, slot] of slotsRef.current.entries()) {
      if (!visible.has(blockId)) {
        slot.remove();
        slotsRef.current.delete(blockId);
      }
    }
  }, [visibleBlockIds]);

  const adjacency = useMemo(() => computeAdjacency(state.layout), [state.layout]);

  // 计算 dropTarget 对应的高亮区域(block side 模式或 canvas edge 模式)
  const dropIndicatorRect = useMemo(() => {
    if (!dropTarget || !state.layout || !containerRef.current) return null;
    const cr = containerRef.current.getBoundingClientRect();
    if (dropTarget.kind === "edge") {
      const EDGE_RATIO = 0.3;
      const w = cr.width;
      const h = cr.height;
      const thickness =
        dropTarget.edge === "top" || dropTarget.edge === "bottom" ? h * EDGE_RATIO : w * EDGE_RATIO;
      let rect: { x: number; y: number; w: number; h: number };
      switch (dropTarget.edge) {
        case "top": rect = { x: 0, y: 0, w, h: thickness }; break;
        case "bottom": rect = { x: 0, y: h - thickness, w, h: thickness }; break;
        case "left": rect = { x: 0, y: 0, w: thickness, h }; break;
        case "right": rect = { x: w - thickness, y: 0, w: thickness, h }; break;
      }
      return { rect, side: "center" as const, isEdge: true };
    }
    const rects = computeRects(state.layout, cr.width, cr.height, 0, 0);
    const r = rects[dropTarget.blockId];
    if (!r) return null;
    return { rect: r, side: dropTarget.side, isEdge: false };
  }, [dropTarget, state.layout]);

  if (!state.layout) {
    return (
      <div className="mc-canvas mc-canvas-empty">
        <p>没有 block,请通过顶栏 + 按钮新增。</p>
      </div>
    );
  }

  // Layout tree 只渲染轻量 anchor div(空标记位)。useLayoutEffect 会把对应
  // blockId 的稳定 slot DOM appendChild 进来。
  const renderLeaf = (blockId: string) => (
    <div
      key={blockId}
      data-mc-anchor={blockId}
      className="mc-portal-anchor"
      // display:flex 让里面 appendChild 进来的 slot 通过 flex 链填满高度。
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
      }}
    />
  );

  return (
    <div ref={containerRef} className={`mc-canvas${dragging ? " mc-canvas--dragging" : ""}`}>
      <LayoutRenderer node={state.layout} renderLeaf={renderLeaf} />

      {/* 扁平稳定 BlockShell 数组 —— 它们在 React tree 里位置永远不变,只是
          portal target(稳定 slot DOM)随 layout 被 reparent 到不同 anchor。
          BlockShell 这层组件实例 + state 永不重建。 */}
      {visibleBlockIds.map((blockId) => {
        const block = state.blocks[blockId];
        if (!block) return null;
        const edges = adjacency[blockId] ?? {
          top: "page", right: "page", bottom: "page", left: "page",
        };
        return (
          <PortalBlock
            key={blockId}
            slot={getOrCreateSlot(blockId)}
            blockId={blockId}
            block={block}
            edges={edges}
            visibleCount={visibleBlockIds.length}
            canvasContainerRef={containerRef}
            globalActiveTableId={globalActiveTableId}
            onPickGlobalTable={onPickGlobalTable}
          />
        );
      })}

      {dropIndicatorRect && (
        <DropIndicator
          rect={dropIndicatorRect.rect}
          side={dropIndicatorRect.isEdge ? "center" : dropIndicatorRect.side}
        />
      )}
    </div>
  );
}

/**
 * Portal-wrapped BlockShell. Slot 永远是稳定 DOM 节点(从 getOrCreateSlot 同步
 * 拿到),不会出现 null,无 first-render gap。layout 变化时 slot 被 reparent
 * (DOM-level move)到新 anchor,React 这一层完全无感。
 */
function PortalBlock(props: {
  slot: HTMLDivElement;
  blockId: string;
  block: Block;
  edges: AdjacencyEdges;
  visibleCount: number;
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  globalActiveTableId: string;
  onPickGlobalTable: (id: string) => void;
}) {
  const { slot, blockId, block, edges, visibleCount, canvasContainerRef, globalActiveTableId, onPickGlobalTable } = props;
  const { state } = useCanvas();
  return createPortal(
    <BlockShell
      blockId={blockId}
      edges={edges}
      visibleCount={visibleCount}
      canvasContainerRef={canvasContainerRef}
    >
      {block.type === "chat" && <ChatBlock blockId={blockId} />}
      {block.type === "artifact" && (
        <ArtifactBlock
          blockId={blockId}
          globalActiveTableId={globalActiveTableId}
          onPickGlobalTable={onPickGlobalTable}
        />
      )}
      {block.type === "system" && (
        (state.blockStates[blockId] as any)?.view === "admin"
          ? <AdminBlock blockId={blockId} />
          : <AgentBlock blockId={blockId} />
      )}
      {block.type === "agency" && <AgencyBlock blockId={blockId} />}
    </BlockShell>,
    slot,
  );
}
