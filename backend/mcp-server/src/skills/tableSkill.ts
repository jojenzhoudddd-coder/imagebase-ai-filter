/**
 * table-skill — Phase 3 Tier 2 bundle.
 *
 * Wraps the existing field / record / view / advanced-table tools that the
 * Agent needs when the user is actually *editing* a data table. Workspace-
 * level navigation (`list_tables`, `get_table`) stays in Tier 1 so the
 * Agent can always peek at the workspace before deciding to activate.
 *
 * Scope:
 *   - 3 table-level write/destroy tools: create_table, rename_table,
 *     delete_table, reset_table
 *   - All field tools (list/create/update/delete/batch_delete)
 *   - All record tools (query/create/update/delete/batch_*)
 *   - All view tools (list/create/update/delete)
 *
 * `list_tables` and `get_table` intentionally stay OUT of this skill — they
 * live in the always-on Tier 1 so an un-activated Agent can still answer
 * "what tables exist here?" without a round trip.
 */

import { tableTools } from "../tools/tableTools.js";
import { fieldTools } from "../tools/fieldTools.js";
import { recordTools } from "../tools/recordTools.js";
import { viewTools } from "../tools/viewTools.js";
import type { SkillDefinition } from "./types.js";

const TIER1_TABLE_TOOL_NAMES = new Set(["list_tables", "get_table"]);

const tableWriteTools = tableTools.filter((t) => !TIER1_TABLE_TOOL_NAMES.has(t.name));

export const tableSkill: SkillDefinition = {
  name: "table-skill",
  displayName: "数据表操作",
  description: "数据表的字段、记录、视图、结构增删改查（激活后即可执行写入类操作）。",
  artifacts: ["table"],
  when:
    "当用户请求涉及数据表的修改——创建/删除表、添加或改字段、新增/查询/修改/删除记录、管理视图——时激活。只想列表查看现状（list_tables / get_table）不需要激活。",
  triggers: [
    // 中文触发词（覆盖创建 / 字段 / 记录 / 视图 / 筛选）
    /创建.*(表|字段|记录|视图)/,
    /(新建|新增|加一?个).*(表|字段|记录|列|视图)/,
    /(删除|清空|删掉|移除).*(表|字段|记录|视图|行|列)/,
    /(改名|重命名|修改|编辑).*(表|字段|视图)/,
    /(填|写入|输入|导入).*(数据|记录|内容)/,
    /批量/,
    /筛选/,
    // 英文
    /\b(create|add|insert)\b.*\b(table|field|column|record|row|view)s?\b/i,
    /\b(delete|remove|drop|clear)\b.*\b(table|field|column|record|row|view)s?\b/i,
    /\b(rename|update|edit)\b.*\b(table|field|view)s?\b/i,
    /\b(batch|bulk)\b/i,
  ],
  tools: [
    ...tableWriteTools,
    ...fieldTools,
    ...recordTools,
    ...viewTools,
  ],
};
