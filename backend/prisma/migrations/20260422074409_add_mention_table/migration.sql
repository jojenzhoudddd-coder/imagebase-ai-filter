-- CreateTable
CREATE TABLE "mentions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "rawLabel" TEXT NOT NULL,
    "contextExcerpt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mentions_workspaceId_targetType_targetId_idx" ON "mentions"("workspaceId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "mentions_sourceType_sourceId_idx" ON "mentions"("sourceType", "sourceId");
