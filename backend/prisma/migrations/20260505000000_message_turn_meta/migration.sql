-- V3.0 UX: persist per-turn meta (duration + token usage) on assistant messages
-- so refreshing the page still shows "Generated · X 秒 · Y tokens" on history bubbles.
-- All three columns nullable — only set when chatAgentService writes the
-- assistant message at end of turn (done event); user messages and aborted
-- turns leave them NULL.

ALTER TABLE "messages"
  ADD COLUMN "durationMs" INTEGER,
  ADD COLUMN "promptTokens" INTEGER,
  ADD COLUMN "completionTokens" INTEGER;
