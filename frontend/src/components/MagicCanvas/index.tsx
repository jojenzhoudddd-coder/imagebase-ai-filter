/**
 * MagicCanvas —— 多 block 的可拖拽画布主体。
 * 替换原 .workspace 里的"chat-part + artifact-part"两栏布局,改为 LayoutNode 树。
 */

import { useMemo, useRef } from "react";
import { useCanvas } from "../../contexts/canvasContext";
import { computeAdjacency, computeRects } from "../../canvas/layoutAlgorithms";
import LayoutRenderer from "./LayoutRenderer";
import BlockShell from "./BlockShell";
import ArtifactBlock from "./ArtifactBlock";
import ChatBlock from "./ChatBlock";
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

  const renderLeaf = (blockId: string) => {
    const block = state.blocks[blockId];
    if (!block) return null;
    const edges = adjacency[blockId] ?? { top: "page", right: "page", bottom: "page", left: "page" };
    return (
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
        {block.type === "system" && (
          <div className="mc-system-placeholder">System block(敬请期待)</div>
        )}
      </BlockShell>
    );
  };

  return (
    <div ref={containerRef} className={`mc-canvas${dragging ? " mc-canvas--dragging" : ""}`}>
      <LayoutRenderer node={state.layout} renderLeaf={renderLeaf} />
      {dropIndicatorRect && (
        <DropIndicator
          rect={dropIndicatorRect.rect}
          side={dropIndicatorRect.isEdge ? "center" : dropIndicatorRect.side}
        />
      )}
    </div>
  );
}
