-- Persistent chat turn runtime state and replayable SSE event log.

CREATE TABLE "chat_turn_runs" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "requestText" TEXT NOT NULL,
    "userMessageId" TEXT,
    "assistantMessageId" TEXT,
    "modelId" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "snapshotJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_turn_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "chat_turn_events" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "turnRunId" TEXT,
    "seq" INTEGER NOT NULL,
    "event" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_turn_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_turn_runs_conversationId_status_createdAt_idx" ON "chat_turn_runs"("conversationId", "status", "createdAt");
CREATE INDEX "chat_turn_runs_workspaceId_status_createdAt_idx" ON "chat_turn_runs"("workspaceId", "status", "createdAt");

CREATE UNIQUE INDEX "chat_turn_events_conversationId_seq_key" ON "chat_turn_events"("conversationId", "seq");
CREATE INDEX "chat_turn_events_conversationId_seq_idx" ON "chat_turn_events"("conversationId", "seq");
CREATE INDEX "chat_turn_events_turnRunId_seq_idx" ON "chat_turn_events"("turnRunId", "seq");

ALTER TABLE "chat_turn_runs"
  ADD CONSTRAINT "chat_turn_runs_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_turn_events"
  ADD CONSTRAINT "chat_turn_events_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_turn_events"
  ADD CONSTRAINT "chat_turn_events_turnRunId_fkey"
  FOREIGN KEY ("turnRunId") REFERENCES "chat_turn_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
