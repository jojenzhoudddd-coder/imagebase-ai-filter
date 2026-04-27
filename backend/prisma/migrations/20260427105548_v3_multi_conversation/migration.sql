-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'idle';

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "branchTag" TEXT,
ADD COLUMN     "parentMessageId" TEXT,
ADD COLUMN     "seq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "subagent_runs" ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "kind" TEXT,
ADD COLUMN     "workflowRunId" TEXT;

-- CreateIndex
CREATE INDEX "conversations_workspaceId_createdAt_idx" ON "conversations"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "messages_conversationId_seq_idx" ON "messages"("conversationId", "seq");

-- CreateIndex
CREATE INDEX "subagent_runs_branchId_idx" ON "subagent_runs"("branchId");
