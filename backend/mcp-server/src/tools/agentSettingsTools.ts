import { apiRequest, toolResult } from "../dataStoreClient.js";
import type { ToolContext, ToolDefinition } from "./tableTools.js";

const DEFAULT_AGENT_ID = "agent_default";
const AGENT_AVATAR_URL_RE = /^(\/uploads\/avatars\/|\/avatars\/|https?:\/\/)/;

function resolveAgentId(args: Record<string, any>, ctx?: ToolContext): string {
  if (typeof args.agentId === "string" && args.agentId.trim()) return args.agentId.trim();
  if (ctx?.agentId) return ctx.agentId;
  return DEFAULT_AGENT_ID;
}

export const agentSettingsTools: ToolDefinition[] = [
  {
    name: "list_my_agents",
    description:
      "列出当前登录用户拥有的 agents。用于确认当前用户可管理哪些 agent；不会返回其他用户的 agent。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const agents = await apiRequest("/api/agents");
      return toolResult(agents, { ok: true });
    },
  },
  {
    name: "get_agent_metadata",
    description:
      "读取当前或指定 agent 的 DB 元数据，包括 name、avatarUrl、userId 等。默认读取当前 agent；会继承当前用户权限。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；默认当前 agent。" },
      },
    },
    handler: async (args, ctx) => {
      const agentId = resolveAgentId(args, ctx);
      const data = await apiRequest(`/api/agents/${encodeURIComponent(agentId)}`);
      return toolResult(data, { ok: true, agentId });
    },
  },
  {
    name: "update_agent_metadata",
    description:
      "修改当前或指定 agent 的名称和头像 URL。仅在用户明确要求修改 agent 名字或头像时调用；会继承当前用户权限，不能修改其他用户的 agent。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；默认当前 agent。" },
        name: { type: "string", description: "新的 agent 名称，1-40 字。" },
        avatarUrl: {
          type: ["string", "null"],
          description: "头像 URL。允许 /uploads/avatars/、/avatars/ 或 http(s) URL；null 表示清空。",
        },
      },
    },
    handler: async (args, ctx) => {
      const agentId = resolveAgentId(args, ctx);
      const body: Record<string, unknown> = {};
      if (typeof args.name === "string") {
        const name = args.name.trim();
        if (!name) return JSON.stringify({ ok: false, error: "name 不能为空" });
        if (name.length > 40) return JSON.stringify({ ok: false, error: "name 不能超过 40 字" });
        body.name = name;
      }
      if (args.avatarUrl === null || typeof args.avatarUrl === "string") {
        if (typeof args.avatarUrl === "string" && args.avatarUrl && !AGENT_AVATAR_URL_RE.test(args.avatarUrl)) {
          return JSON.stringify({ ok: false, error: "avatarUrl must be /uploads/avatars/, /avatars/, or http(s) URL" });
        }
        body.avatarUrl = args.avatarUrl;
      }
      if (!Object.keys(body).length) {
        return JSON.stringify({ ok: false, error: "至少提供 name 或 avatarUrl" });
      }
      const data = await apiRequest(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: "PUT",
        body,
      });
      return toolResult(data, { ok: true, agentId });
    },
  },
  {
    name: "upload_agent_avatar",
    description:
      "上传并设置当前或指定 agent 的头像。dataUrl 必须是 PNG/JPG/GIF/WebP 的 base64 data URL，最大 2MB。默认修改当前 agent。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；默认当前 agent。" },
        dataUrl: { type: "string", description: "形如 data:image/png;base64,... 的头像内容。" },
      },
      required: ["dataUrl"],
    },
    handler: async (args, ctx) => {
      const agentId = resolveAgentId(args, ctx);
      if (typeof args.dataUrl !== "string" || !args.dataUrl.startsWith("data:image/")) {
        return JSON.stringify({ ok: false, error: "dataUrl 必须是 image data URL" });
      }
      const data = await apiRequest(`/api/agents/${encodeURIComponent(agentId)}/avatar`, {
        method: "POST",
        body: { dataUrl: args.dataUrl },
      });
      return toolResult(data, { ok: true, agentId });
    },
  },
  {
    name: "get_agent_identity",
    description:
      "读取当前或指定 agent 的 identity bundle：soul、profile、config。默认读取当前 agent；会继承当前用户权限。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；默认当前 agent。" },
      },
    },
    handler: async (args, ctx) => {
      const agentId = resolveAgentId(args, ctx);
      const data = await apiRequest(`/api/agents/${encodeURIComponent(agentId)}/identity`);
      return toolResult(data, { ok: true, agentId });
    },
  },
];
