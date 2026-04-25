-- Workspace 增加 AI 摘要字段
ALTER TABLE "workspaces"
  ADD COLUMN "aiSummary" TEXT,
  ADD COLUMN "aiSlogan" TEXT,
  ADD COLUMN "aiSummaryAt" TIMESTAMP(3);

-- Token usage 追踪表
CREATE TABLE "token_usage" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workspaceId" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "feature" TEXT NOT NULL,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "token_usage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "token_usage_workspaceId_createdAt_idx" ON "token_usage"("workspaceId", "createdAt");
CREATE INDEX "token_usage_userId_createdAt_idx" ON "token_usage"("userId", "createdAt");
CREATE INDEX "token_usage_feature_createdAt_idx" ON "token_usage"("feature", "createdAt");
