/**
 * V3.0 PR4: TurnOrchestrator — orchestrates main + appended branches + synth.
 *
 * 包装 chatAgentService.runAgent 的"单 turn"流,再叠加多分支 + 合成层。
 * 调用入口在 chatRoutes.POST /messages,旧逻辑(idle 状态走 runAgent)做最小
 * 改动,新增逻辑(inflight 状态走 branch / synth)集中在这里。
 *
 * 流程速览:
 *  - 主线 POST 进来 → registerMainTurn → 跑 runAgent (会 stream 给客户端) →
 *    完成后 awaitBranches → runSynth (stream 给客户端) → 处理 pendingQueue → 关
 *  - append POST 进来 → registerAppendBranch → 返回 ack 立刻关 (branch 跑在 detached promise)
 *  - synth-pending POST 进来 → enqueuePending → 返回 ack 立刻关
 *
 * 所有 branch / synth 事件都走 publishChatEvent 广播 (passive listener 能收到)。
 * 主线 POST 自己额外把事件 yield 出去给当前 SSE response。
 */

import { v4 as uuidv4 } from "uuid";
import {
  type InflightTurn,
  type BranchState,
  type PendingMessage,
  getTurn,
  setTurn,
  deleteTurn,
} from "./turnRegistry.js";
import { publishChatEvent } from "./chatPubsub.js";
import { runAgent, spawnSubagent, type AgentContext, type SseEvent } from "./chatAgentService.js";
import * as convStore from "./conversationStore.js";
import { resolveModelForCall, getModel } from "./modelRegistry.js";
import * as agentSvc from "./agentService.js";
import { createSubagentRun, updateSubagentRun } from "./subagentRunStore.js";
import { createWorkflowRun, updateWorkflowRun } from "./workflowRunStore.js";
import { resolveActiveTools } from "../../mcp-server/src/tools/index.js";

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
 * 总入口。根据 inflight 状态分派到 main / branch / queue 三种处理模式。
 * 返回 AsyncGenerator,主线模式会持续 yield 完整流;branch / queue 模式只
 * yield 一个 ack 事件就 return。
 */
export async function* dispatchMessage(
  input: DispatchInput,
): AsyncGenerator<SseEvent, void, undefined> {
  const { ctx, userMessage, modelOverride, abortSignal } = input;
  const convId = ctx.conversationId;
  const agentId = ctx.agentId || "agent_default";

  // 解析此条 message 用什么模型 (V3.0:@ mention 优先 > modelOverride > agent default)
  const mentionedModelId = extractModelMention(userMessage);
  const effectiveModelId = mentionedModelId
    || modelOverride
    || (await agentSvc.getSelectedModel(agentId));

  // V3.0 PR3 / PR4 一致语义:每条进来的 user message 都先 emit "message_persisted"
  // 让 listener 立即看到 user bubble (即使后续路由到 main / branch / queue),
  // UI 不依赖 routing 决定才看到用户消息。
  const persistedEv: SseEvent = {
    event: "message_persisted",
    data: {
      role: "user",
      content: userMessage,
      modelId: effectiveModelId,
      // user message 实际 id 由 runAgent / startAppendedBranch 内部 persist 时分配,
      // 此处先发个临时 id 让前端 dedupe (PR3 listener reload 时会拿到真实 id)
      messageId: `pending_${convId}_${Date.now()}`,
    },
  };
  publishChatEvent(convId, persistedEv);
  yield persistedEv;

  const inflight = getTurn(convId);

  // Case A: idle → 起新主线
  if (!inflight) {
    yield* startMainTurn({ ctx, userMessage, modelId: effectiveModelId, abortSignal });
    return;
  }

  // Case B: synth 中 → 入队列,立刻返回
  if (inflight.synthesisStarted) {
    const pending: PendingMessage = {
      userMessageId: `msg_${uuidv4()}`,
      queryText: userMessage,
      modelId: effectiveModelId,
      enqueuedAt: Date.now(),
    };
    inflight.pendingQueue.push(pending);
    publishChatEvent(convId, {
      event: "turn_pending",
      data: {
        messageId: pending.userMessageId,
        queryText: pending.queryText,
        reason: "synth-in-progress",
      },
    });
    yield {
      event: "turn_pending",
      data: {
        messageId: pending.userMessageId,
        queryText: pending.queryText,
        reason: "synth-in-progress",
      },
    };
    return;
  }

  // Case C: main inflight → 起 appended branch
  const branch = await startAppendedBranch(inflight, ctx, userMessage, effectiveModelId, abortSignal);
  publishChatEvent(convId, {
    event: "branch_started",
    data: {
      branchId: branch.branchId,
      messageId: branch.userMessageId,
      modelId: branch.modelId,
      queryText: branch.queryText,
    },
  });
  yield {
    event: "branch_started",
    data: {
      branchId: branch.branchId,
      messageId: branch.userMessageId,
      modelId: branch.modelId,
      queryText: branch.queryText,
    },
  };
  // 立刻返回 — branch 在 detached promise 里跑,事件通过 pubsub 流到 listener
}

// ─────────────────────────────────────────────────────────────────────────
// 主线 turn 处理
// ─────────────────────────────────────────────────────────────────────────

async function* startMainTurn(opts: {
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
    mainBranch: {
      branchId: `br_main_${uuidv4().slice(0, 8)}`,
      userMessageId: "",  // 由 runAgent 内部写入 user message 时填,我们 lazy 抓
      queryText: userMessage,
      modelId,
      startedAt: Date.now(),
      status: "running",
      completion: Promise.resolve({ branchId: "", finalText: "", success: false }), // placeholder, replaced below
    },
    appendedBranches: [],
    synthesisStarted: false,
    synthesisDone: false,
    pendingQueue: [],
  };
  setTurn(convId, turn);

  // V3.0 PR5: 创建 WorkflowRun 行用于观测 (append-batch 模板)
  const workflowRunId = `wf_${uuidv4().slice(0, 12)}`;
  const nodeEvents: any[] = [
    { kind: "trigger", nodeId: "n_trigger", ts: Date.now() },
    { kind: "main_started", branchId: turn.mainBranch.branchId, modelId, queryText: userMessage, ts: Date.now() },
  ];
  try {
    await createWorkflowRun({
      id: workflowRunId,
      parentMessageId: `pending_${convId}`,
      parentConversationId: convId,
      hostAgentId: agentId,
      templateId: "append-batch",
      paramsJson: { hostModel: modelId },
      docJson: buildAppendBatchDoc(turn),
    });
    turn.workflowRunId = workflowRunId;
  } catch (err) {
    console.warn("[turnOrchestrator] createWorkflowRun failed:", err);
  }

  // 运行主线 — runAgent 会 stream 完整事件,我们 capture finalText
  let mainAccText = "";
  let mainSuccess = false;
  let mainErrorMessage: string | undefined;
  // 存 promise 以便 appended branch 的等待逻辑用
  let mainResolve: (v: { branchId: string; finalText: string; success: boolean; errorMessage?: string }) => void;
  turn.mainBranch.completion = new Promise((res) => { mainResolve = res; });

  try {
    for await (const ev of runAgent({ ...ctx }, userMessage, ac.signal)) {
      // capture assistant text
      if (ev.event === "message") {
        const d = ev.data as any;
        if (typeof d?.text === "string") mainAccText += d.text;
      }
      if (ev.event === "done") {
        mainSuccess = true;
        // 不 yield done 出去! 因为后面还有 branches + synth 要走完。
        // 把 done 推迟到全部完成后由 orchestrator 自己 emit。
        continue;
      }
      if (ev.event === "error") {
        const d = ev.data as any;
        mainErrorMessage = d?.message || "main turn error";
        mainSuccess = false;
        // 仍把 error event 发出去,但不 break — 等 branches + synth
        yield ev;
        continue;
      }
      yield ev;
    }
  } catch (err) {
    mainErrorMessage = err instanceof Error ? err.message : String(err);
    mainSuccess = false;
  }

  turn.mainBranch.status = mainSuccess ? "success" : "error";
  turn.mainBranch.finalText = mainAccText;
  turn.mainBranch.errorMessage = mainErrorMessage;
  nodeEvents.push({
    kind: "main_finished", branchId: turn.mainBranch.branchId,
    success: mainSuccess, ts: Date.now(),
    durationMs: Date.now() - turn.mainBranch.startedAt,
  });
  mainResolve!({
    branchId: turn.mainBranch.branchId,
    finalText: mainAccText,
    success: mainSuccess,
    errorMessage: mainErrorMessage,
  });

  // 等所有已注册的 appended branches 完成
  while (turn.appendedBranches.some((b) => b.status === "running")) {
    await Promise.race(
      turn.appendedBranches
        .filter((b) => b.status === "running")
        .map((b) => b.completion.catch(() => undefined)),
    );
  }

  // 如果只有主线没有 branch → 不需要 synth,直接 done
  if (turn.appendedBranches.length === 0) {
    if (turn.workflowRunId) {
      await updateWorkflowRun(turn.workflowRunId, {
        status: mainSuccess ? "success" : "error",
        finalSummary: mainAccText.slice(0, 400),
        nodeEventsJson: nodeEvents,
        completedAt: new Date(),
        durationMs: Date.now() - turn.startedAt,
      }).catch(() => undefined);
    }
    deleteTurn(convId);
    yield { event: "done", data: { reason: "main-only" } };
    return;
  }

  // 收集所有 appended branches 的完成事件
  for (const ab of turn.appendedBranches) {
    nodeEvents.push({
      kind: ab.status === "success" ? "branch_finished" : "branch_errored",
      branchId: ab.branchId,
      modelId: ab.modelId,
      success: ab.status === "success",
      durationMs: Date.now() - ab.startedAt,
      ts: Date.now(),
    });
  }

  // 有 branches → 跑 synth
  turn.synthesisStarted = true;
  publishChatEvent(convId, {
    event: "synth_started",
    data: {
      mainBranchId: turn.mainBranch.branchId,
      branchCount: turn.appendedBranches.length + 1,
      modelId: turn.mainBranch.modelId,
    },
  });
  yield {
    event: "synth_started",
    data: {
      mainBranchId: turn.mainBranch.branchId,
      branchCount: turn.appendedBranches.length + 1,
      modelId: turn.mainBranch.modelId,
    },
  };

  try {
    yield* runSynth(turn, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    publishChatEvent(convId, { event: "error", data: { code: "SYNTH_FAILED", message: msg } });
    yield { event: "error", data: { code: "SYNTH_FAILED", message: msg } };
  }

  turn.synthesisDone = true;
  nodeEvents.push({ kind: "synth_finished", ts: Date.now() });
  publishChatEvent(convId, {
    event: "synth_finished",
    data: { mainBranchId: turn.mainBranch.branchId },
  });
  yield {
    event: "synth_finished",
    data: { mainBranchId: turn.mainBranch.branchId },
  };

  // V3.0 PR5: 持久化 WorkflowRun 终态
  if (turn.workflowRunId) {
    await updateWorkflowRun(turn.workflowRunId, {
      status: "success",
      finalSummary: `${turn.appendedBranches.length + 1} branches synthesized`,
      nodeEventsJson: nodeEvents,
      completedAt: new Date(),
      durationMs: Date.now() - turn.startedAt,
    }).catch(() => undefined);
  }

  // 看 pendingQueue 是否有积累
  const queue = turn.pendingQueue;
  deleteTurn(convId);

  if (queue.length > 0) {
    // 触发 detached "下一 batch" — 第一条作为新主线,剩下作为 appended branches。
    // 不 await,主 POST 立刻关闭,新 batch 的事件全部走 pubsub。
    void runDetachedBatchFromQueue(ctx, queue).catch((err) => {
      console.error("[turnOrchestrator] detached batch failed:", err);
      publishChatEvent(convId, {
        event: "error",
        data: { code: "BATCH_FAILED", message: err instanceof Error ? err.message : String(err) },
      });
    });
  }

  yield { event: "done", data: { reason: "synth-complete" } };
}

// ─────────────────────────────────────────────────────────────────────────
// Append branch — 在已有 inflight 上 spawn 一个 subagent
// ─────────────────────────────────────────────────────────────────────────

async function startAppendedBranch(
  inflight: InflightTurn,
  ctx: AgentContext,
  userMessage: string,
  modelId: string,
  parentSignal?: AbortSignal,
): Promise<BranchState> {
  const { conversationId, workspaceId } = ctx;
  const agentId = ctx.agentId || "agent_default";

  // 持久化 user message (branchTag = "appended")
  const userMsg = await convStore.appendMessage(conversationId, {
    role: "user",
    content: userMessage,
    branchTag: "appended",
  } as any);
  if (!userMsg) {
    throw new Error(`startAppendedBranch: conversation ${conversationId} not found when persisting user message`);
  }

  const branchId = `br_${uuidv4().slice(0, 8)}`;
  const branch: BranchState = {
    branchId,
    userMessageId: userMsg.id,
    queryText: userMessage,
    modelId,
    startedAt: Date.now(),
    status: "running",
    completion: Promise.resolve({ branchId, finalText: "", success: false }), // placeholder
  };
  inflight.appendedBranches.push(branch);

  // 创建 SubagentRun 行
  let subagentRunId: string | undefined;
  try {
    const run = await createSubagentRun({
      parentMessageId: userMsg.id,
      parentConversationId: conversationId,
      hostAgentId: agentId,
      subagentModel: modelId,
      requestedModel: modelId,
      systemPrompt: BRANCH_SYSTEM_PROMPT,
      userPrompt: userMessage,
      allowedTools: [],
      maxRounds: 10,
      depth: 1,
      kind: "branch",
      branchId,
    });
    subagentRunId = run.id;
    branch.subagentRunId = subagentRunId;
  } catch (err) {
    console.warn("[turnOrchestrator] createSubagentRun failed:", err);
  }

  // 启动 detached promise 跑 spawnSubagent
  branch.completion = (async () => {
    let acc = "";
    let success = false;
    let errMsg: string | undefined;
    try {
      const startedAt = Date.now();
      const stream = spawnSubagent({
        modelId,
        systemPrompt: BRANCH_SYSTEM_PROMPT,
        userPrompt: userMessage,
        allowedTools: [],  // 继承 host 全部 active tools
        maxRounds: 10,
        parentMessageId: userMsg.id,
        parentConversationId: conversationId,
        hostAgentId: agentId,
        workflowNodeId: null,
        worktreeId: null,
        hostTools: resolveActiveTools([]),
        toolCtx: {
          workspaceId,
          agentId,
          activeSkills: [],
          callId: undefined,
          progress: () => {},
          abortSignal: parentSignal,
          onActivateSkill: () => {},
          onDeactivateSkill: () => {},
        } as any,
        depth: 1,
      }, parentSignal);

      // 手动迭代以拿到 generator 的 return 值 (for-await-of 会丢弃)
      let resultValue: { runId: string; finalText: string; success: boolean } | undefined;
      while (true) {
        const step = await stream.next();
        if (step.done) {
          resultValue = step.value as { runId: string; finalText: string; success: boolean };
          break;
        }
        const ev = step.value;
        publishChatEvent(conversationId, {
          event: ev.event,
          data: { ...((ev.data as any) || {}), branchId },
        });
        if (ev.event === "subagent_message") {
          const d = ev.data as any;
          if (typeof d?.text === "string") acc += d.text;
        }
      }

      success = resultValue?.success ?? true;
      branch.status = success ? "success" : "error";
      branch.finalText = acc || resultValue?.finalText || "";

      if (subagentRunId) {
        await updateSubagentRun(subagentRunId, {
          status: success ? "success" : "error",
          finalText: branch.finalText,
          completedAt: new Date(),
          durationMs: Date.now() - startedAt,
        }).catch(() => undefined);
      }
    } catch (err) {
      errMsg = err instanceof Error ? err.message : String(err);
      branch.status = "error";
      branch.errorMessage = errMsg;
      branch.finalText = `(此分支处理失败: ${errMsg})`;
      if (subagentRunId) {
        await updateSubagentRun(subagentRunId, {
          status: "error",
          errorMessage: errMsg,
          completedAt: new Date(),
        }).catch(() => undefined);
      }
    }

    publishChatEvent(conversationId, {
      event: "branch_finished",
      data: {
        branchId,
        success,
        durationMs: Date.now() - branch.startedAt,
        errorMessage: errMsg,
      },
    });

    return { branchId, finalText: branch.finalText ?? "", success, errorMessage: errMsg };
  })();

  return branch;
}

// ─────────────────────────────────────────────────────────────────────────
// Synthesizer — 拿到所有 branch 的 finalText 后,统一回复用户
// ─────────────────────────────────────────────────────────────────────────

const SYNTH_SYSTEM_PROMPT = `你的任务是把多个并行 branch 的回复**完整拼接**给用户。

## 强约束 (违反则输出无效)
- 顺序:严格按 branchesNewestFirst 数组顺序输出 (新的在前,主线最后)
- 内容:每个 branch 的 fullReply **完整保留,不要概要、不要删减、不要改写**
- 衔接:branch 之间用 markdown 分隔符,格式:
    ─── 关于「<userQuery 的简短摘要>」 ───

    <fullReply 完整内容>
- 不加任何额外的总结、过渡语、自我发挥
- errored=true 的 branch 直接照抄 fullReply 的失败说明,不要美化

你不是在创作,只是在**按规则播报**。直接输出最终拼接结果,不要任何前置说明。`;

const BRANCH_SYSTEM_PROMPT = `你是用户对话的并发分支处理者。在主线对话进行中时,
用户追加了一个新问题给你。请正常作答,作答完会和主线一起被合成回复用户。

# 约束
- 完整作答,可以调用工具
- 不要假设用户能看到你的中间过程 (实际看不到,只看到最终合成后的回复)
- 不要重复"用户的问题是 ..." 之类的复述,直接给出答案`;

async function* runSynth(
  turn: InflightTurn,
  ctx: AgentContext,
): AsyncGenerator<SseEvent, void, undefined> {
  const { conversationId } = ctx;
  // 时间倒序 (新的在前)
  const all = [...turn.appendedBranches.slice().reverse(), turn.mainBranch];
  const synthInput = {
    branchesNewestFirst: all.map((b) => ({
      userQuery: b.queryText,
      fullReply: b.status === "error"
        ? `(此分支处理失败: ${b.errorMessage || "unknown"})`
        : (b.finalText || ""),
      errored: b.status === "error",
      timestamp: b.startedAt,
    })),
    orderingRule: "newest-first",
  };

  // 用主线的模型跑 synth
  const synthModelId = turn.mainBranch.modelId;
  const synthBranchId = `br_synth_${uuidv4().slice(0, 8)}`;

  let synthRunId: string | undefined;
  try {
    const run = await createSubagentRun({
      parentMessageId: turn.mainBranch.userMessageId || `pending_${conversationId}`,
      parentConversationId: conversationId,
      hostAgentId: turn.agentId,
      subagentModel: synthModelId,
      requestedModel: synthModelId,
      systemPrompt: SYNTH_SYSTEM_PROMPT,
      userPrompt: JSON.stringify(synthInput, null, 2),
      allowedTools: [],
      maxRounds: 1,  // synth 不需要工具调用
      depth: 1,
      kind: "synth",
      branchId: synthBranchId,
      workflowRunId: turn.workflowRunId ?? null,
    });
    synthRunId = run.id;
  } catch (err) {
    console.warn("[turnOrchestrator] createSubagentRun(synth) failed:", err);
  }

  let synthText = "";
  let success = false;
  const startedAt = Date.now();
  try {
    const stream = spawnSubagent({
      modelId: synthModelId,
      systemPrompt: SYNTH_SYSTEM_PROMPT,
      userPrompt: JSON.stringify(synthInput, null, 2),
      allowedTools: [],
      maxRounds: 1,
      parentMessageId: turn.mainBranch.userMessageId || `pending_${conversationId}`,
      parentConversationId: conversationId,
      hostAgentId: turn.agentId,
      workflowNodeId: null,
      worktreeId: null,
      hostTools: [],
      toolCtx: {
        workspaceId: ctx.workspaceId,
        agentId: turn.agentId,
        activeSkills: [],
        callId: undefined,
        progress: () => {},
        abortSignal: turn.abortController.signal,
        onActivateSkill: () => {},
        onDeactivateSkill: () => {},
      } as any,
      depth: 1,
    }, turn.abortController.signal);

    // 手动迭代,拿 return 值
    let resultValue: { runId: string; finalText: string; success: boolean } | undefined;
    while (true) {
      const step = await stream.next();
      if (step.done) {
        resultValue = step.value as { runId: string; finalText: string; success: boolean };
        break;
      }
      const ev = step.value;
      // 转发 subagent_message → synth_message_delta (UI 友好命名)
      if (ev.event === "subagent_message") {
        const d = ev.data as any;
        const text = d?.text || "";
        synthText += text;
        const out: SseEvent = { event: "synth_message_delta", data: { text, mainBranchId: turn.mainBranch.branchId } };
        publishChatEvent(conversationId, out);
        yield out;
      } else if (ev.event === "subagent_thinking") {
        const d = ev.data as any;
        const out: SseEvent = { event: "synth_thinking_delta", data: { text: d?.text || "" } };
        publishChatEvent(conversationId, out);
        yield out;
      }
      // 其他 subagent_* 事件不广播给客户端 (UI 不展示 synth 内部 tool 调用)
    }
    success = resultValue?.success ?? true;
  } catch (err) {
    success = false;
    const msg = err instanceof Error ? err.message : String(err);
    publishChatEvent(conversationId, {
      event: "error",
      data: { code: "SYNTH_FAILED", message: msg, branchId: synthBranchId },
    });
    yield { event: "error", data: { code: "SYNTH_FAILED", message: msg } };
  }

  if (synthRunId) {
    await updateSubagentRun(synthRunId, {
      status: success ? "success" : "error",
      finalText: synthText,
      completedAt: new Date(),
      durationMs: Date.now() - startedAt,
    }).catch(() => undefined);
  }

  // 持久化 synthesis 这条最终 assistant 消息(用户在 history 里看到的就是它)
  if (synthText.trim()) {
    try {
      await convStore.appendMessage(conversationId, {
        role: "assistant",
        content: synthText,
        branchTag: "synthesis",
        parentMessageId: turn.mainBranch.userMessageId || null,
      } as any);
    } catch (err) {
      console.warn("[turnOrchestrator] persist synth message failed:", err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Detached batch driver — 处理 pendingQueue
// ─────────────────────────────────────────────────────────────────────────

async function runDetachedBatchFromQueue(
  ctx: AgentContext,
  queue: PendingMessage[],
): Promise<void> {
  if (queue.length === 0) return;
  const main = queue[0];
  const appends = queue.slice(1);

  // pubsub 通知 listener:这一批已升级为新 turn (frontend 把 thinking placeholder 变成 branch card)
  publishChatEvent(ctx.conversationId, {
    event: "turn_promoted",
    data: { messageId: main.userMessageId, role: "main", queryText: main.queryText, modelId: main.modelId },
  });

  // 起新主线 — 复用 startMainTurn,但事件只走 pubsub (没有 fetch SSE response 流)
  // 我们把 generator drain 到 void
  const drained = startMainTurn({
    ctx,
    userMessage: main.queryText,
    modelId: main.modelId,
  });
  // 在主线还没起来之前,先把 appends 的 query 注册成 branch (类似用户连发)
  // 但需要 inflight 已经存在 → 必须先 await 主线的 setTurn。
  // 把 drained 跑到第一个 await(yield 第一个事件)就 fork append。
  // 简化:直接 await 主线 first event,然后 forEach appends 调 dispatchMessage。
  // 这里我们 sync 先记下,等主线注册 inflight 后再补 branches。
  // 实际实现:把 drained 的所有事件都 publish 出去 + 同时为 appends 调 dispatchMessage (它会发现 inflight 后走 branch 路径)。

  // 先消费 drained 第一帧 (确保 inflight 注册了)
  const iter = drained;
  let first: IteratorResult<SseEvent> | undefined;
  try {
    first = await iter.next();
  } catch (err) {
    publishChatEvent(ctx.conversationId, {
      event: "error",
      data: { code: "BATCH_DRIVE_FAILED", message: err instanceof Error ? err.message : String(err) },
    });
    return;
  }
  if (first && !first.done) {
    publishChatEvent(ctx.conversationId, { event: first.value.event, data: first.value.data });
  }

  // appends → 现在 inflight 应该已经存在
  for (const a of appends) {
    publishChatEvent(ctx.conversationId, {
      event: "turn_promoted",
      data: { messageId: a.userMessageId, role: "branch", queryText: a.queryText, modelId: a.modelId },
    });
    // 通过 dispatchMessage 触发 branch 路径
    const branchGen = dispatchMessage({
      ctx,
      userMessage: a.queryText,
      modelOverride: a.modelId,
    });
    // drain (只期望一个 branch_started 事件) — 把它也 publish
    for await (const ev of branchGen) {
      publishChatEvent(ctx.conversationId, ev);
    }
  }

  // 继续 drain 主线剩下事件
  while (true) {
    const r = await iter.next();
    if (r.done) break;
    publishChatEvent(ctx.conversationId, { event: r.value.event, data: r.value.data });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * V3.0 PR5: 构造 append-batch workflow doc。可序列化的节点树,WorkflowBlock
 * 渲染时拿来展示主线 + 各 branch + synth 的层级结构。
 *
 * 注意:这个 doc 不实际在 workflow executor 上跑(branch / synth 由
 * turnOrchestrator 直接调度)。它只是观测层的 schema。
 */
function buildAppendBatchDoc(turn: InflightTurn): any {
  const branchNodeIds = ["n_main", ...turn.appendedBranches.map((b) => `n_branch_${b.branchId}`)];
  return {
    templateId: "append-batch",
    rootNodeId: "n_trigger",
    nodes: {
      n_trigger: { kind: "trigger", source: "chat-message", next: "n_parallel" },
      n_parallel: {
        kind: "logic",
        type: "parallel",
        branches: branchNodeIds,
        joinStrategy: "all",
        next: "n_synth",
      },
      n_main: {
        kind: "action",
        type: "external-await",
        outputAlias: "main",
        meta: { branchId: turn.mainBranch.branchId, modelId: turn.mainBranch.modelId, queryText: turn.mainBranch.queryText },
      },
      // appended branches 在创建时动态注入,这里仅占位
      n_synth: {
        kind: "action",
        type: "subagent",
        subagentModel: turn.mainBranch.modelId,
        outputAlias: "synthesis",
        meta: { phase: "synthesizer" },
      },
    },
  };
}

/**
 * 从 user content 里提取 [@xxx](mention://model/<id>?…) 形式的模型 mention。
 * 返回第一个 model 类型 mention 的 modelId,无则 null。
 */
function extractModelMention(content: string): string | null {
  const re = /\[@[^\]]+\]\(mention:\/\/model\/([^)?]+)/;
  const m = content.match(re);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  // 验证模型存在
  return getModel(id) ? id : null;
}
