-- CreateTable
CREATE TABLE "knowledge_entries" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'web',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "embedding" JSONB,
    "chunkIndex" INTEGER NOT NULL DEFAULT 0,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_entries_agentId_idx" ON "knowledge_entries"("agentId");

-- CreateIndex
CREATE INDEX "knowledge_entries_agentId_createdAt_idx" ON "knowledge_entries"("agentId", "createdAt");
