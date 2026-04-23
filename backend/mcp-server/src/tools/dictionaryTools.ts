/**
 * Data Dictionary & Snapshot nav tools (Tier 1 · always-on).
 *
 * Added P1 · analyst infrastructure:
 *   - `get_data_dictionary` — bulk read of field names + types + descriptions
 *     for one or more tables in a workspace. Gives the Agent a compact
 *     semantic map so it can pick the right field to aggregate on.
 *   - `list_snapshots` — surface existing DuckDB parquet snapshots so the
 *     Agent can tell the user "I'm analyzing based on the 10:15 snapshot".
 *
 * Both tools go through the main backend's `/api/analyst` HTTP proxy; MCP
 * stays a thin schema-mapping layer (CLAUDE.md "MCP Server 与 REST API 的
 * 同步规则").
 */

import { apiRequest, toolResult } from "../dataStoreClient.js";
import type { ToolDefinition } from "./tableTools.js";

export const dictionaryTools: ToolDefinition[] = [
  {
    name: "get_data_dictionary",
    description:
      "获取指定工作空间下若干数据表的**字段字典**（字段名 / 类型 / 用户填写的描述 / 可选项枚举）。" +
      "在做数据分析、条件筛选、选择聚合字段之前应当调用，帮助判断字段语义，避免用错列。" +
      "如果同一语义对应多个字段（如 amount 与 amount_usd），请先向用户确认再开算。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "工作空间 id，默认 doc_default" },
        tableIds: {
          type: "array",
          items: { type: "string" },
          description: "可选：只返回这些表的字典；省略则返回全部表",
        },
      },
    },
    handler: async (args) => {
      const wsId = (args.workspaceId as string) || "doc_default";
      const params = new URLSearchParams({ workspaceId: wsId });
      if (Array.isArray(args.tableIds)) {
        for (const id of args.tableIds as string[]) {
          params.append("tableId", id);
        }
      }
      const data = await apiRequest<unknown>(`/api/analyst/dictionary?${params.toString()}`);
      return toolResult(data);
    },
  },

  {
    name: "list_snapshots",
    description:
      "列出 Analyst 已经在磁盘上持有的表快照（DuckDB parquet 文件）。" +
      "用于 Agent 判断某张表最近一次快照的时点，决定是复用现有快照还是调用 load_workspace_table({refresh:true}) 重建。" +
      "返回按时间倒序。",
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string", description: "可选：只列出该表的快照" },
        limit: { type: "number", description: "最多返回条数，默认 20" },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      if (args.tableId) params.set("tableId", String(args.tableId));
      if (args.limit) params.set("limit", String(args.limit));
      const data = await apiRequest<unknown>(`/api/analyst/snapshots?${params.toString()}`);
      return toolResult(data);
    },
  },
];
