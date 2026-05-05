-- CreateTable
CREATE TABLE "custom_models" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "providerModelId" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "group" TEXT NOT NULL DEFAULT 'custom',
    "specialty" TEXT,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_models_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_models_userId_idx" ON "custom_models"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_models_userId_modelId_key" ON "custom_models"("userId", "modelId");

-- AddForeignKey
ALTER TABLE "custom_models" ADD CONSTRAINT "custom_models_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
