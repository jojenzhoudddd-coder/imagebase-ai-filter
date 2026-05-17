/**
 * folder-skill — workspace folder hierarchy management.
 */

import { folderTools } from "../tools/folderTools.js";
import type { SkillDefinition } from "./types.js";

export const folderSkill: SkillDefinition = {
  name: "folder-skill",
  displayName: "文件夹管理",
  description: "列出、创建、重命名、删除文件夹，以及移动表/文档/设计/Demo 到文件夹。",
  artifacts: ["folder"],
  when:
    "用户要求整理工作空间层级、查看文件夹、创建/改名/删除文件夹，或移动表/文档/设计/Demo 到文件夹时激活。",
  triggers: [
    "文件夹",
    "目录",
    "移动到",
    "归档",
    "整理工作区",
    /(创建|新建|新增|改名|重命名|删除|移动|整理).*(文件夹|目录|folder)/i,
    /(move|folder|directory|organize|archive)/i,
  ],
  tools: [...folderTools],
};
