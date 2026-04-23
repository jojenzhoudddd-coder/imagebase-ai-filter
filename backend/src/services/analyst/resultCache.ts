/**
 * Cross-conversation result cache (P5).
 *
 * Problem this solves: when two users (or the same user across sessions)
 * ask the same aggregation question over the same snapshot, re-running the
 * full group_aggregate is wasteful. We cache the result parquet under a
 * deterministic key derived from:
 *
 *   (canonical_sql, source_snapshot_hashes)
 *
 * keyed by SHA-256. On hit we COPY FROM parquet into a new per-conversation
 * result table and return meta without re-running the expensive agg.
 *
 * Invalidation is automatic: any fresh snapshot creates a new hash, so the
 * old cached entries for that table become unreachable (and get GC'd by
 * cleanupCron after 30 days).
 *
 * Scope: opt-in at the route level. Callers pass `cacheKey` to persist +
 * recall; tools that don't benefit (preview / describe / run_sql ad-hoc)
 * skip it.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { ANALYST_HOME } from "./duckdbRuntime.js";

const CACHE_DIR = path.join(ANALYST_HOME, "cache");

async function ensureCacheDir(): Promise<void> {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
}

function keyToPath(key: string): string {
  return path.join(CACHE_DIR, `digest_${key}.parquet`);
}

/** Build a deterministic cache key for a query + set of source snapshots.
 * The SQL is minified (collapse whitespace) so identical queries with
 * different formatting hit the same entry. */
export function buildCacheKey(
  canonicalSql: string,
  sourceSnapshotAts: string[],
): string {
  const sql = canonicalSql.replace(/\s+/g, " ").trim();
  const snaps = [...sourceSnapshotAts].sort().join("|");
  const hash = crypto.createHash("sha256").update(`${sql}||${snaps}`).digest("hex");
  return hash.slice(0, 32);
}

export async function hasCacheHit(key: string): Promise<boolean> {
  try {
    await fsp.access(keyToPath(key));
    return true;
  } catch {
    return false;
  }
}

/** Return the parquet path for a cache hit, or null. */
export function cachePath(key: string): string | null {
  const p = keyToPath(key);
  return fs.existsSync(p) ? p : null;
}

export async function putCache(key: string, sourceParquetPath: string): Promise<void> {
  await ensureCacheDir();
  const target = keyToPath(key);
  await fsp.copyFile(sourceParquetPath, target);
}

/** Purge cache entries older than `olderThanDays`. */
export async function purgeCache(olderThanMs = 30 * 86_400_000): Promise<{ removed: number }> {
  await ensureCacheDir();
  const files = await fsp.readdir(CACHE_DIR).catch(() => []);
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith(".parquet")) continue;
    const full = path.join(CACHE_DIR, f);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) continue;
    if (stat.mtimeMs < cutoff) {
      try { await fsp.unlink(full); removed++; } catch { /* ignore */ }
    }
  }
  return { removed };
}

export async function listCache(): Promise<Array<{ key: string; path: string; size: number }>> {
  await ensureCacheDir();
  const files = await fsp.readdir(CACHE_DIR).catch(() => []);
  const out: Array<{ key: string; path: string; size: number }> = [];
  for (const f of files) {
    if (!f.endsWith(".parquet")) continue;
    const match = f.match(/^digest_([a-f0-9]+)\.parquet$/);
    if (!match) continue;
    const full = path.join(CACHE_DIR, f);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) continue;
    out.push({ key: match[1], path: full, size: stat.size });
  }
  return out;
}

export function cacheDir(): string {
  return CACHE_DIR;
}
