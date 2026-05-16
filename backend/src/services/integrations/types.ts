export type IntegrationTransport = "mcp-stdio" | "mcp-http" | "cli";

export type IntegrationStatus =
  | "not_configured"
  | "healthy"
  | "error"
  | "disabled";

export interface IntegrationToolManifest {
  /** Local tool id within the integration. Keep stable; used in generated MCP tool names. */
  name: string;
  description: string;
  /** `mcp` delegates to a remote MCP tool; `cli` runs a declared local command. */
  mode: "mcp" | "cli";
  /** Remote MCP tool name. Defaults to `name`. */
  remoteName?: string;
  /** JSON schema for arguments the model may pass. */
  inputSchema?: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** CLI command override. Defaults to integration.config.command. */
  command?: string;
  /** CLI argument template. Values like `{{owner}}` are substituted from tool args. */
  args?: string[];
  /** Expected stdout shape. */
  output?: "json" | "text";
  readOnly?: boolean;
  danger?: boolean;
  timeoutMs?: number;
}

export interface AgentIntegrationRow {
  id: string;
  agentId: string;
  providerKey: string;
  displayName: string;
  transport: IntegrationTransport;
  enabled: boolean;
  status: IntegrationStatus;
  lastError: string | null;
  config: Record<string, any>;
  toolManifest: IntegrationToolManifest[];
  scopes: string[];
  lastHealthAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  credentials: Array<{ name: string; valuePreview: string | null }>;
}

export interface IntegrationProviderPreset {
  key: string;
  displayName: string;
  description: string;
  homepage?: string;
  recommendedTransport: IntegrationTransport;
  transports: IntegrationTransport[];
  auth: Array<{
    name: string;
    label: string;
    type: "secret" | "text";
    required: boolean;
    description?: string;
  }>;
  defaultConfig: Record<string, any>;
  defaultTools: IntegrationToolManifest[];
  triggers: string[];
  scopes: string[];
}
