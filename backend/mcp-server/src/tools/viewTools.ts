/**
 * View-level MCP tools. Mirror of backend/src/routes/tableRoutes.ts view endpoints.
 */

import { apiRequest, toolResult, confirmationRequired } from "../dataStoreClient.js";
import type { ToolDefinition } from "./tableTools.js";

export const viewTools: ToolDefinition[] = [
  {
    name: "list_views",
    description: "列出指定数据表的所有视图。返回 { id, name, type, filter, fieldOrder, hiddenFields }。",
    inputSchema: {
      type: "object",
      properties: { tableId: { type: "string" } },
      required: ["tableId"],
    },
    handler: async (args) => {
      const views = await apiRequest<any[]>(`/api/tables/${args.tableId}/views`);
      return toolResult(views);
    },
  },

  {
    name: "create_view",
    description:
      "在指定表上新建视图。type 可选 'grid' 或 'kanban'。filter/sort/group/fieldOrder/hiddenFields 可选。",
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        name: { type: "string" },
        type: { type: "string", enum: ["grid", "kanban"], description: "默认 grid" },
        filter: { type: "object" },
        sort: { type: "object" },
        group: { type: "object" },
        kanbanFieldId: { type: "string" },
      },
      required: ["tableId", "name"],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        name: String(args.name),
        type: args.type || "grid",
      };
      if (args.filter) body.filter = args.filter;
      if (args.sort) body.sort = args.sort;
      if (args.group) body.group = args.group;
      if (args.kanbanFieldId) body.kanbanFieldId = args.kanbanFieldId;
      const view = await apiRequest<any>(`/api/tables/${args.tableId}/views`, {
        method: "POST",
        body,
      });
      return toolResult({ id: view.id, name: view.name, type: view.type });
    },
  },

  {
    name: "update_view",
    description:
      "修改视图配置。filter 格式：{ logic:'and'|'or', conditions:[{id,fieldId,operator,value}] }。",
    inputSchema: {
      type: "object",
      properties: {
        viewId: { type: "string" },
        name: { type: "string" },
        filter: { type: "object" },
        sort: { type: "object" },
        group: { type: "object" },
        kanbanFieldId: { type: "string" },
        fieldOrder: { type: "array", items: { type: "string" } },
        hiddenFields: { type: "array", items: { type: "string" } },
      },
      required: ["viewId"],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      for (const key of ["name", "filter", "sort", "group", "kanbanFieldId", "fieldOrder", "hiddenFields"]) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      const view = await apiRequest<any>(`/api/tables/views/${args.viewId}`, {
        method: "PUT",
        body,
      });
      return toolResult({ id: view.id, name: view.name });
    },
  },

  {
    name: "delete_view",
    description: "⚠️ 删除视图。不可撤销。必须先征得用户同意。",
    danger: true,
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        viewId: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["tableId", "viewId"],
    },
    handler: async (args) => {
      if (!args.confirmed) {
        return confirmationRequired(
          "delete_view",
          { tableId: args.tableId, viewId: args.viewId },
          `即将删除视图 ${args.viewId}。`
        );
      }
      await apiRequest(`/api/tables/${args.tableId}/views/${args.viewId}`, { method: "DELETE" });
      return toolResult({ ok: true });
    },
  },
];
