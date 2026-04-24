-- Add password auth + optional username login handle to users.
-- Both columns nullable so existing rows survive; we stamp the seed user
-- with a bcrypt hash + username in the follow-up backfill migration.

ALTER TABLE "users"
  ADD COLUMN "username" TEXT,
  ADD COLUMN "passwordHash" TEXT;

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
