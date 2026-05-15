-- AlterTable: add parentId and version to idea_blocks for block tree support (PR-A)
ALTER TABLE "idea_blocks" ADD COLUMN "parentId" TEXT;
ALTER TABLE "idea_blocks" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex: parentId + order for efficient child queries
CREATE INDEX "idea_blocks_parentId_order_idx" ON "idea_blocks"("parentId", "order");

-- AddForeignKey: self-relation for block tree
ALTER TABLE "idea_blocks" ADD CONSTRAINT "idea_blocks_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "idea_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
