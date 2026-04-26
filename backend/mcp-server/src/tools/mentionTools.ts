/**
 * Mention MCP tools — workspace-scoped @ discovery + reverse-ref lookup.
 *
 * Both tools are Tier 1 (always on). Rationale:
 *
 *  - `find_mentionable` is the cross-skill bridge: the chat agent uses it to
 *    enumerate which views / tastes / ideas / idea-sections are linkable
 *    before writing a mention chip into an idea. Without it, the agent has
 *    to first activate table-skill to see views, then design-skill (future)
 *    to see tastes, then idea-skill to see ideas — wasting turns. We keep
 *    this lookup centralized and always-available.
 *
 *  - `list_incoming_mentions` is cheap (indexed read) and needed anywhere a
 *    delete confirmation loop runs. Moving it to Tier 2 would force the
 *    agent to activate a skill just to check "who references this".
 *
 * Neither tool mutates state, so there's no `danger` flag and no
 * confirmation handshake.
 */

import { apiRequest, toolResult } from "../dataStoreClient.js";
import type { ToolDefinition } from "./tableTools.js";

export const mentionTools: ToolDefinition[] = [
  {
    name: "find_mentionable",
    description:
      "按关键字搜索工作空间内可被 @ 引用的实体：table（整张数据表）/design（整个画布）/taste（设计切片 SVG）/idea（灵感文档）/idea-section（灵感章节）。" +
      "返回命中的 label + 完整的 mentionUri + 可直接嵌入 Markdown 的 markdown 字段——" +
      "写入 idea 时把 markdown 原样拼进 payload 即可形成可点击的链接。" +
      "空查询时返回按类型均衡的前 N 条热门候选。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "工作空间 id，默认 doc_default" },
        q: { type: "string", description: "搜索关键字（支持中文、大小写不敏感）" },
        types: {
          type: "string",
          description: "逗号分隔的类型过滤：table,design,taste,idea,idea-section（默认全开）。legacy 'view' 会自动转 'table'。",
        },
        limit: {
          type: "number",
          description: "最大返回条数，默认 10，上限 30",
        },
      },
    },
    handler: async (args) => {
      const wsId = args.workspaceId || "doc_default";
      const params = new URLSearchParams();
      if (args.q) params.set("q", String(args.q));
      if (args.types) params.set("types", String(args.types));
      if (args.limit) params.set("limit", String(args.limit));
      const qs = params.toString();
      const url = `/api/workspaces/${encodeURIComponent(wsId)}/mentions/search${qs ? `?${qs}` : ""}`;
      const data = await apiRequest<{ hits: any[] }>(url);
      return toolResult({ hits: data.hits });
    },
  },
  {
    name: "list_incoming_mentions",
    description:
      "列出工作空间内有哪些实体（目前仅灵感文档）引用了给定 target。常用于删除前弹出二次确认，让用户看清影响范围。" +
      "targetType ∈ {table,design,taste,idea,idea-section}；" +
      "idea-section 的 targetId 使用 '<ideaId>#<slug>' 复合键。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "工作空间 id，默认 doc_default" },
        targetType: {
          type: "string",
          enum: ["table", "design", "taste", "idea", "idea-section"],
        },
        targetId: {
          type: "string",
          description: "目标 id；idea-section 用 '<ideaId>#<slug>'",
        },
        limit: { type: "number", description: "默认 50，上限 200" },
      },
      required: ["targetType", "targetId"],
    },
    handler: async (args) => {
      const wsId = args.workspaceId || "doc_default";
      const params = new URLSearchParams({
        workspaceId: wsId,
        targetType: String(args.targetType),
        targetId: String(args.targetId),
      });
      if (args.limit) params.set("limit", String(args.limit));
      const data = await apiRequest<{ refs: any[]; total: number }>(
        `/api/mentions/reverse?${params.toString()}`
      );
      return toolResult({ refs: data.refs, total: data.total });
    },
  },
];
