-- AlterTable: add layout column to ideas for recursive block layout tree
ALTER TABLE "ideas" ADD COLUMN "layout" JSONB;
