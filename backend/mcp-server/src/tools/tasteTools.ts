/**
 * Taste MCP tools — mirror of backend/src/routes/tasteRoutes.ts.
 * See CLAUDE.md "MCP Server 与 REST API 的同步规则" for the sync contract.
 *
 * 术语对齐：代码中的 "Taste" = 产品语境下画布里的一张 SVG 图片（= 未来的 "Node"）。
 * 其容器是 Design（= 未来的 "Taste"）。
 *
 * Tier split:
 *   - Tier 1 (always-on nav): `list_tastes`, `get_taste`
 *     Cheap reads so the agent can always see what SVGs exist on a design
 *     and drop @taste mentions into idea docs without activating a skill.
 *     `get_taste` defaults to returning only metadata + meta (design-style
 *     structured fields); pass `includeSvg:true` to pull the full SVG source
 *     (can be large — prefer meta-only lookups).
 *   - Tier 2 (taste-skill): create_taste_from_svg, rename_taste, update_taste,
 *     batch_update_tastes, delete_taste (⚠️).
 */

import { apiRequest, toolResult, confirmationRequired } from "../dataStoreClient.js";
import type { ToolDefinition } from "./tableTools.js";

// Base URL mirrors dataStoreClient.ts default; used for the uploads/* static
// passthrough when fetching SVG file contents for `get_taste(includeSvg:true)`.
const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || "http://localhost:3001";

/** Fetch raw SVG file content served by Express static at /uploads/*. */
async function readSvgContent(filePath: string | null | undefined): Promise<string | null> {
  if (!filePath) return null;
  try {
    const url = `${BACKEND_BASE_URL}/${filePath.replace(/^\/+/, "")}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Shape the DB taste row into a summary (no SVG, no meta). */
function summarize(t: any) {
  return {
    id: t.id,
    designId: t.designId,
    name: t.name,
    x: t.x,
    y: t.y,
    width: t.width,
    height: t.height,
    source: t.source,
    hasMeta: Boolean(t.meta),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ── Tier 1 ─────────────────────────────────────────────────────────────────

export const tasteNavTools: ToolDefinition[] = [
  {
    name: "list_tastes",
    description:
      "列出指定画布 Design 下所有 Taste（SVG 图片）。返回每个 taste 的 id / name / 位置 / 尺寸 / source / hasMeta。" +
      "不返回 SVG 内容和 meta 结构（节省 token）。需要某个 taste 的详情时再用 get_taste。",
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string", description: "画布 id" },
      },
      required: ["designId"],
    },
    handler: async (args) => {
      const designId = String(args.designId);
      const tastes = await apiRequest<any[]>(
        `/api/designs/${designId}/tastes`,
      );
      return toolResult({
        designId,
        count: tastes.length,
        tastes: tastes.map(summarize),
      });
    },
  },

  {
    name: "get_taste",
    description:
      "读取单个 Taste（SVG 图片）的详细信息。默认返回位置/尺寸/fileName/source/figmaUrl；" +
      "`includeMeta:true` 追加 AI 生成的设计风格结构化元数据（主色/字体/间距/tags/description 等），" +
      "`includeSvg:true` 追加完整 SVG 源码（可能很长——优先只取 meta）。" +
      "若 meta 还未生成（`hasMeta:false`），可调 POST /meta?sync=1 或本工具带 `includeMeta:true,syncMeta:true` 触发一次同步生成。",
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string" },
        tasteId: { type: "string" },
        includeSvg: { type: "boolean", description: "是否包含完整 SVG 源码，默认 false" },
        includeMeta: { type: "boolean", description: "是否包含 AI 生成的设计风格 meta，默认 false" },
        syncMeta: {
          type: "boolean",
          description: "当 includeMeta 且 meta 缺失时，是否同步等待生成（最多 ~3s）。默认 false（只返回 null）。",
        },
      },
      required: ["designId", "tasteId"],
    },
    handler: async (args) => {
      const designId = String(args.designId);
      const tasteId = String(args.tasteId);
      const includeSvg = Boolean(args.includeSvg);
      const includeMeta = Boolean(args.includeMeta);
      const syncMeta = Boolean(args.syncMeta);

      // Fetch all tastes in the design and find ours — the REST layer has no
      // single-taste GET endpoint; list is cheap because tastes are shallow.
      const tastes = await apiRequest<any[]>(`/api/designs/${designId}/tastes`);
      const t = tastes.find((x) => x.id === tasteId);
      if (!t) {
        return toolResult({ error: "Taste not found", designId, tasteId });
      }

      const detail: Record<string, unknown> = {
        ...summarize(t),
        fileName: t.fileName,
        filePath: t.filePath ?? null,
        figmaUrl: t.figmaUrl ?? null,
      };

      if (includeMeta) {
        const metaRes = await apiRequest<{
          meta: unknown;
          generatedAt: string | null;
          status: string;
        }>(
          `/api/designs/${designId}/tastes/${tasteId}/meta${syncMeta ? "?sync=1" : ""}`,
        );
        detail.meta = metaRes.meta;
        detail.metaGeneratedAt = metaRes.generatedAt;
        detail.metaStatus = metaRes.status;
      }

      if (includeSvg) {
        const svg = await readSvgContent(t.filePath);
        detail.svg = svg;
      }

      return toolResult(detail);
    },
  },
];

// ── Tier 2 (taste-skill) ───────────────────────────────────────────────────

export const tasteWriteTools: ToolDefinition[] = [
  {
    name: "create_taste_from_svg",
    description:
      "在指定画布 Design 上创建一个新 Taste：传入完整的 SVG 源码（`<svg>…</svg>`），后端会保存到磁盘、" +
      "解析尺寸、找一个不与现有 Taste 重叠的位置、异步触发 AI meta 生成。返回新 taste 的 id/name/x/y/width/height。" +
      "适合 Agent 根据用户描述生成 SVG 后直接落到画布上的场景。",
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string" },
        svg: {
          type: "string",
          description: "完整 SVG 源码（含 `<svg>` 根节点，建议含 viewBox）。≤ 5MB。",
        },
        name: { type: "string", description: "可选的 Taste 名称，默认 'Pasted SVG'。同名会自动追加 ' 1/2/…'。" },
      },
      required: ["designId", "svg"],
    },
    handler: async (args) => {
      const designId = String(args.designId);
      const body: Record<string, unknown> = { svg: String(args.svg) };
      if (args.name) body.name = String(args.name);
      const taste = await apiRequest<any>(
        `/api/designs/${designId}/tastes/from-svg`,
        { method: "POST", body },
      );
      return toolResult(summarize(taste));
    },
  },

  {
    name: "rename_taste",
    description: "修改 Taste 的名称。",
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string" },
        tasteId: { type: "string" },
        name: { type: "string" },
      },
      required: ["designId", "tasteId", "name"],
    },
    handler: async (args) => {
      const designId = String(args.designId);
      const tasteId = String(args.tasteId);
      const body = { name: String(args.name) };
      const taste = await apiRequest<any>(
        `/api/designs/${designId}/tastes/${tasteId}`,
        { method: "PUT", body },
      );
      return toolResult({ id: taste.id, name: taste.name });
    },
  },

  {
    name: "update_taste",
    description:
      "修改单个 Taste 的位置或尺寸（x/y/width/height）。传什么改什么，不传的字段保持原值。" +
      "批量移动多个 Taste 请用 batch_update_tastes（只走一次 SSE 事件，更省带宽）。",
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string" },
        tasteId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        name: { type: "string" },
      },
      required: ["designId", "tasteId"],
    },
    handler: async (args) => {
      const designId = String(args.designId);
      const tasteId = String(args.tasteId);
      const body: Record<string, unknown> = {};
      for (const key of ["x", "y", "width", "height", "name"] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      const taste = await apiRequest<any>(
        `/api/designs/${designId}/tastes/${tasteId}`,
        { method: "PUT", body },
      );
      return toolResult(summarize(taste));
    },
  },

  {
    name: "batch_update_tastes",
    description:
      "批量更新同一 Design 下多个 Taste 的位置（x/y）。updates 为 `[{id,x,y},…]`，每项都是绝对坐标。" +
      "用一次数据库事务 + 一次 SSE 事件广播，适合 Agent 手动摆放多张 SVG 的场景。" +
      "自动网格对齐请直接用 auto_layout_design。",
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string" },
        updates: {
          type: "array",
          description: "批量位置更新，最多 500 项",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              x: { type: "number" },
              y: { type: "number" },
            },
            required: ["id", "x", "y"],
          },
        },
      },
      required: ["designId", "updates"],
    },
    handler: async (args) => {
      const designId = String(args.designId);
      const updates = Array.isArray(args.updates) ? args.updates : [];
      await apiRequest(
        `/api/designs/${designId}/tastes/batch-update`,
        { method: "PUT", body: { updates } },
      );
      return toolResult({ ok: true, designId, updatedCount: updates.length });
    },
  },

  {
    name: "delete_taste",
    description:
      "⚠️ 删除单个 Taste 及其磁盘上的 SVG 文件。不可撤销。必须先征得用户同意。",
    danger: true,
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string" },
        tasteId: { type: "string" },
        confirmed: { type: "boolean", description: "仅当用户已确认时传 true" },
      },
      required: ["designId", "tasteId"],
    },
    handler: async (args) => {
      const designId = String(args.designId);
      const tasteId = String(args.tasteId);
      if (!args.confirmed) {
        return confirmationRequired(
          "delete_taste",
          { designId, tasteId },
          `即将删除 Taste ${tasteId}，此操作不可撤销。`,
        );
      }
      await apiRequest(
        `/api/designs/${designId}/tastes/${tasteId}`,
        { method: "DELETE" },
      );
      return toolResult({ ok: true, deletedTasteId: tasteId });
    },
  },
];

/** Union used by index.ts for `allTools` enumeration. */
export const tasteTools: ToolDefinition[] = [
  ...tasteNavTools,
  ...tasteWriteTools,
];
