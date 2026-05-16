import type { AgentIntegrationRow } from "./types.js";
import { loadCredentialValues } from "./integrationStore.js";

export async function listMcpTools(integration: AgentIntegrationRow): Promise<unknown> {
  const { client, close } = await connectMcp(integration);
  try {
    return await client.listTools();
  } finally {
    await close();
  }
}

export async function callMcpIntegrationTool(
  integration: AgentIntegrationRow,
  toolName: string,
  args: Record<string, any>,
): Promise<unknown> {
  const { client, close } = await connectMcp(integration);
  try {
    return await client.callTool({
      name: toolName,
      arguments: args,
    });
  } finally {
    await close();
  }
}

async function connectMcp(integration: AgentIntegrationRow): Promise<{
  client: any;
  close: () => Promise<void>;
}> {
  const [{ Client }, credentials] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    loadCredentialValues(integration.id),
  ]);
  const client = new Client(
    {
      name: `funature-${integration.providerKey}-${integration.id}`,
      version: "1.0.0",
    },
    { capabilities: {} },
  );
  const transport = await buildTransport(integration, credentials);
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

async function buildTransport(
  integration: AgentIntegrationRow,
  credentials: Record<string, string>,
): Promise<any> {
  if (integration.transport === "mcp-stdio") {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const mcp = integration.config.mcp ?? {};
    const command = String(mcp.command || integration.config.command || "").trim();
    if (!command) {
      throw new Error(`Integration ${integration.displayName} has no MCP stdio command configured`);
    }
    const args = Array.isArray(mcp.args) ? mcp.args.map(String) : [];
    return new StdioClientTransport({
      command,
      args,
      env: toStringEnv({
        ...process.env,
        ...credentials,
        ...resolveEnvMap(integration.config.envMap, credentials),
      }),
    });
  }

  if (integration.transport === "mcp-http") {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const endpoint = String(integration.config.endpoint || "").trim();
    if (!endpoint) {
      throw new Error(`Integration ${integration.displayName} has no MCP endpoint configured`);
    }
    const headers = resolveHeaders(
      integration.config.headers,
      integration.config.headersFromCredentials,
      credentials,
    );
    return new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers },
    });
  }

  throw new Error(`Integration ${integration.displayName} is not configured for MCP transport`);
}

function resolveHeaders(
  rawHeaders: unknown,
  headersFromCredentials: unknown,
  credentials: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  if (
    headersFromCredentials &&
    typeof headersFromCredentials === "object" &&
    !Array.isArray(headersFromCredentials)
  ) {
    for (const [headerName, credentialName] of Object.entries(headersFromCredentials as Record<string, unknown>)) {
      if (typeof credentialName !== "string") continue;
      if (credentials[credentialName] !== undefined) headers[headerName] = credentials[credentialName];
    }
  }
  return headers;
}

function resolveEnvMap(
  envMap: unknown,
  credentials: Record<string, string>,
): Record<string, string> {
  if (!envMap || typeof envMap !== "object" || Array.isArray(envMap)) return {};
  const out: Record<string, string> = {};
  for (const [envName, credentialName] of Object.entries(envMap as Record<string, unknown>)) {
    if (typeof credentialName !== "string") continue;
    if (credentials[credentialName] !== undefined) out[envName] = credentials[credentialName];
  }
  return out;
}

function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
