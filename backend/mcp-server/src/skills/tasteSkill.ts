/**
 * taste-skill — Phase 3 Tier 2 bundle for the Design/Taste (画布 × SVG) artifact.
 *
 * 术语对齐：
 *   - 代码中的 Design = 产品语境下的 "Taste"（画布容器，Artifacts 一级实体）
 *   - 代码中的 Taste  = 产品语境下的 "Node" （画布里的一张 SVG 图片）
 *   未来会统一重命名（见 docs/taste-chatbot-plan.md 术语对齐）。
 *
 * Scope:
 *   - Design-level:  create_design, rename_design, delete_design (⚠️),
 *                    auto_layout_design
 *   - Taste-level:   create_taste_from_svg, rename_taste, update_taste,
 *                    batch_update_tastes, delete_taste (⚠️)
 *
 * Intentionally OUT of this skill (stays in Tier 1):
 *   - list_designs, list_tastes, get_taste — read-only nav, always available
 *     so the Agent can answer "画布里有哪些 SVG？" without activating anything
 *     (mirrors the decision in table-skill / idea-skill).
 */

import { designWriteTools } from "../tools/designTools.js";
import { tasteWriteTools } from "../tools/tasteTools.js";
import type { SkillDefinition } from "./types.js";

export const tasteSkill: SkillDefinition = {
  name: "taste-skill",
  displayName: "画布与 SVG 编辑",
  description:
    "画布（Design）和 SVG 图片（Taste）的新建、改名、删除、批量移动、自动排版。激活后才能写入。",
  artifacts: ["design", "taste"],
  when:
    "当用户请求对画布或画布中的 SVG 图片进行编辑——新建画布/SVG、改名、删除、调整位置/尺寸、自动排版——时激活。只想查看现有内容（list_designs / list_tastes / get_taste）不需要激活。",
  triggers: [
    // 中文：新建/删除/改名 × 画布/SVG/Taste/Design
    /(新建|创建|新增|添加|加一?个).*(画布|design|taste|svg|图片|样式)/i,
    /(删除|删掉|移除|清掉).*(画布|design|taste|svg|图片)/i,
    /(改名|重命名|修改|编辑).*(画布|design|taste|svg|图片)/i,
    /(移动|摆放|对齐|整理|排版|排列|布局|reflow).*(画布|design|taste|svg|图片)?/i,
    /(自动排版|自动布局|整理.*画布|tidy\s*up)/i,
    // 英文
    /\b(create|add|insert|new)\b.*\b(design|canvas|taste|svg|image)s?\b/i,
    /\b(delete|remove|drop)\b.*\b(design|canvas|taste|svg|image)s?\b/i,
    /\b(rename|edit|update)\b.*\b(design|canvas|taste|svg)s?\b/i,
    /\b(move|align|auto[-\s]?layout|tidy|arrange|reflow)\b.*\b(design|canvas|taste|svg)?s?\b/i,
  ],
  tools: [...designWriteTools, ...tasteWriteTools],
};
