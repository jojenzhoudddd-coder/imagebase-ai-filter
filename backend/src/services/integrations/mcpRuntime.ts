import type { AgentIntegrationRow } from "./types.js";
import {
  resolveIntegrationRuntimeEnv,
  toStringMap,
} from "./integrationRuntimeEnv.js";
import {
  extractToolOutputError,
  normalizeError,
  summarizeForLog,
  writeErrorLog,
} from "../errorLogService.js";

export async function listMcpTools(integration: AgentIntegrationRow): Promise<unknown> {
  const startedAt = Date.now();
  let close: (() => Promise<void>) | null = null;
  try {
    const connected = await connectMcp(integration);
    close = connected.close;
    return await connected.client.listTools();
  } catch (err) {
    writeMcpIntegrationError("mcp_integration_list_tools_error", integration, undefined, undefined, Date.now() - startedAt, err);
    throw err;
  } finally {
    await close?.();
  }
}

export async function callMcpIntegrationTool(
  integration: AgentIntegrationRow,
  toolName: string,
  args: Record<string, any>,
): Promise<unknown> {
  const startedAt = Date.now();
  let close: (() => Promise<void>) | null = null;
  try {
    const connected = await connectMcp(integration);
    close = connected.close;
    const result = await connected.client.callTool({
      name: toolName,
      arguments: args,
    });
    const reportedError = extractToolOutputError(result);
    if (reportedError) {
      writeErrorLog({
        scope: "integration",
        kind: "mcp_integration_tool_result_error",
        level: "warning",
        message: reportedError,
        durationMs: Date.now() - startedAt,
        integration: mcpIntegrationMeta(integration),
        tool: { name: toolName, args: summarizeForLog(args) },
        result: summarizeForLog(result),
      });
    }
    return result;
  } catch (err) {
    writeMcpIntegrationError("mcp_integration_tool_error", integration, toolName, args, Date.now() - startedAt, err);
    throw err;
  } finally {
    await close?.();
  }
}

function writeMcpIntegrationError(
  kind: string,
  integration: AgentIntegrationRow,
  toolName: string | undefined,
  args: unknown,
  durationMs: number,
  err: unknown,
): void {
  writeErrorLog({
    scope: "integration",
    kind,
    level: "error",
    message: err instanceof Error ? err.message : String(err),
    durationMs,
    integration: mcpIntegrationMeta(integration),
    tool: toolName ? { name: toolName, args: summarizeForLog(args) } : undefined,
    error: normalizeError(err),
  });
}

function mcpIntegrationMeta(integration: AgentIntegrationRow): Record<string, unknown> {
  return {
    id: integration.id,
    agentId: integration.agentId,
    providerKey: integration.providerKey,
    transport: integration.transport,
    displayName: integration.displayName,
  };
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
