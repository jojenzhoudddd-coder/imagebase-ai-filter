/**
 * One-time migration: for every Idea that has content but no IdeaBlock rows,
 * run syncBlocksForIdea to parse the Markdown into blocks.
 *
 * Safe to run multiple times — skips ideas that already have blocks.
 *
 * Usage:
 *   npx tsx backend/src/scripts/migrate-ideas-to-blocks.ts
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { syncBlocksForIdea } from "../services/ideaBlockService.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter }) as any;

async function main() {
  // Find ideas with content but no blocks
  const allIdeas = await prisma.idea.findMany({
    select: { id: true, name: true, content: true },
    where: { content: { not: "" } },
  });

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const idea of allIdeas) {
    // Check if blocks already exist
    const blockCount = await prisma.ideaBlock.count({
      where: { ideaId: idea.id },
    });
    if (blockCount > 0) {
      skipped++;
      continue;
    }

    // No blocks — run sync
    try {
      const count = await prisma.$transaction(async (tx: any) => {
        return syncBlocksForIdea(tx, idea.id, idea.content);
      });
      migrated++;
      console.log(`✓ [${idea.id}] "${idea.name}" → ${count} blocks`);
    } catch (err) {
      failed++;
      console.error(`✗ [${idea.id}] "${idea.name}" — ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nDone: ${migrated} migrated, ${skipped} already had blocks, ${failed} failed.`);
  await prisma.$disconnect();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
