/**
 * Snapshot Service — creates Parquet snapshots of workspace tables so the
 * analyst runtime can query stable data even while the live table is being
 * edited.
 *
 * Snapshot semantics (see docs/analyst-skill-plan.md §6):
 *   - Per-analysis-session: the first time a conversation loads a given
 *     tableId, a snapshot is created and the timestamp is remembered. Later
 *     calls reuse the same snapshot unless {refresh:true} is passed.
 *   - Each snapshot is written once to parquet under
 *     ~/.imagebase/analyst/snapshots/<tableId>@<iso>.parquet
 *   - Snapshots are keyed by a "workspaceId::tableId" pair to match the
 *     analyst's cleanup policy and because tableId is globally unique in
 *     practice but we want the extra namespacing for future multi-tenant.
 *
 * Field typing: we flatten the live table to a simple columnar layout
 *   - Text / User-related names / SingleSelect → VARCHAR
 *   - Number / Currency / Progress / Rating / AutoNumber → DOUBLE
 *   - DateTime / CreatedTime / ModifiedTime → TIMESTAMP (ISO from cell value)
 *   - Checkbox → BOOLEAN
 *   - MultiSelect / arrays → VARCHAR (JSON array text, Agent can `json_each`)
 *
 * Row cardinality is unbounded; we rely on DuckDB's streaming Parquet writer
 * (COPY ... TO) to keep memory flat.
 */

import path from "path";
import fsp from "fs/promises";
import { DuckDBInstance } from "@duckdb/node-api";
import * as store from "../dbStore.js";
import type { CellValue, Field, Table, TableRecord } from "../../types.js";
import { snapshotsDir, sanitizeId, quoteIdent } from "./duckdbRuntime.js";

// ─── Paths / naming ───────────────────────────────────────────────────────

function snapshotPath(tableId: string, snapshotAt: string): string {
  const safeTs = snapshotAt.replace(/[:.]/g, "-");
  return path.join(snapshotsDir(), `${sanitizeId(tableId)}@${safeTs}.parquet`);
}

async function ensureSnapshotDir(): Promise<void> {
  await fsp.mkdir(snapshotsDir(), { recursive: true });
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface SnapshotResult {
  tableId: string;
  tableName: string;
  snapshotAt: string;
  path: string;
  rowCount: number;
  columns: Array<{ name: string; type: string; fieldId: string; fieldType: string; description?: string }>;
}

export interface CreateSnapshotOptions {
  onProgress?: (progress: { phase: string; message: string; current?: number; total?: number }) => void;
}

/**
 * Create a new Parquet snapshot of a workspace table.
 *
 * Steps:
 *   1. Read the table (fields + records) from Prisma via dbStore
 *   2. Build an in-memory DuckDB table with the cell values
 *   3. COPY that DuckDB table to a Parquet file
 *   4. Drop the in-memory table, close the transient DB
 */
export async function createSnapshot(
  tableId: string,
  opts: CreateSnapshotOptions = {},
): Promise<SnapshotResult> {
  const table = await store.getTable(tableId);
  if (!table) throw new Error(`Table not found: ${tableId}`);
  opts.onProgress?.({ phase: "loading", message: `加载表「${table.name}」 (${table.records.length} 行)` });

  await ensureSnapshotDir();
  const snapshotAt = new Date().toISOString();
  const outFile = snapshotPath(tableId, snapshotAt);

  // Transient in-memory DuckDB for the conversion. We don't reuse the session
  // DB because snapshots are shared across conversations — writing into the
  // shared parquet file is the persistence boundary.
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  try {
    const colDefs = buildColumnDefs(table.fields);
    const columnList = colDefs
      .map((c) => `${quoteIdent(c.name)} ${c.duckType}`)
      .join(", ");
    const stagingTable = "_snapshot_stage";
    await conn.run(`CREATE TABLE ${stagingTable} (${columnList});`);

    // Write records in batches so we don't build a huge INSERT VALUES. DuckDB
    // Node doesn't expose the appender for JS objects directly, so we use
    // parameterized INSERT in batches of 200. For 100k rows this is ~500
    // statements — well within DuckDB's single-conn latency.
    const BATCH = 200;
    const placeholdersPerRow = `(${colDefs.map(() => "?").join(", ")})`;
    for (let i = 0; i < table.records.length; i += BATCH) {
      const chunk = table.records.slice(i, i + BATCH);
      const placeholders = chunk.map(() => placeholdersPerRow).join(", ");
      const params: unknown[] = [];
      for (const rec of chunk) {
        for (const col of colDefs) {
          params.push(coerceCell(rec.cells[col.fieldId], col.fieldType, col));
        }
      }
      await conn.run(
        `INSERT INTO ${stagingTable} VALUES ${placeholders};`,
        params as never[],
      );
      opts.onProgress?.({
        phase: "converting",
        message: `已转换 ${Math.min(i + BATCH, table.records.length)} / ${table.records.length} 行`,
        current: Math.min(i + BATCH, table.records.length),
        total: table.records.length,
      });
    }

    opts.onProgress?.({ phase: "writing", message: `写入 Parquet` });
    const safePath = outFile.replace(/'/g, "''");
    await conn.run(
      `COPY ${stagingTable} TO '${safePath}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
    );

    const result: SnapshotResult = {
      tableId,
      tableName: table.name,
      snapshotAt,
      path: outFile,
      rowCount: table.records.length,
      columns: colDefs.map((c) => ({
        name: c.name,
        type: c.duckType,
        fieldId: c.fieldId,
        fieldType: c.fieldType,
        description: c.description,
      })),
    };
    opts.onProgress?.({ phase: "done", message: `快照完成 · ${result.rowCount} 行` });
    return result;
  } finally {
    try { conn.closeSync(); } catch { /* ignore */ }
    try { instance.closeSync(); } catch { /* ignore */ }
  }
}

/**
 * Locate an existing snapshot file for a tableId at (or near) a timestamp.
 * If no timestamp is given, returns the most recent snapshot. Returns null
 * if no snapshots exist.
 */
export async function resolveSnapshot(
  tableId: string,
  snapshotAt?: string,
): Promise<{ path: string; snapshotAt: string } | null> {
  await ensureSnapshotDir();
  const dir = snapshotsDir();
  const prefix = sanitizeId(tableId) + "@";
  const entries = (await fsp.readdir(dir).catch(() => [])).filter((f) =>
    f.startsWith(prefix) && f.endsWith(".parquet"),
  );
  if (!entries.length) return null;

  if (snapshotAt) {
    // Exact match (after timestamp safe-encoding) — try both encoded and raw
    const encoded = snapshotAt.replace(/[:.]/g, "-");
    const match = entries.find((f) => f === `${prefix}${encoded}.parquet`);
    if (match) return { path: path.join(dir, match), snapshotAt };
  }

  // Return newest by embedded timestamp (which is the post-prefix portion).
  entries.sort().reverse();
  const newest = entries[0];
  const ts = newest.slice(prefix.length, -".parquet".length);
  // Convert "---" back to ":" / "." — both chars collapsed to "-", so this is
  // lossy but the timestamp is still readable ISO-ish.
  return { path: path.join(dir, newest), snapshotAt: ts };
}

export interface SnapshotListEntry {
  tableId: string;
  snapshotAt: string;
  path: string;
  byteSize: number;
}

/** List all snapshots on disk, newest-first. Optionally filter by tableId. */
export async function listSnapshots(filter?: { tableId?: string }): Promise<SnapshotListEntry[]> {
  await ensureSnapshotDir();
  const dir = snapshotsDir();
  const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".parquet"));
  const out: SnapshotListEntry[] = [];
  for (const f of files) {
    const at = f.indexOf("@");
    if (at < 0) continue;
    const tableId = f.slice(0, at);
    if (filter?.tableId && filter.tableId !== tableId) continue;
    const snapshotAt = f.slice(at + 1, -".parquet".length);
    const full = path.join(dir, f);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) continue;
    out.push({ tableId, snapshotAt, path: full, byteSize: stat.size });
  }
  out.sort((a, b) => (a.snapshotAt < b.snapshotAt ? 1 : -1));
  return out;
}

/** Delete snapshots older than `olderThanMs` (defaults 30 days). */
export async function purgeOldSnapshots(olderThanMs = 30 * 86_400_000): Promise<{
  removed: string[];
  keptCount: number;
}> {
  const dir = snapshotsDir();
  const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".parquet"));
  const removed: string[] = [];
  let kept = 0;
  const cutoff = Date.now() - olderThanMs;
  for (const f of files) {
    const full = path.join(dir, f);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) continue;
    if (stat.mtimeMs < cutoff) {
      try {
        await fsp.unlink(full);
        removed.push(full);
      } catch {
        /* ignore */
      }
    } else {
      kept++;
    }
  }
  return { removed, keptCount: kept };
}

// ─── Field → DuckDB column mapping ────────────────────────────────────────

interface ColumnDef {
  /** Public name (field.name). */
  name: string;
  /** Field id in the workspace table (unique across columns). */
  fieldId: string;
  /** Source field type. */
  fieldType: string;
  /** DuckDB type string (VARCHAR / DOUBLE / BOOLEAN / TIMESTAMP). */
  duckType: string;
  /** Data dictionary description, when present. */
  description?: string;
  /** ID → display name map for User / Group / CreatedUser / ModifiedUser
   * fields. Populated from `field.config.users` so the Agent sees names
   * (e.g. "陈晓明") instead of opaque IDs (e.g. "u_01") in DuckDB. */
  userNameMap?: Map<string, string>;
}

function buildColumnDefs(fields: Field[]): ColumnDef[] {
  const used = new Set<string>();
  const cols: ColumnDef[] = [];
  for (const f of fields) {
    const name = uniqueName(f.name || f.id, used);
    used.add(name);
    cols.push({
      name,
      fieldId: f.id,
      fieldType: f.type,
      duckType: mapFieldTypeToDuck(f.type),
      description: (f as { description?: string }).description,
      userNameMap: buildUserNameMap(f),
    });
  }
  return cols;
}

/** Build an id→name lookup for User/Group/CreatedUser/ModifiedUser fields.
 * Falls back to undefined when the field has no roster (then IDs pass through
 * as strings). */
function buildUserNameMap(f: Field): Map<string, string> | undefined {
  if (
    f.type !== "User" &&
    f.type !== "CreatedUser" &&
    f.type !== "ModifiedUser" &&
    f.type !== "Group"
  ) {
    return undefined;
  }
  const cfg = f.config as Record<string, unknown> | undefined;
  const list =
    (cfg?.users as Array<{ id?: string; name?: string }> | undefined) ||
    (cfg?.groups as Array<{ id?: string; name?: string }> | undefined) ||
    [];
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const m = new Map<string, string>();
  for (const o of list) {
    if (o?.id && o?.name) m.set(o.id, o.name);
  }
  return m.size > 0 ? m : undefined;
}

function uniqueName(raw: string, used: Set<string>): string {
  const base = raw.trim() || "col";
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

function mapFieldTypeToDuck(type: string): string {
  switch (type) {
    case "Number":
    case "Currency":
    case "Progress":
    case "Rating":
    case "AutoNumber":
      return "DOUBLE";
    case "Checkbox":
      return "BOOLEAN";
    case "DateTime":
    case "CreatedTime":
    case "ModifiedTime":
      return "TIMESTAMP";
    // Text, SingleSelect, User, Group, MultiSelect, Url, Phone, Email, etc.
    default:
      return "VARCHAR";
  }
}

function coerceCell(value: CellValue, fieldType: string, _col: ColumnDef): unknown {
  if (value === null || value === undefined || value === "") return null;
  switch (fieldType) {
    case "Number":
    case "Currency":
    case "Progress":
    case "Rating":
    case "AutoNumber": {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        const n = parseFloat(value);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    }
    case "Checkbox": {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") return value.toLowerCase() === "true";
      return null;
    }
    case "DateTime":
    case "CreatedTime":
    case "ModifiedTime": {
      let d: Date | null = null;
      if (value instanceof Date) d = value;
      else if (typeof value === "number") d = new Date(value);
      else if (typeof value === "string") {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) d = parsed;
      }
      if (!d || Number.isNaN(d.getTime())) return null;
      // DuckDB accepts ISO strings for TIMESTAMP
      return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    }
    case "User":
    case "Group":
    case "CreatedUser":
    case "ModifiedUser": {
      // Resolve id → display name so downstream SQL aggregates on readable
      // labels (负责人, not u_02). Multi-user cells join with " / ".
      // Unknown IDs pass through unchanged so nothing silently disappears.
      const resolve = (id: unknown): string => {
        if (id === null || id === undefined) return "";
        if (typeof id === "string") {
          return _col.userNameMap?.get(id) ?? id;
        }
        if (typeof id === "object" && id !== null) {
          const obj = id as { id?: string; name?: string };
          if (typeof obj.name === "string" && obj.name) return obj.name;
          if (typeof obj.id === "string") {
            return _col.userNameMap?.get(obj.id) ?? obj.id;
          }
        }
        return String(id);
      };
      if (Array.isArray(value)) {
        return value.map(resolve).filter((s) => s).join(" / ");
      }
      return resolve(value);
    }
    case "MultiSelect": {
      // MultiSelect cells are already option-name arrays (strings, not IDs)
      // — join for readability. Fallback to JSON for unexpected shapes.
      if (Array.isArray(value)) {
        return value
          .map((v) =>
            typeof v === "string" ? v : typeof v === "object" && v !== null && "name" in v ? String((v as { name?: unknown }).name ?? "") : String(v),
          )
          .filter((s) => s)
          .join(", ");
      }
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    }
    case "SingleSelect":
    case "Text":
    case "Url":
    case "Phone":
    case "Email":
    case "Location":
    case "Barcode": {
      return typeof value === "string" ? value : String(value);
    }
    default:
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return JSON.stringify(value);
  }
}

// Re-exports for tests / external readers
export { buildColumnDefs, mapFieldTypeToDuck, coerceCell };
export type { Field, Table, TableRecord };
