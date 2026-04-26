/**
 * BlockShellContext —— BlockShell 把"我能不能被关闭 + 怎么关"暴露给内部 artifact /
 * chat 的 topbar,让它们用自己的按钮风格在自己的 topbar 内渲染 X(而不是 BlockShell
 * 在 absolute 角上贴一个外挂按钮)。
 *
 * 用法:在每个 artifact 的 topbar(table-topbar / idea-editor-topbar / 等)末尾
 * 渲染 <BlockCloseButton />,只在 ctx 提示 canClose 时画出。
 */

import { createContext, useContext, type ReactNode } from "react";

export interface BlockShellContextValue {
  canClose: boolean;
  onClose: () => void;
}

const Ctx = createContext<BlockShellContextValue | null>(null);

export function BlockShellProvider({
  value,
  children,
}: {
  value: BlockShellContextValue;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 不在 BlockShell 内部时返回 null —— 渲染按钮的组件可安全调,无 provider 时不画 */
export function useBlockShell(): BlockShellContextValue | null {
  return useContext(Ctx);
}
