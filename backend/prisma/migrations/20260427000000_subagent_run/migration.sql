-- PR3 Agent Workflow: SubagentRun 表
-- 记录 host agent 通过 spawn_subagent 工具 (或 PR4 workflow 的 subagent
-- action) 拉起的子 agent 调用。子消息不写 messages 表 (避免污染主对话历史),
-- 沉到 toolCallsJson + finalText,host 上下文只看 finalText。
CREATE TABLE "subagent_runs" (
  "id"                     TEXT NOT NULL,
  "parentMessageId"        TEXT NOT NULL,
  "parentConversationId"   TEXT NOT NULL,
  "hostAgentId"            TEXT NOT NULL,
  "subagentModel"          TEXT NOT NULL,
  "requestedModel"         TEXT NOT NULL,
  "systemPrompt"           TEXT NOT NULL,
  "userPrompt"             TEXT NOT NULL,
  "allowedTools"           TEXT[] DEFAULT ARRAY[]::TEXT[],
  "maxRounds"              INTEGER NOT NULL DEFAULT 10,
  "parentSubagentRunId"    TEXT,
  "depth"                  INTEGER NOT NULL DEFAULT 0,
  "workflowNodeId"         TEXT,
  "status"                 TEXT NOT NULL,
  "finalText"              TEXT,
  "thinkingText"           TEXT,
  "toolCallsJson"          JSONB,
  "errorMessage"           TEXT,
  "startedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"            TIMESTAMP(3),
  "durationMs"             INTEGER,
  "promptTokens"           INTEGER,
  "completionTokens"       INTEGER,

  CONSTRAINT "subagent_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "subagent_runs_parentMessageId_idx" ON "subagent_runs"("parentMessageId");
CREATE INDEX "subagent_runs_parentConversationId_startedAt_idx" ON "subagent_runs"("parentConversationId", "startedAt");
CREATE INDEX "subagent_runs_parentSubagentRunId_idx" ON "subagent_runs"("parentSubagentRunId");
