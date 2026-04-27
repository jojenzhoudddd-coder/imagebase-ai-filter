/**
 * V3.0 PR3: in-process pub/sub for chat events.
 *
 * 用途:多个 chat block 同时打开同一个 conversation 时,需要 push 到所有
 * passive listener。chatRoutes.POST /messages 走 fetch SSE 直接返给发起方,
 * 同时 publishChatEvent(convId, ev) 把事件 fan out 到 chatPubsub,旁观方通
 * 过 GET /conversations/:id/listen 订阅。
 *
 * 限制:in-memory,只在单实例内同步。多 region 上线时改 Redis pubsub。
 *
 * 失活清理:最后一个 listener unsubscribe 时,自动从 Map 删除该 convId 的
 * Set,防止内存泄漏。
 */

export interface ChatPubsubEvent {
  event: string;       // SSE event name (e.g. "message_persisted", "branch_started")
  data: unknown;       // event data payload
}

type Listener = (ev: ChatPubsubEvent) => void;

const buses = new Map<string, Set<Listener>>();

/** Push an event to all subscribed listeners of a conversation. */
export function publishChatEvent(convId: string, ev: ChatPubsubEvent): void {
  const set = buses.get(convId);
  if (!set || set.size === 0) return;
  // 复制一份再 iterate,防止 listener 在回调里 unsubscribe 改 Set
  const snapshot = [...set];
  for (const cb of snapshot) {
    try {
      cb(ev);
    } catch (err) {
      // listener 内部异常不影响其他 listener
      console.error("[chatPubsub] listener error:", err);
    }
  }
}

/**
 * Subscribe to events for a conversation. Returns an unsubscribe function.
 * 失活 (最后一个 listener 走) 时自动从 Map 删除 convId 的 Set。
 */
export function subscribeChat(convId: string, cb: Listener): () => void {
  let set = buses.get(convId);
  if (!set) {
    set = new Set();
    buses.set(convId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) buses.delete(convId);
  };
}

/** 测试 / 调试用:看当前有多少 conversation 在订阅 */
export function pubsubStats(): { conversations: number; totalListeners: number } {
  let total = 0;
  for (const s of buses.values()) total += s.size;
  return { conversations: buses.size, totalListeners: total };
}
