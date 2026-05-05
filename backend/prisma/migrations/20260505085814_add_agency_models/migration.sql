-- CreateTable
CREATE TABLE "agency_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "todos" JSONB NOT NULL DEFAULT '[]',
    "fromScope" JSONB NOT NULL DEFAULT '{}',
    "chaosMonkeyModel" TEXT NOT NULL DEFAULT 'gpt-5.5',
    "status" TEXT NOT NULL DEFAULT 'planning',
    "roadmap" JSONB,
    "currentSegmentIndex" INTEGER NOT NULL DEFAULT 0,
    "currentMilestoneIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "agency_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_milestones" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "milestoneIndex" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "acceptanceCriteria" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "conversationId" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "failureHistory" JSONB NOT NULL DEFAULT '[]',
    "validationResult" JSONB,
    "durationMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_checkpoints" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "milestoneId" TEXT,
    "artifactType" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agency_sessions_userId_status_idx" ON "agency_sessions"("userId", "status");

-- CreateIndex
CREATE INDEX "agency_sessions_workspaceId_idx" ON "agency_sessions"("workspaceId");

-- CreateIndex
CREATE INDEX "agency_milestones_sessionId_segmentIndex_milestoneIndex_idx" ON "agency_milestones"("sessionId", "segmentIndex", "milestoneIndex");

-- CreateIndex
CREATE INDEX "agency_checkpoints_sessionId_idx" ON "agency_checkpoints"("sessionId");

-- AddForeignKey
ALTER TABLE "agency_milestones" ADD CONSTRAINT "agency_milestones_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "agency_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_checkpoints" ADD CONSTRAINT "agency_checkpoints_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "agency_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
