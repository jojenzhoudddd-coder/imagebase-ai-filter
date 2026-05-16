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
      "Connect Lark Docs, Base, Messenger, Calendar, and Open Platform APIs through Lark MCP or CLI.",
    homepage: "https://github.com/larksuite/lark-openapi-mcp",
    recommendedTransport: "mcp-stdio",
    transports: ["mcp-stdio", "mcp-http", "cli"],
    auth: [
      { name: "LARK_APP_ID", label: "App ID", type: "text", required: true },
      { name: "LARK_APP_SECRET", label: "App Secret", type: "secret", required: true },
    ],
    defaultConfig: {
      mcp: {
        command: "npx",
        args: ["-y", "@larksuiteoapi/lark-mcp", "mcp", "--mode", "stdio"],
      },
      envMap: {
        APP_ID: "LARK_APP_ID",
        APP_SECRET: "LARK_APP_SECRET",
      },
    },
    defaultTools: [
      {
        name: "lark_mcp_call",
        description: "Call a Lark MCP server tool by remote tool name.",
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
    triggers: ["lark", "feishu", "飞书", "多维表格", "Base", "Lark"],
    scopes: ["docs", "base", "messenger"],
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
