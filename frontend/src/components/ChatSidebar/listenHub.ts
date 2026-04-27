/**
 * V3.0.2 ListenHub —— 同 conv 共享一个 EventSource。
 *
 * 现象:多个 chat block 同时打开同一个 (或不同) 对话时,每个 block 自己起
 * 一个 GET /listen EventSource。浏览器对单 origin 的并发连接数 cap ~6,
 * 加上 workspace SSE / table SSE 很容易撑爆,后续 GET /conversations 等
 * 普通 fetch 排队等不到 slot,UI 表现为"列表加载不出来"。
 *
 * 解法:每个 (workspaceId, convId) 只起一个 EventSource,内部 fan-out 给
 * 任意多个订阅者。最后一个订阅者退订时关掉 ES。
 */

import { subscribeChatListen } from "../../api";

type Handlers = Parameters<typeof subscribeChatListen>[1];
type Listener = (eventName: string, data: any) => void;

interface HubEntry {
  listeners: Set<Listener>;
  off: () => void;
}

const hub = new Map<string, HubEntry>();

/**
 * 订阅指定 conversation 的 chat 事件。返回 cleanup 函数。
 *
 * 多次订阅同一 convId 共享一个底层 EventSource。最后一个订阅者退出时关掉。
 */
export function listenChatShared(
  convId: string,
  handlers: Handlers,
): () => void {
  // 把 handlers 折叠成 onEvent fan-out
  const fanOut: Listener = (eventName, data) => {
    switch (eventName) {
      case "message_persisted": handlers.onMessagePersisted?.(data); break;
      case "turn_pending": handlers.onTurnPending?.(data); break;
      case "branch_started": handlers.onBranchStarted?.(data); break;
      case "branch_finished": handlers.onBranchFinished?.(data); break;
      case "turn_promoted": handlers.onTurnPromoted?.(data); break;
      case "synth_started": handlers.onSynthStarted?.(data); break;
      case "synth_message_delta":
      case "synth_thinking_delta": handlers.onSynthDelta?.(data); break;
      case "synth_finished": handlers.onSynthFinished?.(data); break;
      case "error": handlers.onError?.(data); break;
      case "connected": handlers.onConnected?.(data); break;
      default: handlers.onEvent?.(eventName, data); break;
    }
  };

  let entry = hub.get(convId);
  if (!entry) {
    const listeners = new Set<Listener>();
    // 启动底层 ES,fan-out 给所有 listeners
    const off = subscribeChatListen(convId, {
      onMessagePersisted: (d) => listeners.forEach((l) => l("message_persisted", d)),
      onTurnPending: (d) => listeners.forEach((l) => l("turn_pending", d)),
      onBranchStarted: (d) => listeners.forEach((l) => l("branch_started", d)),
      onBranchFinished: (d) => listeners.forEach((l) => l("branch_finished", d)),
      onTurnPromoted: (d) => listeners.forEach((l) => l("turn_promoted", d)),
      onSynthStarted: (d) => listeners.forEach((l) => l("synth_started", d)),
      onSynthDelta: (d) => listeners.forEach((l) => l("synth_message_delta", d)),
      onSynthFinished: (d) => listeners.forEach((l) => l("synth_finished", d)),
      onError: (d) => listeners.forEach((l) => l("error", d)),
      onConnected: (d) => listeners.forEach((l) => l("connected", d)),
      onEvent: (name, d) => listeners.forEach((l) => l(name, d)),
    });
    entry = { listeners, off };
    hub.set(convId, entry);
  }

  entry.listeners.add(fanOut);

  return () => {
    const e = hub.get(convId);
    if (!e) return;
    e.listeners.delete(fanOut);
    if (e.listeners.size === 0) {
      e.off();
      hub.delete(convId);
    }
  };
}
