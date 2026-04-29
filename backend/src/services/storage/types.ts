/**
 * BlobStorage — single backend abstraction for all "asset on fs" data
 * (Skill directories, Idea attachments, Demo files, Taste SVGs, Agent
 * memory, etc.). Lets the application code call `blobStorage.write(key, ...)`
 * without caring whether the bytes land on local fs (today) or S3-compatible
 * object storage (launch-checklist.md Phase 0.2).
 *
 * 详见 docs/launch-checklist.md Pre-Launch Prep + docs/roadmap-post-skill-v1.md PR4-prep。
 *
 * Key conventions:
 *   - `key` is a forward-slash POSIX path-like string, e.g.
 *     `agents/<id>/skills/<sid>/SKILL.md`
 *   - Keys NEVER start with `/` (relative-only). Implementations must reject
 *     absolute paths and `..` traversal.
 *   - Top-level prefix conventionally maps 1:1 to a future S3 bucket
 *     (`agents/` → `imagebase-prod-agents`, etc.) — keep this stable.
 *
 * NOT covered by this interface:
 *   - `agent-worktrees/`: git worktree must own its own inodes (npm install,
 *     SSH keys, .git internals). Stays on direct fs.
 *   - `analyst/sessions/*.duckdb`: DuckDB needs local file handles for its
 *     storage engine. Stays on direct fs.
 */

export interface BlobStat {
  size: number;
  lastModified: Date;
}

export interface BlobStorage {
  /** Read text contents as utf-8. Throws if key not found. */
  read(key: string): Promise<string>;

  /** Read binary contents. Throws if key not found. */
  readBuffer(key: string): Promise<Buffer>;

  /** Write contents (utf-8 text or raw buffer). Creates intermediate
   *  directories as needed. Overwrites if key exists. */
  write(key: string, content: string | Buffer): Promise<void>;

  /** List all keys whose path starts with `prefix`. Returns full keys
   *  (including the prefix itself), in unspecified order. Returns []
   *  if prefix doesn't exist or is empty. Recursive — includes nested. */
  list(prefix: string): Promise<string[]>;

  /** Delete a single key. Idempotent: does NOT throw if missing. */
  delete(key: string): Promise<void>;

  /** Recursively delete all keys under `prefix` (including the prefix
   *  itself if it's a directory in the local fs). Idempotent. */
  deletePrefix(prefix: string): Promise<void>;

  /** Check whether a key exists. */
  exists(key: string): Promise<boolean>;

  /** Stream-based read. Caller must consume + close the stream.
   *  Throws if key not found. */
  readStream(key: string): Promise<NodeJS.ReadableStream>;

  /** Stream-based write. Caller writes then ends the stream; the returned
   *  promise resolves when bytes are durably persisted. Creates parent
   *  directories as needed. */
  writeStream(key: string): Promise<{
    stream: NodeJS.WritableStream;
    /** Resolves when stream end+flush completes. Reject on error. */
    done: Promise<void>;
  }>;

  /** Move / rename. Implementations may emulate via copy+delete. */
  move(srcKey: string, dstKey: string): Promise<void>;

  /** Copy. */
  copy(srcKey: string, dstKey: string): Promise<void>;

  /** Stat. Returns null if missing instead of throwing — most callers
   *  want exists+size in one call. */
  stat(key: string): Promise<BlobStat | null>;
}

/** Backend selector. Default is `local`. */
export type BlobStorageBackend = "local" | "s3";
