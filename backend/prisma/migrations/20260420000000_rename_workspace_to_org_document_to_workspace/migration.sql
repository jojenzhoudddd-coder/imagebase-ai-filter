-- Phase 0: 大重命名
--   旧 Workspace → Org（上层组织）
--   旧 Document  → Workspace（实际 artifact 容器）
--   所有 documentId 外键 → workspaceId
-- 纯 ALTER RENAME，不涉及 DROP/CREATE，数据零丢失。

BEGIN;

-- ────────────────────────────────────────────────────────────
-- Step 1: workspaces / workspace_members → orgs / org_members
-- ────────────────────────────────────────────────────────────

-- 1.1 表重命名
ALTER TABLE "workspaces" RENAME TO "orgs";
ALTER TABLE "workspace_members" RENAME TO "org_members";

-- 1.2 org_members 列重命名：workspaceId → orgId
ALTER TABLE "org_members" RENAME COLUMN "workspaceId" TO "orgId";

-- 1.3 主键约束重命名
ALTER TABLE "orgs" RENAME CONSTRAINT "workspaces_pkey" TO "orgs_pkey";
ALTER TABLE "org_members" RENAME CONSTRAINT "workspace_members_pkey" TO "org_members_pkey";

-- 1.4 唯一索引重命名（先删旧索引，再用新列名建新索引，避免 Prisma drift）
DROP INDEX IF EXISTS "workspace_members_workspaceId_userId_key";
CREATE UNIQUE INDEX "org_members_orgId_userId_key" ON "org_members"("orgId", "userId");

-- 1.5 外键重命名
ALTER TABLE "org_members"
  DROP CONSTRAINT "workspace_members_workspaceId_fkey",
  DROP CONSTRAINT "workspace_members_userId_fkey";

ALTER TABLE "org_members"
  ADD CONSTRAINT "org_members_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "org_members_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────
-- Step 2: documents → workspaces（同名复用，此时旧 workspaces 已改名为 orgs）
-- ────────────────────────────────────────────────────────────

-- 2.1 表重命名
ALTER TABLE "documents" RENAME TO "workspaces";

-- 2.2 新 workspaces 列重命名：原 workspaceId（指向旧 Workspace）→ orgId（指向新 Org）
ALTER TABLE "workspaces" RENAME COLUMN "workspaceId" TO "orgId";

-- 2.3 主键
ALTER TABLE "workspaces" RENAME CONSTRAINT "documents_pkey" TO "workspaces_pkey";

-- 2.4 索引
DROP INDEX IF EXISTS "documents_workspaceId_idx";
CREATE INDEX "workspaces_orgId_idx" ON "workspaces"("orgId");

-- 2.5 外键
ALTER TABLE "workspaces"
  DROP CONSTRAINT "documents_workspaceId_fkey",
  DROP CONSTRAINT "documents_createdById_fkey";

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "workspaces_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────
-- Step 3: artifact 外键 documentId → workspaceId
-- ────────────────────────────────────────────────────────────

-- 3.1 tables
ALTER TABLE "tables" RENAME COLUMN "documentId" TO "workspaceId";
DROP INDEX IF EXISTS "tables_documentId_idx";
CREATE INDEX "tables_workspaceId_idx" ON "tables"("workspaceId");
ALTER TABLE "tables" DROP CONSTRAINT "tables_documentId_fkey";
ALTER TABLE "tables"
  ADD CONSTRAINT "tables_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3.2 folders
ALTER TABLE "folders" RENAME COLUMN "documentId" TO "workspaceId";
DROP INDEX IF EXISTS "folders_documentId_idx";
CREATE INDEX "folders_workspaceId_idx" ON "folders"("workspaceId");
ALTER TABLE "folders" DROP CONSTRAINT "folders_documentId_fkey";
ALTER TABLE "folders"
  ADD CONSTRAINT "folders_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3.3 designs
ALTER TABLE "designs" RENAME COLUMN "documentId" TO "workspaceId";
DROP INDEX IF EXISTS "designs_documentId_idx";
CREATE INDEX "designs_workspaceId_idx" ON "designs"("workspaceId");
ALTER TABLE "designs" DROP CONSTRAINT "designs_documentId_fkey";
ALTER TABLE "designs"
  ADD CONSTRAINT "designs_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3.4 conversations
ALTER TABLE "conversations" RENAME COLUMN "documentId" TO "workspaceId";
DROP INDEX IF EXISTS "conversations_documentId_updatedAt_idx";
CREATE INDEX "conversations_workspaceId_updatedAt_idx" ON "conversations"("workspaceId", "updatedAt" DESC);

COMMIT;
