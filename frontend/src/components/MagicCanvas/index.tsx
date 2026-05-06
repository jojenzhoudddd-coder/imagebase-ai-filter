/**
 * MagicCanvas —— 多 block 的可拖拽画布主体。
 * 替换原 .workspace 里的"chat-part + artifact-part"两栏布局,改为 LayoutNode 树。
 *
 * State preservation across layout changes (Solution A · Portal-based rendering)
 * ─────────────────────────────────────────────────────────────────────────────
 * 问题:LayoutNode 是二叉树,关闭/新增/移动 block 会让某个 block 在 React tree
 * 里的祖先链发生变化(SplitNode 节点出现 / 消失),即使 BlockShell 用 key={blockId},
 * React 跨 parent 不能保住组件身份,会 unmount + remount。后果:ChatSidebar 内
 * 的 streaming / messages / cancelRef 等 useState/useRef 全丢,正在 stream 的
 * turn 看起来"消失"。
 *
 * 解法:把 BlockShell 全部塞进 MagicCanvas 顶层一个**扁平稳定数组** —— 它们
 * 永远是 MagicCanvas 这个组件的直接子节点,React tree 位置不动。LayoutRenderer
 * 只负责渲染**空 slot div**,BlockShell 通过 createPortal 投到对应 slot。
 *
 * 关键时序:
 *   1. visibleBlockIds 或 layout 改变 → MagicCanvas 重渲
 *   2. LayoutRenderer 重建 slot div(旧 div 卸载,新 div 挂载) → ref 回调更新
 *   3. useLayoutEffect 在 commit 后、paint 前同步触发 bumpSlots
 *   4. 第二次 render → BlockShell 数组的 createPortal 用新 slot,React 把
 *      portal children 在 DOM 层"移动"到新容器(组件实例不变,state 保留)
 *
 * 第一帧 slot 还没 attach 时,PortalBlock 返回 null —— BlockShell 这时确实
 * 还没 mount。但这只发生在 MagicCanvas 自己第一次 mount,后续任何 layout 变化,
 * BlockShell 已经存在,只是被 portal 移到不同 DOM 节点,state 全保。
 */

import { createPortal } from "react-dom";
import { useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { useCanvas } from "../../contexts/canvasContext";
import { computeAdjacency, computeRects } from "../../canvas/layoutAlgorithms";
import LayoutRenderer from "./LayoutRenderer";
import BlockShell from "./BlockShell";
import ArtifactBlock from "./ArtifactBlock";
import AgencyBlock from "../AgencyBlock";
import ChatBlock from "./ChatBlock";
import AgentBlock from "../AgentBlock";
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

  // ─── Portal slot tracking ────────────────────────────────────────────
  // slotsRef 是 blockId → slot DOM 的 map,LayoutRenderer 每次 commit 后通过
  // useLayoutEffect 用 querySelectorAll 一次性同步(不在 ref callback 里更新,
  // 避免 ref callback 闭包 over blockId 引发的 spurious unmount-mount 抖动)。
  const slotsRef = useRef<Record<string, HTMLDivElement | null>>({});
  // bumpSlots 强制 MagicCanvas 第二次 render —— 让 PortalBlock 看到最新 slot
  // 节点。在 useLayoutEffect 里调,paint 前同步完成,无可见闪烁。
  const [, bumpSlots] = useReducer((x: number) => x + 1, 0);

  useLayoutEffect(() => {
    // 在 layout 树或 block 列表变化后的 commit 阶段,同步抓取所有 slot DOM。
    // 用 data-block-id selector 而不是 ref callback —— ref callback 每次 render
    // 都换新函数,会引起卸载-重挂,失去稳定性。
    const root = containerRef.current;
    if (!root) return;
    const next: Record<string, HTMLDivElement | null> = {};
    root.querySelectorAll<HTMLDivElement>("[data-mc-slot]").forEach((el) => {
      const id = el.getAttribute("data-mc-slot");
      if (id) next[id] = el;
    });
    slotsRef.current = next;
    bumpSlots();
  }, [state.layout, visibleBlockIds.length]);

  const adjacency = useMemo(() => computeAdjacency(state.layout), [state.layout]);

  // 计算 dropTarget 对应的高亮区域(block side 模式或 canvas edge 模式)
  const dropIndicatorRect = useMemo(() => {
    if (!dropTarget || !state.layout || !containerRef.current) return null;
    const cr = containerRef.current.getBoundingClientRect();
    if (dropTarget.kind === "edge") {
      // 整个 canvas 沿该边的一条 30% 厚带
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

  // Layout tree 只渲染空 slot div(不渲染 BlockShell)。slot 用 data 属性
  // 标识 blockId,useLayoutEffect 通过 querySelector 收集到 slotsRef。
  const renderLeaf = (blockId: string) => (
    <div
      key={blockId}
      data-mc-slot={blockId}
      className="mc-portal-slot"
      style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
    />
  );

  return (
    <div ref={containerRef} className={`mc-canvas${dragging ? " mc-canvas--dragging" : ""}`}>
      <LayoutRenderer node={state.layout} renderLeaf={renderLeaf} />

      {/* 扁平稳定 BlockShell 数组 —— 不论 layout tree 怎么变,这些组件在
          MagicCanvas 这个 React 组件下的位置永远不动,所以 useState / useRef
          全保。只有它们 portal 的目标 DOM 节点会跟着 layout 走。 */}
      {visibleBlockIds.map((blockId) => {
        const block = state.blocks[blockId];
        if (!block) return null;
        const slot = slotsRef.current[blockId];
        const edges = adjacency[blockId] ?? {
          top: "page", right: "page", bottom: "page", left: "page",
        };
        return (
          <PortalBlock
            key={blockId}
            slot={slot}
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
 * Portal-wrapped BlockShell. 在 MagicCanvas 里位置稳定,只是它的 portal
 * 目标随 layout 变化。注意 slot 可能 null(MagicCanvas 第一次 mount 时,
 * useLayoutEffect 还没来得及收集 slot DOM)—— 这时不渲染,等下一帧。
 */
function PortalBlock(props: {
  slot: HTMLDivElement | null;
  blockId: string;
  block: Block;
  edges: AdjacencyEdges;
  visibleCount: number;
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  globalActiveTableId: string;
  onPickGlobalTable: (id: string) => void;
}) {
  const { slot, blockId, block, edges, visibleCount, canvasContainerRef, globalActiveTableId, onPickGlobalTable } = props;
  if (!slot) return null;
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
      {block.type === "system" && <AgentBlock blockId={blockId} />}
      {block.type === "agency" && <AgencyBlock blockId={blockId} />}
    </BlockShell>,
    slot,
  );
}
