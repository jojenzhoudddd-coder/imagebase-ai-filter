/**
 * Folder MCP tools.
 * Mirror of backend/src/routes/folderRoutes.ts — see CLAUDE.md "MCP Server 与 REST API 的同步规则".
 */

import { apiRequest, toolResult, DEFAULT_WORKSPACE_ID } from "../dataStoreClient.js";
import type { ToolDefinition } from "./tableTools.js";

export const folderTools: ToolDefinition[] = [
  {
    name: "list_folders",
    description: "列出工作空间下所有文件夹。返回 id、名称、parentId、order。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "工作空间 id，默认使用当前工作空间" },
      },
    },
    handler: async (args, ctx) => {
      const wsId = args.workspaceId || ctx?.workspaceId || DEFAULT_WORKSPACE_ID;
      const tree = await apiRequest<any>(`/api/workspaces/${encodeURIComponent(wsId)}/tree`);
      return toolResult(tree.folders || []);
    },
  },

  {
    name: "create_folder",
    description: "在工作空间中创建一个新文件夹。可指定 parentId 嵌套到另一个文件夹内。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "文件夹名称" },
        parentId: { type: "string", description: "父文件夹 id（可选，不指定则在根级别创建）" },
        workspaceId: { type: "string", description: "工作空间 id，默认使用当前工作空间" },
      },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      const wsId = args.workspaceId || ctx?.workspaceId || DEFAULT_WORKSPACE_ID;
      const result = await apiRequest<any>("/api/folders", {
        method: "POST",
        body: {
          name: String(args.name),
          parentId: args.parentId || null,
          workspaceId: wsId,
        },
      });
      return toolResult(result);
    },
  },

  {
    name: "rename_folder",
    description: "重命名指定文件夹。",
    inputSchema: {
      type: "object",
      properties: {
        folderId: { type: "string", description: "文件夹 id" },
        name: { type: "string", description: "新名称" },
      },
      required: ["folderId", "name"],
    },
    handler: async (args) => {
      const result = await apiRequest<any>(`/api/folders/${encodeURIComponent(String(args.folderId))}`, {
        method: "PUT",
        body: { name: String(args.name) },
      });
      return toolResult(result);
    },
  },

  {
    name: "delete_folder",
    description: "删除指定文件夹。文件夹内的子项（表、文档、设计等）会被提升到父级。",
    inputSchema: {
      type: "object",
      properties: {
        folderId: { type: "string", description: "文件夹 id" },
      },
      required: ["folderId"],
    },
    handler: async (args) => {
      const result = await apiRequest<any>(`/api/folders/${encodeURIComponent(String(args.folderId))}`, {
        method: "DELETE",
      });
      return toolResult(result);
    },
  },

  {
    name: "move_item_to_folder",
    description: "将 artifact（表/文件夹/设计/文档/Demo）移动到指定文件夹，或移到根级别（newParentId 设为 null）。",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "要移动的项目 id" },
        itemType: { type: "string", enum: ["table", "folder", "design", "idea", "demo"], description: "项目类型" },
        newParentId: { type: ["string", "null"], description: "目标文件夹 id，null 移到根级别" },
      },
      required: ["itemId", "itemType"],
    },
    handler: async (args) => {
      const result = await apiRequest<any>("/api/folders/move", {
        method: "PUT",
        body: {
          itemId: String(args.itemId),
          itemType: String(args.itemType),
          newParentId: args.newParentId || null,
        },
      });
      return toolResult(result);
    },
  },
];
