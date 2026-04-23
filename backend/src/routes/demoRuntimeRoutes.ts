/**
 * /api/demo-runtime/:demoId/* — the SDK target endpoints.
 *
 * See docs/vibe-demo-plan.md §6. Architecture-level contract:
 *  - Only 7 record-level operations on Tables + 2 read-only Idea operations
 *  - Schema operations (createTable / createField / deleteTable) do NOT exist
 *    in this namespace — 404, not 403
 *  - Every request guarded by demoCapabilityGuard (both declared-resource
 *    + per-operation capability + cross-workspace isolation)
 *  - Per (demoId, IP, opFamily) sliding-window rate limit (see rateLimit)
 *
 * Published demos access the same endpoints anonymously — the guard still
 * runs, and the Demo's declared capabilities ARE the ACL.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

import { demoCapabilityGuard, demoListGuard } from "../services/demo/demoCapabilityGuard.js";
import { buildSdkJs } from "../services/demo/demoSdkInjector.js";
import * as store from "../services/dbStore.js";
import { extractIdeaSections } from "../services/ideaSections.js";
import { eventBus } from "../services/eventBus.js";
import {
  runtimeQuerySchema,
  runtimeRecordWriteSchema,
  runtimeBatchCreateSchema,
  runtimeBatchUpdateSchema,
  runtimeBatchDeleteSchema,
  type Capabilities,
} from "../schemas/demoSchema.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const router = Router();

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error("[demoRuntime]", err);
      const status =
        err?.code === "P2025" ? 404 :
        (err && typeof err === "object" && "issues" in err) ? 400 : 500;
      res.status(status).json({
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
}

// ─── Rate limit (sliding window, in-memory) ───────────────────────────────
//
// Keys = `${demoId}:${ip}:${family}`. family ∈ {"read", "write"}.
// - read  budget: 200/min · 100000/day
// - write budget: 30/min · 10000/day
// V1 stays in-memory (single replica). Multi-instance → swap to Redis.

interface Bucket {
  minuteHits: number[];       // sliding 60s
  dayStartMs: number;          // current 24h window start
  dayHits: number;
}
const buckets = new Map<string, Bucket>();

const LIMITS = {
  read:  { perMin: 200, perDay: 100_000 },
  write: { perMin: 30,  perDay: 10_000 },
} as const;

function checkRateLimit(
  demoId: string,
  ip: string,
  family: "read" | "write",
): { ok: true } | { ok: false; retryAfterSec: number } {
  const key = `${demoId}:${ip}:${family}`;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { minuteHits: [], dayStartMs: now, dayHits: 0 };
    buckets.set(key, b);
  }
  // Roll minute window: drop hits older than 60s
  const cutoff = now - 60_000;
  b.minuteHits = b.minuteHits.filter((t) => t > cutoff);
  // Roll day window: reset if 24h elapsed
  if (now - b.dayStartMs > 86_400_000) {
    b.dayStartMs = now;
    b.dayHits = 0;
  }
  const { perMin, perDay } = LIMITS[family];
  if (b.minuteHits.length >= perMin) {
    const oldest = b.minuteHits[0]!;
    return { ok: false, retryAfterSec: Math.ceil((oldest + 60_000 - now) / 1000) };
  }
  if (b.dayHits >= perDay) {
    return { ok: false, retryAfterSec: Math.ceil((b.dayStartMs + 86_400_000 - now) / 1000) };
  }
  b.minuteHits.push(now);
  b.dayHits++;
  return { ok: true };
}

function rateLimitMiddleware(family: "read" | "write") {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.ip as string) || req.socket.remoteAddress || "unknown";
    const demoId = req.params.demoId;
    if (!demoId) return next();
    const r = checkRateLimit(demoId, ip, family);
    if (r.ok) {
      next();
    } else {
      res.setHeader("Retry-After", String(r.retryAfterSec));
      res
        .status(429)
        .json({ error: `rate limit exceeded (${family})`, retryAfterSec: r.retryAfterSec });
    }
  };
}

// ─── SDK script delivery ──────────────────────────────────────────────────
// GET /api/demo-runtime/:demoId/sdk.js — capability-aware SDK source

router.get("/:demoId/sdk.js", asyncHandler(async (req, res) => {
  const d = await prisma.demo.findUnique({
    where: { id: req.params.demoId },
    select: { id: true, dataTables: true, dataIdeas: true, capabilities: true },
  });
  if (!d) {
    res.status(404).type("text/plain").send("// Demo not found");
    return;
  }
  const js = buildSdkJs({
    demoId: d.id,
    dataTables: d.dataTables,
    dataIdeas: d.dataIdeas,
    capabilities: (d.capabilities ?? {}) as Capabilities,
  });
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.send(js);
}));

// ─── Table read ───────────────────────────────────────────────────────────

// POST /api/demo-runtime/:demoId/query
router.post(
  "/:demoId/query",
  rateLimitMiddleware("read"),
  demoCapabilityGuard("query", "table", { prisma }),
  asyncHandler(async (req, res) => {
    const input = runtimeQuerySchema.parse(req.body);
    let records = await store.getRecords(input.tableId);
    if (input.sort && typeof input.sort === "object") {
      // minimal sort support: { fieldId: "asc" | "desc" }
      const [fieldId, dir] = Object.entries(input.sort as Record<string, string>)[0] ?? [];
      if (fieldId) {
        records = [...records].sort((a, b) => {
          const va = a.cells[fieldId];
          const vb = b.cells[fieldId];
          if (va == null && vb == null) return 0;
          if (va == null) return dir === "desc" ? 1 : -1;
          if (vb == null) return dir === "desc" ? -1 : 1;
          const cmp = String(va).localeCompare(String(vb));
          return dir === "desc" ? -cmp : cmp;
        });
      }
    }
    if (input.filter && typeof input.filter === "object") {
      // Dumb filter: exact-match on each {fieldId: value}. V1 minimum.
      const f = input.filter as Record<string, unknown>;
      records = records.filter((r) =>
        Object.entries(f).every(([k, v]) => r.cells[k] === v),
      );
    }
    if (input.limit) {
      records = records.slice(0, input.limit);
    }
    res.json(records);
  }),
);

// GET /api/demo-runtime/:demoId/records/:recordId?tableId=
router.get(
  "/:demoId/records/:recordId",
  rateLimitMiddleware("read"),
  demoCapabilityGuard("getRecord", "table", { prisma }),
  asyncHandler(async (req, res) => {
    const tableId = req.query.tableId as string;
    const rec = await store.getRecord(tableId, req.params.recordId);
    if (!rec) { res.status(404).json({ error: "Record not found" }); return; }
    res.json(rec);
  }),
);

// GET /api/demo-runtime/:demoId/tables/:tableId/schema
router.get(
  "/:demoId/tables/:tableId/schema",
  rateLimitMiddleware("read"),
  (req, _res, next) => {
    // guard needs tableId — it's in params.tableId already, surface it as
    // `body.tableId` so the generic extractor grabs it.
    (req.body as any) = { ...(req.body || {}), tableId: req.params.tableId };
    next();
  },
  demoCapabilityGuard("describeTable", "table", { prisma }),
  asyncHandler(async (req, res) => {
    const t = await store.getTable(req.params.tableId);
    if (!t) { res.status(404).json({ error: "Table not found" }); return; }
    res.json({
      id: t.id,
      name: t.name,
      fields: t.fields.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        isPrimary: f.isPrimary,
        config: f.config,
      })),
      views: t.views.map((v) => ({ id: v.id, name: v.name, type: v.type })),
      recordCount: t.records.length,
    });
  }),
);

// ─── Table write ──────────────────────────────────────────────────────────

// POST /api/demo-runtime/:demoId/records
router.post(
  "/:demoId/records",
  rateLimitMiddleware("write"),
  demoCapabilityGuard("createRecord", "table", { prisma }),
  asyncHandler(async (req, res) => {
    const input = runtimeRecordWriteSchema.parse(req.body);
    const rec = await store.createRecord(input.tableId, { cells: input.cells as any });
    if (!rec) { res.status(500).json({ error: "createRecord returned null" }); return; }
    eventBus.emitChange({
      type: "record:create",
      tableId: input.tableId,
      clientId: `demo:${req.params.demoId}`,
      timestamp: Date.now(),
      payload: { record: rec },
    });
    res.status(201).json(rec);
  }),
);

// PUT /api/demo-runtime/:demoId/records/:recordId
router.put(
  "/:demoId/records/:recordId",
  rateLimitMiddleware("write"),
  demoCapabilityGuard("updateRecord", "table", { prisma }),
  asyncHandler(async (req, res) => {
    const input = runtimeRecordWriteSchema.parse(req.body);
    const rec = await store.updateRecord(
      input.tableId,
      req.params.recordId,
      { cells: input.cells as any },
    );
    if (!rec) { res.status(404).json({ error: "Record not found" }); return; }
    eventBus.emitChange({
      type: "record:update",
      tableId: input.tableId,
      clientId: `demo:${req.params.demoId}`,
      timestamp: Date.now(),
      payload: { record: rec },
    });
    res.json(rec);
  }),
);

// DELETE /api/demo-runtime/:demoId/records/:recordId?tableId=
router.delete(
  "/:demoId/records/:recordId",
  rateLimitMiddleware("write"),
  demoCapabilityGuard("deleteRecord", "table", { prisma }),
  asyncHandler(async (req, res) => {
    const tableId = req.query.tableId as string;
    const ok = await store.deleteRecord(tableId, req.params.recordId);
    if (!ok) { res.status(404).json({ error: "Record not found" }); return; }
    eventBus.emitChange({
      type: "record:delete",
      tableId,
      clientId: `demo:${req.params.demoId}`,
      timestamp: Date.now(),
      payload: { recordId: req.params.recordId },
    });
    res.json({ ok: true });
  }),
);

// Batch variants
router.post(
  "/:demoId/batch-create",
  rateLimitMiddleware("write"),
  demoCapabilityGuard("createRecord", "table", { prisma }),
  asyncHandler(async (req, res) => {
    const input = runtimeBatchCreateSchema.parse(req.body);
    const created = [];
    for (const rec of input.records) {
      const r = await store.createRecord(input.tableId, { cells: rec.cells as any });
      if (r) created.push(r);
    }
    eventBus.emitChange({
      type: "record:batch-create",
      tableId: input.tableId,
      clientId: `demo:${req.params.demoId}`,
      timestamp: Date.now(),
      payload: { records: created },
    });
    res.json({ created: created.length, records: created });
  }),
);

router.post(
  "/:demoId/batch-update",
  rateLimitMiddleware("write"),
  demoCapabilityGuard("updateRecord", "table", { prisma }),
  asyncHandler(async (req, res) => {
    const input = runtimeBatchUpdateSchema.parse(req.body);
    const updated = [];
    for (const u of input.updates) {
      const r = await store.updateRecord(input.tableId, u.recordId, { cells: u.cells as any });
      if (r) updated.push(r);
    }
    res.json({ updated: updated.length, records: updated });
  }),
);

router.post(
  "/:demoId/batch-delete",
  rateLimitMiddleware("write"),
  demoCapabilityGuard("deleteRecord", "table", { prisma }),
  asyncHandler(async (req, res) => {
    const input = runtimeBatchDeleteSchema.parse(req.body);
    const count = await store.batchDeleteRecords(input.tableId, input.recordIds);
    res.json({ deleted: count });
  }),
);

// ─── Idea read ────────────────────────────────────────────────────────────

// GET /api/demo-runtime/:demoId/ideas
router.get(
  "/:demoId/ideas",
  rateLimitMiddleware("read"),
  demoListGuard("listIdeas", { prisma }),
  asyncHandler(async (req, res) => {
    const demo = (req as any).demo as {
      dataIdeas: string[];
      workspaceId: string;
    };
    const ideas = await prisma.idea.findMany({
      where: { id: { in: demo.dataIdeas } },
      select: { id: true, name: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
    });
    res.json(
      ideas.map((i) => ({
        id: i.id,
        name: i.name,
        updatedAt: i.updatedAt.toISOString(),
      })),
    );
  }),
);

// GET /api/demo-runtime/:demoId/ideas/:ideaId
router.get(
  "/:demoId/ideas/:ideaId",
  rateLimitMiddleware("read"),
  demoCapabilityGuard("readIdea", "idea", { prisma }),
  asyncHandler(async (req, res) => {
    const idea = await prisma.idea.findUnique({
      where: { id: req.params.ideaId },
    });
    if (!idea) { res.status(404).json({ error: "Idea not found" }); return; }
    // sections is persisted; fall back to live extract if somehow empty.
    let sections: unknown = idea.sections;
    if (!Array.isArray(sections) || sections.length === 0) {
      try {
        sections = extractIdeaSections(idea.content);
      } catch {
        sections = [];
      }
    }
    res.json({
      id: idea.id,
      name: idea.name,
      content: idea.content,
      sections,
      version: idea.version,
      updatedAt: idea.updatedAt.toISOString(),
    });
  }),
);

export default router;
