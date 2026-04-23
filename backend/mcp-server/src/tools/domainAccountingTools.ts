/**
 * accounting-analyst-skill tools (P4b).
 *
 * Structured accounting ratios + DuPont decomposition. Inputs are explicit
 * numbers (not handles) — accounting analysis typically operates on a small
 * set of hand-picked aggregates the Agent has already pulled from the source
 * tables via analyst-skill's group_aggregate / describe_result.
 */

import { apiRequest, toolResult } from "../dataStoreClient.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

function fwd(ctx?: ToolContext) {
  return {
    conversationId: ctx?.conversationId || "default",
    workspaceId: ctx?.workspaceId || "doc_default",
  };
}

export const accountingAnalystTools: ToolDefinition[] = [
  {
    name: "dupont_analysis",
    description:
      "三因子杜邦拆解：ROE = 净利率 × 资产周转率 × 权益乘数。" +
      "返回五个指标：netProfitMargin / assetTurnover / equityMultiplier / roe / roa。" +
      "输入来自利润表（净利润、营收）和资产负债表（总资产、所有者权益）。",
    inputSchema: {
      type: "object",
      required: ["netIncome", "revenue", "totalAssets", "equity"],
      properties: {
        netIncome: { type: "number", description: "净利润" },
        revenue: { type: "number", description: "营业收入" },
        totalAssets: { type: "number", description: "总资产" },
        equity: { type: "number", description: "股东权益" },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/accounting/dupont", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
  {
    name: "current_ratio",
    description: "流动比率 = 流动资产 / 流动负债。衡量短期偿债能力，一般 > 2 为佳。",
    inputSchema: {
      type: "object",
      required: ["currentAssets", "currentLiabilities"],
      properties: {
        currentAssets: { type: "number" },
        currentLiabilities: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/accounting/current-ratio", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
  {
    name: "quick_ratio",
    description: "速动比率 = (流动资产 − 存货) / 流动负债。剔除存货后的短期偿债能力。",
    inputSchema: {
      type: "object",
      required: ["currentAssets", "inventory", "currentLiabilities"],
      properties: {
        currentAssets: { type: "number" },
        inventory: { type: "number" },
        currentLiabilities: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/accounting/quick-ratio", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
  {
    name: "debt_to_equity",
    description: "产权比率 = 总负债 / 股东权益。衡量财务杠杆水平。",
    inputSchema: {
      type: "object",
      required: ["totalDebt", "equity"],
      properties: {
        totalDebt: { type: "number" },
        equity: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/accounting/debt-to-equity", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
  {
    name: "profit_margins",
    description:
      "一次计算三种毛利率：grossMargin（毛利率）、operatingMargin（营业利润率）、netMargin（净利率）。" +
      "适合汇报「利润率结构」。",
    inputSchema: {
      type: "object",
      required: ["revenue"],
      properties: {
        revenue: { type: "number" },
        cogs: { type: "number", description: "销售成本" },
        operatingIncome: { type: "number", description: "营业利润" },
        netIncome: { type: "number", description: "净利润" },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/accounting/margins", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
];
