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
import { dictionaryTools } from "../tools/dictionaryTools.js";
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

### 表格生成规则（写 markdown 表 / 嵌 idea 时）
- **默认走标准 GFM markdown 表**\`| col | col |\`,前端会按 design token 渲染:
  外层圆角 + 浅灰背景 + th 浅底 + td 横向 row-divider, **行高 = 1.2 × 文字
  line-height(td ≈ 26px / th ≈ 25px)**, 你不用关心 CSS, 写出来就是对的。
- **不要在 markdown 里手动塞 \`<style>\` 或 inline 样式调间距 / 颜色** —— 默认
  样式覆盖 95% 场景, 多写只会跟前端 design token 冲突。
- **需要单元格内换行**: 在 cell 里直接写 \`<br>\` —— GFM markdown 表语法
  不允许真换行,但前端 \`html: true\` 已开,\`<br>\` 会被识别。
- **需要更紧凑或更宽松的特殊样式**(用户明确要求时再用):写 raw HTML \`<table>\`
  + 仅对该表写内联 \`style="line-height: 1.8"\` 或 \`<td style="padding: 8px">\`。
  这种属于"用户要求的局部覆盖", 不是默认行为。
- **不要写 \`<th style="background: #abc">\`** 之类硬色 hex —— 前端按主题
  自动注入 surface-1 / surface-3, 写死会破坏 LM/DM 切换。
- **大数据表**: 默认前 20 行 + 一行声明真实行数, 详见上方"结果展示"段落; 不要把
  上百行 markdown 表硬塞进回复或 idea。

### 图表生成规则（写 vega-lite spec 时严格遵守）
当用 \`generate_chart\` 工具或在回复 / Idea 中直接写 \`\`\`vega-lite\`\`\` 代码块时：

#### 1. 宽度（强制自适应）
- **不要**写 \`"width": <数字>\` —— 前端 ChatChartBlock 默认就用 \`"container"\` 模式跑响应式。
- 如果一定要指定,只能写 \`"width": "container"\`。
- 高度可以指定数字(\`"height": 280\` 等),前端不会覆盖。

#### 2. 颜色（强制使用 design token,不要硬写 hex）
- **不要**写 \`"config": {"range": {...}}\` 覆盖色阶 —— 前端会自动按 LM / DM 主题注入项目 primary 系列(从浅到深四阶蓝),热力图 / sequential ramp 都覆盖到。手动写 range 会让 DM 显示错误。
- **不要**写 \`"background"\` —— 前端强制透明,让图表吃宿主卡片色。
- **不要**写 \`"axis": {"labelColor": ...}\` / \`"legend": {"titleColor": ...}\` 这类硬色 —— 前端会按主题自动 merge 文字 / 轴线 / 网格色。
- **不要**给 mark 写 \`"stroke": "#FFF"\` / \`"stroke": "white"\`(为了在 LM 下伪装成"无形分隔缝") —— DM 下会变成刺眼白线,前端 DM CSS 已经统一处理 mark 间分隔。
- 单系列 mark 想要主色调,优先用 vega-lite **scheme name**(\`"scheme": "blues"\`)而不是硬写 hex —— scheme 在两种主题下都能看;真要写品牌主色,LM 用 \`#1456F0\`、DM 用 \`#4A82FF\`(但优先 scheme)。
- 多系列(category nominal)默认用 vega-lite \`"category10"\` 或 \`"tableau10"\`,色觉友好。

#### 3. 热力图（heatmap）专门提示
\`mark: "rect"\` + 连续 \`color\` 编码就是热力图。spec 里 **完全不要碰 color 配色**,只指定:
\`\`\`json
{
  "mark": "rect",
  "encoding": {
    "x": {...}, "y": {...},
    "color": { "field": "value", "type": "quantitative" }
  }
}
\`\`\`
前端 LM/DM 各自按 design token 注入 4 阶蓝渐变,你写得越少越对。
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
  tools: [...dictionaryTools, ...analystTools, ...analystWriteTools],
  promptFragment: ANALYST_PROMPT_FRAGMENT,
};
