/**
 * ArtifactViewContext —— Magic Canvas V1 的"artifact 渲染层"门面。
 *
 * V1 限制（time-bound 决策）:
 *   App.tsx 维护单一 active artifact + 完整 fields / records / filter / undo /
 *   editing state(整张表的状态),为支持"任意一个 block 内部切换 artifact"
 *   把这堆 state 搬到 per-block 是一次极大的重构(per-tableId hook + 独立
 *   undo stack)。V1 简化:多个 artifact block 共享同一个 active artifact,
 *   用户在任何一个 block 的 sidebar 里切,所有 artifact block 同步切换。
 *
 *   下一版可以做:把 active state 提到 per-block,把 table 数据 / filter
 *   state 抽到 useArtifactData(tableId) hook,各 block 独立。
 *
 * 为什么用 context 而非直接 props:多个 ArtifactBlock 实例都要一份完整的
 * artifact 渲染节点(sidebar+toolbar+view+panel+...),用 context 让它们都能
 * 直接 mount 一份 ArtifactSurface 而不必从根 props 一层层透传。
 */

import { createContext, useContext, type ReactNode } from "react";

/**
 * 这个 context 就是把 App.tsx 渲染 artifact 区域所需的全部 props 都放进来,
 * 由 App.tsx 注入。ArtifactBlock 内 ArtifactSurface 调用 useArtifactView()
 * 拿到这堆 props 直接渲染。
 *
 * 类型故意宽松(unknown),避免与 App 内部类型环 dependency。具体形状由
 * ArtifactSurface.tsx 内部 cast 使用。
 */
export interface ArtifactViewValue {
  /** 渲染整个 artifact 区域(toolbar + view + panel)的函数 —— 由 App.tsx 提供 */
  render: () => ReactNode;
}

const Ctx = createContext<ArtifactViewValue | null>(null);

export function ArtifactViewProvider({ value, children }: { value: ArtifactViewValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useArtifactView(): ArtifactViewValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useArtifactView must be inside <ArtifactViewProvider>");
  return v;
}
