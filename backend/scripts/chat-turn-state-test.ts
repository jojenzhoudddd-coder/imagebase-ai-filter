import assert from "node:assert/strict";
import {
  createInitialTurnSnapshot,
  reduceChatTurnSnapshot,
} from "../src/services/chatTurnSnapshot.js";

function run() {
  let s = createInitialTurnSnapshot({
    turnRunId: "tr_test",
    conversationId: "cv_test",
    requestText: "build a table",
    status: "doing",
    modelId: "claude-test",
    now: 1_000,
  });

  s = reduceChatTurnSnapshot(s, "start", { messageId: "asst_1", model: "claude-test" }, { seq: 1, now: 1_100 });
  s = reduceChatTurnSnapshot(s, "thinking", { text: "plan " }, { seq: 2, now: 1_200 });
  s = reduceChatTurnSnapshot(s, "message", { text: "hello " }, { seq: 3, now: 1_300 });
  s = reduceChatTurnSnapshot(s, "message", { text: "world" }, { seq: 4, now: 1_400 });
  assert.equal(s.assistant.messageId, "asst_1");
  assert.equal(s.assistant.thinking, "plan ");
  assert.equal(s.assistant.content, "hello world");
  assert.equal(s.lastSeq, 4);

  let queued = createInitialTurnSnapshot({
    turnRunId: "tr_queued",
    conversationId: "cv_test",
    requestText: "queued query",
    userMessageId: "user_queued",
    status: "queued",
    now: 2_000,
  });
  queued = reduceChatTurnSnapshot(
    queued,
    "turn_promoted",
    { messageId: "user_queued", modelId: "claude-test" },
    { seq: 1, now: 2_100 },
  );
  assert.equal(queued.status, "doing");
  assert.equal(queued.userMessageId, "user_queued");
  assert.equal(queued.assistant.messageId, null);
  queued = reduceChatTurnSnapshot(
    queued,
    "start",
    { messageId: "asst_queued", model: "claude-test" },
    { seq: 2, now: 2_200 },
  );
  assert.equal(queued.assistant.messageId, "asst_queued");

  s = reduceChatTurnSnapshot(s, "tool_start", {
    callId: "call_1",
    tool: "create_table",
    args: { name: "Leads" },
  }, { seq: 5, now: 1_500 });
  s = reduceChatTurnSnapshot(s, "tool_progress", {
    callId: "call_1",
    message: "creating",
    elapsedMs: 200,
  }, { seq: 6, now: 1_600 });
  s = reduceChatTurnSnapshot(s, "tool_result", {
    callId: "call_1",
    success: true,
    result: { tableId: "tb_1" },
  }, { seq: 7, now: 1_700 });
  assert.equal(s.toolCalls.length, 1);
  assert.equal(s.toolCalls[0].status, "success");
  assert.deepEqual(s.toolCalls[0].result, { tableId: "tb_1" });

  s = reduceChatTurnSnapshot(s, "subagent_start", {
    runId: "sr_1",
    requestedModel: "gpt",
    resolvedModel: "gpt",
    userPrompt: "check",
  }, { seq: 8, now: 1_800 });
  s = reduceChatTurnSnapshot(s, "subagent_message", { runId: "sr_1", text: "ok" }, { seq: 9, now: 1_900 });
  s = reduceChatTurnSnapshot(s, "subagent_done", {
    runId: "sr_1",
    success: true,
    durationMs: 300,
    finalText: "ok",
  }, { seq: 10, now: 2_000 });
  assert.equal(s.subagentRuns[0].status, "success");
  assert.equal(s.subagentRuns[0].finalText, "ok");

  s = reduceChatTurnSnapshot(s, "workflow_start", {
    runId: "wf_1",
    templateId: "custom",
  }, { seq: 11, now: 2_100 });
  s = reduceChatTurnSnapshot(s, "workflow_node_start", {
    runId: "wf_1",
    nodeId: "n1",
    nodeKind: "action",
    nodeType: "subagent",
  }, { seq: 12, now: 2_200 });
  s = reduceChatTurnSnapshot(s, "workflow_end", {
    runId: "wf_1",
    durationMs: 500,
  }, { seq: 13, now: 2_300 });
  assert.equal(s.workflowRuns[0].status, "success");
  assert.equal(s.workflowRuns[0].nodeEvents[0].kind, "node_start");

  s = reduceChatTurnSnapshot(s, "turn_usage", {
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    durationMs: 1_500,
  }, { seq: 14, now: 2_400 });
  assert.equal(s.turnMeta.totalTokens, 30);
  assert.equal(s.turnMeta.durationMs, 1_500);

  s = reduceChatTurnSnapshot(s, "done", {
    durationMs: 2_000,
    promptTokens: 11,
    completionTokens: 22,
    totalTokens: 33,
  }, { seq: 15, now: 3_000 });
  assert.equal(s.status, "done");
  assert.equal(s.assistant.streaming, false);
  assert.equal(s.turnMeta.phase, "generated");
  assert.equal(s.turnMeta.totalTokens, 33);

  let e = createInitialTurnSnapshot({
    turnRunId: "tr_error",
    conversationId: "cv_test",
    requestText: "stop",
    status: "doing",
    now: 10,
  });
  e = reduceChatTurnSnapshot(e, "error", { code: "ABORTED", message: "user_stop" }, { seq: 1, now: 20 });
  assert.equal(e.status, "aborted");
  assert.equal(e.turnMeta.phase, "aborted");
  assert.equal(e.errorMessage, "user_stop");
}

run();
console.log("chat-turn-state-test passed");
