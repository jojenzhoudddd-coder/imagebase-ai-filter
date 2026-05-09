/**
 * migrate-workspace-ids — one-shot CLI: migrate all workspace IDs from legacy
 * formats (cuid, "doc_default", etc.) to the new `ws` + 12-digit format.
 *
 * Idempotent: workspaces whose ID already matches /^ws\d{12}$/ are skipped.
 *
 * For each legacy workspace, within a single Prisma $transaction:
 *   1. Generate a new ws-format ID
 *   2. Update all FK references across every table
 *   3. Update the workspace row itself
 *   4. Rename the filesystem directory for idea-attachments (if exists)
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/migrate-workspace-ids.ts [--dry-run]
 */

import fs from "fs";
import path from "path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { generateId, isNewFormatId } from "../services/idGenerator.js";

const IMAGEBASE_HOME = process.env.IMAGEBASE_HOME || path.join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".imagebase",
);
const ATTACHMENTS_DIR = path.join(IMAGEBASE_HOME, "idea-attachments");

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const allWorkspaces = await prisma.workspace.findMany({
      select: { id: true, name: true },
    });

    const toMigrate = allWorkspaces.filter((w) => !isNewFormatId("workspace", w.id));

    if (toMigrate.length === 0) {
      console.log("All workspace IDs already use the ws-format. Nothing to do.");
      return;
    }

    console.log(`Found ${toMigrate.length} workspace(s) to migrate:\n`);

    for (const ws of toMigrate) {
      const oldId = ws.id;
      const newId = await generateId("workspace", async (id) => {
        const existing = await prisma.workspace.findUnique({ where: { id } });
        return !!existing;
      });

      console.log(`  ${oldId} (${ws.name}) -> ${newId}`);

      if (dryRun) continue;

      // Use raw SQL in a transaction to update the PK + all FK references.
      // Prisma doesn't support updating @id fields via the typed client.
      await prisma.$transaction(async (tx) => {
        // Update all FK references first (order doesn't matter within a transaction,
        // but updating children before parent avoids any transient FK violations
        // on databases without deferred constraints).
        const fkTables = [
          "tables",
          "folders",
          "designs",
          "ideas",
          "demos",
          "idea_attachments",
          "mentions",
          "token_usage",
          "agency_sessions",
          "conversations",
        ];

        for (const table of fkTables) {
          await tx.$executeRawUnsafe(
            `UPDATE "${table}" SET "workspaceId" = $1 WHERE "workspaceId" = $2`,
            newId,
            oldId,
          );
        }

        // Update the workspace row itself
        await tx.$executeRawUnsafe(
          `UPDATE "workspaces" SET "id" = $1 WHERE "id" = $2`,
          newId,
          oldId,
        );
      });

      // Rename filesystem directory for idea-attachments
      const oldDir = path.join(ATTACHMENTS_DIR, oldId);
      const newDir = path.join(ATTACHMENTS_DIR, newId);
      if (fs.existsSync(oldDir)) {
        fs.renameSync(oldDir, newDir);
        console.log(`    Renamed attachments: ${oldId}/ -> ${newId}/`);
      }
    }

    if (dryRun) {
      console.log("\n(--dry-run) No changes made.");
    } else {
      console.log(`\nMigrated ${toMigrate.length} workspace(s).`);
    }

    // Verify
    if (!dryRun) {
      const remaining = await prisma.workspace.findMany({
        where: { id: { not: { startsWith: "ws" } } },
        select: { id: true },
      });
      if (remaining.length > 0) {
        console.warn(`\nWARNING: ${remaining.length} workspace(s) still have non-ws IDs:`);
        remaining.forEach((w) => console.warn(`  ${w.id}`));
      } else {
        console.log("Verification passed: all workspace IDs now use ws-format.");
      }
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
