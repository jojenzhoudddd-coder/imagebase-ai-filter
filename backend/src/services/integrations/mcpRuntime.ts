import type { AgentIntegrationRow } from "./types.js";
import {
  resolveIntegrationRuntimeEnv,
  toStringMap,
} from "./integrationRuntimeEnv.js";

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
  const [{ Client }, runtime] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    resolveIntegrationRuntimeEnv(integration, { includeProcessEnv: true }),
  ]);
  const client = new Client(
    {
      name: `funature-${integration.providerKey}-${integration.id}`,
      version: "1.0.0",
    },
    { capabilities: {} },
  );
  const transport = await buildTransport(integration, runtime);
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
  runtime: Awaited<ReturnType<typeof resolveIntegrationRuntimeEnv>>,
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
      env: toStringMap(runtime.env),
    });
  }

  if (integration.transport === "mcp-http") {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const endpoint = String(integration.config.endpoint || "").trim();
    if (!endpoint) {
      throw new Error(`Integration ${integration.displayName} has no MCP endpoint configured`);
    }
    return new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: runtime.headers },
    });
  }

  throw new Error(`Integration ${integration.displayName} is not configured for MCP transport`);
}
