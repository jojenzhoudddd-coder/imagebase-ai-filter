/**
 * V3.0 PR4 (simplified 2026-05-04): TurnOrchestrator — single-turn + queue.
 *
 * 旧设计(branch + synth)被替换成最简单的"一次跑一个,完了再跑下一个"语义:
 *  - idle POST → 跑 runAgent,事件 stream 给当前 fetch SSE
 *  - inflight 时再有 POST → push 入 pendingQueue,emit `turn_pending`,立刻关流
 *  - 当前 turn 完了 → 在同一条 fetch SSE 上继续 drain queue,逐个跑 runAgent
 *
 * 这样用户在 generating 时能继续输入,新输入不会打断当前回复,但会按顺序排队。
 * 所有 turn 都通过 publishChatEvent 广播,passive listener (其他 chat block) 能同步。
 */

import { v4 as uuidv4 } from "uuid";
import {
  type InflightTurn,
  type PendingMessage,
  getTurn,
  setTurn,
  deleteTurn,
} from "./turnRegistry.js";
import { publishChatEvent } from "./chatPubsub.js";
import { runAgent, type AgentContext, type SseEvent } from "./chatAgentService.js";
import { getModel } from "./modelRegistry.js";
import * as agentSvc from "./agentService.js";

// ─────────────────────────────────────────────────────────────────────────
// Public entry — called by chatRoutes for every POST /messages
// ─────────────────────────────────────────────────────────────────────────

export interface DispatchInput {
  ctx: AgentContext;
  userMessage: string;
  modelOverride?: string;  // V3.0: per-message model (e.g. via @ mention)
  abortSignal?: AbortSignal;
}

/**
 * 总入口。idle 时启动主线;inflight 时入队后立刻关流。
 */
export async function* dispatchMessage(
  input: DispatchInput,
): AsyncGenerator<SseEvent, void, undefined> {
  const { ctx, userMessage, modelOverride, abortSignal } = input;
  const convId = ctx.conversationId;
  const agentId = ctx.agentId || "agent_default";

  // 解析此条 message 用什么模型 (@ mention > modelOverride > agent default)
  const mentionedModelId = extractModelMention(userMessage);
  const effectiveModelId = mentionedModelId
    || modelOverride
    || (await agentSvc.getSelectedModel(agentId));

  // 每条进来的 user message 都先 emit "message_persisted" 让 listener 立即看到 user bubble
  // (即使后续被入队,UI 不依赖 routing 决定才看到用户消息)
  const persistedEv: SseEvent = {
    event: "message_persisted",
    data: {
      role: "user",
      content: userMessage,
      modelId: effectiveModelId,
      messageId: `pending_${convId}_${Date.now()}`,
    },
  };
  publishChatEvent(convId, persistedEv);
  yield persistedEv;

  const inflight = getTurn(convId);

  // Case A: idle → 起新主线 (drain queue inline)
  if (!inflight) {
    yield* runTurnAndDrainQueue({ ctx, userMessage, modelId: effectiveModelId, abortSignal });
    return;
  }

  // Case B: 有 inflight (主线 or 队列正在跑) → 入队,立刻关流
  const pending: PendingMessage = {
    userMessageId: `msg_${uuidv4()}`,
    queryText: userMessage,
    modelId: effectiveModelId,
    enqueuedAt: Date.now(),
  };
  inflight.pendingQueue.push(pending);
  const ev: SseEvent = {
    event: "turn_pending",
    data: {
      messageId: pending.userMessageId,
      queryText: pending.queryText,
      reason: "turn-inflight",
    },
  };
  publishChatEvent(convId, ev);
  yield ev;
}

// ─────────────────────────────────────────────────────────────────────────
// 核心:跑一个 turn,然后 drain pendingQueue (在同一条 fetch SSE 上)
// ─────────────────────────────────────────────────────────────────────────

async function* runTurnAndDrainQueue(opts: {
  ctx: AgentContext;
  userMessage: string;
  modelId: string;
  abortSignal?: AbortSignal;
}): AsyncGenerator<SseEvent, void, undefined> {
  const { ctx, userMessage, modelId, abortSignal } = opts;
  const convId = ctx.conversationId;
  const agentId = ctx.agentId || "agent_default";

  const ac = new AbortController();
  const externalAbort = abortSignal;
  if (externalAbort) {
    if (externalAbort.aborted) ac.abort(externalAbort.reason);
    else externalAbort.addEventListener("abort", () => ac.abort(externalAbort.reason), { once: true });
  }

  const turn: InflightTurn = {
    convId,
    agentId,
    startedAt: Date.now(),
    abortController: ac,
    pendingQueue: [],
  };
  setTurn(convId, turn);

  try {
    // 跑当前 turn (主线)
    yield* runOneTurn(ctx, userMessage, modelId, ac.signal);

    // 主线完成后,逐个 drain 队列
    while (turn.pendingQueue.length > 0 && !ac.signal.aborted) {
      const next = turn.pendingQueue.shift()!;
      // emit turn_promoted 让 FE 知道队列里的某条 user message 现在升级为正在跑的 turn
      // (FE 可以用这个 messageId 关联到之前 turn_pending 时的 user bubble)
      const promotedEv: SseEvent = {
        event: "turn_promoted",
        data: {
          messageId: next.userMessageId,
          queryText: next.queryText,
          modelId: next.modelId,
        },
      };
      publishChatEvent(convId, promotedEv);
      yield promotedEv;

      yield* runOneTurn(ctx, next.queryText, next.modelId, ac.signal);
    }
  } finally {
    deleteTurn(convId);
  }
}

/**
 * 跑一次 host agent (含完整 SSE 事件流)。runAgent 自己会 emit `done`,
 * 我们直接透传 — 用户的 GeneratingMeta freeze、token 计数都依赖那个 done payload。
 *
 * 多个 turn 串起来时,每个 turn 都会 emit 一个独立 `done`,FE 通过
 * messageId(在 start/done 里)区分不同 turn,各自渲染 streaming → frozen 状态。
 */
async function* runOneTurn(
  ctx: AgentContext,
  userMessage: string,
  _modelId: string,
  signal: AbortSignal,
): AsyncGenerator<SseEvent, void, undefined> {
  // _modelId 实际由 runAgent 内部从 agentService.getSelectedModel(agentId) 读取;
  // V3.0 PR3 的 per-message override 通过 @ mention 实现 (extractModelMention 已在
  // dispatchMessage 提取并 publish 了 message_persisted 用以让 FE 显示模型 chip)。
  // 真实的模型路由在 chatAgentService.runAgent → resolveModelForCall(agentId)。
  for await (const ev of runAgent({ ...ctx }, userMessage, signal)) {
    yield ev;
    if (signal.aborted) break;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * 从 user content 里提取 [@xxx](mention://model/<id>?…) 形式的模型 mention。
 * 返回第一个 model 类型 mention 的 modelId,无则 null。
 */
function extractModelMention(content: string): string | null {
  const re = /\[@[^\]]+\]\(mention:\/\/model\/([^)?]+)/;
  const m = content.match(re);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  return getModel(id) ? id : null;
}
