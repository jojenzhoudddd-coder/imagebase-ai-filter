/**
 * Skill registry — single source of truth for Phase 3+.
 *
 * Adding a new skill:
 *   1. Create a new file under `src/skills/` exporting a SkillDefinition.
 *   2. Import + add it to `allSkills` below.
 *   3. Start tests. No changes needed in chatAgentService — the router reads
 *      this registry directly.
 *
 * Shipped skills (2026-04-22):
 *   - `table-skill` — field/record/view/table-write tools
 *   - `idea-skill`  — Markdown doc write + streaming
 *   - `taste-skill` — Design/Taste write (画布 + SVG)
 */

import { tableSkill } from "./tableSkill.js";
import { ideaSkill } from "./ideaSkill.js";
import { tasteSkill } from "./tasteSkill.js";
import { analystSkill } from "./analystSkill.js";
import { internetAnalystSkill } from "./internetAnalystSkill.js";
import { accountingAnalystSkill } from "./accountingAnalystSkill.js";
import { financeAnalystSkill } from "./financeAnalystSkill.js";
import { demoSkill } from "./demoSkill.js";
import { vibeDesignSkill } from "./vibeDesignSkill.js";
import { vibeCodingSkill } from "./vibeCodingSkill.js";
import type { SkillDefinition } from "./types.js";

export const allSkills: SkillDefinition[] = [
  tableSkill,
  ideaSkill,
  tasteSkill,
  analystSkill,
  internetAnalystSkill,
  accountingAnalystSkill,
  financeAnalystSkill,
  demoSkill,
  vibeDesignSkill,
  vibeCodingSkill,
];

export const skillsByName: Record<string, SkillDefinition> = Object.fromEntries(
  allSkills.map((s) => [s.name, s])
);

export type { SkillDefinition };
