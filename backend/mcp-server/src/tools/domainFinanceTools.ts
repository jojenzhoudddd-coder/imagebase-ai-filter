/**
 * finance-analyst-skill tools (P4c).
 *
 * Investment / portfolio primitives — IRR, NPV, WACC, CAGR, volatility,
 * Sharpe, beta, max drawdown. All pure numeric in / numeric out; no DuckDB
 * handle required (callers pass arrays directly). For series-from-table
 * use cases the Agent first extracts the series via run_sql or top_n, then
 * calls these.
 */

import { apiRequest, toolResult } from "../dataStoreClient.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

function fwd(ctx?: ToolContext) {
  return {
    conversationId: ctx?.conversationId || "default",
    workspaceId: ctx?.workspaceId || "doc_default",
  };
}

export const financeAnalystTools: ToolDefinition[] = [
  {
    name: "irr",
    description:
      "内部收益率 IRR。输入现金流数组（首元素通常是负的初始投资，后续为各期流入）。" +
      "返回小数表示的 IRR（0.12 = 12%）。对无符号变化或不收敛的序列返回 NaN。",
    inputSchema: {
      type: "object",
      required: ["cashflows"],
      properties: {
        cashflows: { type: "array", items: { type: "number" } },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/finance/irr", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
  {
    name: "npv",
    description: "净现值 NPV。输入贴现率（小数） + 现金流数组。",
    inputSchema: {
      type: "object",
      required: ["rate", "cashflows"],
      properties: {
        rate: { type: "number", description: "贴现率，如 0.1 表示 10%" },
        cashflows: { type: "array", items: { type: "number" } },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/finance/npv", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
  {
    name: "wacc",
    description:
      "加权平均资本成本 WACC = E/(E+D) × Ke + D/(E+D) × Kd × (1−t)。" +
      "equity / debt 可以是账面值或市值（建议市值）；所有 rate 字段小数表示。",
    inputSchema: {
      type: "object",
      required: ["equity", "debt", "costOfEquity", "costOfDebt", "taxRate"],
      properties: {
        equity: { type: "number" },
        debt: { type: "number" },
        costOfEquity: { type: "number" },
        costOfDebt: { type: "number" },
        taxRate: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/finance/wacc", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
  {
    name: "cagr",
    description: "年复合增长率 CAGR = (endValue / startValue) ^ (1/periods) - 1。",
    inputSchema: {
      type: "object",
      required: ["startValue", "endValue", "periods"],
      properties: {
        startValue: { type: "number" },
        endValue: { type: "number" },
        periods: { type: "number", description: "期数（年数 / 月数等）" },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/finance/cagr", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
  {
    name: "volatility",
    description:
      "年化波动率 = stddev(returns) × sqrt(periodsPerYear)。" +
      "returns 是简单收益率序列；日频用 252，月频用 12，周频用 52。",
    inputSchema: {
      type: "object",
      required: ["returns"],
      properties: {
        returns: { type: "array", items: { type: "number" } },
        periodsPerYear: { type: "number", description: "默认 252（日频）" },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/finance/volatility", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
  {
    name: "sharpe_ratio",
    description:
      "夏普比率 Sharpe = (mean_return − rf_per_period) / stddev(returns) × sqrt(periodsPerYear)。" +
      "riskFreeRate 是年化无风险利率（小数）；periodsPerYear 同 volatility。",
    inputSchema: {
      type: "object",
      required: ["returns"],
      properties: {
        returns: { type: "array", items: { type: "number" } },
        riskFreeRate: { type: "number", description: "年化无风险利率，默认 0" },
        periodsPerYear: { type: "number", description: "默认 252" },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/finance/sharpe", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
  {
    name: "beta",
    description:
      "贝塔系数 = cov(asset, market) / var(market)。输入资产收益序列和市场收益序列（同长度）。",
    inputSchema: {
      type: "object",
      required: ["assetReturns", "marketReturns"],
      properties: {
        assetReturns: { type: "array", items: { type: "number" } },
        marketReturns: { type: "array", items: { type: "number" } },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/finance/beta", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
  {
    name: "max_drawdown",
    description:
      "最大回撤 = max((peak − trough) / peak)。输入累积价值序列（不是收益率！）。" +
      "返回小数，0.3 表示 30% 最大回撤。",
    inputSchema: {
      type: "object",
      required: ["values"],
      properties: {
        values: {
          type: "array",
          items: { type: "number" },
          description: "累积价值序列，如净值曲线",
        },
      },
    },
    handler: async (args, ctx) => {
      const r = await apiRequest<any>("/api/analyst/finance/max-drawdown", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(r);
    },
  },
];
