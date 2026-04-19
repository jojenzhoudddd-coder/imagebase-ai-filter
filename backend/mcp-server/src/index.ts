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
  const tool = toolsByName[req.params.name];
  if (!tool) {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }
  try {
    const result = await tool.handler((req.params.arguments || {}) as Record<string, any>);
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-server] ready on stdio");
}

main().catch((err) => {
  console.error("[mcp-server] fatal:", err);
  process.exit(1);
});
