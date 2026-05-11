/**
 * One-off script: backfill DailySnapshot for the past 7 days.
 *
 * For each day, counts cumulative users / conversations / user-messages / tokens
 * created on or before that day's end (23:59:59.999 UTC).
 *
 * Usage:  npx tsx backend/src/scripts/backfill-snapshots.ts
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

async function main() {
  const now = new Date();
  const days = 7;

  for (let i = days; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10); // "2026-05-04"
    const endOfDay = new Date(dateStr + "T23:59:59.999Z");

    const [userCount, conversationCount, activityCount, tokenAgg] =
      await Promise.all([
        prisma.user.count({ where: { createdAt: { lte: endOfDay } } }),
        prisma.conversation.count({ where: { createdAt: { lte: endOfDay } } }),
        prisma.message.count({
          where: { role: "user", timestamp: { lte: endOfDay } },
        }),
        prisma.tokenUsage.aggregate({
          _sum: { totalTokens: true },
          where: { createdAt: { lte: endOfDay } },
        }),
      ]);

    const totalTokens = tokenAgg._sum.totalTokens ?? 0;

    await prisma.dailySnapshot.upsert({
      where: { date: dateStr },
      create: { date: dateStr, userCount, conversationCount, activityCount, totalTokens },
      update: { userCount, conversationCount, activityCount, totalTokens },
    });

    console.log(
      `[Backfill] ${dateStr}: users=${userCount} convs=${conversationCount} activities=${activityCount} tokens=${totalTokens}`
    );
  }

  console.log("Done.");
  await prisma.$disconnect();
  pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
