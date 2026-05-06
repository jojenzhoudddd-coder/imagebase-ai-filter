/**
 * MagicCanvas —— 多 block 的可拖拽画布主体。
 * 替换原 .workspace 里的"chat-part + artifact-part"两栏布局,改为 LayoutNode 树。
 *
 * Block 生命周期保护：所有 block 都渲染在一个扁平的稳定容器里（keyed by blockId），
 * LayoutRenderer 只渲染空的占位 div，block 通过 React portal 投射进去。
 * 这样关闭任意 block 导致的 layout tree 重构不会 unmount/remount 其他 block，
 * 保护了 prefillMessage、SSE 连接等组件内部状态。
 */

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCanvas } from "../../contexts/canvasContext";
import { computeAdjacency, computeRects } from "../../canvas/layoutAlgorithms";
import LayoutRenderer from "./LayoutRenderer";
import BlockShell from "./BlockShell";
import ArtifactBlock from "./ArtifactBlock";
import AgencyBlock from "../AgencyBlock";
import ChatBlock from "./ChatBlock";
import AgentBlock from "../AgentBlock";
import DropIndicator from "./DropIndicator";
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

  const adjacency = useMemo(() => computeAdjacency(state.layout), [state.layout]);

  // ─── Portal slots: layout tree renders empty divs, blocks portal into them ──
  const slotRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Force re-render after layout changes so portals can find their new slots
  const [, setSlotTick] = useState(0);
  useEffect(() => { setSlotTick((t) => t + 1); }, [state.layout]);

  const setSlotRef = useCallback((blockId: string) => (el: HTMLDivElement | null) => {
    slotRefs.current[blockId] = el;
  }, []);

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

  // Layout tree only renders empty slot divs — blocks are portaled in below.
  const renderLeaf = (blockId: string) => {
    return (
      <div
        key={blockId}
        ref={setSlotRef(blockId)}
        className="mc-portal-slot"
        style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
      />
    );
  };

  return (
    <div ref={containerRef} className={`mc-canvas${dragging ? " mc-canvas--dragging" : ""}`}>
      <LayoutRenderer node={state.layout} renderLeaf={renderLeaf} />

      {/* Stable flat container — blocks are keyed by blockId and never remount
          due to layout tree restructuring. They portal into the slot divs above. */}
      {visibleBlockIds.map((blockId) => {
        const block = state.blocks[blockId];
        if (!block) return null;
        const edges = adjacency[blockId] ?? { top: "page", right: "page", bottom: "page", left: "page" };
        const slot = slotRefs.current[blockId];

        const content = (
          <BlockShell
            key={blockId}
            blockId={blockId}
            edges={edges}
            visibleCount={visibleBlockIds.length}
            canvasContainerRef={containerRef}
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
          </BlockShell>
        );

        // Portal into the layout slot if available; otherwise render hidden
        // (first render tick before refs are set)
        if (slot) return createPortal(content, slot);
        return null;
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
