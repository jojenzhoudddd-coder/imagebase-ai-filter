/**
 * Analyst cleanup cron — periodic housekeeping for DuckDB sessions + snapshots.
 *
 * Runs in the same Node process as the main backend, gated on
 * `RUNTIME_DISABLED` so tests / one-off scripts don't spin up background
 * timers. Fires every 30 min:
 *   1. Close sessions whose last activity is > IDLE_CLOSE_MS ago (keeps the
 *      file, just releases the DuckDB handle + memory).
 *   2. Delete `.duckdb` files older than `STALE_FILE_MS` (default 7d).
 *   3. Delete parquet snapshots older than `SNAPSHOT_MAX_AGE_MS` (30d).
 *
 * All steps are best-effort — we log failures and keep going.
 */

import path from "path";
import fsp from "fs/promises";
import {
  listOpenSessions,
  closeSession,
  ANALYST_HOME,
  sessionFilePath,
} from "./duckdbRuntime.js";
import { purgeOldSnapshots } from "./snapshotService.js";
import { purgeCache } from "./resultCache.js";

const INTERVAL_MS = Number(process.env.ANALYST_CLEANUP_INTERVAL_MS) || 30 * 60_000;
const IDLE_CLOSE_MS = Number(process.env.ANALYST_IDLE_CLOSE_MS) || 2 * 3_600_000; // 2h
const STALE_FILE_MS = Number(process.env.ANALYST_STALE_FILE_MS) || 7 * 86_400_000;
const SNAPSHOT_MAX_AGE_MS = Number(process.env.ANALYST_SNAPSHOT_MAX_AGE_MS) || 30 * 86_400_000;

let handle: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  const gmt8 = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 19);
  try {
    const now = Date.now();

    // Step 1 — close idle sessions
    const sessions = listOpenSessions();
    let closed = 0;
    for (const s of sessions) {
      if (now - s.lastActiveAt >= IDLE_CLOSE_MS) {
        try {
          await closeSession(s.conversationId);
          closed++;
        } catch {
          /* ignore */
        }
      }
    }

    // Step 2 — delete stale session files (only those not currently open)
    const sessionsDir = path.join(ANALYST_HOME, "sessions");
    const files = (await fsp.readdir(sessionsDir).catch(() => [])) as string[];
    const openIds = new Set(listOpenSessions().map((s) => s.conversationId));
    let deletedFiles = 0;
    for (const f of files) {
      if (!f.endsWith(".duckdb")) continue;
      const convId = f.replace(/^conv_/, "").replace(/\.duckdb$/, "");
      if (openIds.has(convId)) continue;
      const full = path.join(sessionsDir, f);
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat) continue;
      if (now - stat.mtimeMs >= STALE_FILE_MS) {
        try {
          await fsp.unlink(full);
          // Also clean the matching WAL/SHM sidecars if any
          for (const ext of [".wal", ".shm"]) {
            await fsp.unlink(sessionFilePath(convId) + ext).catch(() => undefined);
          }
          deletedFiles++;
        } catch {
          /* ignore */
        }
      }
    }

    // Step 3 — purge old snapshots
    const snapRes = await purgeOldSnapshots(SNAPSHOT_MAX_AGE_MS);

    // Step 4 — purge stale cross-conversation cache entries (P5)
    const cacheRes = await purgeCache(SNAPSHOT_MAX_AGE_MS);

    console.log(
      `[analyst-cleanup] ${gmt8} idle-closed=${closed} file-deleted=${deletedFiles} snapshots-purged=${snapRes.removed.length} cache-purged=${cacheRes.removed}`,
    );
  } catch (err) {
    console.warn(`[analyst-cleanup] ${gmt8} error:`, err);
  } finally {
    running = false;
  }
}

/** Kick off the cleanup cron. Safe to call multiple times. */
export function startAnalystCleanup(): void {
  if (handle) return;
  if (process.env.RUNTIME_DISABLED === "1") {
    console.log("[analyst-cleanup] disabled via RUNTIME_DISABLED=1");
    return;
  }
  // Run once after a 60s warmup so we don't compete with boot IO.
  setTimeout(() => void tick(), 60_000);
  handle = setInterval(() => void tick(), INTERVAL_MS);
  handle.unref?.();
  console.log(`[analyst-cleanup] scheduled every ${INTERVAL_MS}ms`);
}

export async function stopAnalystCleanup(): Promise<void> {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}

export async function runCleanupOnce(): Promise<void> {
  await tick();
}
