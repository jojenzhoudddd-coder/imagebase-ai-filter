/**
 * ArtifactBlock —— sidebar(per-block) + artifact view(全局 active 共享 V1)。
 *
 * 内置 ResizeObserver 监听自己宽度,< 400px 时 sidebar 强制收起(覆盖用户偏好);
 * ≥ 400px 时尊重用户偏好(默认展开)。
 *
 * sidebar 数据从 WorkspaceContext 读;ActiveArtifact 切换走 onSelectItem
 * 回调,App.tsx 接住后改全局 activeTableId(V1 多 artifact block 共享)。
 */

import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../../contexts/workspaceContext";
import { useArtifactView } from "../../contexts/artifactViewContext";
import { useCanvas } from "../../contexts/canvasContext";
import Sidebar from "../Sidebar";
import type { ArtifactBlockState } from "../../canvas/types";

const AUTO_COLLAPSE_THRESHOLD_PX = 400;

interface Props {
  blockId: string;
  /** 全局 active artifact id,V1 共享 */
  activeArtifactId: string;
  /** 用户在 sidebar 点击时,回调到 App.tsx 切换全局 active */
  onSelectArtifact: (id: string, type?: import("../../types").TreeItemType) => void;
}

export default function ArtifactBlock({ blockId, activeArtifactId, onSelectArtifact }: Props) {
  const ws = useWorkspace();
  const av = useArtifactView();
  const { state, patchBlockState } = useCanvas();

  const blockState = (state.blockStates[blockId] ?? {}) as ArtifactBlockState;
  const userCollapsed = blockState.sidebarCollapsedPreference ?? false;

  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(800);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const tooNarrow = width < AUTO_COLLAPSE_THRESHOLD_PX;
  const effectiveCollapsed = userCollapsed || tooNarrow;

  const handleCollapse = () => {
    // 用户主动点击收起按钮 → 写偏好
    patchBlockState(blockId, { sidebarCollapsedPreference: true });
  };

  // 注:展开按钮在 artifact topbar 里 —— SidebarToggleProvider 的 onToggle
  // 由 App 注入(对每个 block 不同)。这里通过 patchBlockState 实现。
  // 为了不引入 per-block SidebarToggleProvider(否则每个 block 都得包一层),
  // V1 简化:用户点 artifact 内的"展开 sidebar"按钮(目前只在 sidebar 收起
  // 才显示)就改写偏好。展开按钮的实际逻辑见 ArtifactView 内的 SidebarExpandButton。
  // (V1 因为多 artifact block 共享一个 SidebarToggleProvider,展开按钮全局
  //  控制 —— 暂时让用户用每个 block 的 close-sidebar 按钮关,要展开就拖宽
  //  block 或刷新。这是 V1 已知 limitation。)

  return (
    <div className="mc-artifact-block" ref={containerRef}>
      {!effectiveCollapsed && (
        <div className="mc-artifact-sidebar" style={{ width: blockState.sidebarWidth ?? 190 }}>
          <Sidebar
            items={ws.sidebarItems}
            onRenameItem={ws.onRenameItem}
            activeItemId={activeArtifactId}
            onSelectItem={onSelectArtifact}
            onReorderItems={ws.onReorderItems}
            onDeleteTable={ws.onDeleteTable}
            tableCount={ws.tableCount}
            onCreateWithAI={ws.onCreateWithAI}
            onResetToDefault={ws.onResetToDefault}
            onCreateBlank={ws.onCreateBlank}
            folders={ws.folders.map((f) => ({ id: f.id, name: f.name }))}
            onCreateFolder={ws.onCreateFolder}
            onCreateDesign={ws.onCreateDesign}
            onCreateIdea={ws.onCreateIdea}
            onDeleteItem={ws.onDeleteItem}
            onMoveItem={ws.onMoveItem}
            onCollapse={handleCollapse}
          />
        </div>
      )}
      <div className="mc-artifact-content">{av.render()}</div>
    </div>
  );
}
