/**
 * knowledge-skill — agent knowledge base management.
 */

import { knowledgeTools } from "../tools/knowledgeTools.js";
import type { SkillDefinition } from "./types.js";

export const knowledgeSkill: SkillDefinition = {
  name: "knowledge-skill",
  displayName: "知识库",
  description: "学习网页/文本知识，搜索、查看、更新、删除 agent 知识库条目。",
  artifacts: ["knowledge"],
  when:
    "用户要求学习/沉淀资料，搜索以前学过的知识，查看、更新或删除知识库内容时激活。",
  triggers: [
    "知识库",
    "学习",
    "记到知识",
    "沉淀",
    "资料",
    "以前学过",
    /(学习|保存|沉淀|搜索|查找|更新|删除).*(知识|资料|文档|knowledge)/i,
    /(knowledge|learn|remember this document|search memory|saved knowledge)/i,
  ],
  tools: [...knowledgeTools],
};
