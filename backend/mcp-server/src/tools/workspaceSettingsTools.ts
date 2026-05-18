import { apiRequest, toolResult, DEFAULT_WORKSPACE_ID } from "../dataStoreClient.js";
import type { ToolContext, ToolDefinition } from "./tableTools.js";

const WORKSPACE_AVATAR_URL_RE = /^(data:image\/(png|jpe?g|gif|webp);base64,|\/uploads\/avatars\/|\/avatars\/|https?:\/\/)/;

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
  {
    name: "update_workspace_avatar",
    description:
      "修改当前或指定 workspace 的头像 URL。常用于先用 generate_image 生成 workspace logo/avatar，再把返回的 imageUrl 设置为 workspace avatar。仅在用户明确要求修改 workspace 头像时调用；会继承当前用户权限，不能修改无权限 workspace。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "可选；默认当前 workspace。" },
        avatarUrl: {
          type: "string",
          description:
            "新的 workspace 头像 URL。允许 Seedream 返回的 http(s) URL、/uploads/avatars/、/avatars/，或 image data URL。",
        },
      },
      required: ["avatarUrl"],
    },
    handler: async (args, ctx) => {
      const workspaceId = resolveWorkspaceId(args, ctx);
      const avatarUrl = typeof args.avatarUrl === "string" ? args.avatarUrl.trim() : "";
      if (!avatarUrl) return JSON.stringify({ ok: false, error: "avatarUrl 不能为空" });
      if (!WORKSPACE_AVATAR_URL_RE.test(avatarUrl)) {
        return JSON.stringify({
          ok: false,
          error: "avatarUrl must be data:image, /uploads/avatars/, /avatars/, or http(s) URL",
        });
      }
      const data = await apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/avatar`, {
        method: "PATCH",
        body: { avatarUrl },
      });
      return toolResult(data, { ok: true, workspaceId });
    },
  },
];
