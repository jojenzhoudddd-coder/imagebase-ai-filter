/**
 * analyst-skill — Tier 2 bundle for AI-powered data analysis (P2).
 *
 * Compute engine: DuckDB (embedded, per-conversation .duckdb file at
 * ~/.imagebase/analyst/sessions/conv_<id>.duckdb). Snapshot semantics:
 * each workspace table gets one parquet snapshot per analysis session,
 * reused unless `refresh:true` is passed. See docs/analyst-skill-plan.md.
 *
 * softDeps: idea-skill and table-skill are kept alive while analyst is
 * active — user might pivot to "write these results to a doc / save as
 * a new table" at any point without having to re-activate.
 *
 * promptFragment: pinned rules for (a) truncating large results, (b)
 * disambiguating fields before aggregating, (c) stamping the snapshot
 * time on every reply. Injected when this skill is active.
 */

import { analystTools } from "../tools/analystTools.js";
import { analystWriteTools } from "../tools/analystWriteTools.js";
import type { SkillDefinition } from "./types.js";

export const ANALYST_PROMPT_FRAGMENT = `## Analyst 操作规则（严格）

### 入口
- 任何涉及"分析 / 统计 / 聚合 / 计算 / 分布 / 对比 / 排名 / 占比 / 同比环比 / 趋势"的问题，
  都要先调 \`load_workspace_table\` 把相关表加载进 DuckDB，拿到 \`_resultHandle\` 再在上面做聚合。
- **不要**把 query_records 的原始行塞进上下文逐行数——10万行会爆，换 analyst 工具。

### 字段消歧义（强制）
在做任何聚合 / 筛选前：
1. 若候选字段 ≥ 2 个且语义模糊（如 amount / amount_usd / net_amount），
   **必须先用自然语言反问用户**："我看到 X / Y / Z 三个字段，你指的是哪个？"
2. 若字段有 \`description\`（数据字典）能明确区分，直接使用，但在回复开头声明
   "我使用的是 \`字段名\`: \`description\`"。
3. 使用 \`get_data_dictionary\` 一次性加载字段语义，避免逐字段猜。

### 结果展示（严格）
生成最终回复时：
- **≤ 100 行**：在回复里嵌 Markdown 表格（ChatTableBlock 会自动虚拟滚动）。
- **> 100 行**：只展示前 20 行 Markdown 表，紧接一行声明：
  > 以上为前 20 行预览，完整结果共 N 行。如需导出为文档 / 继续分析 / 追加筛选，告知即可。
  **不要**挂按钮，不要说"点击展开"。用户开口才物化。
- **标量或空**：直接文字说明，不要硬凑表格。
- **永远在回复开头**声明："本次分析基于 <snapshotAt> 的数据快照"——给 snapshotAt（来自 meta）
  即可，日期精确到分钟。

### 物化（对话驱动）
用户出现以下意图词时，调 \`write_analysis_to_idea(handle=<最近一个 handle>, workspaceId, narrative, title?)\`：
- "整理 / 写成 / 生成 文档 / 报告 / 笔记"
- "导出 / 落地 / 保存"
- "写到文档里 / 汇总一下"

用户明确说"存到新表 / 做成新数据表 / 落成表"时，调 \`write_analysis_to_table\`。

**跨轮 handle 引用（重要）**：
当前对话的所有 analyst 结果 handle 都列在 Layer 3 · Turn Context 的"最近的 Analyst 结果"段落里，**每轮系统 prompt 都会自动注入最新 10 条**。
- 用户在新一轮说"保存这个结果"时，**不要回"handle 丢了 / 需要重新跑"**——直接看 Turn Context 的 handle 列表，用最顶部（最新）那条的 handle 值。
- 列表项格式：\`\`\`ducktbl_xxxxxxxxxxxx\`\`\` · <producedBy> · <rowCount> 行 · [字段] · <时间>。
- 若 Turn Context 里确实为空（比如对话一上来就说"保存"），再说明"目前还没有分析结果"并请用户先提出分析意图。

**只要用户在继续追问或调整分析，都不要主动 write**——保留 handle，继续工具迭代。

### 工具选择策略
- 快捷工具（group_aggregate / pivot_result / filter_result / time_bucket / top_n / join_results）
  → 覆盖 80% 场景；优先使用，效率高、语义清晰。
- \`run_sql\` → 只在快捷工具拼不出时用。WITH / SELECT / CREATE TABLE AS 允许，其他语法会被拒。
- 大表处理：DuckDB 内部流式，Agent 不需要自己分页——直接一条 SQL 跑完。

### 数据一致性声明
Snapshot 粒度：进入 analyst 时每张表创建一次快照，本会话后续复用。如果用户说"基于最新数据重新分析"，
调 \`load_workspace_table(tableId, {refresh:true})\` 显式刷新。
`;

export const analystSkill: SkillDefinition = {
  name: "analyst-skill",
  displayName: "数据分析",
  description:
    "AI 问数：加载 workspace 数据表到 DuckDB 会话，做专业聚合 / 透视 / 排名 / 时序 / 自由 SQL，" +
    "结论以结论 + 表格（+ 图表）形式返回对话，支持落地为 Idea 文档或新数据表。",
  artifacts: ["table"],
  softDeps: ["idea-skill", "table-skill"],
  when:
    "当用户提出的问题是关于数据的统计 / 聚合 / 对比 / 排名 / 分布 / 趋势 / 同比环比 / 透视 / 跨表关联" +
    "等分析需求时激活。单纯增删改字段 / 记录不属于这里（那是 table-skill）。",
  triggers: [
    // 中文
    /(分析|统计|聚合|汇总|对比|比较|排名|排序|分布|占比|趋势|走势|同比|环比|透视|多少|几个)/,
    /(最高|最低|最大|最小|top|前\d+|第\d+名)/i,
    /(月度|日度|季度|年度|按月|按天|按季)/,
    // 英文
    /\b(analyze|aggregate|group by|pivot|top\s*\d+|trend|distribution|breakdown|sum|avg|average|count|compare)\b/i,
  ],
  tools: [...analystTools, ...analystWriteTools],
  promptFragment: ANALYST_PROMPT_FRAGMENT,
};
