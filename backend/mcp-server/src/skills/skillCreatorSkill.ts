/**
 * Skill Creator skill — bundles the 6 user-skill management tools
 * (create / list / update / delete / enable / save_workflow_run_as_skill).
 *
 * Moved from Tier 0 (always-on) to Tier 2 (opt-in) so it only loads
 * when the user explicitly triggers it via /skill-creator or keyword match.
 */

import { userSkillTools } from "../tools/userSkillTools.js";
import type { SkillDefinition } from "./types.js";

export const skillCreatorSkill: SkillDefinition = {
  name: "skill-creator",
  displayName: "Skill Creator",
  description: "创建、管理、更新自定义技能。用户可以通过对话创建可复用的能力包。",
  artifacts: [],
  when: "用户想创建、修改、删除、启用/禁用自定义技能时激活",
  triggers: [
    "创建技能", "新建技能", "添加技能", "自定义技能",
    "修改技能", "更新技能", "删除技能", "技能管理",
    "create skill", "new skill", "add skill", "custom skill",
    "manage skill", "update skill", "delete skill",
    "skill creator",
  ],
  tools: userSkillTools,
};
