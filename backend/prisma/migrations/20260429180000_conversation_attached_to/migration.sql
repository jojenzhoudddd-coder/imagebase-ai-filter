-- PR9: Conversation 加 attached_to_* 字段,支持"挂在某 idea block / taste /
-- table-record 上的评论对话"。普通对话不填(NULL)。FE 在 IdeaEditor 通过
-- GET /api/ideas/:id/comments 反查该 idea 所有 block 上的对话。

ALTER TABLE "conversations"
  ADD COLUMN "attachedToType" TEXT,
  ADD COLUMN "attachedToId"   TEXT;

CREATE INDEX "conversations_attachedToType_attachedToId_idx"
  ON "conversations"("attachedToType", "attachedToId");
