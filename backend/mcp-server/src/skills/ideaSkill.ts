/**
 * idea-skill — Phase 3 Tier 2 bundle for the灵感 (Idea) artifact.
 *
 * Scope:
 *   - 5 doc-level tools: create / rename / delete (⚠️) / full-replace (⚠️)
 *   - 2 insert tools: append_to_idea, insert_into_idea (anchor-based)
 *
 * Intentionally OUT of this skill:
 *   - `list_ideas`, `get_idea`   → Tier 1 always-on nav (mirrors table-skill)
 *   - `find_mentionable`         → Tier 1 cross-skill bridge
 *   - `list_incoming_mentions`   → Tier 1 (needed for delete safety from any
 *                                   skill context, not just this one)
 *
 * Keeping the read side always-on mirrors the `list_tables / get_table`
 * decision in table-skill: un-activated agents should still be able to
 * answer "what idea docs exist here?" and "show me the roadmap doc" without
 * burning a turn on activate_skill.
 */

import { ideaWriteTools, ideaStreamTools } from "../tools/ideaTools.js";
import type { SkillDefinition } from "./types.js";

export const ideaSkill: SkillDefinition = {
  name: "idea-skill",
  displayName: "灵感文档编辑",
  description:
    "灵感（Idea）文档的创建、删改、按章节锚点插入 Markdown/HTML，以及整篇替换。激活后才能写入。",
  artifacts: ["idea"],
  when:
    "当用户请求对灵感文档进行编辑——新建文档、改名、删除、在某章节追加/替换内容、整篇重写——时激活。只想读取文档内容（list_ideas / get_idea）不需要激活。",
  triggers: [
    // 中文：常见的写作动作词 + 灵感/文档/章节 组合
    /(写|新增|新建|创建|追加|插入|补充|撰写|续写).*(灵感|文档|文稿|doc|idea|章节|段落)/i,
    /(改|改写|重写|替换|更新|填).*(灵感|文档|文稿|doc|idea)/i,
    /(删除|删掉|移除).*(灵感|文档|文稿|doc|idea)/i,
    // 英文
    /\b(write|append|insert|add)\b.*\b(idea|doc|document|section|paragraph|heading)s?\b/i,
    /\b(rewrite|replace|update|edit)\b.*\b(idea|doc|document)s?\b/i,
    /\b(delete|remove|drop)\b.*\b(idea|doc|document)s?\b/i,
    // 通用：显式提到 Markdown 正文编辑
    /\bmarkdown\b/i,
  ],
  tools: [...ideaWriteTools, ...ideaStreamTools],
};
