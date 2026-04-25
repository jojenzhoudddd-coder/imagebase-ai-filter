-- Per-user UI preferences (theme / locale / safe-delete).
-- 默认 {} 表示走 localStorage / 系统默认；用户首次切换后写进来。
ALTER TABLE "users"
  ADD COLUMN "preferences" JSONB NOT NULL DEFAULT '{}'::jsonb;
