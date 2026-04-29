-- PR6: Idea 双轨 schema —— IdeaBlock 表派生自 Idea.content,FE 在 PR7+ 切到
-- block 渲染。Idea.content 仍是 source of truth (旧 API 兼容);写时在同
-- $transaction 里 deleteMany + createMany 同步这张表。
--
-- 现有 ideas 行通过应用启动时 lazy backfill 填充 (idea 第一次被读 / 写时
-- 顺手 syncBlocksForIdea)。Migration 只建表,不批量 backfill。

CREATE TABLE "idea_blocks" (
  "id"        TEXT NOT NULL,
  "ideaId"    TEXT NOT NULL,
  "order"     DOUBLE PRECISION NOT NULL,
  "type"      TEXT NOT NULL,
  "content"   TEXT NOT NULL,
  "props"     JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "idea_blocks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idea_blocks_ideaId_order_idx"
  ON "idea_blocks"("ideaId", "order");

ALTER TABLE "idea_blocks"
  ADD CONSTRAINT "idea_blocks_ideaId_fkey"
  FOREIGN KEY ("ideaId") REFERENCES "ideas"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
