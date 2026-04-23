/**
 * internet-analyst-skill — Tier 2 bundle for互联网 / 产品分析 (P4a).
 *
 * Tools: dau_mau, funnel_conversion, cohort_retention, arpu_arppu.
 * softDeps: analyst-skill (required — these tools consume handles from it).
 *
 * Prompt fragment covers互联网指标术语对齐 so the model doesn't guess what
 * "粘性 / 留存曲线 / 漏斗" mean.
 */

import { internetAnalystTools } from "../tools/domainInternetTools.js";
import type { SkillDefinition } from "./types.js";

const PROMPT = `## 互联网产品分析 · 术语与方法

你熟悉互联网产品运营的核心指标体系：
- **DAU / MAU / WAU**：日 / 月 / 周活跃用户数。粘性 = DAU/MAU。
- **留存曲线 / cohort**：按用户首活日分 cohort，每一期的回访比例就是该期留存率。
  - "次日留存"就是 cohort period_1 的留存率。
  - 健康的产品 7 日留存通常 > 20%（消费级），30 日 > 10%。
- **漏斗（funnel）**：有序阶段的转化率。相邻阶段的转化率 = 本阶段用户 / 上阶段用户。
- **ARPU（人均收入） / ARPPU（付费用户人均）**：ARPPU 通常 10-100 倍于 ARPU。
- **LTV（用户生命周期价值）** = ARPU × 留存 × 生命周期长度；需要用户分群。

### 分析套路
1. 先 load_workspace_table 加载事件表（需含 userId、date、以及可选 stage/revenue）。
2. 选对工具：
   - "日活 / 月活 / 粘性" → dau_mau
   - "留存 / cohort" → cohort_retention
   - "漏斗 / 转化率" → funnel_conversion
   - "ARPU / ARPPU" → arpu_arppu
3. 涉及时间趋势时优先用 analyst-skill 的 time_bucket + group_aggregate，它们更通用。
4. 结果出来后结合 generate_chart 生成 line / bar 图表更直观。

### 字段消歧义
"用户 id" 字段多个时（user_id / member_id / device_id）必须先向用户确认 — 不同字段算出来的留存天差地别。
`;

export const internetAnalystSkill: SkillDefinition = {
  name: "internet-analyst-skill",
  displayName: "互联网数据分析",
  description:
    "互联网产品指标：DAU / MAU / 留存（cohort）/ 漏斗转化 / ARPU·ARPPU。" +
    "与 analyst-skill 搭配使用。",
  artifacts: [],
  softDeps: ["analyst-skill"],
  when:
    "用户问题涉及互联网产品指标（日活 / 月活 / 粘性 / 留存 / cohort / 漏斗 / 转化率 / ARPU 等）时激活。",
  triggers: [
    /(DAU|MAU|WAU|日活|月活|周活|粘性)/i,
    /(留存|retention|cohort|流失|churn)/i,
    /(漏斗|funnel|转化率)/i,
    /(ARPU|ARPPU|LTV)/i,
  ],
  tools: internetAnalystTools,
  promptFragment: PROMPT,
};
