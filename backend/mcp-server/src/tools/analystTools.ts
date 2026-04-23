/**
 * Analyst-skill MCP tools — thin proxies to /api/analyst/*.
 *
 * See docs/analyst-skill-plan.md for the architecture rationale. Each tool
 * forwards the conversationId from `ctx` (plumbed through the chat agent
 * loop) so the backend keys DuckDB sessions correctly.
 *
 * Every tool returns:
 *   {
 *     _resultHandle: "ducktbl_xxx",          (when it produces a new handle)
 *     meta: ResultMeta,                      (schema + rowCount + snapshot time)
 *     preview: ResultPreview                 (first 20 rows for ChatTableBlock)
 *   }
 * — a contract the frontend recognizes and renders as an inline table.
 */

import { apiRequest, toolResult } from "../dataStoreClient.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

function fwd(ctx?: ToolContext) {
  return {
    conversationId: ctx?.conversationId || "default",
    workspaceId: ctx?.workspaceId || "doc_default",
  };
}

export const analystTools: ToolDefinition[] = [
  {
    name: "load_workspace_table",
    description:
      "将 workspace 数据表加载进 DuckDB 分析会话。首次加载会创建 parquet 快照并作为 read-only 视图挂载；" +
      "同一对话后续复用同一快照，除非 refresh=true。返回 _resultHandle + 完整 meta + 前 20 行预览。" +
      "分析任何表之前必须先调本工具，否则其他分析工具无 handle 可用。",
    inputSchema: {
      type: "object",
      required: ["tableId"],
      properties: {
        tableId: { type: "string", description: "workspace 中的 tbl_xxx" },
        refresh: {
          type: "boolean",
          description: "强制重新快照（丢弃本会话内已挂载的旧快照），用于用户明确要求使用最新数据",
        },
        snapshotAt: {
          type: "string",
          description: "可选：显式指定加载某个历史时点的快照（ISO timestamp）",
        },
      },
    },
    handler: async (args, ctx) => {
      const opts = fwd(ctx);
      ctx?.progress?.({ phase: "planning", message: `加载数据表 ${args.tableId}` });
      const resp = await apiRequest<{ meta: any; preview: any }>(
        "/api/analyst/load-workspace-table",
        { method: "POST", body: args, ...opts },
      );
      return toolResult(resp, { _resultHandle: resp.meta.handle });
    },
  },

  {
    name: "describe_result",
    description:
      "对一个 handle 做**纯聚合描述**：每字段返回 null_count / distinct_count / min / max / mean / p50 / p95 " +
      "（数值列）以及 top-K 高频值（分类列）。**不会抽样**——统计值基于全表。适合回答 " +
      "「这张表大致长啥样 / 有多少空值 / 哪几个分类最常见」这类问题，避免把几万行塞进上下文。",
    inputSchema: {
      type: "object",
      required: ["handle"],
      properties: {
        handle: { type: "string" },
        topK: {
          type: "number",
          description: "分类列返回的 top-K 值个数，默认 5",
        },
      },
    },
    handler: async (args, ctx) => {
      const stats = await apiRequest<any>("/api/analyst/describe", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(stats);
    },
  },

  {
    name: "preview_result",
    description:
      "读取某个 handle 的前 N 行（默认 20）。" +
      "给用户/Agent 看数据样貌用；返回的 rows 数组可直接贴到 ChatTableBlock。" +
      "如果 rowCount > 100 并打算展示给用户，在正文中务必声明真实 rowCount 并引导对话。",
    inputSchema: {
      type: "object",
      required: ["handle"],
      properties: {
        handle: { type: "string" },
        limit: { type: "number", description: "默认 20，最多 1000" },
      },
    },
    handler: async (args, ctx) => {
      const preview = await apiRequest<any>("/api/analyst/preview", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(preview);
    },
  },

  {
    name: "filter_result",
    description:
      "按 SQL WHERE 表达式筛选一个 handle，产生新 handle。" +
      "where 支持 DuckDB SQL 语法（如 `amount > 100 AND city = '北京'`），" +
      "但会用 AST 白名单拒绝 DROP/DELETE/INSERT/UPDATE/ATTACH 等危险关键字。",
    inputSchema: {
      type: "object",
      required: ["handle", "where"],
      properties: {
        handle: { type: "string" },
        where: { type: "string", description: "WHERE 子句表达式，不要带 WHERE 关键字本身" },
        description: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      ctx?.progress?.({ phase: "computing", message: `应用筛选` });
      const resp = await apiRequest<{ meta: any; preview: any }>(
        "/api/analyst/filter",
        { method: "POST", body: args, ...fwd(ctx) },
      );
      return toolResult(resp, { _resultHandle: resp.meta.handle });
    },
  },

  {
    name: "group_aggregate",
    description:
      "对一个 handle 做分组聚合：`SELECT groupBy..., metric(field)... FROM handle GROUP BY groupBy`。" +
      "metrics 每项指定一个字段 + 聚合函数（count / sum / avg / min / max / count_distinct / median / stddev）" +
      "+ 可选别名。产生新 handle。**批量操作优先用这个而不是 run_sql，效率高、Agent 指令清晰**。",
    inputSchema: {
      type: "object",
      required: ["handle", "groupBy", "metrics"],
      properties: {
        handle: { type: "string" },
        groupBy: { type: "array", items: { type: "string" }, description: "分组字段列表" },
        metrics: {
          type: "array",
          items: {
            type: "object",
            required: ["field", "op"],
            properties: {
              field: { type: "string" },
              op: {
                type: "string",
                enum: ["count", "sum", "avg", "min", "max", "count_distinct", "median", "stddev"],
              },
              as: { type: "string" },
            },
          },
        },
        description: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      ctx?.progress?.({ phase: "computing", message: `分组聚合 · ${(args.groupBy as any[]).length} 维` });
      const resp = await apiRequest<{ meta: any; preview: any }>(
        "/api/analyst/group-aggregate",
        { method: "POST", body: args, ...fwd(ctx) },
      );
      return toolResult(resp, { _resultHandle: resp.meta.handle });
    },
  },

  {
    name: "pivot_result",
    description:
      "对一个 handle 做透视（PIVOT）。rows 是行维度，columns 是列维度（列值变成新列名），values 是聚合值。" +
      "典型用法：按产品 × 地区看销售额（rows=['产品'], columns=['地区'], values=[{field:'销售额', op:'sum'}]）。",
    inputSchema: {
      type: "object",
      required: ["handle", "rows", "columns", "values"],
      properties: {
        handle: { type: "string" },
        rows: { type: "array", items: { type: "string" } },
        columns: { type: "array", items: { type: "string" } },
        values: {
          type: "array",
          items: {
            type: "object",
            required: ["field"],
            properties: {
              field: { type: "string" },
              op: { type: "string", enum: ["sum", "count", "avg", "min", "max"] },
            },
          },
        },
        description: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      ctx?.progress?.({ phase: "computing", message: `构建透视` });
      const resp = await apiRequest<{ meta: any; preview: any }>(
        "/api/analyst/pivot",
        { method: "POST", body: args, ...fwd(ctx) },
      );
      return toolResult(resp, { _resultHandle: resp.meta.handle });
    },
  },

  {
    name: "join_results",
    description:
      "按 equi-join 条件连接两个 handle。on 指定左右字段对。type 默认 inner。" +
      "跨表分析时先各自 load_workspace_table → 再 join_results。",
    inputSchema: {
      type: "object",
      required: ["leftHandle", "rightHandle", "on"],
      properties: {
        leftHandle: { type: "string" },
        rightHandle: { type: "string" },
        on: {
          type: "array",
          items: {
            type: "object",
            required: ["left", "right"],
            properties: {
              left: { type: "string" },
              right: { type: "string" },
            },
          },
        },
        type: { type: "string", enum: ["inner", "left", "right", "full"] },
        description: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      ctx?.progress?.({ phase: "computing", message: `连接两个结果` });
      const resp = await apiRequest<{ meta: any; preview: any }>(
        "/api/analyst/join",
        { method: "POST", body: args, ...fwd(ctx) },
      );
      return toolResult(resp, { _resultHandle: resp.meta.handle });
    },
  },

  {
    name: "time_bucket",
    description:
      "按时间桶（day / week / month / quarter / year）聚合。date_trunc 内部完成。" +
      "`metrics` 数组同 group_aggregate；`groupBy` 附加维度（可选）。适合看月度 / 周度趋势。",
    inputSchema: {
      type: "object",
      required: ["handle", "dateField", "granularity", "metrics"],
      properties: {
        handle: { type: "string" },
        dateField: { type: "string" },
        granularity: { type: "string", enum: ["day", "week", "month", "quarter", "year"] },
        metrics: {
          type: "array",
          items: {
            type: "object",
            required: ["field", "op"],
            properties: {
              field: { type: "string" },
              op: { type: "string", enum: ["count", "sum", "avg", "min", "max"] },
              as: { type: "string" },
            },
          },
        },
        groupBy: { type: "array", items: { type: "string" } },
        description: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      ctx?.progress?.({
        phase: "computing",
        message: `按 ${args.granularity} 分桶`,
      });
      const resp = await apiRequest<{ meta: any; preview: any }>(
        "/api/analyst/time-bucket",
        { method: "POST", body: args, ...fwd(ctx) },
      );
      return toolResult(resp, { _resultHandle: resp.meta.handle });
    },
  },

  {
    name: "top_n",
    description:
      "取 top N 行（按 orderBy 排序）。orderBy 可多字段，direction 默认 desc。" +
      "适合「销冠」「最贵的 10 单」这类问题。",
    inputSchema: {
      type: "object",
      required: ["handle", "orderBy", "n"],
      properties: {
        handle: { type: "string" },
        orderBy: {
          type: "array",
          items: {
            type: "object",
            required: ["field"],
            properties: {
              field: { type: "string" },
              direction: { type: "string", enum: ["asc", "desc"] },
            },
          },
        },
        n: { type: "number", description: "最多 10000" },
        description: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      const resp = await apiRequest<{ meta: any; preview: any }>(
        "/api/analyst/top-n",
        { method: "POST", body: args, ...fwd(ctx) },
      );
      return toolResult(resp, { _resultHandle: resp.meta.handle });
    },
  },

  {
    name: "generate_chart",
    description:
      "为一个 handle 的数据生成 vega-lite 图表 spec。" +
      "chartType: bar / line / pie / area / scatter；x 是横轴字段，y 是纵轴字段，series 是分组系列字段。" +
      "aggregate 可选（sum / count / avg / min / max）会在 y 轴做聚合。" +
      "返回 { _chartSpec }——把这个 spec 以 ```vega-lite``` 代码块嵌入回复或 Idea 即可在前端渲染。",
    inputSchema: {
      type: "object",
      required: ["handle", "chartType"],
      properties: {
        handle: { type: "string" },
        chartType: { type: "string", enum: ["bar", "line", "pie", "area", "scatter"] },
        x: { type: "string", description: "x 轴字段名" },
        y: { type: "string", description: "y 轴字段名（数值）" },
        series: { type: "string", description: "可选：分组系列字段（多系列折线/柱状图）" },
        title: { type: "string" },
        aggregate: { type: "string", enum: ["sum", "count", "avg", "min", "max"] },
      },
    },
    handler: async (args, ctx) => {
      ctx?.progress?.({ phase: "computing", message: `生成 ${args.chartType} 图表` });
      const resp = await apiRequest<any>("/api/analyst/generate-chart", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(resp);
    },
  },

  {
    name: "propose_field_descriptions",
    description:
      "为指定数据表的每个字段提出 description 建议（基于字段名 + 样本值的启发式匹配）。" +
      "返回 proposals 数组，每项含 fieldId / fieldName / fieldType / existing / proposed / sampleValues。" +
      "用户可据此决定是否将 proposed 写回字段。该工具本身**不写入任何数据**，仅给建议。",
    inputSchema: {
      type: "object",
      required: ["tableId"],
      properties: {
        tableId: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      const resp = await apiRequest<any>("/api/analyst/propose-field-descriptions", {
        method: "POST",
        body: args,
        ...fwd(ctx),
      });
      return toolResult(resp);
    },
  },

  {
    name: "run_sql",
    description:
      "**兜底工具**：当上面的专用工具组合表达不了需要的分析时，直接写一条 DuckDB SQL。" +
      "只允许 SELECT / WITH / CREATE TABLE AS；DROP/DELETE/INSERT/UPDATE/ATTACH 会被拒。" +
      "**表名规则**：FROM 后面**必须用 `r_xxxxxxxxxxxx`**（来自 Turn Context 里每个 handle 旁边标注的 SQL 表名），" +
      "或原始快照视图 `src_<tableId>`。即便你写成 `ducktbl_xxx` 后端会自动翻译，但写对省重试。" +
      "⚠️ 优先使用专用工具（group_aggregate / pivot_result / time_bucket 等）；只在无法拼出时才动 run_sql。",
    inputSchema: {
      type: "object",
      required: ["sql"],
      properties: {
        sql: { type: "string", description: "DuckDB SQL 单语句，末尾分号可省" },
        description: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      ctx?.progress?.({ phase: "computing", message: `执行 SQL` });
      const resp = await apiRequest<{ meta: any; preview: any }>(
        "/api/analyst/run-sql",
        { method: "POST", body: args, ...fwd(ctx) },
      );
      return toolResult(resp, { _resultHandle: resp.meta.handle });
    },
  },
];
