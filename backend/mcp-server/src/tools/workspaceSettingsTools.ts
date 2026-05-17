import { apiRequest, toolResult, DEFAULT_WORKSPACE_ID } from "../dataStoreClient.js";
import type { ToolContext, ToolDefinition } from "./tableTools.js";

function resolveWorkspaceId(args: Record<string, any>, ctx?: ToolContext): string {
  if (typeof args.workspaceId === "string" && args.workspaceId.trim()) return args.workspaceId.trim();
  if (ctx?.workspaceId) return ctx.workspaceId;
  return DEFAULT_WORKSPACE_ID;
}

export const workspaceSettingsTools: ToolDefinition[] = [
  {
    name: "get_workspace",
    description:
      "读取当前或指定 workspace 的基础信息。默认使用当前对话所在 workspace。会继承当前用户权限，不能读取无权限 workspace。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "可选；默认当前 workspace。" },
      },
    },
    handler: async (args, ctx) => {
      const workspaceId = resolveWorkspaceId(args, ctx);
      const data = await apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}`);
      return toolResult(data, { ok: true, workspaceId });
    },
  },
  {
    name: "update_workspace_name",
    description:
      "修改当前或指定 workspace 名称。仅在用户明确要求重命名 workspace 时调用；会继承当前用户权限，不能修改无权限 workspace。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "可选；默认当前 workspace。" },
        name: { type: "string", description: "新的 workspace 名称，不能为空。" },
      },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      const workspaceId = resolveWorkspaceId(args, ctx);
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) {
        return JSON.stringify({ ok: false, error: "name 不能为空" });
      }
      const data = await apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: "PUT",
        body: { name },
      });
      return toolResult(data, { ok: true, workspaceId });
    },
  },
];
