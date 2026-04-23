/**
 * accounting-analyst-skill — Tier 2 bundle for 财务 / 会计分析 (P4b).
 *
 * Tools: dupont_analysis, current_ratio, quick_ratio, debt_to_equity,
 * profit_margins. softDeps: analyst-skill.
 *
 * These tools take explicit numbers (not handles) — the typical analysis
 * flow is: Agent loads a financial statement via load_workspace_table +
 * group_aggregate to produce annual / quarterly totals, then feeds those
 * totals into these ratio calculators.
 */

import { accountingAnalystTools } from "../tools/domainAccountingTools.js";
import type { SkillDefinition } from "./types.js";

const PROMPT = `## 财务 · 会计分析 · 术语与方法

你熟悉标准会计报表与财务比率分析体系：

### 三张表关键科目
- **利润表**：营业收入 / 营业成本 / 毛利 / 营业利润 / 净利润
- **资产负债表**：流动资产 / 非流动资产 / 总资产 / 流动负债 / 非流动负债 / 所有者权益
- **现金流量表**：经营活动 / 投资活动 / 筹资活动现金流净额

### 核心比率（所有比率输出为小数，如 0.3 表示 30%）
- **毛利率** = (营业收入 − 营业成本) / 营业收入 → profit_margins.grossMargin
- **净利率** = 净利润 / 营业收入 → profit_margins.netMargin
- **ROE** = 净利润 / 股东权益 → dupont_analysis.roe
- **ROA** = 净利润 / 总资产 → dupont_analysis.roa
- **流动比率** = 流动资产 / 流动负债 → current_ratio（> 2 为佳）
- **速动比率** = (流动资产 − 存货) / 流动负债 → quick_ratio（> 1 为佳）
- **产权比率** = 总负债 / 股东权益 → debt_to_equity

### 杜邦分析
\`ROE = 净利率 × 资产周转率 × 权益乘数\` — 用 dupont_analysis 一次性拆解。
解读：
- 净利率低 → 成本结构问题（毛利 or 费用 or 税负）
- 资产周转率低 → 资产效率问题（存货、应收账款周转慢）
- 权益乘数高 → 高杠杆，风险放大

### 分析套路
1. 如果用户提供的是"某公司某年财报"，直接在提示里把关键科目读出来，套入工具。
2. 如果是表格数据，load_workspace_table + group_aggregate 先汇总出年度数据，再取值套入。
3. 多年对比时先各年算比率，再用 analyst-skill 的 generate_chart 画趋势图。
4. 解读时要讲"和行业均值 / 历史均值比"的方向，光说绝对值没意义。

### 字段消歧义
"营业收入" 可能有 "营业总收入 / 营业收入 / 主营业务收入" 等变体，先问清再算。
`;

export const accountingAnalystSkill: SkillDefinition = {
  name: "accounting-analyst-skill",
  displayName: "财务数据分析",
  description:
    "财务报表分析：杜邦拆解、流动比率、速动比率、毛利/净利率、产权比率等标准会计指标。" +
    "配合 analyst-skill 读数据，计算层走确定性函数。",
  artifacts: [],
  softDeps: ["analyst-skill"],
  when:
    "用户问题涉及财务报表 / 会计比率 / 盈利能力 / 偿债能力 / 杜邦分析等时激活。",
  triggers: [
    /(财务|会计|财报|报表|资产负债|利润表|现金流量表)/,
    /(毛利率|净利率|ROE|ROA|杜邦|DuPont)/i,
    /(流动比率|速动比率|产权比率|资产周转|权益乘数)/,
    /\b(accounting|balance sheet|income statement|cash flow)\b/i,
    /\b(gross margin|net margin|current ratio|quick ratio|debt.?to.?equity)\b/i,
  ],
  tools: accountingAnalystTools,
  promptFragment: PROMPT,
};
