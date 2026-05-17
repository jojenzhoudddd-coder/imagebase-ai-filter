/**
 * schedule-skill — agent scheduled task / habit management.
 */

import { cronTools } from "../tools/cronTools.js";
import type { SkillDefinition } from "./types.js";

export const scheduleSkill: SkillDefinition = {
  name: "schedule-skill",
  displayName: "定时任务与习惯",
  description: "创建、查看、修改、取消 agent 定时任务和 habits。",
  artifacts: ["schedule"],
  when:
    "用户要求每天/每周/每月提醒或定期执行某事，查看已有定时任务，暂停/修改/取消 habit 时激活。",
  triggers: [
    "定时",
    "提醒",
    "每天",
    "每周",
    "每月",
    "habit",
    "习惯",
    "cron",
    /(每天|每周|每月|定期|定时|提醒|暂停|取消|修改).*(任务|习惯|habit|提醒)?/i,
    /(schedule|scheduled|remind|recurring|habit|cron)/i,
  ],
  tools: [...cronTools],
};
