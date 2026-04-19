/**
 * Field-level MCP tools. Mirror of backend/src/routes/tableRoutes.ts field endpoints.
 */

import { apiRequest, toolResult, confirmationRequired } from "../dataStoreClient.js";
import type { ToolDefinition } from "./tableTools.js";

const FIELD_TYPES = [
  "Text", "SingleSelect", "MultiSelect", "User", "Group",
  "DateTime", "Attachment", "Number", "Checkbox", "Url",
  "AutoNumber", "Phone", "Email", "Location", "Barcode",
  "Progress", "Currency", "Rating",
  "CreatedUser", "ModifiedUser", "CreatedTime", "ModifiedTime",
];

export const fieldTools: ToolDefinition[] = [
  {
    name: "list_fields",
    description: "列出指定数据表的所有字段（含类型、config）。",
    inputSchema: {
      type: "object",
      properties: { tableId: { type: "string" } },
      required: ["tableId"],
    },
    handler: async (args) => {
      const fields = await apiRequest<any[]>(`/api/tables/${args.tableId}/fields`);
      return toolResult(
        fields.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          isPrimary: f.isPrimary,
          config: f.config,
        }))
      );
    },
  },

  {
    name: "create_field",
    description:
      "在指定数据表添加一个字段。SingleSelect/MultiSelect 的 options 需附 color（如 '#FFE2D9' 等 Figma 颜色）。包含'姓名'或以'人'结尾的字段应使用 User 类型。",
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        name: { type: "string" },
        type: { type: "string", enum: FIELD_TYPES },
        config: {
          type: "object",
          description: "字段配置，如 { options: [{name, color}] } 或 { numberFormat: 'decimal2' }",
        },
      },
      required: ["tableId", "name", "type"],
    },
    handler: async (args) => {
      const body = {
        name: String(args.name),
        type: String(args.type),
        config: args.config || {},
      };
      const field = await apiRequest<any>(`/api/tables/${args.tableId}/fields`, { method: "POST", body });
      return toolResult({ id: field.id, name: field.name, type: field.type });
    },
  },

  {
    name: "update_field",
    description: "修改字段属性（重命名 / 改类型 / 改 config）。改类型会清空该列的所有值，请谨慎。",
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        fieldId: { type: "string" },
        name: { type: "string" },
        type: { type: "string", enum: FIELD_TYPES },
        config: { type: "object" },
      },
      required: ["tableId", "fieldId"],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.type !== undefined) body.type = args.type;
      if (args.config !== undefined) body.config = args.config;
      const field = await apiRequest<any>(
        `/api/tables/${args.tableId}/fields/${args.fieldId}`,
        { method: "PUT", body }
      );
      return toolResult({ id: field.id, name: field.name, type: field.type });
    },
  },

  {
    name: "delete_field",
    description: "⚠️ 删除字段（及该字段在所有记录中的值）。不可撤销。必须先征得用户同意。",
    danger: true,
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        fieldId: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["tableId", "fieldId"],
    },
    handler: async (args) => {
      if (!args.confirmed) {
        return confirmationRequired(
          "delete_field",
          { tableId: args.tableId, fieldId: args.fieldId },
          `即将删除字段 ${args.fieldId}，相关数据将一并丢失。`
        );
      }
      await apiRequest(`/api/tables/${args.tableId}/fields/${args.fieldId}`, { method: "DELETE" });
      return toolResult({ ok: true, deletedFieldId: args.fieldId });
    },
  },

  {
    name: "batch_delete_fields",
    description: "⚠️ 一次性删除多个字段。比 delete_field 更高效，但同样不可撤销。",
    danger: true,
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        fieldIds: { type: "array", items: { type: "string" } },
        confirmed: { type: "boolean" },
      },
      required: ["tableId", "fieldIds"],
    },
    handler: async (args) => {
      const ids = args.fieldIds as string[];
      if (!args.confirmed) {
        return confirmationRequired(
          "batch_delete_fields",
          { tableId: args.tableId, fieldIds: ids },
          `即将批量删除 ${ids.length} 个字段，相关数据将一并丢失。`
        );
      }
      const body = { fieldIds: ids };
      const result = await apiRequest(`/api/tables/${args.tableId}/fields/batch-delete`, {
        method: "POST",
        body,
      });
      return toolResult(result);
    },
  },
];
