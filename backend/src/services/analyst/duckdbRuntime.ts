/**
 * DuckDB Runtime — per-conversation session + result registry.
 *
 * Each conversation owns exactly one `.duckdb` file at
 *   ~/.imagebase/analyst/conv_<conversationId>.duckdb
 *
 * Inside that file:
 *   - `src_<tableId>` views : mapped onto parquet snapshots (read-only)
 *   - `r_<handle>` tables   : intermediate analysis results (mutable)
 *   - `_result_meta`        : registry row per handle (produced_at, meta JSON)
 *
 * The runtime's job is narrow: open/close the DB, serialize concurrent
 * queries on the same connection (DuckDB Node bindings aren't thread-safe),
 * allocate handles, persist meta, and expose a small set of high-level ops
 * (createResult / previewResult / describeResult / runSqlSafe / attachSnapshot).
 *
 * MCP tools go through this runtime via `backend/src/routes/analystRoutes.ts`
 * to keep the "MCP is a thin HTTP proxy" invariant (see CLAUDE.md).
 *
 * Thread-safety: DuckDB's single connection is serialized via a per-session
 * promise chain. Multiple agent tool calls on the same conversation run
 * sequentially; different conversations are fully parallel.
 */

import path from "path";
import os from "os";
import fs from "fs";
import fsp from "fs/promises";
import crypto from "crypto";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { ResultMeta, ResultPreview } from "../../schemas/analystSchema.js";

// ─── Paths ────────────────────────────────────────────────────────────────

export const ANALYST_HOME =
  process.env.ANALYST_HOME || path.join(os.homedir(), ".imagebase", "analyst");
const SESSIONS_DIR = path.join(ANALYST_HOME, "sessions");
const SNAPSHOTS_DIR = path.join(ANALYST_HOME, "snapshots");

export function sessionFilePath(conversationId: string): string {
  return path.join(SESSIONS_DIR, `conv_${sanitizeId(conversationId)}.duckdb`);
}

export function snapshotsDir(): string {
  return SNAPSHOTS_DIR;
}

export function sanitizeId(id: string): string {
  // Safe filename chars only — id shouldn't contain anything weird but guard.
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

async function ensureDirs(): Promise<void> {
  await fsp.mkdir(SESSIONS_DIR, { recursive: true });
  await fsp.mkdir(SNAPSHOTS_DIR, { recursive: true });
}

// ─── Session struct ───────────────────────────────────────────────────────

interface Session {
  conversationId: string;
  instance: DuckDBInstance;
  conn: DuckDBConnection;
  /** Serializes queries on this connection. Always await prevQueue before
   * issuing a new one. */
  queue: Promise<unknown>;
  lastActiveAt: number;
  /** Set of snapshots already attached this session, keyed by "tableId@snapshotAt". */
  attachedSnapshots: Set<string>;
  /** Per-tableId → most-recent snapshotAt attached in this session. Used for
   * default "reuse current snapshot" behavior. */
  currentSnapshotByTable: Map<string, string>;
}

const sessions = new Map<string, Session>();

// ─── Bootstrapping the _result_meta registry table ────────────────────────

async function ensureRegistry(conn: DuckDBConnection): Promise<void> {
  await conn.run(`
    CREATE TABLE IF NOT EXISTS _result_meta (
      handle       VARCHAR PRIMARY KEY,
      duck_table   VARCHAR NOT NULL,
      meta_json    VARCHAR NOT NULL,
      produced_at  TIMESTAMP NOT NULL
    );
  `);
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Get (or create) the DuckDB session for a conversation. Lazy bootstrap —
 * creates the .duckdb file if missing.
 */
export async function getOrCreateSession(conversationId: string): Promise<Session> {
  let sess = sessions.get(conversationId);
  if (sess) {
    sess.lastActiveAt = Date.now();
    return sess;
  }
  await ensureDirs();
  const file = sessionFilePath(conversationId);
  const instance = await DuckDBInstance.create(file);
  const conn = await instance.connect();
  await ensureRegistry(conn);
  sess = {
    conversationId,
    instance,
    conn,
    queue: Promise.resolve(),
    lastActiveAt: Date.now(),
    attachedSnapshots: new Set(),
    currentSnapshotByTable: new Map(),
  };
  sessions.set(conversationId, sess);
  return sess;
}

/** Serialize a callback onto the session's query queue. */
function runSerialized<T>(sess: Session, fn: () => Promise<T>): Promise<T> {
  const next = sess.queue.then(fn, fn);
  // Swallow errors in the queue chain so one failure doesn't poison everything.
  sess.queue = next.catch(() => undefined);
  return next;
}

/** Raw SQL run (no return rows). Use for DDL and writes only. */
export async function execSQL(conversationId: string, sql: string): Promise<void> {
  const sess = await getOrCreateSession(conversationId);
  await runSerialized(sess, async () => {
    await sess.conn.run(sql);
  });
}

/** Run a query and return rows as plain JS objects. Use sparingly — prefer
 * `createResult` for anything the agent should be able to reference later. */
export async function readRows(
  conversationId: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const sess = await getOrCreateSession(conversationId);
  return runSerialized(sess, async () => {
    const reader = await sess.conn.runAndReadAll(sql);
    return normalizeRows(reader.getRowObjectsJS());
  });
}

/** Attach a parquet snapshot as a read-only view in the session. */
export async function attachSnapshot(
  conversationId: string,
  tableId: string,
  parquetPath: string,
  snapshotAt: string,
): Promise<string /* duckdb view name */> {
  const sess = await getOrCreateSession(conversationId);
  const viewName = `src_${sanitizeIdent(tableId)}`;
  const key = `${tableId}@${snapshotAt}`;
  if (sess.attachedSnapshots.has(key) && sess.currentSnapshotByTable.get(tableId) === snapshotAt) {
    sess.lastActiveAt = Date.now();
    return viewName;
  }
  // Escape single quotes in path
  const safePath = parquetPath.replace(/'/g, "''");
  await runSerialized(sess, async () => {
    await sess.conn.run(
      `CREATE OR REPLACE VIEW ${viewName} AS SELECT * FROM read_parquet('${safePath}');`,
    );
  });
  sess.attachedSnapshots.add(key);
  sess.currentSnapshotByTable.set(tableId, snapshotAt);
  return viewName;
}

export function currentSnapshotForTable(
  conversationId: string,
  tableId: string,
): string | undefined {
  return sessions.get(conversationId)?.currentSnapshotByTable.get(tableId);
}

// ─── Result creation ──────────────────────────────────────────────────────

export interface CreateResultOptions {
  sql: string;
  sourceTableIds: string[];
  snapshotAt: string;
  producedBy: string;
  description?: string;
  /** Column metadata to enrich the stored meta with source-field hints. */
  columnHints?: Record<
    string,
    { sourceField?: string; description?: string }
  >;
}

/** Run `CREATE TABLE r_<handle> AS <sql>`, record meta, return the full meta. */
export async function createResult(
  conversationId: string,
  opts: CreateResultOptions,
): Promise<ResultMeta> {
  const sess = await getOrCreateSession(conversationId);
  const handle = generateHandle();
  const duckTable = handleToTableName(handle);
  const producedAt = new Date().toISOString();

  return runSerialized(sess, async () => {
    // Wrap SQL in parens so any top-level WITH or SELECT still yields a table.
    const wrapped = `CREATE TABLE ${duckTable} AS ${opts.sql}`;
    await sess.conn.run(wrapped);

    // Pull schema from DuckDB information_schema — reliable across DuckDB
    // versions, and handles computed column types correctly.
    const schemaReader = await sess.conn.runAndReadAll(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = '${duckTable}' ORDER BY ordinal_position;`,
    );
    const schemaRows = schemaReader.getRowObjectsJS() as Array<{
      column_name: string;
      data_type: string;
    }>;

    const countReader = await sess.conn.runAndReadAll(
      `SELECT COUNT(*)::BIGINT AS n FROM ${duckTable};`,
    );
    const rowCount = Number(
      (countReader.getRowObjectsJS()[0] as { n: unknown })?.n ?? 0,
    );

    const fields = schemaRows.map((r) => {
      const hint = opts.columnHints?.[r.column_name];
      return {
        name: r.column_name,
        type: r.data_type,
        ...(hint?.sourceField ? { sourceField: hint.sourceField } : {}),
        ...(hint?.description ? { description: hint.description } : {}),
      };
    });

    const meta: ResultMeta = {
      handle,
      duckdbTable: duckTable,
      sourceTableIds: opts.sourceTableIds,
      snapshotAt: opts.snapshotAt,
      rowCount,
      fields,
      producedBy: opts.producedBy,
      producedAt,
      ...(opts.description ? { description: opts.description } : {}),
    };

    const safeJson = JSON.stringify(meta).replace(/'/g, "''");
    await sess.conn.run(
      `INSERT INTO _result_meta(handle, duck_table, meta_json, produced_at)
       VALUES ('${handle}', '${duckTable}', '${safeJson}', '${producedAt}')`,
    );

    return meta;
  });
}

/** Look up meta for a handle. Throws if not found. */
export async function resolveHandle(
  conversationId: string,
  handle: string,
): Promise<ResultMeta> {
  const sess = await getOrCreateSession(conversationId);
  return runSerialized(sess, async () => {
    const reader = await sess.conn.runAndReadAll(
      `SELECT meta_json FROM _result_meta WHERE handle = '${handle.replace(/'/g, "''")}' LIMIT 1;`,
    );
    const rows = reader.getRowObjectsJS() as Array<{ meta_json: string }>;
    if (!rows.length) {
      throw new Error(`Unknown result handle: ${handle}`);
    }
    return JSON.parse(rows[0].meta_json) as ResultMeta;
  });
}

/** List handles in this session. */
export async function listHandles(conversationId: string): Promise<ResultMeta[]> {
  const sess = await getOrCreateSession(conversationId);
  return runSerialized(sess, async () => {
    const reader = await sess.conn.runAndReadAll(
      `SELECT meta_json FROM _result_meta ORDER BY produced_at DESC LIMIT 200;`,
    );
    const rows = reader.getRowObjectsJS() as Array<{ meta_json: string }>;
    return rows.map((r) => JSON.parse(r.meta_json) as ResultMeta);
  });
}

export async function previewResult(
  conversationId: string,
  handle: string,
  limit = 20,
): Promise<ResultPreview> {
  const meta = await resolveHandle(conversationId, handle);
  const sess = await getOrCreateSession(conversationId);
  return runSerialized(sess, async () => {
    const reader = await sess.conn.runAndReadAll(
      `SELECT * FROM ${meta.duckdbTable} LIMIT ${Math.max(1, Math.floor(limit))};`,
    );
    const rows = normalizeRows(reader.getRowObjectsJS());
    const columns = meta.fields.map((f) => ({ name: f.name, type: f.type }));
    return {
      columns,
      rows,
      rowCount: meta.rowCount,
      truncated: rows.length < meta.rowCount,
      previewLimit: limit,
    };
  });
}

// ─── Describe (pure aggregate, no sampling) ───────────────────────────────
//
// Each field produces:
//   - nullCount, distinctCount
//   - numeric: min / max / mean / p50 / p95
//   - categorical (VARCHAR, <= 1000 distinct): top K values + counts

export interface DescribeOptions {
  topK: number;
}

export async function describeResult(
  conversationId: string,
  handle: string,
  opts: DescribeOptions,
): Promise<{
  handle: string;
  rowCount: number;
  fields: Array<{
    name: string;
    type: string;
    nullCount: number;
    distinctCount: number | null;
    min?: unknown;
    max?: unknown;
    mean?: number | null;
    p50?: number | null;
    p95?: number | null;
    topValues?: Array<{ value: unknown; count: number }>;
  }>;
}> {
  const meta = await resolveHandle(conversationId, handle);
  const sess = await getOrCreateSession(conversationId);
  const duckTable = meta.duckdbTable;
  const topK = opts.topK;

  return runSerialized(sess, async () => {
    const fields: Array<{
      name: string;
      type: string;
      nullCount: number;
      distinctCount: number | null;
      min?: unknown;
      max?: unknown;
      mean?: number | null;
      p50?: number | null;
      p95?: number | null;
      topValues?: Array<{ value: unknown; count: number }>;
    }> = [];

    for (const f of meta.fields) {
      const ident = quoteIdent(f.name);
      const isNumeric = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)/i.test(
        f.type,
      );
      const isDateTime = /(DATE|TIME|TIMESTAMP)/i.test(f.type);

      const baseSql = `SELECT
        COUNT(*) FILTER (WHERE ${ident} IS NULL)::BIGINT AS null_count,
        COUNT(DISTINCT ${ident})::BIGINT AS distinct_count
        ${isNumeric ? `, MIN(${ident})::DOUBLE AS minv, MAX(${ident})::DOUBLE AS maxv,
            AVG(${ident})::DOUBLE AS meanv,
            approx_quantile(${ident}, 0.5) AS p50v,
            approx_quantile(${ident}, 0.95) AS p95v` : ""}
        ${isDateTime ? `, MIN(${ident})::VARCHAR AS minv, MAX(${ident})::VARCHAR AS maxv` : ""}
        FROM ${duckTable};`;
      const r = await sess.conn.runAndReadAll(baseSql);
      const row = (r.getRowObjectsJS()[0] ?? {}) as Record<string, unknown>;
      const fStat: (typeof fields)[number] = {
        name: f.name,
        type: f.type,
        nullCount: Number(row.null_count ?? 0),
        distinctCount:
          row.distinct_count !== null && row.distinct_count !== undefined
            ? Number(row.distinct_count)
            : null,
      };
      if (isNumeric || isDateTime) {
        fStat.min = row.minv ?? null;
        fStat.max = row.maxv ?? null;
      }
      if (isNumeric) {
        fStat.mean = row.meanv !== null && row.meanv !== undefined ? Number(row.meanv) : null;
        fStat.p50 = row.p50v !== null && row.p50v !== undefined ? Number(row.p50v) : null;
        fStat.p95 = row.p95v !== null && row.p95v !== undefined ? Number(row.p95v) : null;
      }

      // Top-K values for low-cardinality non-numeric fields.
      if (
        !isNumeric &&
        topK > 0 &&
        fStat.distinctCount !== null &&
        fStat.distinctCount > 0 &&
        fStat.distinctCount <= 2000
      ) {
        const topReader = await sess.conn.runAndReadAll(
          `SELECT ${ident} AS v, COUNT(*)::BIGINT AS c
             FROM ${duckTable}
            WHERE ${ident} IS NOT NULL
            GROUP BY 1
            ORDER BY c DESC
            LIMIT ${topK};`,
        );
        fStat.topValues = (topReader.getRowObjectsJS() as Array<{ v: unknown; c: unknown }>).map(
          (r2) => ({ value: r2.v, count: Number(r2.c) }),
        );
      }
      fields.push(fStat);
    }

    return {
      handle,
      rowCount: meta.rowCount,
      fields,
    };
  });
}

// ─── Safe SQL ─────────────────────────────────────────────────────────────

const ALLOWED_STMT_PREFIX = /^(\s*WITH\b|\s*SELECT\b|\s*CREATE\s+TABLE\s+\w+\s+AS\b)/i;
const BANNED_PATTERNS = [
  /\bDROP\b/i,
  /\bDELETE\b/i,
  /\bTRUNCATE\b/i,
  /\bATTACH\b/i,
  /\bDETACH\b/i,
  /\bINSTALL\b/i,
  /\bLOAD\b/i,
  /\bCOPY\b/i,
  /\bPRAGMA\b/i,
  /\bSET\b/i,
  /\bEXPORT\b/i,
  /\bIMPORT\b/i,
  /\bALTER\b/i,
  /\bREPLACE\b/i,
  /\bUPDATE\b/i,
  /\bINSERT\b/i,
];

/** Lightweight guard for `run_sql` — SELECT/CTE only, no DDL/DML mutations
 * and nothing that can escape the session sandbox. */
export function assertSafeSql(sql: string): void {
  const trimmed = sql.trim().replace(/;$/, "");
  if (!ALLOWED_STMT_PREFIX.test(trimmed)) {
    throw new Error("run_sql: 仅支持 SELECT / WITH / CREATE TABLE <name> AS");
  }
  for (const pat of BANNED_PATTERNS) {
    if (pat.test(trimmed)) {
      throw new Error(`run_sql: SQL 中出现禁用关键字 ${pat.source}`);
    }
  }
  if (/;/.test(trimmed)) {
    throw new Error("run_sql: 不支持多语句执行");
  }
}

/**
 * Translate any `ducktbl_<12 hex>` handle references in a SQL string to their
 * physical DuckDB table names (`r_<12 hex>`). Agent commonly (and reasonably)
 * tries `FROM ducktbl_xxx` because that's the identifier we surface in
 * Turn Context — this rewrite makes both forms work.
 *
 * Safe: only matches the exact `ducktbl_[a-f0-9]{12}` shape (same regex the
 * Zod schema validates handles against), so it can't corrupt unrelated
 * identifiers or string literals that happen to start with "ducktbl".
 */
export function rewriteHandleToTable(sql: string): string {
  return sql.replace(/\bducktbl_([a-f0-9]{12})\b/g, "r_$1");
}

// ─── Close / cleanup ──────────────────────────────────────────────────────

export async function closeSession(conversationId: string): Promise<void> {
  const sess = sessions.get(conversationId);
  if (!sess) return;
  try {
    await sess.queue.catch(() => undefined);
    sess.conn.closeSync();
    sess.instance.closeSync();
  } catch (err) {
    console.warn(`[duckdbRuntime] close failed for ${conversationId}:`, err);
  }
  sessions.delete(conversationId);
}

/** Iterate all open sessions (for cleanup cron). */
export function listOpenSessions(): Array<{
  conversationId: string;
  lastActiveAt: number;
}> {
  return Array.from(sessions.values()).map((s) => ({
    conversationId: s.conversationId,
    lastActiveAt: s.lastActiveAt,
  }));
}

/** Delete the .duckdb file for a conversation (call after closeSession). */
export async function deleteSessionFile(conversationId: string): Promise<void> {
  const file = sessionFilePath(conversationId);
  try {
    await fsp.unlink(file);
  } catch {
    // ignore missing
  }
  // DuckDB may have -wal / -shm sidecars
  for (const ext of [".wal", ".shm"]) {
    try {
      await fsp.unlink(file + ext);
    } catch {
      /* ignore */
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export function generateHandle(): string {
  return "ducktbl_" + crypto.randomBytes(6).toString("hex");
}

export function handleToTableName(handle: string): string {
  return "r_" + handle.slice("ducktbl_".length);
}

export function quoteIdent(name: string): string {
  // DuckDB uses double-quoted identifiers. Escape any internal quotes.
  return '"' + name.replace(/"/g, '""') + '"';
}

export function sanitizeIdent(raw: string): string {
  // Must be a valid SQL identifier — alnum + underscore only.
  return raw.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Recursively normalize DuckDB JS values so they JSON-serialize cleanly
 * (BigInt → Number when safe, Dates → ISO strings). */
export function normalizeRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((r) => normalizeRow(r));
}

function normalizeRow<T extends Record<string, unknown>>(r: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    out[k] = normalizeValue(v);
  }
  return out as T;
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") {
    // Safe-integer range → plain number; otherwise keep as string.
    if (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)) {
      return Number(v);
    }
    return v.toString();
  }
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (typeof v === "object") {
    // DuckDB timestamp / decimal / uuid wrapper objects all expose toString()
    // with a sensible representation. Prefer that before recursing.
    const maybeToString = (v as { toString?: () => string }).toString;
    if (typeof maybeToString === "function" && maybeToString !== Object.prototype.toString) {
      return maybeToString.call(v);
    }
    return normalizeRow(v as Record<string, unknown>);
  }
  return v;
}

/** For tests: wipe all sessions and snapshot dirs. */
export async function resetForTest(): Promise<void> {
  for (const convId of Array.from(sessions.keys())) {
    await closeSession(convId);
  }
  try {
    await fsp.rm(SESSIONS_DIR, { recursive: true, force: true });
    await fsp.rm(SNAPSHOTS_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Check if a conversation currently has an open session. */
export function hasOpenSession(conversationId: string): boolean {
  return sessions.has(conversationId);
}

/** Check if the .duckdb file exists on disk (even if session isn't open). */
export function sessionFileExists(conversationId: string): boolean {
  return fs.existsSync(sessionFilePath(conversationId));
}

/**
 * `listHandles` that short-circuits to `[]` when the conversation has never
 * done any analysis — avoids creating an empty DuckDB file on every chat
 * turn for plain text conversations.
 *
 * Used by chatAgentService to surface recent handles in Turn Context so the
 * Agent can reference prior results (e.g. `write_analysis_to_idea(handle=...)`)
 * across turns without the backend replaying tool outputs in the prompt.
 */
export async function listHandlesIfExists(conversationId: string): Promise<ResultMeta[]> {
  if (!hasOpenSession(conversationId) && !sessionFileExists(conversationId)) {
    return [];
  }
  return listHandles(conversationId);
}
