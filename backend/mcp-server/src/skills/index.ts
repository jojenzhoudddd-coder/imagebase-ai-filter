/**
 * Skill registry — single source of truth for Phase 3+.
 *
 * Adding a new skill:
 *   1. Create a new file under `src/skills/` exporting a SkillDefinition.
 *   2. Import + add it to `allSkills` below.
 *   3. Start tests. No changes needed in chatAgentService — the router reads
 *      this registry directly.
 */

import { tableSkill } from "./tableSkill.js";
import type { SkillDefinition } from "./types.js";

export const allSkills: SkillDefinition[] = [tableSkill];

export const skillsByName: Record<string, SkillDefinition> = Object.fromEntries(
  allSkills.map((s) => [s.name, s])
);

export type { SkillDefinition };
