/**
 * ChatBlockContext —— ChatBlock 的渲染门面。App.tsx 提供 render(blockId) 函数,
 * 由 App.tsx 注入(里面会渲染一份 ChatSidebar)。
 *
 * 为啥要 context?ChatSidebar 自带很多 props 和 state,直接从根 props 透到
 * MagicCanvas 太啰嗦。让 App.tsx 给一个 render 函数,canvas 层不关心细节。
 */

import { createContext, useContext, type ReactNode } from "react";

export interface ChatBlockValue {
  render: (blockId: string) => ReactNode;
}

const Ctx = createContext<ChatBlockValue | null>(null);

export function ChatBlockProvider({ value, children }: { value: ChatBlockValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChat(): ChatBlockValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useChat must be inside <ChatBlockProvider>");
  return v;
}
