/**
 * finance-analyst-skill — Tier 2 bundle for 投资 / 金融量化分析 (P4c).
 *
 * Tools: irr, npv, wacc, cagr, volatility, sharpe_ratio, beta, max_drawdown.
 *
 * Inputs are numeric arrays (not DuckDB handles). The typical flow is:
 *   1. analyst-skill extracts a time series via run_sql
 *   2. Agent pulls the numeric column into a JS array (via preview_result rows)
 *   3. Feeds the array into these tools
 */

import { financeAnalystTools } from "../tools/domainFinanceTools.js";
import type { SkillDefinition } from "./types.js";

const PROMPT = `## 金融 · 投资量化分析 · 术语与方法

你熟悉企业估值与组合管理的核心量化指标：

### 现金流类
- **NPV（净现值）**：给定贴现率，将未来现金流折现求和。NPV > 0 意味着项目创造价值。
- **IRR（内部收益率）**：使 NPV = 0 的贴现率。与资本成本比较决定是否投资。
  - IRR > WACC → 投资创造价值
  - IRR 存在时可能有多解，多项目排序时 NPV 更可靠
- **CAGR（年复合增长率）**：(end/start)^(1/periods) − 1，适合"十年增长率"这类问题。

### 资本成本
- **WACC = E/(E+D) × Ke + D/(E+D) × Kd × (1−t)**：公司折现率基准
- Ke 通常用 CAPM 估：Ke = Rf + β × (Rm − Rf)
- Kd 用税后债务成本（利息可抵税）

### 风险 & 收益
- **波动率（年化）** = std(returns) × sqrt(periodsPerYear)
  - 日频：252，月频：12，周频：52
- **夏普比率** = (年化超额收益) / 年化波动率；> 1 优秀，> 2 杰出
- **β（贝塔）** = cov(asset, market) / var(market)；> 1 比大盘波动大
- **最大回撤（MDD）**：峰值到谷底的最大跌幅。越小越稳。

### 分析套路
1. 基金 / 股票分析流程：load 价格序列 → 计算日收益率 → volatility + sharpe + beta + max_drawdown
2. 投资项目评估：列出 cashflows → irr + npv + 对比 wacc
3. 估值：dcf（未来现金流折现）= sum(CF_t / (1+wacc)^t) + 终值

### 数据准备提示
- 收益率用简单算术收益 (P_t − P_{t-1}) / P_{t-1}；长期可考虑对数收益
- 累积值（如净值）才能算 max_drawdown；传错类型结果会离谱

### 字段消歧义 / 数据边界
- 用户问 "IRR 多少" 时先确认现金流数组的时间方向和初始投资的符号（通常为负）
- 问 "波动率" 要先确认是日频 / 月频数据，否则年化系数用错
- 这类分析**不做市场预测**，只做历史指标；用户问 "以后会怎样" 时要明确说"历史 ≠ 未来"
`;

export const financeAnalystSkill: SkillDefinition = {
  name: "finance-analyst-skill",
  displayName: "金融量化分析",
  description:
    "金融量化分析：IRR / NPV / WACC / CAGR / 波动率 / 夏普比率 / Beta / 最大回撤。" +
    "输入数组计算，结果纯数值。",
  artifacts: [],
  softDeps: ["analyst-skill"],
  when:
    "用户问题涉及投资评估、项目 NPV / IRR、组合风险收益、基金 / 股票量化指标（夏普 / Beta / 波动率 / 回撤）等时激活。",
  triggers: [
    /(IRR|NPV|WACC|DCF|CAGR)/i,
    /(夏普|sharpe|贝塔|beta|波动率|volatility|回撤|drawdown)/i,
    /(年化|无风险利率|资本成本|贴现率|折现)/,
    /\b(internal rate of return|net present value|wacc|cagr|sharpe ratio|max drawdown)\b/i,
  ],
  tools: financeAnalystTools,
  promptFragment: PROMPT,
};
