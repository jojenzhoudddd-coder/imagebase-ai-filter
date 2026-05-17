/**
 * settings-skill — user / agent / workspace settings tools.
 *
 * Kept out of the default tool list. The router tools (`find_tool` /
 * `find_skill`) can discover this bundle when the user asks to inspect or
 * modify account, agent, or workspace settings.
 */

import { accountTools } from "../tools/accountTools.js";
import { agentSettingsTools } from "../tools/agentSettingsTools.js";
import { workspaceSettingsTools } from "../tools/workspaceSettingsTools.js";
import type { SkillDefinition } from "./types.js";

export const settingsSkill: SkillDefinition = {
  name: "settings-skill",
  displayName: "用户与工作区设置",
  description: "查看和修改当前用户、agent、workspace 的名称、头像、偏好和身份信息。",
  artifacts: ["user", "agent", "workspace"],
  when:
    "用户要求查看/修改自己的资料、用户名、头像、偏好，或修改 agent 名称/头像、workspace 名称时激活。",
  triggers: [
    "修改名字",
    "改名字",
    "改名",
    "修改头像",
    "换头像",
    "用户资料",
    "个人资料",
    "偏好",
    "timezone",
    "时区",
    "workspace 名称",
    "工作区名称",
    "agent 名称",
    "agent 头像",
    /修改.*(workspace|工作区|agent|头像|名字|名称)/i,
    /(rename|profile|avatar|preference|settings|workspace name|agent name)/i,
  ],
  tools: [
    ...accountTools,
    ...agentSettingsTools,
    ...workspaceSettingsTools,
  ],
};
