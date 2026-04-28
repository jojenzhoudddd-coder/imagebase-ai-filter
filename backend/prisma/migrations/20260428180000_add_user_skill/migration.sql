-- Skill Creator V1: UserSkill 表
-- 用户/Agent 自助创建的 skill 容器。三类资产任意非空即有效:
--   - promptFragment: 注入 system prompt 的策略/术语片段
--   - workflowDocs[]:  WorkflowDoc DSL 数组,激活后变成 invoke_skill_workflow_<id>_<i> 工具
--   - toolWhitelist[]: 激活时可用的 tool 白名单 (V2 启用,V1 写库不消费)
-- scriptHandlers (确定性代码) 留给 V2,需 isolated-vm sandbox。
-- 详见 docs/skill-creator-plan.md。
CREATE TABLE "user_skills" (
  "id"                   TEXT NOT NULL,
  "ownerType"            TEXT NOT NULL,                 -- "agent" | "workspace" | "global"
  "ownerId"              TEXT NOT NULL,                 -- agentId / workspaceId / null-for-global
  "name"                 TEXT NOT NULL,
  "description"          TEXT NOT NULL DEFAULT '',
  "triggers"             JSONB NOT NULL,                -- string[]

  "promptFragment"       TEXT,
  "workflowDocs"         JSONB,                         -- WorkflowDoc[]
  "toolWhitelist"        JSONB,                         -- string[]

  "sourceConversationId" TEXT,
  "sourceWorkflowRunId"  TEXT,

  "enabled"              BOOLEAN NOT NULL DEFAULT TRUE,
  "invokedCount"         INTEGER NOT NULL DEFAULT 0,
  "lastInvokedAt"        TIMESTAMP(3),

  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_skills_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_skills_ownerType_ownerId_idx"
  ON "user_skills"("ownerType", "ownerId");
CREATE INDEX "user_skills_enabled_idx"
  ON "user_skills"("enabled");
