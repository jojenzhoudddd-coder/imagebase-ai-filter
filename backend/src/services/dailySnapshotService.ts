/**
 * DailySnapshotService — records daily aggregate stats for the admin dashboard.
 *
 * - `recordSnapshot()`: upserts today's stats row
 * - `getHistory(days)`: returns the last N days of snapshots (ASC)
 * - `startDailySnapshotCron()`: hourly check, records if date changed
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function recordSnapshot(): Promise<void> {
  const date = todayDateStr();

  const [userCount, conversationCount, activityCount, tokenAgg] = await Promise.all([
    prisma.user.count(),
    prisma.conversation.count(),
    prisma.message.count({ where: { role: "user" } }),
    prisma.tokenUsage.aggregate({ _sum: { totalTokens: true } }),
  ]);

  const totalTokens = tokenAgg._sum.totalTokens ?? 0;

  await prisma.dailySnapshot.upsert({
    where: { date },
    create: { date, userCount, conversationCount, activityCount, totalTokens },
    update: { userCount, conversationCount, activityCount, totalTokens },
  });

  console.log(`[DailySnapshot] recorded for ${date}: users=${userCount} convs=${conversationCount} activities=${activityCount} tokens=${totalTokens}`);
}

export async function getHistory(days: number): Promise<Array<{
  date: string;
  userCount: number;
  conversationCount: number;
  activityCount: number;
  totalTokens: number;
}>> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const rows = await prisma.dailySnapshot.findMany({
    where: { date: { gte: cutoffStr } },
    orderBy: { date: "asc" },
    select: {
      date: true,
      userCount: true,
      conversationCount: true,
      activityCount: true,
      totalTokens: true,
    },
  });

  return rows;
}

let _lastRecordedDate: string | null = null;
let _intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startDailySnapshotCron(): void {
  if (_intervalHandle) return;
  _lastRecordedDate = todayDateStr();

  // Check every hour if date has changed
  _intervalHandle = setInterval(async () => {
    const now = todayDateStr();
    if (now !== _lastRecordedDate) {
      _lastRecordedDate = now;
      try {
        await recordSnapshot();
      } catch (err) {
        console.warn("[DailySnapshot] cron error (non-fatal):", err);
      }
    }
  }, 60 * 60 * 1000); // 1 hour

  // Don't hold the event loop open
  _intervalHandle.unref();
}

export function stopDailySnapshotCron(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}
