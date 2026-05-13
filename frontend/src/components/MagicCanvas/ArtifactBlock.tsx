/**
 * ArtifactBlock —— per-block sidebar + per-block 渲染。
 *
 * V2: 每个 block 有自己的 active artifact (在 blockState.active),sidebar 高亮独立。
 *
 * 渲染策略:
 *   - active.type ∈ {"idea","design","demo"} → 直接 mount 对应自包含组件
 *     (IdeaEditor / SvgCanvas / DemoPreviewPanel),N 个 block 完全独立。
 *   - active.type === "table" → 走 ArtifactViewContext 的 global render()
 *     (V2 限制:table 的 fields/records/filter/undo state 仍住 App.tsx,
 *     多 block 共享同一张表)。clicking table 在某 block 同时更新 global
 *     activeTableId,确保该 block 渲染对应表内容。
 *   - active null:空状态提示。
 *
 * sidebar:
 *   - ResizeObserver 监听自己宽度,< 400px sidebar 强制收起(覆盖用户偏好)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../contexts/workspaceContext";
import { useCanvas } from "../../contexts/canvasContext";
import { useAuth } from "../../auth/AuthContext";
import { createConversation } from "../../api";
import { SidebarToggleProvider } from "../../contexts/sidebarToggleContext";
import Sidebar from "../Sidebar";
import IdeaEditor from "../IdeaEditor/index";
import SvgCanvas from "../SvgCanvas/index";
import DemoPreviewPanel from "../DemoPreviewPanel/index";
import TableArtifactSurface from "../TableArtifactSurface/index";
import { CLIENT_ID } from "../../api";
import type { ArtifactBlockState, ArtifactKind } from "../../canvas/types";
import type { TreeItemType } from "../../types";
import { useTranslation } from "../../i18n/index";

const AUTO_COLLAPSE_THRESHOLD_PX = 400;

interface Props {
  blockId: string;
  /** 全局 active artifact id —— 仅用于 table 类型(V2 共享)。其它类型 block 走自己的 active。 */
  globalActiveTableId: string;
  /** 用户在 block 内 sidebar 点击 table 类型时,把 global active 同步过去 */
  onPickGlobalTable: (id: string) => void;
}

/** TreeItemType → ArtifactKind(只有 table/idea/design/demo 是有效 artifact) */
function toArtifactKind(t: TreeItemType | undefined): ArtifactKind | null {
  if (t === "table" || t === "idea" || t === "design" || t === "demo") return t;
  return null;
}

export default function ArtifactBlock({ blockId, globalActiveTableId, onPickGlobalTable }: Props) {
  const ws = useWorkspace();
  const { state, patchBlockState, hydrated, addBlock } = useCanvas();
  const { workspaceId, agentId } = useAuth();
  const { t } = useTranslation();

  const blockState = (state.blockStates[blockId] ?? {}) as ArtifactBlockState;
  // 真正在使用的 active —— 完全 per-block,不再 fallback 到 global。
  // 仅在 block 首次创建(active 还是 null/undefined)时一次性 seed 进 global 当前选中的 table。
  // 以后用户在该 block 切换 artifact 都只更新 blockState.active,不影响其它 block。
  const active = blockState.active ?? null;

  // Seed 一次:如果 blockState.active 从未被设置(刚创建的 artifact block),
  // 把 global activeTableId 作为初始值持久化到 blockState。这样后续 global 变化
  // 不会再透传过来,真正实现 "table 切换不会一起切换" 的隔离。
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (blockState.active) {
      seededRef.current = true;
      return;
    }
    if (globalActiveTableId) {
      patchBlockState(blockId, { active: { type: "table", id: globalActiveTableId } });
      seededRef.current = true;
    }
  }, [blockId, blockState.active, globalActiveTableId, patchBlockState]);

  // React to workspace-level deletions: if this block's active artifact is
  // no longer in sidebarItems, navigate to the nearest remaining artifact.
  useEffect(() => {
    if (!active) return;
    const stillExists = ws.sidebarItems.some(s => s.id === active.id);
    if (stillExists) return;
    // Active was deleted — pick nearest remaining non-folder item
    const remaining = ws.sidebarItems.filter(s => s.type !== "folder");
    if (remaining.length === 0) {
      patchBlockState(blockId, { active: null as any });
      return;
    }
    // Use lastDeleted hint if available, otherwise pick first remaining
    const del = ws.lastDeleted;
    if (del && del.id === active.id && del.nextId && del.nextType) {
      const kind = toArtifactKind(del.nextType);
      if (kind) {
        patchBlockState(blockId, { active: { type: kind, id: del.nextId } });
        return;
      }
    }
    const pick = remaining[0];
    const kind = toArtifactKind(pick.type as TreeItemType);
    if (kind) {
      patchBlockState(blockId, { active: { type: kind, id: pick.id } });
    }
  }, [ws.sidebarItems, active, blockId, patchBlockState, ws.lastDeleted]);

  // hydration 未完成前忽略 localStorage 的 stale 偏好,默认展开 sidebar,
  // 避免 server preferences 尚未加载时 sidebar 闪现收起状态。
  const userCollapsed = hydrated ? (blockState.sidebarCollapsedPreference ?? false) : false;

  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(800);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const tooNarrow = width < AUTO_COLLAPSE_THRESHOLD_PX;
  const effectiveCollapsed = userCollapsed || tooNarrow;

  const handleCollapse = () => {
    patchBlockState(blockId, { sidebarCollapsedPreference: true });
  };

  // Wrap create callbacks to auto-activate the new item in this block
  const handleCreateBlank = useCallback(async (): Promise<string> => {
    const id = await ws.onCreateBlank();
    patchBlockState(blockId, { active: { type: "table", id } });
    onPickGlobalTable(id);
    return id;
  }, [ws.onCreateBlank, blockId, patchBlockState, onPickGlobalTable]);

  const handleCreateDesign = useCallback(async (name: string, figmaUrl?: string): Promise<string> => {
    if (!ws.onCreateDesign) throw new Error("onCreateDesign not available");
    const id = await ws.onCreateDesign(name, figmaUrl);
    patchBlockState(blockId, { active: { type: "design", id } });
    return id;
  }, [ws.onCreateDesign, blockId, patchBlockState]);

  const handleCreateIdea = useCallback(async (): Promise<string> => {
    if (!ws.onCreateIdea) throw new Error("onCreateIdea not available");
    const id = await ws.onCreateIdea();
    patchBlockState(blockId, { active: { type: "idea", id } });
    return id;
  }, [ws.onCreateIdea, blockId, patchBlockState]);

  const handleCreateDemo = useCallback(async (): Promise<string> => {
    if (!ws.onCreateDemo) throw new Error("onCreateDemo not available");
    const id = await ws.onCreateDemo();
    patchBlockState(blockId, { active: { type: "demo", id } });
    return id;
  }, [ws.onCreateDemo, blockId, patchBlockState]);

  const handleCreateByAI = useCallback(async () => {
    const prefillMessage = t("createMenu.aiCreatePrompt");
    let conv: { id: string } | null = null;
    if (workspaceId) {
      try {
        conv = await createConversation(workspaceId, agentId || undefined);
      } catch { /* ignore */ }
    }
    addBlock("chat", conv
      ? { conversationId: conv.id, prefillMessage } as any
      : { prefillMessage } as any
    );
  }, [workspaceId, agentId, addBlock, t]);

  const handleSelectItem = useCallback(
    (id: string, type?: TreeItemType) => {
      const kind = toArtifactKind(type);
      if (!kind) return;
      patchBlockState(blockId, { active: { type: kind, id } });
      // 同步 global —— 仅用于跨组件 (TopBar tableName / AI 工具引用) 仍依赖
      // App-level activeTableId 的场景。不会反向影响其它 block 的渲染,因为
      // 各 block 现在直接从 blockState.active 读、不再 fallback。
      if (kind === "table") {
        onPickGlobalTable(id);
      }
    },
    [blockId, patchBlockState, onPickGlobalTable],
  );

  // 渲染 artifact 内容 —— 按 active.type 选择独立 mount or fallback 到 global render()
  const artifactContent = useMemo(() => {
    if (!active) {
      return <div className="mc-artifact-empty" />;
    }
    if (active.type === "idea") {
      const idea = ws.ideas.find((x) => x.id === active.id);
      // V2.9.3: 不渲染"已不存在"文字,留空 div 占位即可。多数情况是删除后
      // sidebar 切到下一个 artifact 就直接换走,留页面就一闪而过的现象就更轻量了。
      if (!idea) return <div className="mc-artifact-empty" />;
      return (
        <IdeaEditor
          key={active.id}
          ideaId={active.id}
          ideaName={idea.name}
          workspaceId={ws.workspaceId}
          clientId={CLIENT_ID}
          onRename={(name) => ws.onRenameItem(active.id, name)}
          onNavigate={() => { /* mention 跳转 V2 再接入 magic canvas focus 逻辑 */ }}
        />
      );
    }
    if (active.type === "design") {
      const design = ws.designs.find((x) => x.id === active.id);
      if (!design) return <div className="mc-artifact-empty" />;
      return (
        <SvgCanvas
          key={active.id}
          designId={active.id}
          designName={design.name}
          workspaceId={ws.workspaceId}
          onRename={(name) => ws.onRenameItem(active.id, name)}

        />
      );
    }
    if (active.type === "demo") {
      const demo = ws.demos.find((x) => x.id === active.id);
      if (!demo) return <div className="mc-artifact-empty" />;
      return <DemoPreviewPanel key={active.id} demoId={active.id} workspaceId={ws.workspaceId} />;
    }
    // table V2:每个 block 使用一个独立的 TableArtifactSurface,自管 fields /
    // records / filter / undo / SSE。N 个 block 完全独立,互不切换。
    if (active.type === "table") {
      return (
        <TableArtifactSurface
          key={active.id}
          tableId={active.id}
          workspaceId={ws.workspaceId}
          onRename={(name) => ws.onRenameItem(active.id, name)}
        />
      );
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.type, ws.ideas, ws.designs, ws.demos, ws.workspaceId]);

  // per-block SidebarToggleProvider —— 让 artifact topbar 里的 SidebarExpandButton
  // 读取这个 block 的 collapsed 状态(原 App-level 全局 SidebarToggleProvider 不再
  // 反映 per-block 状态)。effectiveCollapsed 既包含用户偏好也包含宽度阈值。
  const sidebarToggleValue = useMemo(
    () => ({
      collapsed: effectiveCollapsed,
      onToggle: () => {
        // 用户主动 toggle —— 反转 sidebarCollapsedPreference
        patchBlockState(blockId, { sidebarCollapsedPreference: !userCollapsed });
      },
      expandTitle: t("sidebar.expand"),
    }),
    [effectiveCollapsed, userCollapsed, blockId, patchBlockState, t],
  );

  return (
    <SidebarToggleProvider value={sidebarToggleValue}>
    <div className="mc-artifact-block" ref={containerRef}>
      {!effectiveCollapsed && (
        <div className="mc-artifact-sidebar">
          <Sidebar
            items={ws.sidebarItems}
            onRenameItem={ws.onRenameItem}
            activeItemId={active?.id ?? ""}
            onSelectItem={handleSelectItem}
            onReorderItems={ws.onReorderItems}
            onDeleteTable={ws.onDeleteTable}
            tableCount={ws.tableCount}
            onCreateWithAI={ws.onCreateWithAI}
            onResetToDefault={ws.onResetToDefault}
            onCreateBlank={handleCreateBlank}
            folders={ws.folders.map((f) => ({ id: f.id, name: f.name }))}
            onCreateFolder={ws.onCreateFolder}
            onCreateDesign={handleCreateDesign}
            onCreateIdea={handleCreateIdea}
            onCreateDemo={handleCreateDemo}
            onDeleteItem={ws.onDeleteItem}
            onMoveItem={ws.onMoveItem}
            onCreateByAI={handleCreateByAI}
            onCollapse={handleCollapse}
            width={blockState.sidebarWidth ?? 200}
            onWidthChange={(w) => patchBlockState(blockId, { sidebarWidth: w })}
          />
        </div>
      )}
      <div className="mc-artifact-content">{artifactContent}</div>
    </div>
    </SidebarToggleProvider>
  );
}
