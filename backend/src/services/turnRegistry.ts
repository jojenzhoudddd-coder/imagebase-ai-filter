/**
 * V3.0 PR4 (simplified 2026-05-04): TurnRegistry — single inflight turn per conv +
 * a pending-message queue for serial processing.
 *
 * 设计变化:之前为每条 user message 起 branch/synth,现在简化为"一次只跑一个
 * turn,inflight 时新 message 仅入队,turn 完成后逐个 drain"。
 *
 *  - inflight: 当前正在跑的 turn (有 abortController)
 *  - pendingQueue: turn 进行中收到的 user messages,按到达顺序 drain
 *
 * 与 chatAgentService 的关系:chatAgentService 仍负责单 turn 的 host agent 主流程;
 * turnOrchestrator 在它之上加上"inflight 时入队、完成后逐个 drain"的 orchestrate 逻辑。
 *
 * V1: 单进程内同步(in-memory Map),多 region 时改 Redis pubsub + locks。
 */

export interface PendingMessage {
  userMessageId: string;
  turnRunId: string;
  queryText: string;
  modelId: string;
  enqueuedAt: number;
}

export interface InflightTurn {
  convId: string;
  agentId: string;
  startedAt: number;
  /** AbortController for the whole turn (host agent + all queued drains). */
  abortController: AbortController;

  /** Messages received while a turn is inflight — drained serially after current turn. */
  pendingQueue: PendingMessage[];
}

const turns = new Map<string, InflightTurn>();

export function getTurn(convId: string): InflightTurn | undefined {
  return turns.get(convId);
}

export function setTurn(convId: string, turn: InflightTurn): void {
  turns.set(convId, turn);
}

export function deleteTurn(convId: string): void {
  turns.delete(convId);
}

export function turnExists(convId: string): boolean {
  return turns.has(convId);
}

/** abort 当前 conv 的所有 inflight (含尚未 drain 的 pendingQueue) */
export function abortTurn(convId: string, reason: string = "user_stop"): boolean {
  const t = turns.get(convId);
  if (!t) return false;
  t.abortController.abort(reason);
  // 清掉 pendingQueue 防止 abort 后还继续 drain
  t.pendingQueue.length = 0;
  return true;
}

/** 测试 / debug */
export function turnRegistryStats(): { active: number; conversations: string[] } {
  return { active: turns.size, conversations: [...turns.keys()] };
}
