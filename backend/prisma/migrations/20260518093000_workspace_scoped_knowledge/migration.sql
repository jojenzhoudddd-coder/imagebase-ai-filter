ALTER TABLE "knowledge_entries" ADD COLUMN "workspaceId" TEXT;
CREATE INDEX "knowledge_entries_agentId_workspaceId_idx" ON "knowledge_entries"("agentId", "workspaceId");
