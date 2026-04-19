-- CreateTable
CREATE TABLE "designs" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "figmaUrl" TEXT NOT NULL,
    "figmaFileKey" TEXT NOT NULL,
    "figmaNodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "designs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "designs_documentId_idx" ON "designs"("documentId");

-- CreateIndex
CREATE INDEX "designs_parentId_idx" ON "designs"("parentId");

-- AddForeignKey
ALTER TABLE "designs" ADD CONSTRAINT "designs_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
