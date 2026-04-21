-- AlterTable
ALTER TABLE "ideas" ADD COLUMN     "sections" JSONB NOT NULL DEFAULT '[]';
