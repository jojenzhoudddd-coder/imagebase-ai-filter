/**
 * Analyst → Artifact write tools.
 *
 *   write_analysis_to_idea — Creates or appends to an Idea Markdown doc
 *     with analysis narrative + rendered Markdown table + optional vega-lite
 *     fenced code blocks. The high-frequency output path for analyst.
 *
 *   write_analysis_to_table — Materializes a handle as a new workspace Table
 *     (Lark-style grid). Low-frequency; capped at 50000 rows.
 *
 * Both tools go through the main backend's existing /api/ideas and
 * /api/tables routes so they trigger eventBus + share persistence paths.
 * The analyst HTTP API only supplies the handle's rows on demand.
 */

import { apiRequest, toolResult } from "../dataStoreClient.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

const MAX_TABLE_ROWS = 50_000;
const INLINE_PREVIEW_ROW_LIMIT = 500;

function fwd(ctx?: ToolContext) {
  return {
    conversationId: ctx?.conversationId || "default",
    workspaceId: ctx?.workspaceId || "doc_default",
  };
}

/** Fetch meta + rows from the analyst runtime for a handle. */
async function fetchHandle(
  handle: string,
  ctx: ToolContext | undefined,
  limit: number,
): Promise<{
  meta: {
    handle: string;
    duckdbTable: string;
    sourceTableIds: string[];
    snapshotAt: string;
    rowCount: number;
    fields: Array<{ name: string; type: string; description?: string }>;
    producedBy: string;
    producedAt: string;
    description?: string;
  };
  preview: {
    columns: Array<{ name: string; type: string }>;
    rows: Array<Record<string, unknown>>;
    rowCount: number;
    truncated: boolean;
    previewLimit: number;
  };
}> {
  const meta = await apiRequest<any>(
    `/api/analyst/handle/${encodeURIComponent(handle)}/meta`,
    { method: "GET", ...fwd(ctx) },
  );
  const preview = await apiRequest<any>(
    `/api/analyst/handle/${encodeURIComponent(handle)}/rows?limit=${limit}`,
    { method: "GET", ...fwd(ctx) },
  );
  return { meta, preview };
}

/** Build a Markdown table from {columns, rows}. Truncates cell text > 200 chars. */
function toMarkdownTable(
  columns: Array<{ name: string; type: string }>,
  rows: Array<Record<string, unknown>>,
): string {
  if (!columns.length) return "_(结果为空)_";
  const headerRow = "| " + columns.map((c) => escapeCell(c.name)).join(" | ") + " |";
  const sep = "| " + columns.map(() => "---").join(" | ") + " |";
  const bodyRows = rows.map(
    (r) =>
      "| " +
      columns
        .map((c) => escapeCell(formatCell(r[c.name])))
        .join(" | ") +
      " |",
  );
  return [headerRow, sep, ...bodyRows].join("\n");
}

function escapeCell(s: string): string {
  if (!s) return "";
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/\.?0+$/, "");
  if (typeof v === "string") return v.length > 200 ? v.slice(0, 197) + "…" : v;
  if (typeof v === "boolean") return v ? "✓" : "";
  try {
    const j = JSON.stringify(v);
    return j.length > 200 ? j.slice(0, 197) + "…" : j;
  } catch {
    return String(v);
  }
}

function defaultTitle(meta: { sourceTableIds: string[]; producedBy: string }): string {
  const date = new Date().toISOString().slice(0, 10);
  if (meta.sourceTableIds.length) {
    return `分析报告 · ${meta.sourceTableIds[0]} · ${date}`;
  }
  return `分析报告 · ${date}`;
}

// ─── Tool definitions ─────────────────────────────────────────────────────

export const analystWriteTools: ToolDefinition[] = [
  {
    name: "write_analysis_to_idea",
    description:
      "将 Analyst 的分析结果落地为一份 Idea 文档（高频出口）。" +
      "自动包含：分析结论正文（narrative）+ 核心结果 Markdown 表格 + 时点声明 + 可选 vega-lite 图表代码块。" +
      "若 ideaId 为空则创建新文档（标题用 title 或自动生成）；指定 ideaId 则追加到该文档末尾。" +
      "**仅当用户明确表达导出 / 整理文档 / 保存意图时才调用**，不要主动落地。",
    inputSchema: {
      type: "object",
      required: ["handle", "narrative", "workspaceId"],
      properties: {
        handle: { type: "string" },
        additionalHandles: { type: "array", items: { type: "string" } },
        narrative: { type: "string", description: "Markdown 分析叙述段（结论 + 解读）" },
        chartSpecs: {
          type: "array",
          description: "可选：vega-lite JSON spec 数组，会作为 ```vega-lite 代码块嵌入",
          items: { type: "object" },
        },
        ideaId: { type: "string", description: "可选：追加到已有 Idea" },
        title: { type: "string", description: "新 Idea 的标题；省略时自动生成" },
        workspaceId: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      const workspaceId = args.workspaceId as string;
      ctx?.progress?.({ phase: "planning", message: `准备写入 Idea` });
      const { meta, preview } = await fetchHandle(
        args.handle as string,
        ctx,
        INLINE_PREVIEW_ROW_LIMIT,
      );

      // Additional handles — fetched sequentially so we can report progress.
      const addlBlocks: Array<{ title: string; table: string; note: string }> = [];
      const addlHandles = (args.additionalHandles as string[]) || [];
      for (let i = 0; i < addlHandles.length; i++) {
        ctx?.progress?.({
          phase: "computing",
          message: `加载附加结果 ${i + 1}/${addlHandles.length}`,
          current: i + 1,
          total: addlHandles.length,
        });
        try {
          const extra = await fetchHandle(addlHandles[i], ctx, INLINE_PREVIEW_ROW_LIMIT);
          addlBlocks.push({
            title: extra.meta.description || `附加结果 ${i + 1}`,
            table: toMarkdownTable(extra.preview.columns, extra.preview.rows),
            note:
              extra.preview.truncated
                ? `\n\n_仅显示前 ${extra.preview.rows.length} 行，完整 ${extra.meta.rowCount} 行_`
                : "",
          });
        } catch (err) {
          addlBlocks.push({
            title: `附加结果 (无法加载)`,
            table: "",
            note: `_加载失败: ${err instanceof Error ? err.message : String(err)}_`,
          });
        }
      }

      // Compose markdown content
      const snapStamp = meta.snapshotAt.slice(0, 19).replace("T", " ");
      const title = (args.title as string | undefined) || defaultTitle(meta);
      const mainTable = toMarkdownTable(preview.columns, preview.rows);
      const truncNote = preview.truncated
        ? `\n\n_以上为前 ${preview.rows.length} 行，完整结果共 ${meta.rowCount} 行。如需全量请再问一次。_`
        : "";
      const chartBlocks = ((args.chartSpecs as unknown[]) || []).map((spec) => {
        return "```vega-lite\n" + JSON.stringify(spec, null, 2) + "\n```";
      });

      const parts: string[] = [
        `_本次分析基于 ${snapStamp} 的数据快照（${meta.sourceTableIds.join(", ") || "多表"}）_`,
        "",
        "## 分析结论",
        args.narrative as string,
        "",
        "## 核心数据",
        mainTable + truncNote,
      ];
      if (chartBlocks.length) {
        parts.push("", "## 图表");
        parts.push(chartBlocks.join("\n\n"));
      }
      for (const blk of addlBlocks) {
        parts.push("", `## ${blk.title}`);
        if (blk.table) parts.push(blk.table);
        if (blk.note) parts.push(blk.note);
      }
      parts.push("", `_来源：${meta.producedBy} · handle=${meta.handle} · ${meta.rowCount} 行_`);

      const body = parts.join("\n");

      ctx?.progress?.({ phase: "finalizing", message: `写入文档` });
      let ideaId = args.ideaId as string | undefined;
      if (!ideaId) {
        const created = await apiRequest<{ id: string; name: string; version: number }>(
          "/api/ideas",
          {
            method: "POST",
            body: { name: title, workspaceId },
          },
        );
        ideaId = created.id;
        // Write content via the anchor endpoint
        await apiRequest(`/api/ideas/${encodeURIComponent(ideaId)}/write`, {
          method: "POST",
          body: {
            anchor: { position: "end" },
            payload: `# ${title}\n\n${body}`,
          },
        });
        return toolResult({
          ideaId,
          title,
          created: true,
          mention: `[@${title}](mention://idea/${ideaId})`,
          handle: meta.handle,
        });
      }

      await apiRequest(`/api/ideas/${encodeURIComponent(ideaId)}/write`, {
        method: "POST",
        body: {
          anchor: { position: "end" },
          payload: `\n\n---\n\n## ${title}\n\n${body}`,
        },
      });
      return toolResult({
        ideaId,
        title,
        created: false,
        mention: `[@${title}](mention://idea/${ideaId})`,
        handle: meta.handle,
      });
    },
  },

  {
    name: "write_analysis_to_table",
    description:
      "将 Analyst 结果物化为一张 workspace 数据表（低频出口，最多 50000 行）。" +
      "字段类型从 DuckDB 列类型自动推断（或使用 fieldMappings 显式指定）：" +
      "DOUBLE/BIGINT → Number，VARCHAR → Text，TIMESTAMP → DateTime，BOOLEAN → Checkbox。" +
      "⚠️ 仅当用户明确要求「落成新表」「做成表格」时调用。结果超 50000 行会拒绝，建议改为写入文档。",
    inputSchema: {
      type: "object",
      required: ["handle", "tableName", "workspaceId"],
      properties: {
        handle: { type: "string" },
        tableName: { type: "string" },
        workspaceId: { type: "string" },
        fieldMappings: {
          type: "array",
          items: {
            type: "object",
            required: ["duckdbField", "tableFieldName", "tableFieldType"],
            properties: {
              duckdbField: { type: "string" },
              tableFieldName: { type: "string" },
              tableFieldType: {
                type: "string",
                enum: ["Text", "Number", "DateTime", "Checkbox", "SingleSelect"],
              },
            },
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const workspaceId = args.workspaceId as string;
      ctx?.progress?.({ phase: "planning", message: `准备建表` });
      const { meta, preview } = await fetchHandle(
        args.handle as string,
        ctx,
        MAX_TABLE_ROWS + 1,
      );
      if (meta.rowCount > MAX_TABLE_ROWS) {
        return toolResult({
          error: `结果共 ${meta.rowCount} 行，超过 write_analysis_to_table 的 ${MAX_TABLE_ROWS} 行上限。建议改用 write_analysis_to_idea 生成文档，或让用户导出 CSV。`,
          rowCount: meta.rowCount,
        });
      }

      // Build field mappings: user-supplied takes precedence, otherwise
      // auto-infer from DuckDB types.
      const mappings = (args.fieldMappings as Array<any> | undefined) ?? meta.fields.map(
        (f) => ({
          duckdbField: f.name,
          tableFieldName: f.name,
          tableFieldType: inferTableFieldType(f.type),
        }),
      );

      // Step 1 — create the empty table
      ctx?.progress?.({ phase: "computing", message: `创建数据表` });
      const tbl = await apiRequest<{ id: string; name: string }>("/api/tables", {
        method: "POST",
        body: { name: args.tableName as string, workspaceId },
      });
      const tableId = tbl.id;

      // Step 2 — build fields. The backend creates a default primary text field,
      // which we first rename to match our first mapping (instead of adding a
      // duplicate). Then we create the rest via /fields.
      const existingFields = await apiRequest<any[]>(
        `/api/tables/${tableId}/fields`,
        { method: "GET" },
      );
      const primary = existingFields.find((f) => f.isPrimary) ?? existingFields[0];
      const firstMap = mappings[0];
      if (primary && firstMap) {
        await apiRequest(`/api/tables/${tableId}/fields/${primary.id}`, {
          method: "PUT",
          body: {
            name: firstMap.tableFieldName,
            type: firstMap.tableFieldType,
            config: {},
          },
        });
      }
      const createdFields: Array<{ id: string; duckdbField: string }> = [];
      if (primary) createdFields.push({ id: primary.id, duckdbField: firstMap.duckdbField });
      for (let i = 1; i < mappings.length; i++) {
        const m = mappings[i];
        ctx?.progress?.({
          phase: "computing",
          message: `创建字段 ${i + 1}/${mappings.length}`,
          current: i + 1,
          total: mappings.length,
        });
        const f = await apiRequest<any>(`/api/tables/${tableId}/fields`, {
          method: "POST",
          body: { name: m.tableFieldName, type: m.tableFieldType, config: {} },
        });
        createdFields.push({ id: f.id, duckdbField: m.duckdbField });
      }

      // Step 3 — delete the 5 default empty records
      const existingRecs = await apiRequest<any[]>(
        `/api/tables/${tableId}/records`,
        { method: "GET" },
      );
      if (existingRecs.length > 0) {
        await apiRequest(`/api/tables/${tableId}/records/batch-delete`, {
          method: "POST",
          body: { recordIds: existingRecs.map((r) => r.id) },
        });
      }

      // Step 4 — batch insert (200 at a time)
      const BATCH = 200;
      const total = preview.rows.length;
      for (let i = 0; i < total; i += BATCH) {
        const chunk = preview.rows.slice(i, i + BATCH);
        const records = chunk.map((r) => {
          const cells: Record<string, unknown> = {};
          for (const cf of createdFields) {
            cells[cf.id] = r[cf.duckdbField] ?? null;
          }
          return { cells };
        });
        await apiRequest(`/api/tables/${tableId}/records/batch-create`, {
          method: "POST",
          body: { records },
        });
        ctx?.progress?.({
          phase: "computing",
          message: `写入记录 ${Math.min(i + BATCH, total)}/${total}`,
          current: Math.min(i + BATCH, total),
          total,
        });
      }

      return toolResult({
        tableId,
        tableName: tbl.name,
        fieldCount: createdFields.length,
        recordCount: total,
        mention: `[@${tbl.name}](mention://table/${tableId})`,
      });
    },
  },
];

function inferTableFieldType(duckType: string): string {
  const u = duckType.toUpperCase();
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)/.test(u))
    return "Number";
  if (/BOOLEAN/.test(u)) return "Checkbox";
  if (/TIMESTAMP|DATE|TIME/.test(u)) return "DateTime";
  return "Text";
}
