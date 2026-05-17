import type { IntegrationProviderPreset } from "./types.js";

const jsonSchemaObject = {
  type: "object" as const,
  properties: {},
};

export const INTEGRATION_PROVIDER_PRESETS: IntegrationProviderPreset[] = [
  {
    key: "github",
    displayName: "GitHub",
    description:
      "Operate repositories, issues, pull requests, Actions, and GitHub API calls through GitHub MCP or gh CLI.",
    homepage: "https://github.com/github/github-mcp-server",
    recommendedTransport: "cli",
    transports: ["cli", "mcp-stdio", "mcp-http"],
    auth: [
      {
        name: "GITHUB_TOKEN",
        label: "GitHub token",
        type: "secret",
        required: false,
        description: "Optional when gh is already authenticated; required for many MCP server deployments.",
      },
    ],
    defaultConfig: {
      command: "gh",
      mcp: {
        command: "github-mcp-server",
        args: ["stdio"],
      },
    },
    defaultTools: [
      {
        name: "gh_repo_view",
        description: "Read one GitHub repository summary using gh repo view.",
        mode: "cli",
        readOnly: true,
        output: "json",
        args: ["repo", "view", "{{repo}}", "--json", "name,owner,description,url,isPrivate,defaultBranchRef"],
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository in owner/name form." },
          },
          required: ["repo"],
        },
      },
      {
        name: "gh_repo_search",
        description: "Search GitHub repositories using gh search repos.",
        mode: "cli",
        readOnly: true,
        output: "json",
        args: [
          "search",
          "repos",
          "{{query}}",
          "--limit",
          "{{limit}}",
          "--json",
          "fullName,description,url,visibility,updatedAt,stargazersCount",
        ],
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Repository search query." },
            limit: { type: "number", description: "Maximum repositories to return. Default 20." },
          },
          required: ["query"],
        },
      },
      {
        name: "gh_issue_list",
        description: "List GitHub issues for a repository.",
        mode: "cli",
        readOnly: true,
        output: "json",
        args: ["issue", "list", "--repo", "{{repo}}", "--limit", "{{limit}}", "--json", "number,title,state,author,url,updatedAt"],
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository in owner/name form." },
            limit: { type: "number", description: "Maximum issues to return. Default 20." },
          },
          required: ["repo"],
        },
      },
      {
        name: "gh_pr_list",
        description: "List GitHub pull requests for a repository.",
        mode: "cli",
        readOnly: true,
        output: "json",
        args: ["pr", "list", "--repo", "{{repo}}", "--limit", "{{limit}}", "--json", "number,title,state,author,url,updatedAt,isDraft"],
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository in owner/name form." },
            limit: { type: "number", description: "Maximum PRs to return. Default 20." },
          },
          required: ["repo"],
        },
      },
      {
        name: "github_mcp_call",
        description: "Call a GitHub MCP server tool by remote tool name.",
        mode: "mcp",
        readOnly: false,
        remoteName: "",
        inputSchema: {
          type: "object",
          properties: {
            tool: { type: "string", description: "Remote MCP tool name." },
            arguments: { type: "object", description: "Remote MCP tool arguments." },
          },
          required: ["tool"],
        },
      },
    ],
    triggers: ["github", "GitHub", "repo", "issue", "pull request", "PR"],
    scopes: ["repo:read", "issues:read", "pull_requests:read"],
  },
  {
    key: "lark",
    displayName: "Lark / Feishu",
    description:
      "Connect Lark Docs, Base, Messenger, Calendar, and Open Platform APIs through the official lark-cli.",
    homepage: "https://github.com/larksuite/cli",
    recommendedTransport: "cli",
    transports: ["cli"],
    auth: [],
    defaultConfig: {
      command: "lark-cli",
    },
    defaultTools: [
      {
        name: "lark_auth_status",
        description:
          "Check whether lark-cli is installed, configured, and logged in inside this integration sandbox. If setup or login is missing, use start_lark_auth and send the returned URL/QR/code to the user.",
        mode: "cli",
        readOnly: true,
        output: "text",
        args: ["auth", "status"],
        inputSchema: jsonSchemaObject,
      },
      {
        name: "lark_schema",
        description:
          "Inspect a lark-cli command/API schema before calling less familiar Lark commands.",
        mode: "cli",
        readOnly: true,
        output: "text",
        args: ["schema", "{{method}}"],
        inputSchema: {
          type: "object",
          properties: {
            method: {
              type: "string",
              description: "Method id such as calendar.events.instance_view or im.messages.delete.",
            },
          },
          required: ["method"],
        },
      },
      {
        name: "lark_api_get",
        description:
          "Call a read-only Lark Open Platform GET endpoint through lark-cli. Use for APIs that do not have a narrower shortcut in the manifest.",
        mode: "cli",
        readOnly: true,
        output: "json",
        args: ["api", "GET", "{{path}}", "--params", "{{params}}", "--format", "json"],
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Open API path, e.g. /open-apis/calendar/v4/calendars." },
            params: { type: "object", description: "Query parameters. Defaults to {}." },
          },
          required: ["path"],
        },
      },
      {
        name: "lark_api_post",
        description:
          "Call a Lark Open Platform POST endpoint through lark-cli. This may write third-party data and requires confirmation. For calendar event creation, prefer lark_calendar_create_event so the backend converts time safely.",
        mode: "cli",
        readOnly: false,
        danger: true,
        output: "json",
        args: ["api", "POST", "{{path}}", "--params", "{{params}}", "--data", "{{data}}", "--format", "json"],
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Open API path, e.g. /open-apis/im/v1/messages." },
            params: { type: "object", description: "Query parameters. Defaults to {}." },
            data: { type: "object", description: "JSON request body." },
          },
          required: ["path", "data"],
        },
      },
      {
        name: "lark_calendar_create_event",
        description:
          "Create a Lark/Feishu calendar event. Prefer this over lark_api_post for schedules: pass ISO-8601 startTime/endTime, never hand-write Unix timestamps. If endTime is omitted, durationMinutes defaults to 60. Relative dates must be resolved from the current Asia/Shanghai date in the system context.",
        mode: "cli",
        readOnly: false,
        danger: true,
        output: "json",
        args: [],
        inputSchema: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Event title, e.g. LR - 字段搜索." },
            startTime: {
              type: "string",
              description: "ISO datetime with timezone, e.g. 2026-05-18T17:00:00+08:00. Do not pass Unix timestamps.",
            },
            endTime: {
              type: "string",
              description: "Optional ISO datetime with timezone. If omitted, durationMinutes is used.",
            },
            durationMinutes: {
              type: "number",
              description: "Optional duration when endTime is omitted. Default 60.",
            },
            timezone: {
              type: "string",
              description: "IANA timezone. Default Asia/Shanghai.",
            },
            calendarId: {
              type: "string",
              description: "Optional calendar_id. Omit to use the user's primary calendar.",
            },
            description: { type: "string", description: "Optional event description." },
            location: {
              type: "object",
              description: "Optional event location, e.g. {name, address}.",
            },
            reminderMinutes: {
              type: "number",
              description: "Optional reminder offset in minutes before start, e.g. 15.",
            },
            videoMeeting: {
              type: "boolean",
              description: "Set false to create without a video meeting.",
            },
            idempotencyKey: {
              type: "string",
              description: "Optional explicit idempotency key. Normally omit; backend derives one from title/time/calendar.",
            },
            allowPast: {
              type: "boolean",
              description: "Only true when the user explicitly asks to create a past event.",
            },
          },
          required: ["summary", "startTime"],
        },
      },
      {
        name: "lark_cli",
        description:
          "Run an explicit lark-cli argv list for official shortcut/API commands, such as ['base', '+...', ...] or ['docs', '+search', ...]. Writes and broad commands require confirmation.",
        mode: "cli",
        readOnly: false,
        danger: true,
        output: "json",
        args: ["{{argv}}"],
        inputSchema: {
          type: "object",
          properties: {
            argv: {
              type: "array",
              items: { type: "string" },
              description:
                "Arguments after `lark-cli`; each token must be a separate array item. Do not include shell syntax.",
            },
          },
          required: ["argv"],
        },
      },
    ],
    triggers: ["lark", "feishu", "飞书", "多维表格", "Base", "Lark", "lark-cli"],
    scopes: ["lark-cli", "docs", "base", "messenger"],
  },
  {
    key: "figma",
    displayName: "Figma",
    description:
      "Read Figma files, selections, components, and design metadata through Figma MCP or REST-compatible tools.",
    homepage: "https://help.figma.com/hc/en-us/articles/39216419318551-Get-started-with-the-Figma-MCP-server",
    recommendedTransport: "mcp-http",
    transports: ["mcp-http", "mcp-stdio"],
    auth: [
      {
        name: "FIGMA_TOKEN",
        label: "Figma token",
        type: "secret",
        required: false,
        description: "Optional for local Dev Mode MCP; required for REST or hosted MCP deployments.",
      },
    ],
    defaultConfig: {
      endpoint: "http://127.0.0.1:3845/mcp",
      headersFromCredentials: {
        "X-Figma-Token": "FIGMA_TOKEN",
      },
    },
    defaultTools: [
      {
        name: "figma_mcp_call",
        description: "Call a Figma MCP server tool by remote tool name.",
        mode: "mcp",
        readOnly: true,
        remoteName: "",
        inputSchema: {
          type: "object",
          properties: {
            tool: { type: "string", description: "Remote MCP tool name." },
            arguments: { type: "object", description: "Remote MCP tool arguments." },
          },
          required: ["tool"],
        },
      },
    ],
    triggers: ["figma", "Figma", "设计稿", "组件", "selection"],
    scopes: ["files:read", "dev-mode"],
  },
  {
    key: "custom-cli",
    displayName: "Custom CLI",
    description:
      "Wrap a user-provided local CLI as safe Agent tools through a manifest with explicit commands and arguments.",
    recommendedTransport: "cli",
    transports: ["cli"],
    auth: [],
    defaultConfig: {
      command: "",
    },
    defaultTools: [
      {
        name: "cli_help",
        description: "Run the configured CLI help command.",
        mode: "cli",
        readOnly: true,
        output: "text",
        args: ["--help"],
        inputSchema: jsonSchemaObject,
      },
    ],
    triggers: ["cli", "command line", "命令行", "自定义集成", "custom integration"],
    scopes: ["local-cli"],
  },
];

export function getIntegrationPreset(providerKey: string): IntegrationProviderPreset | null {
  return INTEGRATION_PROVIDER_PRESETS.find((p) => p.key === providerKey) ?? null;
}

export function listIntegrationPresets(): IntegrationProviderPreset[] {
  return INTEGRATION_PROVIDER_PRESETS;
}

export function isSystemIntegrationProvider(providerKey: string): boolean {
  return providerKey === "github" || providerKey === "lark" || providerKey === "figma";
}

export function listSystemIntegrationPresets(): IntegrationProviderPreset[] {
  return INTEGRATION_PROVIDER_PRESETS.filter((preset) => isSystemIntegrationProvider(preset.key));
}
