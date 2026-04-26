/**
 * MagicCanvas —— 多 block 的可拖拽画布主体。
 * 替换原 .workspace 里的"chat-part + artifact-part"两栏布局,改为 LayoutNode 树。
 */

import { useMemo, useRef } from "react";
import { useCanvas } from "../../contexts/canvasContext";
import { computeAdjacency } from "../../canvas/layoutAlgorithms";
import LayoutRenderer from "./LayoutRenderer";
import BlockShell from "./BlockShell";
import ArtifactBlock from "./ArtifactBlock";
import ChatBlock from "./ChatBlock";
import "./MagicCanvas.css";

interface Props {
  /** 全局 active artifact id —— V1 多 artifact block 共享 */
  activeArtifactId: string;
  onSelectArtifact: (id: string, type?: import("../../types").TreeItemType) => void;
}

export default function MagicCanvas({ activeArtifactId, onSelectArtifact }: Props) {
  const { state, visibleBlockIds } = useCanvas();
  const containerRef = useRef<HTMLDivElement>(null);

  const adjacency = useMemo(() => computeAdjacency(state.layout), [state.layout]);

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
            activeArtifactId={activeArtifactId}
            onSelectArtifact={onSelectArtifact}
          />
        )}
        {block.type === "system" && (
          <div className="mc-system-placeholder">System block(敬请期待)</div>
        )}
      </BlockShell>
    );
  };

  return (
    <div ref={containerRef} className="mc-canvas">
      <LayoutRenderer node={state.layout} renderLeaf={renderLeaf} />
    </div>
  );
}
