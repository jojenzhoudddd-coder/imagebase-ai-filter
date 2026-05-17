/**
 * model-management-skill — custom model configuration.
 */

import { modelTools } from "../tools/modelTools.js";
import type { SkillDefinition } from "./types.js";

export const modelManagementSkill: SkillDefinition = {
  name: "model-management-skill",
  displayName: "模型管理",
  description: "添加、查看、测试、删除用户自定义模型配置。",
  artifacts: ["model"],
  when:
    "用户要求添加 OpenAI-compatible/Anthropic/custom 模型，测试模型连通性，查看或删除自定义模型时激活。",
  triggers: [
    "添加模型",
    "自定义模型",
    "测试模型",
    "模型配置",
    "api key",
    "baseUrl",
    /(添加|新增|配置|测试|删除|查看).*(模型|model)/i,
    /(custom model|add model|test model|api key|base url|provider model)/i,
  ],
  tools: [...modelTools],
};
