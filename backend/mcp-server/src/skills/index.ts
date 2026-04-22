/**
 * Skill registry — single source of truth for Phase 3+.
 *
 * Adding a new skill:
 *   1. Create a new file under `src/skills/` exporting a SkillDefinition.
 *   2. Import + add it to `allSkills` below.
 *   3. Start tests. No changes needed in chatAgentService — the router reads
 *      this registry directly.
 *
 * Roadmap note — design-skill (v3+):
 *   A future `designSkill` will bundle Design/Taste write tools (create
 *   design, upload taste from URL, reposition tastes on the SVG canvas,
 *   etc.). For v1 we deliberately ship read-only visibility of tastes
 *   through Tier 1 `find_mentionable` (so the agent can still drop a taste
 *   chip into an idea) but leave the design-side writes for a dedicated
 *   skill. The placeholder here marks the architectural slot.
 */

import { tableSkill } from "./tableSkill.js";
import { ideaSkill } from "./ideaSkill.js";
// import { designSkill } from "./designSkill.js";  // TODO(v3+): bundle
// Design/Taste write tools into their own skill. Not yet implemented; the
// read surface (finding tastes via find_mentionable) is already available
// in Tier 1.
import type { SkillDefinition } from "./types.js";

export const allSkills: SkillDefinition[] = [tableSkill, ideaSkill];

export const skillsByName: Record<string, SkillDefinition> = Object.fromEntries(
  allSkills.map((s) => [s.name, s])
);

export type { SkillDefinition };
