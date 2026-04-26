/**
 * WorkspaceContext —— 把 App.tsx 现有的 workspace 全局状态(sidebar items / 各类
 * artifact 列表 / CRUD handlers)提升到 context,让多个 ArtifactBlock 内嵌的
 * sidebar 共享同一个数据源。
 *
 * 数据流:
 *   - 单一订阅: useWorkspaceSync 仍在 App.tsx 跑,只 1 个 SSE 连接
 *   - 单一 state: documentTables/Ideas/Designs/Demos/Folders 仍住 App.tsx
 *   - 通过 Provider value 暴露给 N 个 sidebar
 *   - 任何 CRUD 通过 Context.actions 触发,App.tsx 内部仍写后端
 *   - SSE 回声 → App state 更新 → 所有 sidebar 自动重渲染(React 默认)
 */

import { createContext, useContext, type ReactNode } from "react";
import type { TreeItemType, IdeaBrief } from "../types";
import type { SidebarItem } from "../components/Sidebar";
import type { FolderBrief, DesignBrief, GeneratedField } from "../api";

export interface WorkspaceContextValue {
  workspaceId: string;
  sidebarItems: SidebarItem[];
  folders: FolderBrief[];
  designs: DesignBrief[];
  ideas: IdeaBrief[];
  demos: Array<{ id: string; name: string; parentId: string | null; order: number }>;
  tableCount: number;

  // Actions(CRUD) —— 由 App.tsx 注入,实现里调后端 API
  onRenameItem: (id: string, name: string) => void;
  onDeleteTable: (id: string) => void;
  onDeleteItem?: (id: string, type: TreeItemType) => void;
  onCreateBlank: () => Promise<void>;
  onCreateWithAI: (name: string, fields: GeneratedField[]) => Promise<string>;
  onResetToDefault: (tableId: string, name: string) => Promise<void>;
  onCreateFolder?: () => void;
  onCreateDesign?: (name: string, figmaUrl?: string) => Promise<string>;
  onCreateIdea?: () => Promise<string>;
  onMoveItem?: (
    id: string,
    type: "table" | "folder" | "design" | "idea" | "demo",
    newParentId: string | null,
  ) => void;
  onReorderItems: (
    updates: Array<{ id: string; type: TreeItemType; order: number }>,
  ) => void;

  /** 让 ArtifactBlock 内 sidebar 切换 active artifact 时调用,App.tsx 不直接管 */
  // (active state 由每个 block 自己管,不在 context 里)
}

const Ctx = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceContextValue;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return v;
}
