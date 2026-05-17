export type ChatTurnStatus =
  | "queued"
  | "doing"
  | "awaiting_confirmation"
  | "done"
  | "error"
  | "aborted";

export interface ChatTurnToolCallSnapshot {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  status: "running" | "success" | "error" | "awaiting_confirmation";
  result?: unknown;
  error?: string;
  progress?: {
    phase?: string;
    message: string;
    progress?: number;
    current?: number;
    total?: number;
    elapsedMs: number;
  };
  heartbeat?: { elapsedMs: number };
}

export interface ChatTurnSubagentSnapshot {
  runId: string;
  requestedModel?: string;
  resolvedModel?: string;
  usedFallback?: boolean;
  userPrompt?: string;
  systemPrompt?: string;
  thinking: string;
  finalText: string;
  toolCalls: ChatTurnToolCallSnapshot[];
  status: "running" | "success" | "error";
  startedAt: number;
  durationMs?: number;
  error?: string;
  workflowNodeId?: string | null;
}

export interface ChatTurnWorkflowNodeEventSnapshot {
  kind: "node_start" | "node_end" | "loop_iter" | "branch_start" | "error" | "aborted";
  nodeId?: string;
  nodeKind?: string;
  nodeType?: string;
  output?: unknown;
  loopNodeId?: string;
  iter?: number;
  maxIter?: number;
  parentNodeId?: string;
  branchIdx?: number;
  totalBranches?: number;
  error?: string;
  reason?: string;
  ts: number;
}

export interface ChatTurnWorkflowSnapshot {
  runId: string;
  templateId?: string;
  status: "running" | "success" | "error" | "aborted";
  nodeEvents: ChatTurnWorkflowNodeEventSnapshot[];
  startedAt: number;
  durationMs?: number;
  error?: string;
}

export interface ChatTurnSnapshot {
  turnRunId: string;
  conversationId: string;
  status: ChatTurnStatus;
  requestText: string;
  userMessageId?: string | null;
  modelId?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  updatedAt: number;
  lastSeq: number;
  assistant: {
    messageId?: string | null;
    content: string;
    thinking: string;
    streaming: boolean;
  };
  turnMeta: {
    startedAt?: number | null;
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    phase: "queued" | "generating" | "generated" | "error" | "aborted" | "awaiting_confirmation";
  };
  toolCalls: ChatTurnToolCallSnapshot[];
  subagentRuns: ChatTurnSubagentSnapshot[];
  workflowRuns: ChatTurnWorkflowSnapshot[];
  pendingConfirm: null | {
    callId: string;
    tool: string;
    args: Record<string, unknown>;
    prompt: string;
    incomingRefs?: unknown;
  };
  errorMessage?: string | null;
}

export function createInitialTurnSnapshot(input: {
  turnRunId: string;
  conversationId: string;
  requestText: string;
  status?: ChatTurnStatus;
  modelId?: string | null;
  userMessageId?: string | null;
  now?: number;
}): ChatTurnSnapshot {
  const now = input.now ?? Date.now();
  const phase = input.status === "queued" ? "queued" : "generating";
  return {
    turnRunId: input.turnRunId,
    conversationId: input.conversationId,
    status: input.status ?? "queued",
    requestText: input.requestText,
    userMessageId: input.userMessageId ?? null,
    modelId: input.modelId ?? null,
    startedAt: input.status === "doing" ? now : null,
    completedAt: null,
    updatedAt: now,
    lastSeq: 0,
    assistant: {
      messageId: null,
      content: "",
      thinking: "",
      streaming: input.status !== "queued",
    },
    turnMeta: {
      startedAt: input.status === "doing" ? now : null,
      durationMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      phase,
    },
    toolCalls: [],
    subagentRuns: [],
    workflowRuns: [],
    pendingConfirm: null,
    errorMessage: null,
  };
}

export function reduceChatTurnSnapshot(
  previous: ChatTurnSnapshot,
  event: string,
  data: Record<string, unknown>,
  opts: { seq?: number; now?: number } = {},
): ChatTurnSnapshot {
  const now = opts.now ?? Date.now();
  const next: ChatTurnSnapshot = {
    ...previous,
    assistant: { ...previous.assistant },
    turnMeta: { ...previous.turnMeta },
    toolCalls: previous.toolCalls.map((tc) => ({ ...tc })),
    subagentRuns: previous.subagentRuns.map((run) => ({
      ...run,
      toolCalls: run.toolCalls.map((tc) => ({ ...tc })),
    })),
    workflowRuns: previous.workflowRuns.map((run) => ({
      ...run,
      nodeEvents: run.nodeEvents.map((ev) => ({ ...ev })),
    })),
    updatedAt: now,
    lastSeq: opts.seq ?? previous.lastSeq,
  };

  const setDoing = () => {
    if (next.status === "queued") {
      next.startedAt = now;
      next.turnMeta.startedAt = now;
    }
    if (next.status !== "awaiting_confirmation") next.status = "doing";
    if (next.turnMeta.phase === "queued") next.turnMeta.phase = "generating";
    next.assistant.streaming = true;
  };

  switch (event) {
    case "message_persisted": {
      if (typeof data.messageId === "string") next.userMessageId = data.messageId;
      if (typeof data.content === "string" && !next.requestText) next.requestText = data.content;
      if (typeof data.modelId === "string") next.modelId = data.modelId;
      break;
    }
    case "turn_pending": {
      next.status = "queued";
      next.turnMeta.phase = "queued";
      break;
    }
    case "turn_promoted":
    case "start": {
      setDoing();
      if (typeof data.messageId === "string") next.assistant.messageId = data.messageId;
      if (typeof data.model === "string") next.modelId = data.model;
      break;
    }
    case "message": {
      setDoing();
      next.assistant.content += typeof data.text === "string" ? data.text : "";
      break;
    }
    case "thinking": {
      setDoing();
      next.assistant.thinking += typeof data.text === "string" ? data.text : "";
      break;
    }
    case "tool_start": {
      setDoing();
      const callId = String(data.callId ?? "");
      if (!callId) break;
      upsertToolCall(next.toolCalls, {
        callId,
        tool: String(data.tool ?? ""),
        args: asRecord(data.args),
        status: "running",
      });
      break;
    }
    case "tool_progress": {
      const tc = findToolCall(next.toolCalls, String(data.callId ?? ""));
      if (tc) {
        tc.progress = {
          phase: typeof data.phase === "string" ? data.phase : undefined,
          message: typeof data.message === "string" ? data.message : "",
          progress: typeof data.progress === "number" ? data.progress : undefined,
          current: typeof data.current === "number" ? data.current : undefined,
          total: typeof data.total === "number" ? data.total : undefined,
          elapsedMs: typeof data.elapsedMs === "number" ? data.elapsedMs : 0,
        };
        tc.heartbeat = undefined;
      }
      break;
    }
    case "tool_heartbeat": {
      const tc = findToolCall(next.toolCalls, String(data.callId ?? ""));
      if (tc) tc.heartbeat = { elapsedMs: typeof data.elapsedMs === "number" ? data.elapsedMs : 0 };
      break;
    }
    case "tool_result": {
      const callId = String(data.callId ?? "");
      const tc = findToolCall(next.toolCalls, callId);
      if (tc) {
        const ok = Boolean(data.success);
        tc.status = ok ? "success" : "error";
        tc.result = data.result ?? data.output;
        tc.progress = undefined;
        tc.heartbeat = undefined;
      }
      break;
    }
    case "confirm": {
      next.status = "awaiting_confirmation";
      next.turnMeta.phase = "awaiting_confirmation";
      next.assistant.streaming = false;
      const callId = String(data.callId ?? "");
      if (callId) {
        const tc = findToolCall(next.toolCalls, callId);
        if (tc) tc.status = "awaiting_confirmation";
      }
      next.pendingConfirm = {
        callId,
        tool: String(data.tool ?? ""),
        args: asRecord(data.args),
        prompt: String(data.prompt ?? ""),
        incomingRefs: data.incomingRefs,
      };
      break;
    }
    case "turn_usage": {
      updateUsage(next, data);
      break;
    }
    case "subagent_start": {
      setDoing();
      const runId = String(data.runId ?? "");
      if (!runId) break;
      upsertSubagent(next, {
        runId,
        requestedModel: stringOrUndefined(data.requestedModel),
        resolvedModel: stringOrUndefined(data.resolvedModel),
        usedFallback: Boolean(data.usedFallback),
        userPrompt: stringOrUndefined(data.userPrompt),
        systemPrompt: stringOrUndefined(data.systemPrompt),
        thinking: "",
        finalText: "",
        toolCalls: [],
        status: "running",
        startedAt: now,
        workflowNodeId: (data.workflowNodeId as string | null | undefined) ?? null,
      });
      break;
    }
    case "subagent_thinking": {
      const run = findSubagent(next, String(data.runId ?? ""));
      if (run) run.thinking += typeof data.text === "string" ? data.text : "";
      break;
    }
    case "subagent_message": {
      const run = findSubagent(next, String(data.runId ?? ""));
      if (run) run.finalText += typeof data.text === "string" ? data.text : "";
      break;
    }
    case "subagent_tool_start": {
      const run = findSubagent(next, String(data.runId ?? ""));
      const callId = String(data.callId ?? "");
      if (run && callId) {
        upsertToolCall(run.toolCalls, {
          callId,
          tool: String(data.tool ?? ""),
          args: asRecord(data.args),
          status: "running",
        });
      }
      break;
    }
    case "subagent_tool_result": {
      const run = findSubagent(next, String(data.runId ?? ""));
      const tc = run ? findToolCall(run.toolCalls, String(data.callId ?? "")) : undefined;
      if (tc) {
        tc.status = Boolean(data.success) ? "success" : "error";
        tc.result = data.result;
      }
      break;
    }
    case "subagent_done": {
      const run = findSubagent(next, String(data.runId ?? ""));
      if (run) {
        run.status = Boolean(data.success) ? "success" : "error";
        run.durationMs = typeof data.durationMs === "number" ? data.durationMs : run.durationMs;
        if (typeof data.finalText === "string" && data.finalText) run.finalText = data.finalText;
      }
      break;
    }
    case "subagent_error": {
      const run = findSubagent(next, String(data.runId ?? ""));
      if (run) {
        run.status = "error";
        run.error = String(data.error ?? "subagent error");
      }
      break;
    }
    case "workflow_start": {
      setDoing();
      const runId = String(data.runId ?? "");
      if (!runId) break;
      upsertWorkflow(next, {
        runId,
        templateId: stringOrUndefined(data.templateId),
        status: "running",
        nodeEvents: [],
        startedAt: now,
      });
      break;
    }
    case "workflow_node_start":
    case "workflow_node_end":
    case "workflow_loop_iteration":
    case "workflow_branch_start":
    case "workflow_error":
    case "workflow_aborted": {
      appendWorkflowEvent(next, event, data, now);
      break;
    }
    case "workflow_end": {
      const run = findWorkflow(next, String(data.runId ?? ""));
      if (run) {
        run.status = "success";
        run.durationMs = typeof data.durationMs === "number" ? data.durationMs : run.durationMs;
      }
      break;
    }
    case "done": {
      next.status = "done";
      next.completedAt = now;
      next.assistant.streaming = false;
      next.pendingConfirm = null;
      next.turnMeta.phase = "generated";
      updateUsage(next, data);
      if (!next.turnMeta.durationMs && next.turnMeta.startedAt) {
        next.turnMeta.durationMs = now - next.turnMeta.startedAt;
      }
      break;
    }
    case "error": {
      const code = String(data.code ?? "");
      next.status = code === "ABORTED" ? "aborted" : "error";
      next.completedAt = now;
      next.assistant.streaming = false;
      next.errorMessage = String(data.message ?? "chat turn failed");
      next.turnMeta.phase = code === "ABORTED" ? "aborted" : "error";
      break;
    }
  }

  if (next.turnMeta.startedAt && next.status === "doing") {
    next.turnMeta.durationMs = Math.max(next.turnMeta.durationMs, now - next.turnMeta.startedAt);
  }
  return next;
}

function updateUsage(snapshot: ChatTurnSnapshot, data: Record<string, unknown>) {
  if (typeof data.promptTokens === "number") snapshot.turnMeta.promptTokens = data.promptTokens;
  if (typeof data.completionTokens === "number") snapshot.turnMeta.completionTokens = data.completionTokens;
  if (typeof data.totalTokens === "number") {
    snapshot.turnMeta.totalTokens = data.totalTokens;
  } else {
    snapshot.turnMeta.totalTokens = snapshot.turnMeta.promptTokens + snapshot.turnMeta.completionTokens;
  }
  if (typeof data.durationMs === "number") snapshot.turnMeta.durationMs = data.durationMs;
}

function upsertToolCall(list: ChatTurnToolCallSnapshot[], call: ChatTurnToolCallSnapshot) {
  const existing = findToolCall(list, call.callId);
  if (existing) Object.assign(existing, call);
  else list.push(call);
}

function findToolCall(list: ChatTurnToolCallSnapshot[], callId: string) {
  return list.find((tc) => tc.callId === callId);
}

function upsertSubagent(snapshot: ChatTurnSnapshot, run: ChatTurnSubagentSnapshot) {
  const existing = findSubagent(snapshot, run.runId);
  if (existing) Object.assign(existing, run);
  else snapshot.subagentRuns.push(run);
}

function findSubagent(snapshot: ChatTurnSnapshot, runId: string) {
  return snapshot.subagentRuns.find((run) => run.runId === runId);
}

function upsertWorkflow(snapshot: ChatTurnSnapshot, run: ChatTurnWorkflowSnapshot) {
  const existing = findWorkflow(snapshot, run.runId);
  if (existing) Object.assign(existing, run);
  else snapshot.workflowRuns.push(run);
}

function findWorkflow(snapshot: ChatTurnSnapshot, runId: string) {
  return snapshot.workflowRuns.find((run) => run.runId === runId);
}

function appendWorkflowEvent(
  snapshot: ChatTurnSnapshot,
  event: string,
  data: Record<string, unknown>,
  now: number,
) {
  const run = findWorkflow(snapshot, String(data.runId ?? ""));
  if (!run) return;
  if (event === "workflow_error") {
    run.status = "error";
    run.error = String(data.error ?? "workflow error");
    run.nodeEvents.push({ kind: "error", nodeId: stringOrUndefined(data.nodeId), error: run.error, ts: now });
    return;
  }
  if (event === "workflow_aborted") {
    run.status = "aborted";
    run.error = String(data.reason ?? "workflow aborted");
    run.nodeEvents.push({ kind: "aborted", reason: run.error, ts: now });
    return;
  }
  if (event === "workflow_node_start") {
    run.nodeEvents.push({
      kind: "node_start",
      nodeId: stringOrUndefined(data.nodeId),
      nodeKind: stringOrUndefined(data.nodeKind),
      nodeType: stringOrUndefined(data.nodeType),
      ts: now,
    });
  } else if (event === "workflow_node_end") {
    run.nodeEvents.push({
      kind: "node_end",
      nodeId: stringOrUndefined(data.nodeId),
      output: data.output,
      ts: now,
    });
  } else if (event === "workflow_loop_iteration") {
    run.nodeEvents.push({
      kind: "loop_iter",
      loopNodeId: stringOrUndefined(data.loopNodeId),
      iter: typeof data.iter === "number" ? data.iter : undefined,
      maxIter: typeof data.maxIter === "number" ? data.maxIter : undefined,
      ts: now,
    });
  } else if (event === "workflow_branch_start") {
    run.nodeEvents.push({
      kind: "branch_start",
      parentNodeId: stringOrUndefined(data.parentNodeId),
      branchIdx: typeof data.branchIdx === "number" ? data.branchIdx : undefined,
      totalBranches: typeof data.totalBranches === "number" ? data.totalBranches : undefined,
      ts: now,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
