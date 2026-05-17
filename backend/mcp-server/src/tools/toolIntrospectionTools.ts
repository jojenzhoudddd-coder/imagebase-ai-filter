import type { ToolContext, ToolDefinition } from "./tableTools.js";

export const toolIntrospectionTools: ToolDefinition[] = [
  {
    name: "list_available_tools",
    description:
      "列出你当前这一轮真正可调用的工具、已激活 skills、可激活 skills 目录，以及当前 user/agent/workspace 上下文。用于在不确定能力边界时自查。",
    inputSchema: {
      type: "object",
      properties: {
        includeDescriptions: {
          type: "boolean",
          description: "是否返回工具描述。默认 false，只返回工具名，节省上下文。",
        },
      },
    },
    handler: async (args, ctx?: ToolContext) => {
      const includeDescriptions = args.includeDescriptions === true;
      const tools = includeDescriptions
        ? ctx?.availableToolSummaries ?? []
        : ctx?.availableToolNames ?? [];
      const skills = (ctx?.availableSkills ?? []).map((skill) => ({
        name: skill.name,
        active: Boolean(ctx?.activeSkills?.includes(skill.name)),
        toolCount: skill.tools.length,
        description: skill.description,
      }));
      return JSON.stringify({
        ok: true,
        context: {
          userId: ctx?.userId ?? null,
          agentId: ctx?.agentId ?? null,
          workspaceId: ctx?.workspaceId ?? null,
          timeZone: ctx?.timeZone ?? null,
        },
        activeSkills: ctx?.activeSkills ?? [],
        tools,
        toolCount: Array.isArray(tools) ? tools.length : 0,
        skills,
        skillCount: skills.length,
      });
    },
  },
  {
    name: "list_my_permissions",
    description:
      "说明你当前继承的用户级权限边界：当前 userId、agentId、workspaceId，以及你可以操作哪些类型的资源。用于执行写操作前确认权限模型。",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx?: ToolContext) => JSON.stringify({
      ok: true,
      userId: ctx?.userId ?? null,
      agentId: ctx?.agentId ?? null,
      workspaceId: ctx?.workspaceId ?? null,
      permissions: {
        userProfile: "current authenticated user only",
        agents: "agents owned by current authenticated user only",
        workspace: "workspaces accessible to current authenticated user only",
        admin: "admin tools only appear when the owner user is admin",
      },
      notes: [
        "API-backed tools forward the user's auth cookie and reuse backend access middleware.",
        "Dangerous persistent operations may require confirmation when their tool definition is marked danger.",
      ],
    }),
  },
];
