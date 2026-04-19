/**
 * Record-level MCP tools. Mirror of backend/src/routes/tableRoutes.ts record endpoints.
 */

import { apiRequest, toolResult, confirmationRequired } from "../dataStoreClient.js";
import type { ToolDefinition } from "./tableTools.js";

export const recordTools: ToolDefinition[] = [
  {
    name: "query_records",
    description:
      "查询指定表的记录，支持 filter/sort。返回 { records, total }。filter 格式：{ logic:'and'|'or', conditions:[{id,fieldId,operator,value}] }。",
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        filter: { type: "object" },
        sort: { type: "object" },
      },
      required: ["tableId"],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (args.filter) body.filter = args.filter;
      if (args.sort) body.sort = args.sort;
      const result = await apiRequest<any>(`/api/tables/${args.tableId}/records/query`, {
        method: "POST",
        body,
      });
      // Truncate to avoid flooding the model context
      const records = result.records as any[];
      return toolResult({
        total: result.total,
        returned: Math.min(records.length, 20),
        records: records.slice(0, 20),
        truncated: records.length > 20,
      });
    },
  },

  {
    name: "create_record",
    description:
      "新增一条记录。cells 是 { fieldId: value } 映射。不需要填所有字段，未填的默认为 null。",
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        cells: {
          type: "object",
          description: "{ 'fld_xxx': value, 'fld_yyy': value, ... }",
        },
      },
      required: ["tableId", "cells"],
    },
    handler: async (args) => {
      const body = { cells: args.cells || {} };
      const rec = await apiRequest<any>(`/api/tables/${args.tableId}/records`, {
        method: "POST",
        body,
      });
      return toolResult({ id: rec.id });
    },
  },

  {
    name: "batch_create_records",
    description:
      "一次新增多条记录（比循环调 create_record 更高效）。records 是 [{ cells: {...} }, ...] 数组。",
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        records: {
          type: "array",
          items: {
            type: "object",
            properties: { cells: { type: "object" } },
            required: ["cells"],
          },
        },
      },
      required: ["tableId", "records"],
    },
    handler: async (args) => {
      const body = { records: args.records };
      const result = await apiRequest(`/api/tables/${args.tableId}/records/batch-create`, {
        method: "POST",
        body,
      });
      return toolResult(result);
    },
  },

  {
    name: "update_record",
    description: "修改一条记录的部分字段。只需传入要变更的字段，未传的字段保持不变。",
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        recordId: { type: "string" },
        cells: { type: "object" },
      },
      required: ["tableId", "recordId", "cells"],
    },
    handler: async (args) => {
      const body = { cells: args.cells || {} };
      const rec = await apiRequest<any>(
        `/api/tables/${args.tableId}/records/${args.recordId}`,
        { method: "PUT", body }
      );
      return toolResult({ id: rec.id });
    },
  },

  {
    name: "delete_record",
    description: "⚠️ 删除一条记录。不可撤销。必须先征得用户同意。",
    danger: true,
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        recordId: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["tableId", "recordId"],
    },
    handler: async (args) => {
      if (!args.confirmed) {
        return confirmationRequired(
          "delete_record",
          { tableId: args.tableId, recordId: args.recordId },
          `即将删除记录 ${args.recordId}。`
        );
      }
      await apiRequest(`/api/tables/${args.tableId}/records/${args.recordId}`, {
        method: "DELETE",
      });
      return toolResult({ ok: true });
    },
  },

  {
    name: "batch_delete_records",
    description: "⚠️ 批量删除记录。不可撤销。必须先征得用户同意。",
    danger: true,
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        recordIds: { type: "array", items: { type: "string" } },
        confirmed: { type: "boolean" },
      },
      required: ["tableId", "recordIds"],
    },
    handler: async (args) => {
      const ids = args.recordIds as string[];
      if (!args.confirmed) {
        return confirmationRequired(
          "batch_delete_records",
          { tableId: args.tableId, recordIds: ids },
          `即将删除 ${ids.length} 条记录。`
        );
      }
      const body = { recordIds: ids };
      const result = await apiRequest(`/api/tables/${args.tableId}/records/batch-delete`, {
        method: "POST",
        body,
      });
      return toolResult(result);
    },
  },
];
