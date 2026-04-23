/**
 * /api/analyst/* — REST proxy for Analyst MCP tools.
 *
 * All analyst MCP tools flow through these routes (mirror of other skills
 * — see CLAUDE.md "MCP Server 与 REST API 的同步规则"). The HTTP hop buys
 * us:
 *   - Uniform request logging in the main backend's access log
 *   - A stable surface we can unit-test with fetch
 *   - Future hook points (auth, rate-limit) without changing MCP tools
 *
 * Most routes take a `conversationId` — without it, we can't key DuckDB
 * sessions. When the chat agent forwards an MCP tool call, it injects
 * `X-Conversation-Id` via the dataStoreClient header. Standalone MCP
 * callers (stdio) can supply it in the body.
 */

import express, { type Request, type Response } from "express";
import * as runtime from "../services/analyst/duckdbRuntime.js";
import * as snapshot from "../services/analyst/snapshotService.js";
import * as store from "../services/dbStore.js";
import * as domain from "../services/analyst/domainFunctions.js";
import * as cache from "../services/analyst/resultCache.js";
import {
  loadWorkspaceTableSchema,
  filterResultSchema,
  groupAggregateSchema,
  pivotResultSchema,
  joinResultsSchema,
  timeBucketSchema,
  topNSchema,
  runSqlSchema,
  previewResultSchema,
  describeResultSchema,
} from "../schemas/analystSchema.js";
import type { Field } from "../types.js";

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────

function getConversationId(req: Request): string {
  const header = req.header("x-conversation-id");
  const body = typeof (req.body as any)?.conversationId === "string"
    ? (req.body as any).conversationId
    : undefined;
  const q = typeof req.query.conversationId === "string" ? req.query.conversationId : undefined;
  return header || body || q || "default";
}

function getWorkspaceId(req: Request): string {
  const header = req.header("x-workspace-id");
  const body = typeof (req.body as any)?.workspaceId === "string" ? (req.body as any).workspaceId : undefined;
  const q = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
  return header || body || q || "doc_default";
}

function handleError(res: Response, err: unknown, fallback = "Internal error"): void {
  const msg = err instanceof Error ? err.message : String(err);
  const isZodIssue = !!(err && typeof err === "object" && "issues" in (err as object));
  const code = isZodIssue
    ? 400
    : msg.includes("Unknown result handle") || msg.includes("Table not found")
    ? 404
    : 500;
  res.status(code).json({ error: msg || fallback });
}

function buildColumnHints(fields: Field[]): Record<string, { sourceField?: string; description?: string }> {
  const hints: Record<string, { sourceField?: string; description?: string }> = {};
  for (const f of fields) {
    hints[f.name] = {
      sourceField: f.name,
      ...(((f as { description?: string }).description)
        ? { description: (f as { description?: string }).description }
        : {}),
    };
  }
  return hints;
}

// ─── Data dictionary ──────────────────────────────────────────────────────

// GET /api/analyst/dictionary?workspaceId=&tableId=...&tableId=...
router.get("/dictionary", async (req: Request, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  try {
    const tableIds = Array.isArray(req.query.tableId)
      ? (req.query.tableId as string[])
      : req.query.tableId
      ? [req.query.tableId as string]
      : undefined;
    const tables = tableIds
      ? (await Promise.all(tableIds.map((id) => store.getTable(id)))).filter(
          (t): t is NonNullable<typeof t> => !!t,
        )
      : await store.listTables().then((list) => list.filter((t: any) => !t.workspaceId || t.workspaceId === workspaceId));

    const entries = tables.map((t: any) => ({
      tableId: t.id,
      tableName: t.name,
      fields: t.fields.map((f: any) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        ...(f.description ? { description: f.description } : {}),
        ...(Array.isArray(f.config?.options)
          ? { options: f.config.options.map((o: any) => ({ name: o.name })) }
          : {}),
      })),
    }));
    res.json({ workspaceId, tables: entries });
  } catch (err) {
    handleError(res, err, "Failed to read data dictionary");
  }
});

// ─── Snapshots ────────────────────────────────────────────────────────────

// GET /api/analyst/snapshots?tableId=&limit=
router.get("/snapshots", async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const tableId = typeof req.query.tableId === "string" ? req.query.tableId : undefined;
    const all = await snapshot.listSnapshots(tableId ? { tableId } : undefined);
    res.json({
      total: all.length,
      snapshots: all.slice(0, limit).map((s) => ({
        tableId: s.tableId,
        snapshotAt: s.snapshotAt,
        path: s.path,
        byteSize: s.byteSize,
      })),
    });
  } catch (err) {
    handleError(res, err, "Failed to list snapshots");
  }
});

// POST /api/analyst/snapshots/purge — { olderThanDays }
router.post("/snapshots/purge", async (req: Request, res: Response) => {
  try {
    const days = Math.max(1, Number((req.body as any)?.olderThanDays ?? 30));
    const result = await snapshot.purgeOldSnapshots(days * 86_400_000);
    res.json(result);
  } catch (err) {
    handleError(res, err, "Failed to purge snapshots");
  }
});

// ─── Cross-conversation cache (P5) ────────────────────────────────────────

// GET /api/analyst/cache — list cached entries
router.get("/cache", async (_req: Request, res: Response) => {
  try {
    const entries = await cache.listCache();
    res.json({ entries });
  } catch (err) {
    handleError(res, err, "Failed to list cache");
  }
});

// POST /api/analyst/cache/purge — { olderThanDays }
router.post("/cache/purge", async (req: Request, res: Response) => {
  try {
    const days = Math.max(1, Number((req.body as any)?.olderThanDays ?? 30));
    const r = await cache.purgeCache(days * 86_400_000);
    res.json(r);
  } catch (err) {
    handleError(res, err, "Failed to purge cache");
  }
});

// ─── Load workspace table (snapshot + attach + register as result) ────────

router.post("/load-workspace-table", async (req: Request, res: Response) => {
  try {
    const input = loadWorkspaceTableSchema.parse(req.body);
    const conversationId = getConversationId(req);
    const table = await store.getTable(input.tableId);
    if (!table) {
      res.status(404).json({ error: `Table not found: ${input.tableId}` });
      return;
    }

    // Reuse existing session snapshot unless refresh=true or explicit snapshotAt.
    const existingSnapshotAt = runtime.currentSnapshotForTable(conversationId, input.tableId);
    let resolvedPath: string;
    let resolvedSnapshotAt: string;
    if (input.refresh || input.snapshotAt || !existingSnapshotAt) {
      if (input.snapshotAt) {
        const resolved = await snapshot.resolveSnapshot(input.tableId, input.snapshotAt);
        if (!resolved) {
          res.status(404).json({ error: `No snapshot at ${input.snapshotAt}` });
          return;
        }
        resolvedPath = resolved.path;
        resolvedSnapshotAt = resolved.snapshotAt;
      } else {
        const created = await snapshot.createSnapshot(input.tableId);
        resolvedPath = created.path;
        resolvedSnapshotAt = created.snapshotAt;
      }
    } else {
      const resolved = await snapshot.resolveSnapshot(input.tableId, existingSnapshotAt);
      if (!resolved) {
        const created = await snapshot.createSnapshot(input.tableId);
        resolvedPath = created.path;
        resolvedSnapshotAt = created.snapshotAt;
      } else {
        resolvedPath = resolved.path;
        resolvedSnapshotAt = resolved.snapshotAt;
      }
    }

    const viewName = await runtime.attachSnapshot(
      conversationId,
      input.tableId,
      resolvedPath,
      resolvedSnapshotAt,
    );
    const meta = await runtime.createResult(conversationId, {
      sql: `SELECT * FROM ${viewName}`,
      sourceTableIds: [input.tableId],
      snapshotAt: resolvedSnapshotAt,
      producedBy: "load_workspace_table",
      description: `Source: ${table.name}`,
      columnHints: buildColumnHints(table.fields as Field[]),
    });
    const preview = await runtime.previewResult(conversationId, meta.handle, 20);
    res.json({ meta, preview });
  } catch (err) {
    handleError(res, err, "Failed to load workspace table");
  }
});

// ─── Preview / describe ───────────────────────────────────────────────────

router.post("/preview", async (req: Request, res: Response) => {
  try {
    const input = previewResultSchema.parse(req.body);
    const conversationId = getConversationId(req);
    const preview = await runtime.previewResult(conversationId, input.handle, input.limit ?? 20);
    res.json({ preview });
  } catch (err) {
    handleError(res, err, "preview failed");
  }
});

router.post("/describe", async (req: Request, res: Response) => {
  try {
    const input = describeResultSchema.parse(req.body);
    const conversationId = getConversationId(req);
    const stats = await runtime.describeResult(conversationId, input.handle, {
      topK: input.topK ?? 5,
    });
    res.json(stats);
  } catch (err) {
    handleError(res, err, "describe failed");
  }
});

// ─── Transform routes ─────────────────────────────────────────────────────

router.post("/filter", async (req: Request, res: Response) => {
  try {
    const input = filterResultSchema.parse(req.body);
    const conversationId = getConversationId(req);
    const src = await runtime.resolveHandle(conversationId, input.handle);
    runtime.assertSafeSql(`SELECT * FROM x WHERE ${input.where}`); // reuse AST guard via a probe
    const meta = await runtime.createResult(conversationId, {
      sql: `SELECT * FROM ${src.duckdbTable} WHERE ${input.where}`,
      sourceTableIds: src.sourceTableIds,
      snapshotAt: src.snapshotAt,
      producedBy: "filter_result",
      description: input.description,
      columnHints: fieldsToHints(src.fields),
    });
    const preview = await runtime.previewResult(conversationId, meta.handle, 20);
    res.json({ meta, preview });
  } catch (err) {
    handleError(res, err, "filter failed");
  }
});

router.post("/group-aggregate", async (req: Request, res: Response) => {
  try {
    const input = groupAggregateSchema.parse(req.body);
    const conversationId = getConversationId(req);
    const src = await runtime.resolveHandle(conversationId, input.handle);
    const groupCols = input.groupBy.map(runtime.quoteIdent).join(", ");
    const aggParts = input.metrics.map((m) => {
      const as = runtime.quoteIdent(m.as || `${m.op}_${m.field}`);
      const fieldExpr = runtime.quoteIdent(m.field);
      const expr =
        m.op === "count_distinct"
          ? `COUNT(DISTINCT ${fieldExpr})`
          : m.op === "median"
          ? `approx_quantile(${fieldExpr}, 0.5)`
          : m.op === "stddev"
          ? `stddev_samp(${fieldExpr})`
          : `${m.op.toUpperCase()}(${fieldExpr})`;
      return `${expr} AS ${as}`;
    });
    const sql = `SELECT ${groupCols}, ${aggParts.join(", ")} FROM ${src.duckdbTable} GROUP BY ${groupCols} ORDER BY ${groupCols}`;
    const meta = await runtime.createResult(conversationId, {
      sql,
      sourceTableIds: src.sourceTableIds,
      snapshotAt: src.snapshotAt,
      producedBy: "group_aggregate",
      description: input.description,
      columnHints: fieldsToHints(src.fields),
    });
    const preview = await runtime.previewResult(conversationId, meta.handle, 20);
    res.json({ meta, preview });
  } catch (err) {
    handleError(res, err, "group_aggregate failed");
  }
});

router.post("/pivot", async (req: Request, res: Response) => {
  try {
    const input = pivotResultSchema.parse(req.body);
    const conversationId = getConversationId(req);
    const src = await runtime.resolveHandle(conversationId, input.handle);
    // DuckDB native PIVOT:
    //   PIVOT src ON col1, col2 USING sum(v) AS sum_v GROUP BY row1, row2;
    const onCols = input.columns.map(runtime.quoteIdent).join(", ");
    const groupCols = input.rows.map(runtime.quoteIdent).join(", ");
    const usingParts = input.values.map((v) => {
      const fieldExpr = runtime.quoteIdent(v.field);
      return `${v.op}(${fieldExpr})`;
    });
    const sql = `PIVOT ${src.duckdbTable} ON ${onCols} USING ${usingParts.join(", ")} GROUP BY ${groupCols}`;
    const meta = await runtime.createResult(conversationId, {
      sql,
      sourceTableIds: src.sourceTableIds,
      snapshotAt: src.snapshotAt,
      producedBy: "pivot_result",
      description: input.description,
    });
    const preview = await runtime.previewResult(conversationId, meta.handle, 20);
    res.json({ meta, preview });
  } catch (err) {
    handleError(res, err, "pivot failed");
  }
});

router.post("/join", async (req: Request, res: Response) => {
  try {
    const input = joinResultsSchema.parse(req.body);
    const conversationId = getConversationId(req);
    const left = await runtime.resolveHandle(conversationId, input.leftHandle);
    const right = await runtime.resolveHandle(conversationId, input.rightHandle);
    const onClause = input.on
      .map(
        (k) =>
          `l.${runtime.quoteIdent(k.left)} = r.${runtime.quoteIdent(k.right)}`,
      )
      .join(" AND ");
    const joinKw =
      input.type === "inner"
        ? "INNER JOIN"
        : input.type === "left"
        ? "LEFT JOIN"
        : input.type === "right"
        ? "RIGHT JOIN"
        : "FULL OUTER JOIN";
    const sql = `SELECT l.*, r.* FROM ${left.duckdbTable} l ${joinKw} ${right.duckdbTable} r ON ${onClause}`;
    const meta = await runtime.createResult(conversationId, {
      sql,
      sourceTableIds: Array.from(new Set([...left.sourceTableIds, ...right.sourceTableIds])),
      snapshotAt: left.snapshotAt < right.snapshotAt ? left.snapshotAt : right.snapshotAt,
      producedBy: "join_results",
      description: input.description,
    });
    const preview = await runtime.previewResult(conversationId, meta.handle, 20);
    res.json({ meta, preview });
  } catch (err) {
    handleError(res, err, "join failed");
  }
});

router.post("/time-bucket", async (req: Request, res: Response) => {
  try {
    const input = timeBucketSchema.parse(req.body);
    const conversationId = getConversationId(req);
    const src = await runtime.resolveHandle(conversationId, input.handle);
    const bucketExpr = `date_trunc('${input.granularity}', ${runtime.quoteIdent(input.dateField)})`;
    const extraGroups = (input.groupBy ?? []).map(runtime.quoteIdent).join(", ");
    const allGroups = [bucketExpr, extraGroups].filter(Boolean).join(", ");
    const aggParts = input.metrics.map((m) => {
      const as = runtime.quoteIdent(m.as || `${m.op}_${m.field}`);
      const fieldExpr = runtime.quoteIdent(m.field);
      return `${m.op.toUpperCase()}(${fieldExpr}) AS ${as}`;
    });
    const sql = `SELECT ${bucketExpr} AS bucket${extraGroups ? ", " + extraGroups : ""}, ${aggParts.join(", ")}
                 FROM ${src.duckdbTable}
                 GROUP BY ${allGroups}
                 ORDER BY bucket`;
    const meta = await runtime.createResult(conversationId, {
      sql,
      sourceTableIds: src.sourceTableIds,
      snapshotAt: src.snapshotAt,
      producedBy: "time_bucket",
      description: input.description,
    });
    const preview = await runtime.previewResult(conversationId, meta.handle, 20);
    res.json({ meta, preview });
  } catch (err) {
    handleError(res, err, "time_bucket failed");
  }
});

router.post("/top-n", async (req: Request, res: Response) => {
  try {
    const input = topNSchema.parse(req.body);
    const conversationId = getConversationId(req);
    const src = await runtime.resolveHandle(conversationId, input.handle);
    const orderClause = input.orderBy
      .map((o) => `${runtime.quoteIdent(o.field)} ${o.direction.toUpperCase()}`)
      .join(", ");
    const sql = `SELECT * FROM ${src.duckdbTable} ORDER BY ${orderClause} LIMIT ${input.n}`;
    const meta = await runtime.createResult(conversationId, {
      sql,
      sourceTableIds: src.sourceTableIds,
      snapshotAt: src.snapshotAt,
      producedBy: "top_n",
      description: input.description,
      columnHints: fieldsToHints(src.fields),
    });
    const preview = await runtime.previewResult(conversationId, meta.handle, Math.min(input.n, 20));
    res.json({ meta, preview });
  } catch (err) {
    handleError(res, err, "top_n failed");
  }
});

router.post("/run-sql", async (req: Request, res: Response) => {
  try {
    const input = runSqlSchema.parse(req.body);
    const conversationId = getConversationId(req);
    runtime.assertSafeSql(input.sql);
    // Accept both `FROM ducktbl_<hex>` (handle) and `FROM r_<hex>` (DuckDB
    // table name). The handle form is what we expose in Turn Context, so
    // the Agent naturally reaches for it first. See issue-3 debugging
    // notes in docs/changelog.md.
    let sql = runtime.rewriteHandleToTable(input.sql);
    // Strip any "CREATE TABLE x AS" prefix — we re-wrap so the handle table
    // name matches the runtime.createResult convention.
    const stripped = sql.replace(
      /^\s*CREATE\s+TABLE\s+\w+\s+AS\s+/i,
      "",
    );
    const openSessions = runtime.listOpenSessions();
    const sessionIds = new Set(openSessions.map((s) => s.conversationId));
    const sourceTableIds = sessionIds.has(conversationId) ? await collectSourceTableIds(conversationId) : [];
    const meta = await runtime.createResult(conversationId, {
      sql: stripped,
      sourceTableIds,
      snapshotAt: new Date().toISOString(),
      producedBy: "run_sql",
      description: input.description,
    });
    const preview = await runtime.previewResult(conversationId, meta.handle, 20);
    res.json({ meta, preview });
  } catch (err) {
    handleError(res, err, "run_sql failed");
  }
});

async function collectSourceTableIds(conversationId: string): Promise<string[]> {
  try {
    const handles = await runtime.listHandles(conversationId);
    return Array.from(new Set(handles.flatMap((h) => h.sourceTableIds)));
  } catch {
    return [];
  }
}

// ─── Field description proposals (P5) ────────────────────────────────────
//
// Lightweight heuristic proposer: inspects field name + sample values to
// suggest a one-line description the user can accept or edit. No LLM call
// — keeps cost at 0 and response at < 100ms. For higher-quality proposals
// an LLM-backed implementation can be layered later via aiService.

router.post("/propose-field-descriptions", async (req: Request, res: Response) => {
  try {
    const tableId = (req.body as any)?.tableId as string;
    if (!tableId) { res.status(400).json({ error: "tableId required" }); return; }
    const table = await store.getTable(tableId);
    if (!table) { res.status(404).json({ error: "Table not found" }); return; }

    const proposals = table.fields.map((f: any) => {
      const existing = typeof f.description === "string" ? f.description : "";
      const sampleVals = table.records.slice(0, 20)
        .map((r: any) => r.cells?.[f.id])
        .filter((v: unknown) => v !== null && v !== undefined && v !== "");
      return {
        fieldId: f.id,
        fieldName: f.name,
        fieldType: f.type,
        existing,
        proposed: proposeDescription(f.name, f.type, sampleVals),
        sampleValues: sampleVals.slice(0, 5),
      };
    });

    res.json({ tableId, proposals });
  } catch (err) {
    handleError(res, err, "propose-field-descriptions failed");
  }
});

function proposeDescription(name: string, type: string, samples: unknown[]): string {
  const n = name.toLowerCase();
  const commonLookups: Array<[RegExp, string]> = [
    [/\b(id|编号)\b/i, "唯一标识符"],
    [/创建\s*时间|created_?at/i, "记录创建时间"],
    [/更新\s*时间|modified_?at|updated_?at/i, "最近修改时间"],
    [/姓名|人名|name/i, "名称 / 姓名"],
    [/^status$|状态/i, "状态"],
    [/负责|owner|assignee/i, "负责人"],
    [/手机|phone/i, "手机号码"],
    [/邮箱|email/i, "电子邮箱"],
    [/金额|价格|amount|price|revenue|cost/i, "金额（数值）"],
    [/数量|quantity|count|qty/i, "数量"],
    [/工时|hours|duration/i, "工时 / 时长"],
    [/优先级|priority/i, "优先级"],
    [/分类|类型|category|type/i, "分类 / 类型"],
    [/地址|地区|city|province|region/i, "地址 / 地区"],
    [/备注|说明|描述|desc|note|remark/i, "文字描述 / 备注"],
  ];
  for (const [re, hint] of commonLookups) {
    if (re.test(name)) return hint;
  }
  // Type-based fallback
  if (/Number|Currency|Progress|Rating|AutoNumber/.test(type)) return "数值字段";
  if (/DateTime|CreatedTime|ModifiedTime/.test(type)) return "日期 / 时间";
  if (/Checkbox/.test(type)) return "布尔字段";
  if (/Select/.test(type)) {
    const unique = Array.from(new Set(samples.map(String))).slice(0, 3);
    return unique.length > 0 ? `单选，常见：${unique.join(", ")}` : "单选字段";
  }
  return "文本字段";
}

// ─── Domain functions (P4 · finance / accounting / internet) ─────────────
//
// These routes are thin wrappers around pure functions in domainFunctions.ts.
// For tools that also need to read rows from a DuckDB handle, the tool
// handler fetches the handle's rows first, then POSTs the array here.

router.post("/finance/irr", (req, res) => {
  const cashflows = (req.body as any)?.cashflows as number[];
  if (!Array.isArray(cashflows)) { res.status(400).json({ error: "cashflows required" }); return; }
  res.json({ irr: domain.irr(cashflows) });
});

router.post("/finance/npv", (req, res) => {
  const { rate, cashflows } = (req.body ?? {}) as { rate?: number; cashflows?: number[] };
  if (typeof rate !== "number" || !Array.isArray(cashflows)) {
    res.status(400).json({ error: "rate + cashflows required" }); return;
  }
  res.json({ npv: domain.npv(rate, cashflows) });
});

router.post("/finance/wacc", (req, res) => {
  const b = req.body as any;
  res.json({
    wacc: domain.wacc(
      Number(b.equity), Number(b.debt),
      Number(b.costOfEquity), Number(b.costOfDebt), Number(b.taxRate),
    ),
  });
});

router.post("/finance/cagr", (req, res) => {
  const b = req.body as any;
  res.json({ cagr: domain.cagr(Number(b.startValue), Number(b.endValue), Number(b.periods)) });
});

router.post("/finance/volatility", (req, res) => {
  const returns = (req.body as any)?.returns as number[];
  const periodsPerYear = Number((req.body as any)?.periodsPerYear ?? 252);
  if (!Array.isArray(returns)) { res.status(400).json({ error: "returns required" }); return; }
  res.json({ volatility: domain.volatility(returns, periodsPerYear) });
});

router.post("/finance/sharpe", (req, res) => {
  const { returns, riskFreeRate, periodsPerYear } = (req.body ?? {}) as any;
  if (!Array.isArray(returns)) { res.status(400).json({ error: "returns required" }); return; }
  res.json({
    sharpe: domain.sharpe(returns, Number(riskFreeRate ?? 0), Number(periodsPerYear ?? 252)),
  });
});

router.post("/finance/beta", (req, res) => {
  const { assetReturns, marketReturns } = (req.body ?? {}) as any;
  if (!Array.isArray(assetReturns) || !Array.isArray(marketReturns)) {
    res.status(400).json({ error: "assetReturns + marketReturns required" }); return;
  }
  res.json({ beta: domain.beta(assetReturns, marketReturns) });
});

router.post("/finance/max-drawdown", (req, res) => {
  const values = (req.body as any)?.values as number[];
  if (!Array.isArray(values)) { res.status(400).json({ error: "values required" }); return; }
  res.json({ maxDrawdown: domain.maxDrawdown(values) });
});

// Accounting
router.post("/accounting/dupont", (req, res) => {
  const i = (req.body ?? {}) as any;
  res.json(domain.dupontAnalysis({
    netIncome: Number(i.netIncome), revenue: Number(i.revenue),
    totalAssets: Number(i.totalAssets), equity: Number(i.equity),
  }));
});
router.post("/accounting/current-ratio", (req, res) => {
  const b = req.body as any;
  res.json({ currentRatio: domain.currentRatio(Number(b.currentAssets), Number(b.currentLiabilities)) });
});
router.post("/accounting/quick-ratio", (req, res) => {
  const b = req.body as any;
  res.json({
    quickRatio: domain.quickRatio(
      Number(b.currentAssets), Number(b.inventory), Number(b.currentLiabilities),
    ),
  });
});
router.post("/accounting/debt-to-equity", (req, res) => {
  const b = req.body as any;
  res.json({ debtToEquity: domain.debtToEquity(Number(b.totalDebt), Number(b.equity)) });
});
router.post("/accounting/margins", (req, res) => {
  const b = req.body as any;
  const rev = Number(b.revenue);
  res.json({
    grossMargin: domain.grossMargin(rev, Number(b.cogs ?? 0)),
    operatingMargin: domain.operatingMargin(rev, Number(b.operatingIncome ?? 0)),
    netMargin: domain.netMargin(rev, Number(b.netIncome ?? 0)),
  });
});

// Internet / product
router.post("/internet/dau-mau", async (req, res) => {
  try {
    const { handle, userField, dateField } = (req.body ?? {}) as any;
    if (!handle || !userField || !dateField) {
      res.status(400).json({ error: "handle, userField, dateField required" }); return;
    }
    const conversationId = getConversationId(req);
    const meta = await runtime.resolveHandle(conversationId, handle);
    const rows = await runtime.readRows(
      conversationId,
      `SELECT ${runtime.quoteIdent(userField)} AS userId, CAST(${runtime.quoteIdent(dateField)} AS VARCHAR) AS date FROM ${meta.duckdbTable}`,
    );
    res.json(domain.dauMau(rows as Array<{ userId: string; date: string }>));
  } catch (err) {
    handleError(res, err, "dau_mau failed");
  }
});
router.post("/internet/funnel", async (req, res) => {
  try {
    const { handle, userField, stageField, stages } = (req.body ?? {}) as any;
    if (!handle || !userField || !stageField || !Array.isArray(stages)) {
      res.status(400).json({ error: "handle, userField, stageField, stages required" }); return;
    }
    const conversationId = getConversationId(req);
    const meta = await runtime.resolveHandle(conversationId, handle);
    const rows = await runtime.readRows(
      conversationId,
      `SELECT ${runtime.quoteIdent(userField)} AS userId, ${runtime.quoteIdent(stageField)} AS stage FROM ${meta.duckdbTable}`,
    );
    res.json({ stages: domain.funnelConversion(rows as Array<{ userId: string; stage: string }>, stages) });
  } catch (err) { handleError(res, err, "funnel failed"); }
});
router.post("/internet/cohort-retention", async (req, res) => {
  try {
    const { handle, userField, dateField, granularity, periods } = (req.body ?? {}) as any;
    if (!handle || !userField || !dateField || !granularity) {
      res.status(400).json({ error: "handle, userField, dateField, granularity required" }); return;
    }
    const conversationId = getConversationId(req);
    const meta = await runtime.resolveHandle(conversationId, handle);
    const rows = await runtime.readRows(
      conversationId,
      `SELECT ${runtime.quoteIdent(userField)} AS userId, CAST(${runtime.quoteIdent(dateField)} AS VARCHAR) AS date FROM ${meta.duckdbTable}`,
    );
    res.json({
      rows: domain.cohortRetention(rows as Array<{ userId: string; date: string }>, {
        granularity,
        periods: Number(periods ?? 8),
      }),
    });
  } catch (err) { handleError(res, err, "cohort_retention failed"); }
});
router.post("/internet/arpu", async (req, res) => {
  try {
    const { handle, userField, revenueField } = (req.body ?? {}) as any;
    if (!handle || !userField || !revenueField) {
      res.status(400).json({ error: "handle, userField, revenueField required" }); return;
    }
    const conversationId = getConversationId(req);
    const meta = await runtime.resolveHandle(conversationId, handle);
    const rows = await runtime.readRows(
      conversationId,
      `SELECT ${runtime.quoteIdent(userField)} AS userId, CAST(${runtime.quoteIdent(revenueField)} AS DOUBLE) AS revenue FROM ${meta.duckdbTable}`,
    );
    res.json(domain.arpu(rows as Array<{ userId: string; revenue: number }>));
  } catch (err) { handleError(res, err, "arpu failed"); }
});

// ─── Chart generation (P3) ────────────────────────────────────────────────
//
// Generates a vega-lite spec from a result handle + encoding hints. The
// tool itself is schema-shaping — DuckDB gets asked for the rows (up to
// 1000, downsampled by modulo if needed) and we splice them into
// `data.values`. The FE renders via vega-embed.

router.post("/generate-chart", async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      handle?: string;
      chartType?: "bar" | "line" | "pie" | "area" | "scatter";
      x?: string;
      y?: string;
      series?: string;
      title?: string;
      aggregate?: "sum" | "count" | "avg" | "min" | "max";
    };
    if (!body.handle || !body.chartType) {
      res.status(400).json({ error: "handle and chartType are required" });
      return;
    }
    const conversationId = getConversationId(req);
    const meta = await runtime.resolveHandle(conversationId, body.handle);
    // Grab at most 1000 rows — downsample if larger
    const previewLimit = Math.min(1000, meta.rowCount);
    const preview = await runtime.previewResult(conversationId, body.handle, previewLimit);
    const dataValues = preview.rows;
    const spec = buildVegaLiteSpec(body, dataValues);
    res.json({
      _chartSpec: spec,
      handle: body.handle,
      sampledRows: dataValues.length,
      totalRows: meta.rowCount,
    });
  } catch (err) {
    handleError(res, err, "generate_chart failed");
  }
});

function buildVegaLiteSpec(
  body: {
    chartType?: "bar" | "line" | "pie" | "area" | "scatter";
    x?: string;
    y?: string;
    series?: string;
    title?: string;
    aggregate?: "sum" | "count" | "avg" | "min" | "max";
  },
  values: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const commonData = { values };
  const xField = body.x;
  const yField = body.y;
  const seriesField = body.series;
  const agg = body.aggregate;

  if (body.chartType === "pie") {
    return {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      ...(body.title ? { title: body.title } : {}),
      data: commonData,
      mark: { type: "arc", tooltip: true },
      encoding: {
        theta: { field: yField, type: "quantitative", ...(agg ? { aggregate: agg } : {}) },
        color: { field: xField, type: "nominal" },
      },
      width: "container",
      height: 260,
    };
  }

  const baseMark =
    body.chartType === "line"
      ? { type: "line", point: true, tooltip: true }
      : body.chartType === "area"
      ? { type: "area", tooltip: true }
      : body.chartType === "scatter"
      ? { type: "circle", tooltip: true }
      : { type: "bar", tooltip: true };

  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    ...(body.title ? { title: body.title } : {}),
    data: commonData,
    mark: baseMark,
    encoding: {
      x: { field: xField, type: inferVegaType(xField, values, "nominal") },
      y: {
        field: yField,
        type: "quantitative",
        ...(agg ? { aggregate: agg } : {}),
      },
      ...(seriesField
        ? { color: { field: seriesField, type: "nominal" } }
        : {}),
      tooltip: [
        { field: xField },
        { field: yField, type: "quantitative" },
        ...(seriesField ? [{ field: seriesField }] : []),
      ],
    },
    width: "container",
    height: 260,
  };
}

function inferVegaType(
  field: string | undefined,
  values: Array<Record<string, unknown>>,
  fallback: "nominal" | "temporal" | "quantitative",
): string {
  if (!field) return fallback;
  const sample = values.find((r) => r[field] !== null && r[field] !== undefined);
  if (!sample) return fallback;
  const v = sample[field];
  if (typeof v === "number") return "quantitative";
  if (v instanceof Date) return "temporal";
  if (typeof v === "string") {
    // Heuristic: ISO date format → temporal
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return "temporal";
    return "nominal";
  }
  return fallback;
}

// ─── Handle resolution for write-to-idea / write-to-table ─────────────────

// GET /api/analyst/handle/:handle/rows?limit=
router.get("/handle/:handle/rows", async (req: Request, res: Response) => {
  try {
    const conversationId = getConversationId(req);
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit ?? 500)));
    const preview = await runtime.previewResult(conversationId, req.params.handle, limit);
    res.json(preview);
  } catch (err) {
    handleError(res, err, "handle rows fetch failed");
  }
});

router.get("/handle/:handle/meta", async (req: Request, res: Response) => {
  try {
    const conversationId = getConversationId(req);
    const meta = await runtime.resolveHandle(conversationId, req.params.handle);
    res.json(meta);
  } catch (err) {
    handleError(res, err, "handle meta fetch failed");
  }
});

// ─── Session lifecycle ────────────────────────────────────────────────────

router.post("/session/close", async (req: Request, res: Response) => {
  try {
    const conversationId = getConversationId(req);
    await runtime.closeSession(conversationId);
    if ((req.body as any)?.deleteFile) {
      await runtime.deleteSessionFile(conversationId);
    }
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, "close session failed");
  }
});

router.get("/session/status", async (req: Request, res: Response) => {
  const conversationId = getConversationId(req);
  res.json({
    conversationId,
    open: runtime.hasOpenSession(conversationId),
    fileExists: runtime.sessionFileExists(conversationId),
  });
});

// GET /api/analyst/handles — list active result handles for the conversation.
// Powers chatAgentService's Turn Context injection (see buildAnalystHandlesSection),
// and useful for debugging / FE "recent analysis" pickers.
router.get("/handles", async (req: Request, res: Response) => {
  try {
    const conversationId = getConversationId(req);
    const list = await runtime.listHandlesIfExists(conversationId);
    res.json({
      conversationId,
      count: list.length,
      handles: list.map((h) => ({
        handle: h.handle,
        producedBy: h.producedBy,
        producedAt: h.producedAt,
        rowCount: h.rowCount,
        fields: h.fields.map((f) => f.name),
        description: h.description,
        sourceTableIds: h.sourceTableIds,
      })),
    });
  } catch (err) {
    handleError(res, err, "Failed to list handles");
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function fieldsToHints(
  fields: Array<{ name: string; sourceField?: string; description?: string }>,
): Record<string, { sourceField?: string; description?: string }> {
  const hints: Record<string, { sourceField?: string; description?: string }> = {};
  for (const f of fields) {
    if (f.sourceField || f.description) {
      hints[f.name] = {
        ...(f.sourceField ? { sourceField: f.sourceField } : {}),
        ...(f.description ? { description: f.description } : {}),
      };
    }
  }
  return hints;
}

export default router;
