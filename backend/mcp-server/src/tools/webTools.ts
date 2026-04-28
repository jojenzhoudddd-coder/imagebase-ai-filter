/**
 * Web search + web fetch tools (Tier 1 · always-on).
 *
 * 两个工具:
 *   - `web_search(query, count?, timeRange?)` 通过 Tavily 查全网,返回 5-10 个
 *     结构化结果(title/url/snippet)。适合需要最新信息 / 不确定知识 / 用户
 *     明确要求查询的场景。
 *   - `web_fetch(url)` 拉一个具体网页,Readability 抽正文 + 转 Markdown 返回。
 *     适合用户给了 URL,或 web_search 结果中要深读某条时。
 *
 * 触发 Agent 调用的 system prompt 引导(写在 description 里):
 *   - 知识截止后的事实 / 最新动态 → 优先 web_search
 *   - 用户给具体 URL → web_fetch
 *   - 答完一定列**引用源 URL**,提升可信度
 *
 * Defenses 在 service 层完成 (SSRF / 5MB cap / 10s timeout / markdown 50KB cap)。
 */

import { searchWeb } from "../../../src/services/webSearch/index.js";
import { fetchAndExtract } from "../../../src/services/webFetchService.js";
import type { ToolDefinition } from "./tableTools.js";

export const webTools: ToolDefinition[] = [
  {
    name: "web_search",
    description:
      "用搜索引擎查全网,返回 5-10 条结构化结果 (title / url / snippet)。" +
      "适合需要最新信息(发布日期之后的事)、不确定知识、用户明确要求'查/搜/最新/调研'时。" +
      "查询完一定要列出引用源 URL,**不要凭空编造**。" +
      "支持时间范围过滤 (day/week/month/year),涉及'最近 X 天/上周'类问题时主动加。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索查询。中英文都支持。具体且简洁,如 'React 19 RC 发布'、'OpenAI o3 benchmarks'。",
        },
        count: {
          type: "number",
          description: "返回结果数 (1-10),默认 5。复杂主题可给 8-10 多看几个来源。",
        },
        timeRange: {
          type: "string",
          enum: ["day", "week", "month", "year", "all"],
          description: "时间过滤。'最近一周'类问题填 week,默认 all 不过滤。",
        },
      },
      required: ["query"],
    },
    handler: async (args): Promise<string> => {
      try {
        const query = String(args.query ?? "").trim();
        if (!query) return JSON.stringify({ error: "query is required" });
        const count = typeof args.count === "number" ? args.count : 5;
        const timeRange = (typeof args.timeRange === "string" ? args.timeRange : "all") as
          | "day" | "week" | "month" | "year" | "all";
        const results = await searchWeb(query, { count, timeRange });
        return JSON.stringify({
          query,
          provider: "tavily",
          count: results.length,
          results,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `web_search failed: ${msg}` });
      }
    },
  },
  {
    name: "web_fetch",
    description:
      "下载并读取一个网页的正文。返回 Markdown 格式的标题 + 正文(带截断,最多 50KB)。" +
      "适合用户给了具体 URL 要你读、或 web_search 返回的某条结果需要深读时。" +
      "**只能 http(s) URL,自动拒绝内网 / localhost**。10 秒超时,5MB 内容上限。" +
      "拿到内容后引用时一定标注 source URL。",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要读的网页 URL,必须是 http:// 或 https:// 开头。",
        },
      },
      required: ["url"],
    },
    handler: async (args): Promise<string> => {
      try {
        const url = String(args.url ?? "").trim();
        if (!url) return JSON.stringify({ error: "url is required" });
        const r = await fetchAndExtract(url);
        return JSON.stringify(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `web_fetch failed: ${msg}` });
      }
    },
  },
];
