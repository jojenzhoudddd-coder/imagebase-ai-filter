/**
 * V3.0 PR4: TurnRegistry — multi-branch chat turn orchestrator.
 *
 * Tracks one InflightTurn per conversation:
 *  - mainBranch: original user query (host agent stream)
 *  - appendedBranches: queries arriving while main + branches are still running
 *  - pendingQueue: queries arriving DURING synth (deferred to next batch)
 *  - synthesisStarted: once true, new messages go to pendingQueue
 *
 * 与 chatAgentService 的关系:chatAgentService 仍负责单 turn 的 host agent
 * 主流程(就是这里说的 mainBranch);TurnRegistry 在它之上加上"来 second
 * message 时起 branch、batch 完了起 synth、synth 中暂存"的 orchestrate 逻辑。
 *
 * V3.0 PR4 V1: 支持任意多 branch / 任意多 pendingQueue 长度,但只在单进程内
 *   同步(in-memory Map)。多 region 时改 Redis pubsub + locks。
 */

export interface BranchState {
  branchId: string;
  userMessageId: string;
  queryText: string;
  modelId: string;
  startedAt: number;
  status: "running" | "success" | "error" | "aborted";
  finalText?: string;
  errorMessage?: string;
  /** Promise resolves when this branch's underlying agent loop finishes. */
  completion: Promise<{ branchId: string; finalText: string; success: boolean; errorMessage?: string }>;
  subagentRunId?: string;
}

export interface PendingMessage {
  userMessageId: string;
  queryText: string;
  modelId: string;
  enqueuedAt: number;
}

export interface InflightTurn {
  convId: string;
  agentId: string;
  startedAt: number;
  /** WorkflowRun.id (PR5 will create one); V1 may be null for simplicity. */
  workflowRunId?: string;
  /** AbortController for the whole turn (main + branches + synth). */
  abortController: AbortController;

  mainBranch: BranchState;
  appendedBranches: BranchState[];

  /** True after all branches resolved + synth has been kicked off. */
  synthesisStarted: boolean;
  /** Set once synth completes (success / error). */
  synthesisDone: boolean;

  /** Messages received during synth — process as a new batch after synth. */
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

/** abort 当前 conv 的所有 inflight (main + branches + synth) */
export function abortTurn(convId: string, reason: string = "user_stop"): boolean {
  const t = turns.get(convId);
  if (!t) return false;
  t.abortController.abort(reason);
  return true;
}

/** 测试 / debug */
export function turnRegistryStats(): { active: number; conversations: string[] } {
  return { active: turns.size, conversations: [...turns.keys()] };
}

/**
 * 把 user message append 到当前 turn(添加 branch 或入 pendingQueue)。
 * 由 chatAgentService 调用,根据状态自动决定路由。
 */
export type AppendResult =
  | { mode: "main"; turn: InflightTurn }              // 没有 inflight,起新 main turn (caller 决定后续)
  | { mode: "branch"; branch: BranchState; turn: InflightTurn } // 加为 appended branch
  | { mode: "queued"; pending: PendingMessage; turn: InflightTurn }; // synth 中,入 queue
