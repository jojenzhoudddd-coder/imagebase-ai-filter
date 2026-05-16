import { runCliIntegrationTool } from "./cliRuntime.js";
import { callMcpIntegrationTool, listMcpTools } from "./mcpRuntime.js";
import {
  getAgentIntegration,
  markIntegrationHealth,
  markIntegrationUsed,
} from "./integrationStore.js";
import type { AgentIntegrationRow, IntegrationToolManifest } from "./types.js";

export async function callIntegrationTool(
  integrationId: string,
  toolName: string,
  args: Record<string, any>,
  opts?: { requireAgentId?: string },
): Promise<unknown> {
  const integration = await getAgentIntegration(integrationId, {
    requireAgentId: opts?.requireAgentId,
  });
  if (!integration) throw new Error(`integration not found: ${integrationId}`);
  if (!integration.enabled) throw new Error(`integration is disabled: ${integration.displayName}`);
  const manifest = integration.toolManifest.find((t) => t.name === toolName);
  if (!manifest) throw new Error(`unknown integration tool: ${toolName}`);
  const result = await dispatch(integration, manifest, args);
  await markIntegrationUsed(integration.id).catch(() => {});
  return result;
}

export async function testIntegration(integrationId: string, opts?: { requireAgentId?: string }): Promise<{
  ok: boolean;
  transport: string;
  detail: unknown;
}> {
  const integration = await getAgentIntegration(integrationId, {
    requireAgentId: opts?.requireAgentId,
  });
  if (!integration) throw new Error(`integration not found: ${integrationId}`);
  try {
    let detail: unknown;
    if (integration.transport === "cli") {
      const tool = getCliHealthCheckTool(integration)
        ?? integration.toolManifest.find((t) => t.mode === "cli" && t.readOnly !== false)
        ?? integration.toolManifest.find((t) => t.mode === "cli");
      if (!tool) throw new Error("No CLI tool declared in manifest");
      detail = await runCliIntegrationTool(integration, tool, {});
    } else {
      detail = await listMcpTools(integration);
    }
    await markIntegrationHealth(integration.id, "healthy", null);
    return { ok: true, transport: integration.transport, detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markIntegrationHealth(integration.id, "error", message).catch(() => {});
    return { ok: false, transport: integration.transport, detail: { error: message } };
  }
}

function getCliHealthCheckTool(integration: AgentIntegrationRow): IntegrationToolManifest | null {
  if (integration.providerKey === "github") {
    return {
      name: "gh_auth_status",
      description: "Check GitHub CLI authentication status.",
      mode: "cli",
      readOnly: true,
      output: "text",
      args: ["auth", "status", "--hostname", "github.com"],
      inputSchema: { type: "object", properties: {} },
    };
  }
  return null;
}

async function dispatch(
  integration: AgentIntegrationRow,
  manifest: IntegrationToolManifest,
  args: Record<string, any>,
): Promise<unknown> {
  if (manifest.mode === "cli") {
    return runCliIntegrationTool(integration, manifest, args);
  }
  const remoteName =
    manifest.remoteName ||
    (typeof args.tool === "string" ? args.tool : "") ||
    manifest.name;
  if (!remoteName) throw new Error("Remote MCP tool name is required");
  const remoteArgs =
    args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
      ? args.arguments
      : args;
  return callMcpIntegrationTool(integration, remoteName, remoteArgs);
}
