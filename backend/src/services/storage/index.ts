/**
 * BlobStorage singleton — the way all app code should reach into asset
 * storage. Use `getBlobStorage()` (lazy) or import the module-level
 * `blobStorage` (eager) — they return the same instance.
 *
 * Today: `local` only. `s3` will be added at launch hardening (see
 * docs/launch-checklist.md Phase 0.2). Selection via env:
 *
 *   BLOB_STORAGE_BACKEND=local        # default; uses LocalFsStorage
 *   IMAGEBASE_HOME=/var/lib/imagebase # local root (default ~/.imagebase)
 *
 *   BLOB_STORAGE_BACKEND=s3           # not implemented yet — throws
 *   S3_BUCKET=...
 *   S3_REGION=...
 *   ...
 *
 * Why a singleton: the local fs root is set once per process at boot, and
 * we don't want N callers each constructing a new instance with potentially
 * different roots. Future S3 will need shared SDK clients / connection pools.
 */

import os from "os";
import path from "path";
import { LocalFsStorage } from "./localFsStorage.js";
import type { BlobStorage, BlobStorageBackend } from "./types.js";

let _instance: BlobStorage | null = null;

function buildInstance(): BlobStorage {
  const backend = (process.env.BLOB_STORAGE_BACKEND ?? "local") as BlobStorageBackend;
  if (backend === "local") {
    const root = process.env.IMAGEBASE_HOME?.trim() ||
      path.join(os.homedir(), ".imagebase");
    return new LocalFsStorage(root);
  }
  if (backend === "s3") {
    throw new Error(
      "BlobStorage: backend=s3 not implemented yet. Will land at launch " +
      "hardening (docs/launch-checklist.md Phase 0.2). Set BLOB_STORAGE_BACKEND=local " +
      "(or unset) to use LocalFsStorage."
    );
  }
  throw new Error(`BlobStorage: unknown BLOB_STORAGE_BACKEND="${backend}"`);
}

/**
 * Lazily construct + cache the singleton. Safe to call from anywhere; all
 * callers see the same instance.
 *
 * Returns immediately on every call after the first.
 */
export function getBlobStorage(): BlobStorage {
  if (_instance) return _instance;
  _instance = buildInstance();
  return _instance;
}

/**
 * Test helper: replace the cached singleton (or clear it). NOT for app code.
 * Used by `scripts/storage-pr4-prep-test.ts` to construct a fresh instance
 * pointing at a temp directory.
 */
export function _resetBlobStorageForTest(next?: BlobStorage): void {
  _instance = next ?? null;
}

export type { BlobStorage, BlobStat, BlobStorageBackend } from "./types.js";
export { LocalFsStorage } from "./localFsStorage.js";
