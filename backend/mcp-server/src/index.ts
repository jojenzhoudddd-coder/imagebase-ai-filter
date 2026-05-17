/**
 * Standalone MCP Server entry point (stdio transport).
 *
 * Exposes all Table/Field/Record/View CRUD tools to external MCP clients
 * (Claude Code, Cursor, MCP inspector, etc.).
 *
 * NOTE: In production, the primary consumer of these tools is the in-process
 * ChatAgentService (via direct import from `./tools/index.ts`), which is
 * faster than stdio serialization. This entry point exists so external MCP
 * clients can also use the same tools — a design benefit of the user's
 * choice to expose a standalone MCP server (see docs/chat-sidebar-plan.md
 * "关键技术决策").
 *
 * Run standalone:
 *   cd backend/mcp-server && npx tsx src/index.ts
 *
 * Then connect from MCP inspector:
 *   npx @modelcontextprotocol/inspector
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { allTools, toolsByName } from "./tools/index.js";
import {
  extractToolOutputError,
  normalizeError,
  summarizeForLog,
  writeErrorLog,
} from "../../src/services/errorLogService.js";

const server = new Server(
  {
    name: "ai-filter-table-agent",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const startedAt = Date.now();
  const args = (req.params.arguments || {}) as Record<string, any>;
  const tool = toolsByName[req.params.name];
  if (!tool) {
    const err = new Error(`Unknown tool: ${req.params.name}`);
    writeStandaloneMcpError("standalone_mcp_tool_unknown", req.params.name, args, Date.now() - startedAt, err);
    throw err;
  }
  try {
    const result = await tool.handler(args);
    const reportedError = extractToolOutputError(result);
    if (reportedError) {
      writeErrorLog({
        scope: "mcp",
        kind: "standalone_mcp_tool_result_error",
        level: "warning",
        message: reportedError,
        durationMs: Date.now() - startedAt,
        tool: {
          name: req.params.name,
          args: summarizeForLog(args),
        },
        result: summarizeForLog(result),
      });
    }
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeStandaloneMcpError("standalone_mcp_tool_error", req.params.name, args, Date.now() - startedAt, err);
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
    };
  }
});

function writeStandaloneMcpError(
  kind: string,
  toolName: string,
  args: unknown,
  durationMs: number,
  err: unknown,
): void {
  writeErrorLog({
    scope: "mcp",
    kind,
    level: "error",
    message: err instanceof Error ? err.message : String(err),
    durationMs,
    tool: {
      name: toolName,
      args: summarizeForLog(args),
    },
    error: normalizeError(err),
  });
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-server] ready on stdio");
}

main().catch((err) => {
  console.error("[mcp-server] fatal:", err);
  process.exit(1);
});
