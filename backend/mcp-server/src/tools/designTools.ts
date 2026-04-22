/**
 * Design MCP tools — mirror of backend/src/routes/designRoutes.ts.
 * See CLAUDE.md "MCP Server 与 REST API 的同步规则" for the sync contract.
 *
 * Tier split:
 *   - Tier 1 (always-on nav): `list_designs`
 *     Cheap workspace-level read so the agent can always see what canvas
 *     artifacts exist without activating `taste-skill`.
 *   - Tier 2 (taste-skill): `create_design`, `rename_design`, `delete_design` (⚠️),
 *     `auto_layout_design`. Loaded when the agent activates `taste-skill`
 *     (auto-triggered by 创建/排版/整理 × taste/design/画布 keywords).
 *
 * 术语对齐：代码中沿用 "Design"（画布/Artifacts 实体）+ "Taste"（画布中的
 * 单张 SVG 图片）。未来产品侧会重命名为 Taste + Node（见 taste-chatbot-plan.md
 * 术语对齐章节），本 MCP 工具同步跟随。
 */

import { apiRequest, toolResult, confirmationRequired } from "../dataStoreClient.js";
import type { ToolDefinition } from "./tableTools.js";

// ── Tier 1 ─────────────────────────────────────────────────────────────────

export const designNavTools: ToolDefinition[] = [
  {
    name: "list_designs",
    description:
      "列出指定工作空间下所有画布 Design（Taste 的容器）。返回每个 design 的 id / name / parentId / order / figmaUrl（若为 Figma 导入）。" +
      "不返回 taste 列表（可能很多），需要时再调 list_tastes。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "工作空间 id，默认 doc_default" },
      },
    },
    handler: async (args) => {
      const wsId = args.workspaceId || "doc_default";
      // Reuse the tree endpoint — it returns designs directly for the workspace
      // without needing a dedicated list route.
      const tree = await apiRequest<{
        designs: Array<{
          id: string;
          name: string;
          parentId: string | null;
          order: number;
          figmaUrl: string | null;
          createdAt: string;
          updatedAt: string;
        }>;
      }>(`/api/workspaces/${encodeURIComponent(wsId)}/tree`);
      return toolResult({
        designs: tree.designs.map((d) => ({
          id: d.id,
          name: d.name,
          parentId: d.parentId,
          order: d.order,
          figmaUrl: d.figmaUrl,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        })),
      });
    },
  },
];

// ── Tier 2 (taste-skill) ───────────────────────────────────────────────────

export const designWriteTools: ToolDefinition[] = [
  {
    name: "create_design",
    description:
      "新建一个空白画布 Design（Taste 的容器）。可选地传入 figmaUrl 以关联 Figma 源文件/节点。" +
      "返回 {id, name, parentId, order, figmaUrl}。新 design 中 taste 为空，随后可用 create_taste_from_svg 添加。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "画布名称，如 'Button 样式探索'" },
        workspaceId: { type: "string", description: "所属工作空间 id，默认 doc_default" },
        parentId: { type: "string", description: "父文件夹 id（可选）" },
        figmaUrl: {
          type: "string",
          description: "可选的 Figma 源链接（figma.com/design/... 或 figma.com/board/...）。留空即空白画布。",
        },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        name: String(args.name),
        workspaceId: args.workspaceId || "doc_default",
        parentId: args.parentId || null,
      };
      if (args.figmaUrl) body.figmaUrl = String(args.figmaUrl);
      const design = await apiRequest<any>("/api/designs", { method: "POST", body });
      return toolResult({
        id: design.id,
        name: design.name,
        parentId: design.parentId,
        order: design.order,
        figmaUrl: design.figmaUrl,
      });
    },
  },

  {
    name: "rename_design",
    description: "修改画布 Design 的名称。",
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string" },
        name: { type: "string", description: "新名称" },
      },
      required: ["designId", "name"],
    },
    handler: async (args) => {
      const designId = String(args.designId);
      const body = { name: String(args.name) };
      const design = await apiRequest<any>(`/api/designs/${designId}`, { method: "PUT", body });
      return toolResult({ id: design.id, name: design.name });
    },
  },

  {
    name: "delete_design",
    description:
      "⚠️ 删除整个画布 Design 及其下所有 Taste（SVG 图片）。会级联清理磁盘上的 SVG 文件。不可撤销。必须先征得用户同意。",
    danger: true,
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string" },
        confirmed: { type: "boolean", description: "仅当用户已确认时传 true" },
      },
      required: ["designId"],
    },
    handler: async (args) => {
      const designId = String(args.designId);
      if (!args.confirmed) {
        return confirmationRequired(
          "delete_design",
          { designId },
          `即将删除画布 ${designId} 及其所有 Taste，此操作不可撤销。`,
        );
      }
      await apiRequest(`/api/designs/${designId}`, { method: "DELETE" });
      return toolResult({ ok: true, deletedDesignId: designId });
    },
  },

  {
    name: "auto_layout_design",
    description:
      "对指定画布执行自动网格排版：推断当前 Taste 的行结构，在每行内等距对齐、行间统一间距。" +
      "返回 {designId, updatedCount, bounds:{width,height}}。用于用户说「整理一下画布」「自动排版」等场景。",
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string" },
      },
      required: ["designId"],
    },
    handler: async (args) => {
      const designId = String(args.designId);
      const result = await apiRequest<any>(`/api/designs/${designId}/auto-layout`, {
        method: "POST",
        body: {},
      });
      return toolResult(result);
    },
  },
];

/** Union used by index.ts for `allTools` enumeration. */
export const designTools: ToolDefinition[] = [
  ...designNavTools,
  ...designWriteTools,
];
