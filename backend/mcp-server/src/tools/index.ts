/**
 * Tool registry — aggregates all MCP tool definitions.
 *
 * This module is imported from TWO places:
 *  1. `backend/mcp-server/src/index.ts` — standalone MCP server entry (stdio transport)
 *  2. `backend/src/services/chatAgentService.ts` — in-process consumer (fast path for the chat agent)
 *
 * Keeping a single source avoids drift between "what external MCP clients see"
 * and "what the in-process agent uses".
 */

import { tableTools } from "./tableTools.js";
import { fieldTools } from "./fieldTools.js";
import { recordTools } from "./recordTools.js";
import { viewTools } from "./viewTools.js";
import type { ToolDefinition } from "./tableTools.js";

export const allTools: ToolDefinition[] = [
  ...tableTools,
  ...fieldTools,
  ...recordTools,
  ...viewTools,
];

export const toolsByName: Record<string, ToolDefinition> =
  Object.fromEntries(allTools.map((t) => [t.name, t]));

export function isDangerousTool(name: string): boolean {
  return Boolean(toolsByName[name]?.danger);
}

/** Convert to Volcano ARK Responses API tool format (function calling). */
export function toArkToolFormat() {
  return allTools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

export type { ToolDefinition };
