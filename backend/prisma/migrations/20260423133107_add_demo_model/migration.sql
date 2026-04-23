-- CreateTable
CREATE TABLE "demos" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "parentId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "template" TEXT NOT NULL DEFAULT 'static',
    "version" INTEGER NOT NULL DEFAULT 0,
    "dataTables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dataIdeas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "lastBuildAt" TIMESTAMP(3),
    "lastBuildStatus" TEXT,
    "lastBuildError" TEXT,
    "publishSlug" TEXT,
    "publishedVersion" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "demos_publishSlug_key" ON "demos"("publishSlug");

-- CreateIndex
CREATE INDEX "demos_workspaceId_idx" ON "demos"("workspaceId");

-- CreateIndex
CREATE INDEX "demos_publishSlug_idx" ON "demos"("publishSlug");

-- AddForeignKey
ALTER TABLE "demos" ADD CONSTRAINT "demos_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
