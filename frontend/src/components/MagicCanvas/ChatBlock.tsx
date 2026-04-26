/**
 * ChatBlock —— 包装现有 ChatSidebar。
 *
 * V1: 多个 chat block 都展示同一个 agent 的 active conversation(共享后端
 * conversation state,SSE 自动同步)。等同于"打开多个浏览器 tab 看同一对话"。
 *
 * 未来:chat 内部支持多会话(per-block conversationId),canvas 层不需要改。
 */

import { useChat } from "../../contexts/chatBlockContext";

export default function ChatBlock({ blockId }: { blockId: string }) {
  const chat = useChat();
  return <div className="mc-chat-block-inner">{chat.render(blockId)}</div>;
}
