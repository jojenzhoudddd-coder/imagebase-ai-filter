import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { NextFunction, Request, Response } from "express";

export type ErrorLogLevel = "warning" | "error";

export interface ErrorLogEntry {
  scope: string;
  kind: string;
  level?: ErrorLogLevel;
  message?: string;
  error?: unknown;
  [key: string]: unknown;
}

export interface ReadErrorLogsOptions {
  date?: string;
  limit?: number;
  scope?: string;
  kind?: string;
  q?: string;
}

const MAX_LOG_FIELD_CHARS = 6_000;
const MAX_LOG_LINE_BYTES = 64 * 1024;
const MAX_READ_LIMIT = 500;
const DEFAULT_READ_LIMIT = 100;
const SENSITIVE_KEY_RE =
  /(authorization|cookie|set-cookie|password|passwd|pwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|credential|jwt|session)/i;
const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function logDir(): string {
  return path.resolve(process.env.ERROR_LOG_DIR || path.join(BACKEND_ROOT, "logs"));
}

function gmt8Date(date = new Date()): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

function gmt8Timestamp(date = new Date()): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().replace("Z", "+08:00");
}

function truncateString(value: string, max = MAX_LOG_FIELD_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[${value.length - max} chars truncated]`;
}

function sanitizeForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[function ${(value as Function).name || "anonymous"}]`;
  if (value instanceof Error) return normalizeError(value);
  if (value instanceof Date) return value.toISOString();

  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= 5) return "[max-depth]";
  seen.add(value);

  if (Array.isArray(value)) {
    const out = value.slice(0, 50).map((item) => sanitizeForLog(item, depth + 1, seen));
    if (value.length > 50) out.push(`...[${value.length - 50} items truncated]`);
    return out;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries.slice(0, 80)) {
    out[key] = SENSITIVE_KEY_RE.test(key)
      ? "[redacted]"
      : sanitizeForLog(item, depth + 1, seen);
  }
  if (entries.length > 80) out.__truncatedKeys = entries.length - 80;
  return out;
}

export function summarizeForLog(value: unknown): unknown {
  return sanitizeForLog(value);
}

export function normalizeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const extended = err as Error & {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };
    return {
      name: err.name,
      message: truncateString(err.message),
      stack: err.stack ? truncateString(err.stack, 8_000) : undefined,
      code: extended.code,
      status: extended.status ?? extended.statusCode,
      cause: extended.cause ? sanitizeForLog(extended.cause) : undefined,
    };
  }
  if (typeof err === "object" && err !== null) return sanitizeForLog(err) as Record<string, unknown>;
  return { message: truncateString(String(err)) };
}

function parseJsonLike(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function stringifyShort(value: unknown): string {
  if (typeof value === "string") return truncateString(value);
  try {
    return truncateString(JSON.stringify(sanitizeForLog(value)));
  } catch {
    return truncateString(String(value));
  }
}

export function extractToolOutputError(output: unknown): string | null {
  const parsed = parseJsonLike(output);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;

  if (record.error !== undefined && record.error !== null) {
    return stringifyShort(record.error);
  }
  const apiCode = readFailureCode(record.code ?? record.errcode ?? record.error_code);
  if (apiCode !== null) {
    return stringifyShort(record.msg ?? record.message ?? record.reason ?? record);
  }
  if (record.ok === false) {
    return stringifyShort(record.message ?? record.reason ?? record);
  }
  if (record.isError === true) {
    return stringifyShort(record.content ?? record.message ?? record);
  }
  if (record.success === false) {
    return stringifyShort(record.message ?? record.reason ?? record);
  }
  return null;
}

function readFailureCode(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "0") return null;
    if (/^-?\d+$/.test(trimmed) && Number(trimmed) !== 0) return trimmed;
  }
  return null;
}

export function writeErrorLog(entry: ErrorLogEntry): void {
  const now = new Date();
  const normalized = sanitizeForLog({
    timestamp: gmt8Timestamp(now),
    level: entry.level ?? "error",
    ...entry,
  });
  let line: string;
  try {
    line = JSON.stringify(normalized);
  } catch {
    line = JSON.stringify({
      timestamp: gmt8Timestamp(now),
      level: entry.level ?? "error",
      scope: entry.scope,
      kind: entry.kind,
      message: "failed to serialize error log entry",
    });
  }
  if (Buffer.byteLength(line, "utf8") > MAX_LOG_LINE_BYTES) {
    line = JSON.stringify({
      timestamp: gmt8Timestamp(now),
      level: entry.level ?? "error",
      scope: entry.scope,
      kind: entry.kind,
      message: entry.message ?? "error log entry exceeded max line size",
      truncated: true,
      preview: truncateString(line, 8_000),
    });
  }
  const file = path.join(logDir(), `error-events-${gmt8Date(now)}.jsonl`);
  void fs.mkdir(logDir(), { recursive: true })
    .then(() => fs.appendFile(file, `${line}\n`, "utf8"))
    .catch((err) => {
      console.warn("[errorLogService] write failed:", err);
    });
}

function readQueryParam(req: Request, name: string): unknown {
  const value = req.query[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestBodyForLog(req: Request): unknown {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  return req.body;
}

export function createApiErrorLogger() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const pathForMatch = req.originalUrl || req.url;
    if (
      !pathForMatch.startsWith("/api") &&
      !pathForMatch.startsWith("/share") &&
      !pathForMatch.startsWith("/uploads")
    ) {
      next();
      return;
    }

    const startedAt = Date.now();
    res.on("finish", () => {
      if (res.statusCode < 400) return;
      const user = (req as Request & { user?: { id?: string; email?: string; admin?: boolean } }).user;
      writeErrorLog({
        scope: "api",
        kind: "api_response_error",
        level: res.statusCode >= 500 ? "error" : "warning",
        message: `${req.method} ${req.originalUrl} -> ${res.statusCode}`,
        durationMs: Date.now() - startedAt,
        request: {
          method: req.method,
          url: req.originalUrl,
          routePath: req.path,
          statusCode: res.statusCode,
          clientId: req.headers["x-client-id"],
          userId: user?.id,
          userEmail: user?.email,
          query: summarizeForLog(req.query),
          body: summarizeForLog(requestBodyForLog(req)),
          referer: req.headers.referer,
          userAgent: req.headers["user-agent"],
        },
      });
    });
    next();
  };
}

function isIsoDate(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

export async function readErrorLogs(options: ReadErrorLogsOptions = {}): Promise<{
  file: string;
  rows: Array<Record<string, unknown>>;
}> {
  const limit = Math.max(1, Math.min(MAX_READ_LIMIT, Math.floor(options.limit ?? DEFAULT_READ_LIMIT)));
  const date = isIsoDate(options.date) ? options.date : gmt8Date();
  const file = path.join(logDir(), `error-events-${date}.jsonl`);
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { file, rows: [] };
    throw err;
  }

  const q = options.q?.toLowerCase();
  const rows: Array<Record<string, unknown>> = [];
  const lines = raw.split(/\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (q && !line.toLowerCase().includes(q)) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (options.scope && parsed.scope !== options.scope) continue;
      if (options.kind && parsed.kind !== options.kind) continue;
      rows.push(parsed);
      if (rows.length >= limit) break;
    } catch {
      rows.push({
        timestamp: null,
        level: "error",
        scope: "error-log",
        kind: "malformed_log_line",
        message: truncateString(line),
      });
      if (rows.length >= limit) break;
    }
  }
  return { file, rows };
}

export function readErrorLogQuery(req: Request): ReadErrorLogsOptions {
  const rawLimit = Number(readQueryParam(req, "limit"));
  return {
    date: typeof readQueryParam(req, "date") === "string" ? String(readQueryParam(req, "date")) : undefined,
    limit: Number.isFinite(rawLimit) ? rawLimit : DEFAULT_READ_LIMIT,
    scope: typeof readQueryParam(req, "scope") === "string" ? String(readQueryParam(req, "scope")) : undefined,
    kind: typeof readQueryParam(req, "kind") === "string" ? String(readQueryParam(req, "kind")) : undefined,
    q: typeof readQueryParam(req, "q") === "string" ? String(readQueryParam(req, "q")) : undefined,
  };
}
