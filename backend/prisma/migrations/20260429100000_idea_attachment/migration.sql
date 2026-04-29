-- PR5: Idea attachment 管线
-- 让 Idea 能贴图 / SVG / PDF / 视频。Markdown 主体只存 URL,实际 blob 走
-- BlobStorage (idea-attachments/<wsId>/<hash>.<ext>),元数据存这张表。
-- 同 (workspaceId, hash) 内 dedup;Idea 删除级联清行,blob 在路由层 reap。

CREATE TABLE "idea_attachments" (
  "id"           TEXT NOT NULL,
  "ideaId"       TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "hash"         TEXT NOT NULL,
  "ext"          TEXT NOT NULL,
  "mime"         TEXT NOT NULL,
  "size"         INTEGER NOT NULL,
  "originalName" TEXT NOT NULL DEFAULT '',
  "uploadedBy"   TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "idea_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idea_attachments_ideaId_idx" ON "idea_attachments"("ideaId");
CREATE INDEX "idea_attachments_workspaceId_hash_idx"
  ON "idea_attachments"("workspaceId", "hash");

ALTER TABLE "idea_attachments"
  ADD CONSTRAINT "idea_attachments_ideaId_fkey"
  FOREIGN KEY ("ideaId") REFERENCES "ideas"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
