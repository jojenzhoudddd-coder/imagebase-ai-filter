import { apiRequest, toolResult } from "../dataStoreClient.js";
import type { ToolDefinition } from "./tableTools.js";

const USER_AVATAR_URL_RE = /^(\/uploads\/avatars\/|\/avatars\/|https?:\/\/)/;

export const accountTools: ToolDefinition[] = [
  {
    name: "get_current_user",
    description:
      "读取当前登录用户、默认 workspace、当前 agent、用户偏好。用于确认你正在代表哪个用户操作，以及拿到用户级上下文。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const data = await apiRequest("/api/auth/me");
      return toolResult(data);
    },
  },
  {
    name: "update_user_profile",
    description:
      "修改当前登录用户的展示资料。可改 name、username、avatarUrl。仅在用户明确要求修改自己的资料时调用；avatarUrl 应为 /uploads/avatars/、/avatars/ 或 http(s) URL。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "新的用户展示名，不能为空。" },
        username: { type: "string", description: "新的 username 展示字段，1-32 字；传空字符串表示不修改。" },
        avatarUrl: {
          type: ["string", "null"],
          description: "头像 URL。允许 /uploads/avatars/、/avatars/ 或 http(s) URL；null 表示清空。",
        },
      },
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (typeof args.name === "string") body.name = args.name;
      if (typeof args.username === "string") body.username = args.username;
      if (args.avatarUrl === null || typeof args.avatarUrl === "string") {
        if (typeof args.avatarUrl === "string" && args.avatarUrl && !USER_AVATAR_URL_RE.test(args.avatarUrl)) {
          return JSON.stringify({ ok: false, error: "avatarUrl must be /uploads/avatars/, /avatars/, or http(s) URL" });
        }
        body.avatarUrl = args.avatarUrl;
      }
      if (!Object.keys(body).length) {
        return JSON.stringify({ ok: false, error: "至少提供 name、username、avatarUrl 之一" });
      }
      const data = await apiRequest("/api/auth/profile", { method: "PATCH", body });
      return toolResult(data, { ok: true });
    },
  },
  {
    name: "upload_user_avatar",
    description:
      "上传并设置当前登录用户头像。dataUrl 必须是 PNG/JPG/GIF/WebP 的 base64 data URL，最大 2MB。仅在用户明确提供或要求更换头像时调用。",
    inputSchema: {
      type: "object",
      properties: {
        dataUrl: { type: "string", description: "形如 data:image/png;base64,... 的头像内容。" },
      },
      required: ["dataUrl"],
    },
    handler: async (args) => {
      if (typeof args.dataUrl !== "string" || !args.dataUrl.startsWith("data:image/")) {
        return JSON.stringify({ ok: false, error: "dataUrl 必须是 image data URL" });
      }
      const data = await apiRequest("/api/auth/avatar", {
        method: "POST",
        body: { dataUrl: args.dataUrl },
      });
      return toolResult(data, { ok: true });
    },
  },
  {
    name: "update_user_preferences",
    description:
      "修改当前登录用户偏好。支持 theme、locale、timezone、deleteProtection。仅在用户明确要求调整偏好时调用。",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: ["string", "null"], enum: ["light", "dark", "system", null], description: "主题偏好。" },
        locale: { type: ["string", "null"], enum: ["zh", "en", null], description: "界面语言。" },
        timezone: { type: ["string", "null"], description: "IANA 时区，例如 Asia/Shanghai；null 表示删除偏好。" },
        deleteProtection: { type: ["boolean", "null"], description: "删除保护开关。" },
      },
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      for (const key of ["theme", "locale", "timezone", "deleteProtection"] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      if (!Object.keys(body).length) {
        return JSON.stringify({ ok: false, error: "至少提供一个偏好字段" });
      }
      const data = await apiRequest("/api/auth/preferences", { method: "PATCH", body });
      return toolResult(data, { ok: true });
    },
  },
];
