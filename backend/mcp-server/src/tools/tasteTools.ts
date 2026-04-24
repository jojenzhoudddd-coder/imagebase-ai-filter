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

/** Fetch raw bytes (works for SVG/PNG/JPG alike). */
async function readFileBytes(filePath: string | null | undefined): Promise<{
  bytes: Buffer;
  mediaType: string;
} | null> {
  if (!filePath) return null;
  try {
    const url = `${BACKEND_BASE_URL}/${filePath.replace(/^\/+/, "")}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    const ct = res.headers.get("content-type") || "application/octet-stream";
    const mediaType = ct.split(";")[0].trim();
    return { bytes: Buffer.from(ab), mediaType };
  } catch {
    return null;
  }
}

/**
 * Magic prefix the chat agent's provider adapter looks for to expand a
 * tool_result into a real image content block. See
 * backend/src/services/providers/oneapiAdapter.ts IBASE_IMAGE_MARKER.
 */
const IBASE_IMAGE_MARKER = "__IBASE_IMAGE_v1__";
function packImageToolResult(
  payload: { mediaType: string; base64: string; caption?: string; text?: string }
): string {
  return IBASE_IMAGE_MARKER + JSON.stringify(payload);
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

  {
    name: "view_taste_image",
    description:
      "以**图像**方式读取一个 Taste（设计稿 / SVG / PNG），返回给 Claude 的 vision 模态。" +
      "Agent 能真正看见设计的视觉效果（像素级），用于 1:1 还原设计稿。" +
      "SVG 会在 server 端自动 rasterize 成 PNG（1.5× 分辨率）；PNG/JPG 原样返回。" +
      "当设计稿源是位图（PNG）或你需要视觉对比像素/颜色/字号时用这个；" +
      "当你需要文本级 SVG 结构（路径、节点树）时用 `get_taste(includeSvg:true)`；" +
      "当你需要结构化设计 token（颜色直方图、字体、区域盒）时用 `analyze_taste`。",
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string" },
        tasteId: { type: "string" },
        // Larger scale = crisper image but more tokens. Default 1.5x is a
        // reasonable balance for design mocks (Claude handles up to ~1568px).
        scale: {
          type: "number",
          description: "SVG 栅格化倍数（默认 1.5），过大会消耗更多 token",
        },
      },
      required: ["designId", "tasteId"],
    },
    handler: async (args) => {
      const designId = String(args.designId);
      const tasteId = String(args.tasteId);
      const scale = Math.max(0.5, Math.min(3, Number(args.scale) || 1.5));

      const tastes = await apiRequest<any[]>(`/api/designs/${designId}/tastes`);
      const t = tastes.find((x) => x.id === tasteId);
      if (!t) return toolResult({ error: "Taste not found", designId, tasteId });

      const fetched = await readFileBytes(t.filePath);
      if (!fetched) {
        return toolResult({ error: "Could not read taste file", filePath: t.filePath });
      }

      const caption =
        `Taste "${t.name}" (${t.id}) · ${t.width}×${t.height}` +
        (t.source ? ` · source=${t.source}` : "");

      // PNG / JPG / GIF / WebP — Claude vision accepts directly
      const supported = ["image/png", "image/jpeg", "image/gif", "image/webp"];
      if (supported.includes(fetched.mediaType)) {
        return packImageToolResult({
          mediaType: fetched.mediaType,
          base64: fetched.bytes.toString("base64"),
          caption,
          text: `This is the visual reference. Reproduce its layout / colors / typography 1:1 in the Demo you're building.`,
        });
      }

      // SVG → rasterize via sharp. Lazy-import so the MCP tool loads even on
      // hosts that skipped native deps install.
      const looksLikeSvg =
        fetched.mediaType.includes("svg") ||
        fetched.bytes.slice(0, 100).toString("utf8").toLowerCase().includes("<svg");
      if (looksLikeSvg) {
        try {
          const { default: sharp } = await import("sharp");
          const png = await sharp(fetched.bytes, { density: Math.round(72 * scale) })
            .png()
            .toBuffer();
          return packImageToolResult({
            mediaType: "image/png",
            base64: png.toString("base64"),
            caption,
            text:
              `SVG source was rasterized to PNG at ${scale}× for Claude vision. ` +
              `If you need the SVG markup to embed 1:1 into the Demo, call ` +
              `get_taste(includeSvg:true) instead.`,
          });
        } catch (err: any) {
          return toolResult({
            error: "SVG rasterization failed; fall back to get_taste(includeSvg:true).",
            detail: err?.message ?? String(err),
          });
        }
      }

      return toolResult({
        error: `Unsupported media type: ${fetched.mediaType}`,
        hint: "Only image/png, image/jpeg, image/gif, image/webp, image/svg+xml are supported.",
      });
    },
  },

  {
    name: "analyze_taste",
    description:
      "结构化解析 SVG Taste：扫描所有 `<rect>` / `<text>` / `<image>` / `<path>` 节点，" +
      "聚合出颜色直方图、字体字号用量、区域盒（按大矩形聚类）、文本清单、SVG 根 viewBox。" +
      "返回 token 量远小于 get_taste(includeSvg) 但信息密度高，适合 1:1 还原设计 token " +
      "（primary/bg/border 颜色、typography、栅格）。" +
      "只对 SVG 类型的 taste 有意义；PNG 走 `view_taste_image`。",
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string" },
        tasteId: { type: "string" },
      },
      required: ["designId", "tasteId"],
    },
    handler: async (args) => {
      const designId = String(args.designId);
      const tasteId = String(args.tasteId);

      const tastes = await apiRequest<any[]>(`/api/designs/${designId}/tastes`);
      const t = tastes.find((x) => x.id === tasteId);
      if (!t) return toolResult({ error: "Taste not found", designId, tasteId });
      if (!t.filePath || !/\.svg$/i.test(String(t.fileName || ""))) {
        return toolResult({
          error: "analyze_taste only supports SVG tastes. Call view_taste_image for PNG/raster.",
          fileName: t.fileName,
        });
      }

      try {
        const report = await apiRequest<any>(
          `/api/designs/${designId}/tastes/${tasteId}/analyze`,
        );
        return toolResult({
          tasteId: t.id,
          tasteName: t.name,
          ...report,
        });
      } catch (err: any) {
        return toolResult({
          error: "SVG analysis failed",
          detail: err?.message ?? String(err),
        });
      }
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
