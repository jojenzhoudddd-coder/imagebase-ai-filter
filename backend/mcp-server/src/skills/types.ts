/**
 * Skill abstraction — Phase 3.
 *
 * A Skill bundles a set of MCP tools plus metadata describing when it should
 * be activated. Skills are Tier 2 in the four-layer capability model
 * (docs/chatbot-openclaw-plan.md §4): not always loaded, activated on
 * demand by the Agent via `activate_skill`, or auto-activated by keyword
 * heuristics before the model call.
 *
 * Design choices for this phase:
 *   - Skills are code-defined (no filesystem SKILL.md parsing yet); the plan
 *     allows for on-disk skill packages later, but that adds loader
 *     complexity we don't need when we only ship one skill.
 *   - A skill's tools retain their own `name` / `description` / `inputSchema`
 *     — we do NOT namespace them ("table.create_field"). Keeping flat names
 *     means we can activate/deactivate without touching history in the
 *     conversation log. Namespacing becomes useful once two skills collide
 *     on a name; today the namespace is a no-op.
 *   - Eviction is tracked per-conversation (`lastUsedTurn`) in the agent
 *     service, not here. This file only describes the skill; activation
 *     state is runtime concern.
 */

import type { ToolDefinition } from "../tools/tableTools.js";

export interface SkillDefinition {
  /** Stable identifier, e.g. "table-skill". Used in activate_skill / find_skill. */
  name: string;

  /** Human-readable name surfaced in find_skill output, e.g. "数据表操作". */
  displayName: string;

  /** 5–15-word summary of what the skill enables. Drives the model's pick in find_skill. */
  description: string;

  /**
   * Artifact types that should auto-activate this skill when opened (e.g.
   * ["table"]). Phase 3 doesn't wire UI artifact-open events yet; the field
   * is reserved for Phase 4+ so callers can already start populating it.
   */
  artifacts: string[];

  /**
   * One-sentence guidance hint surfaced in the system prompt catalog.
   * Example: "涉及数据表的字段/记录/视图增删改查时激活"。
   * Model reads this to decide whether to call activate_skill.
   */
  when: string;

  /**
   * Keyword / regex patterns that, if present in the user's turn message,
   * trigger auto-activation before the model sees the turn. Keep these
   * conservative — false positives cost the same as having the skill
   * always-on. Leave empty to require explicit activate_skill.
   */
  triggers: (string | RegExp)[];

  /** The tools bundled under this skill. */
  tools: ToolDefinition[];

  /**
   * Soft dependencies — when this skill is active, these dependent skills
   * are kept alive (exempt from idle-turn eviction) but NOT automatically
   * activated. Use for "I might need to write to an idea at the tail of my
   * workflow" relationships. Declaring a softDep is a hint to the eviction
   * machinery only; the dep still has to be loaded via trigger match or
   * `activate_skill` to appear in the model's tool list.
   *
   * Intentionally non-transitive: if A.softDeps=[B] and B.softDeps=[C],
   * activating A only protects B, not C. Keeps the graph tractable.
   *
   * Added P1 · analyst-skill requires this to keep idea-skill and table-skill
   * alive across long analysis sessions.
   */
  softDeps?: string[];

  /**
   * Optional prompt fragment injected into the system prompt when this skill
   * is active. Use for domain vocabulary, analytical frameworks, or
   * skill-specific output rules. Kept concise — the skill catalog already
   * covers "when to use". This is for "how to use / how to think".
   *
   * Added P1 · analyst-skill uses this for truncation rules + field
   * disambiguation; domain skills (finance/internet/accounting) for
   * terminology alignment.
   */
  promptFragment?: string;
}
