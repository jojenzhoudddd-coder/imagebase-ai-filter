/**
 * internet-analyst-skill tools (P4a).
 *
 * Product analytics primitives — DAU/MAU, funnel, cohort retention, ARPU.
 * Input is always a result handle (created via analyst-skill's
 * load_workspace_table + filters). These tools read rows from the handle
 * and run deterministic pure-function calculators in domainFunctions.ts.
 *
 * Every tool produces a JSON result suitable for inline display. None of
 * them create a new DuckDB result handle (the calculated output is small
 * enough to return directly).
 */

import { apiRequest, toolResult } from "../dataStoreClient.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

function fwd(ctx?: ToolContext) {
  return {
    conversationId: ctx?.conversationId || "default",
    workspaceId: ctx?.workspaceId || "doc_default",
  };
}

export const internetAnalystTools: ToolDefinition[] = [
  {
    name: "dau_mau",
    description:
      "计算 DAU / MAU / DAU/MAU 比率。输入一个 handle（需含 userId 字段和 date 字段），按日聚合活跃用户，按月聚合月活。" +
      "返回每日 DAU、月度 MAU、以及每日 DAU/MAU 粘性指标。",
    inputSchema: {
      type: "object",
      required: ["handle", "userField", "dateField"],
      properties: {
        handle: { type: "string" },
        userField: { type: "string", description: "用户 id 字段" },
        dateField: { type: "string", description: "日期字段（TIMESTAMP 或 VARCHAR ISO）" },
      },
    },
    handler: async (args, ctx) => {
      ctx?.progress?.({ phase: "computing", message: "计算 DAU/MAU" });
      const resp = await apiRequest<any>("/api/analyst/internet/dau-mau", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(resp);
    },
  },

  {
    name: "funnel_conversion",
    description:
      "漏斗转化分析。输入一个含 userId + stage 字段的 handle，以及有序 stages 列表。" +
      "计算每个阶段的用户数、相对上一阶段的转化率、相对首阶段的整体转化率。",
    inputSchema: {
      type: "object",
      required: ["handle", "userField", "stageField", "stages"],
      properties: {
        handle: { type: "string" },
        userField: { type: "string" },
        stageField: { type: "string" },
        stages: {
          type: "array",
          items: { type: "string" },
          description: "有序的阶段列表，如 ['浏览', '加购', '下单', '支付']",
        },
      },
    },
    handler: async (args, ctx) => {
      ctx?.progress?.({ phase: "computing", message: "计算漏斗转化" });
      const resp = await apiRequest<any>("/api/analyst/internet/funnel", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(resp);
    },
  },

  {
    name: "cohort_retention",
    description:
      "Cohort 留存分析。输入 userId + date 字段、粒度（day/week/month）和观察期数。" +
      "按用户首次活跃时间分 cohort，计算各期留存率矩阵。返回每行是一个 cohort，列 period_0..period_N 为对应期的留存比例。",
    inputSchema: {
      type: "object",
      required: ["handle", "userField", "dateField", "granularity"],
      properties: {
        handle: { type: "string" },
        userField: { type: "string" },
        dateField: { type: "string" },
        granularity: { type: "string", enum: ["day", "week", "month"] },
        periods: { type: "number", description: "观察期数，默认 8" },
      },
    },
    handler: async (args, ctx) => {
      ctx?.progress?.({ phase: "computing", message: "构建 cohort 留存矩阵" });
      const resp = await apiRequest<any>("/api/analyst/internet/cohort-retention", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(resp);
    },
  },

  {
    name: "arpu_arppu",
    description:
      "计算 ARPU（人均收入）和 ARPPU（付费用户人均收入）。" +
      "输入 userId + revenue 字段的 handle。ARPU = totalRevenue / users；ARPPU = totalRevenue / payingUsers。" +
      "其中 payingUsers 是 revenue > 0 的用户数。",
    inputSchema: {
      type: "object",
      required: ["handle", "userField", "revenueField"],
      properties: {
        handle: { type: "string" },
        userField: { type: "string" },
        revenueField: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      const resp = await apiRequest<any>("/api/analyst/internet/arpu", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(resp);
    },
  },
];
