/**
 * Tool registry — aggregates all MCP tool definitions.
 *
 * This module is imported from TWO places:
 *  1. `backend/mcp-server/src/index.ts` — standalone MCP server entry (stdio transport)
 *  2. `backend/src/services/chatAgentService.ts` — in-process consumer (fast path for the chat agent)
 *
 * ── Phase 3 (tiered loading) ──────────────────────────────────────────────
 * Tools are now classified into Tiers so the chat agent can send a small
 * default context and let the model opt into bigger bundles via
 * `activate_skill`. External stdio MCP callers still see every tool via
 * `allTools` — tier filtering is an in-process concern only.
 *
 *   Tier 0 (always on): metaTools + memoryTools + skillRouterTools
 *     → identity, memory, and skill routing. ~8 tools, ~1.5 k tokens.
 *   Tier 1 (always on): list_tables + get_table
 *     → workspace navigation. The agent can always peek at state without
 *       activating any skill.
 *   Tier 2 skills (opt-in): tableSkill (field / record / view / write-table)
 *     → loaded only after activate_skill.
 */

import { tableTools } from "./tableTools.js";
import { fieldTools } from "./fieldTools.js";
import { recordTools } from "./recordTools.js";
import { viewTools } from "./viewTools.js";
import { metaTools } from "./metaTools.js";
import { memoryTools } from "./memoryTools.js";
import { skillRouterTools } from "./skillRouterTools.js";
import { cronTools } from "./cronTools.js";
import { ideaNavTools, ideaTools } from "./ideaTools.js";
import { mentionTools } from "./mentionTools.js";
import { designNavTools } from "./designTools.js";
import { tasteNavTools } from "./tasteTools.js";
import { dictionaryTools } from "./dictionaryTools.js";
import { demoNavTools } from "./demoTools.js";
import { subagentTools } from "./subagentTools.js";
import { workflowTools } from "./workflowTools.js";
import { allSkills, skillsByName } from "../skills/index.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

// ── Tier partitioning ────────────────────────────────────────────────────

// Tier 1 = always-on workspace navigation. Stays small on purpose — every
// tool here ships in the system prompt for every agent turn, so each added
// name trades prompt budget for capability. Current members:
//   - Table nav:   list_tables, get_table              (exists since Phase 3)
//   - Idea nav:    list_ideas,  get_idea               (v1 of chatbot-idea)
//   - Design nav:  list_designs                        (taste-chatbot v1)
//   - Taste nav:   list_tastes,  get_taste             (taste-chatbot v1)
//   - Mention:     find_mentionable,
//                  list_incoming_mentions              (cross-skill bridge)
//
// `find_mentionable` is cross-skill on purpose: writing an idea may require
// referencing a view or a taste the agent hasn't "activated" any skill for.
// Keeping the lookup in Tier 1 avoids a redundant activate_skill round trip
// just to enumerate candidates. `list_incoming_mentions` stays in Tier 1
// so delete-confirm flows work identically from any skill context.
const TIER1_NAMES = new Set([
  "list_tables",
  "get_table",
  "list_ideas",
  "get_idea",
  "list_designs",
  "list_tastes",
  "get_taste",
  // Vision + SVG structural inspection — always available so the Agent can
  // reach for them the moment a user mentions a design / taste, without
  // having to activate taste-skill first.
  "view_taste_image",
  "analyze_taste",
  "find_mentionable",
  "list_incoming_mentions",
  // Analyst P1 additions (always-on — semantic map + snapshot awareness)
  "get_data_dictionary",
  "list_snapshots",
  // Vibe Demo V1 nav
  "list_demos",
  "get_demo",
  // PR3 Agent Workflow: subagent spawn always-on so the host doesn't need
  // to activate workflow-skill just to fork a single sub-task.
  "spawn_subagent",
  // V2.4 B1 subagent danger upcall — host-only resolution tools, always-on
  // so host can react to subagent_danger_request events without activating
  // any skill mid-flight.
  "approve_subagent_danger",
  "reject_subagent_danger",
  "escalate_subagent_danger",
  // PR4 Agent Workflow: workflow template orchestration. Always-on so any
  // host can list / run review / brainstorm without first activating skill.
  "list_workflow_templates",
  "execute_workflow_template",
  // V2.5 B4 自由编排
  "compose_workflow",
]);

/** Tier 0 — identity + memory + skill routing + cron. Always loaded. */
export const tier0Tools: ToolDefinition[] = [
  ...metaTools,
  ...memoryTools,
  ...skillRouterTools,
  ...cronTools,
];

/** Tier 1 — core workspace navigation. Always loaded. */
export const tier1Tools: ToolDefinition[] = [
  ...tableTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...ideaNavTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...designNavTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...tasteNavTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...mentionTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...dictionaryTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...demoNavTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...subagentTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...workflowTools.filter((t) => TIER1_NAMES.has(t.name)),
];

/**
 * Resolve the tool list for an in-process agent turn given the active skills.
 * External MCP stdio callers use `allTools` directly.
 */
export function resolveActiveTools(activeSkillNames: string[] = []): ToolDefinition[] {
  const active: ToolDefinition[] = [...tier0Tools, ...tier1Tools];
  const seen = new Set(active.map((t) => t.name));
  for (const name of activeSkillNames) {
    const skill = skillsByName[name];
    if (!skill) continue;
    for (const t of skill.tools) {
      if (seen.has(t.name)) continue; // dedupe (shouldn't happen but defensive)
      active.push(t);
      seen.add(t.name);
    }
  }
  return active;
}

// ── Legacy: the full always-loaded list (every tool). Used by:
//   - stdio MCP server, which shouldn't filter by skill
//   - `isDangerousTool` / `toolsByName` lookups that must resolve any name
export const allTools: ToolDefinition[] = [
  ...tier0Tools,
  ...tier1Tools,
  // Flatten every skill's tools so the lookup map covers everything.
  ...allSkills.flatMap((s) => s.tools),
];

export const toolsByName: Record<string, ToolDefinition> =
  Object.fromEntries(allTools.map((t) => [t.name, t]));

export function isDangerousTool(name: string): boolean {
  return Boolean(toolsByName[name]?.danger);
}

/**
 * Convert tools to Volcano ARK Responses API tool format.
 * @param tools Optional subset (e.g. from `resolveActiveTools`). Defaults to every tool.
 */
export function toArkToolFormat(tools: ToolDefinition[] = allTools) {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

export type { ToolDefinition, ToolContext };
