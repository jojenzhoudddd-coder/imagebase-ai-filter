/**
 * Diagnostic: show what conversations exist in the DB.
 *
 * Usage: cd backend && npx tsx src/scripts/conv-check.ts
 *
 * Prints total count, breakdown by workspace, and the 5 latest entries.
 * Used to triage "我的历史对话丢了" reports — conversations live in
 * Postgres and are not affected by DuckDB / Analyst cron cleanup.
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) as any });
  const count = await prisma.conversation.count();
  console.log("Total conversations in DB:", count);
  const perWs = await prisma.conversation.groupBy({
    by: ["workspaceId"],
    _count: true,
  });
  for (const g of perWs) {
    console.log(" ", g.workspaceId, ":", g._count, "conversations");
  }
  const latest = await prisma.conversation.findMany({
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
  console.log("\nLatest 8 conversations:");
  for (const c of latest) {
    console.log(
      " ",
      c.id,
      "·",
      c.title.slice(0, 30).padEnd(30),
      "·",
      c.workspaceId,
      "·",
      c.updatedAt.toISOString().slice(0, 16),
    );
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
