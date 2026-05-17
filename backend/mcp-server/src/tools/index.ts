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
import { userSkillTools } from "./userSkillTools.js";
import { ideaNavTools, ideaTools } from "./ideaTools.js";
import { mentionTools } from "./mentionTools.js";
import { designNavTools } from "./designTools.js";
import { tasteNavTools } from "./tasteTools.js";
import { demoNavTools } from "./demoTools.js";
import { webTools } from "./webTools.js";
import { visionTools } from "./visionTools.js";
import { adminTools } from "./adminTools.js";
import { toolIntrospectionTools } from "./toolIntrospectionTools.js";
import { allSkills, skillsByName } from "../skills/index.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

// ── Tier partitioning ────────────────────────────────────────────────────

// Tier 1 = minimal always-on workspace navigation. Stays small on purpose:
// every tool here ships in the prompt for every agent turn, so non-core
// capabilities should live behind skills and be discovered via find_tool.
// Current members:
//   - Table nav:   list_tables, get_table
//   - Idea nav:    list_ideas,  get_idea
//   - Design nav:  list_designs
//   - Taste nav:   list_tastes, get_taste
//   - Demo nav:    list_demos,  get_demo
//   - Mention:     find_mentionable, list_incoming_mentions
//   - Web/Vision:  web_search, web_fetch, analyze_image
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
  "find_mentionable",
  "list_incoming_mentions",
  // Vibe Demo V1 nav
  "list_demos",
  "get_demo",
  // Web + image analysis — common enough to stay one hop away while heavier
  // domain bundles remain behind find_tool / activate_skill.
  "web_search",
  "web_fetch",
  "analyze_image",
]);

const tier0RouterTools = [
  ...skillRouterTools.filter((t) => t.name === "find_tool"),
  ...skillRouterTools.filter((t) => t.name === "find_skill"),
  ...skillRouterTools.filter((t) => t.name !== "find_tool" && t.name !== "find_skill"),
];

/** Tier 0 — identity + memory + skill routing + cron + user-skill management.
 *  Always loaded. Skill Creator V1 adds 6 user-skill management tools so the
 *  Agent can create / list / update / delete / toggle / save-from-run user
 *  skills in any conversation. */
export const tier0Tools: ToolDefinition[] = [
  ...tier0RouterTools,
  ...metaTools,
  ...memoryTools,
  ...toolIntrospectionTools,
];

/** Tier 1 — core workspace navigation. Always loaded. */
export const tier1Tools: ToolDefinition[] = [
  ...tableTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...ideaNavTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...designNavTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...tasteNavTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...mentionTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...demoNavTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...webTools.filter((t) => TIER1_NAMES.has(t.name)),
  ...visionTools.filter((t) => TIER1_NAMES.has(t.name)),
];

/**
 * Resolve the tool list for an in-process agent turn given the active skills.
 * External MCP stdio callers use `allTools` directly.
 *
 * Skill Creator V1: optional `extraSkillsByName` lets the chat agent loop
 * splice in user-defined skills (loaded per-turn from DB) without polluting
 * the module-level builtin registry. User-skill names in `activeSkillNames`
 * are looked up there first, falling back to builtin `skillsByName`.
 * On name collision, user skill wins (intentional — user customisation is
 * the entire point).
 */
export function resolveActiveTools(
  activeSkillNames: string[] = [],
  extraSkillsByName?: Record<string, import("../skills/types.js").SkillDefinition>,
  options?: { isAdmin?: boolean },
): ToolDefinition[] {
  const active: ToolDefinition[] = [...tier0Tools, ...tier1Tools];
  // Admin-only tools: only injected when the calling user is an admin
  if (options?.isAdmin) {
    active.push(...adminTools);
  }
  const seen = new Set(active.map((t) => t.name));
  for (const name of activeSkillNames) {
    const skill = extraSkillsByName ? extraSkillsByName[name] : skillsByName[name];
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
  // Admin tools — included in lookup map so handlers resolve, but only
  // injected into the active tool list for admin users via resolveActiveTools.
  ...adminTools,
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
