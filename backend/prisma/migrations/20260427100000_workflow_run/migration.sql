-- V2.1 Agent Workflow: WorkflowRun 持久化表
-- 每次 host 调 execute_workflow_template 建一行,timeline + DSL doc + 启动
-- 参数全部沉到 JSON 字段。subagent_runs.workflowNodeId 字段已在 PR3 加,
-- 现在和 workflow_runs.id 形成跨表关联(应用层 join,无 FK 约束以便容忍
-- workflow_runs 行被先清理但 subagent_runs 仍残留的 cleanup 顺序差异)。
CREATE TABLE "workflow_runs" (
  "id"                   TEXT NOT NULL,
  "parentMessageId"      TEXT NOT NULL,
  "parentConversationId" TEXT NOT NULL,
  "hostAgentId"          TEXT NOT NULL,
  "templateId"           TEXT NOT NULL,
  "paramsJson"           JSONB,
  "docJson"              JSONB,
  "nodeEventsJson"       JSONB,
  "status"               TEXT NOT NULL,
  "errorMessage"         TEXT,
  "finalSummary"         TEXT,
  "startedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"          TIMESTAMP(3),
  "durationMs"           INTEGER,

  CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workflow_runs_parentMessageId_idx" ON "workflow_runs"("parentMessageId");
CREATE INDEX "workflow_runs_parentConversationId_startedAt_idx" ON "workflow_runs"("parentConversationId", "startedAt");
