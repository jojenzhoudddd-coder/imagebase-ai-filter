/**
 * SidebarToggleContext —— App.tsx 把 sidebar 的 collapse 状态 + 切换函数注入,
 * 各个 artifact 的 topbar（Toolbar / IdeaEditor / SvgCanvas / DemoPreviewPanel）
 * 通过 useSidebarToggle 订阅,在 title 左边渲染 <SidebarExpandButton>（仅 collapsed
 * 时显示）。
 *
 * 用 Context 而不是 props 是因为 4 个 artifact topbar 彼此独立,plumb 4 套 props
 * 太啰嗦,而 collapse 状态属于 workspace 层面,context 是合适的抽象。
 */

import { createContext, useContext, type ReactNode } from "react";

interface SidebarToggleValue {
  collapsed: boolean;
  onToggle: () => void;
  expandTitle: string;
}

const Ctx = createContext<SidebarToggleValue | null>(null);

export function SidebarToggleProvider({ value, children }: { value: SidebarToggleValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSidebarToggle(): SidebarToggleValue | null {
  return useContext(Ctx);
}
