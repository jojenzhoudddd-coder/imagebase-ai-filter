-- AlterTable
ALTER TABLE "tastes" ADD COLUMN     "meta" JSONB,
ADD COLUMN     "metaGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "svgHash" TEXT;
