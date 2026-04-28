/**
 * Tavily adapter — https://docs.tavily.com/docs/rest-api/api-reference
 *
 * Tavily 是为 LLM agent 设计的搜索 API,返回 title/url/content(结构化摘要)。
 * basic 模式 $0.005/搜,免费层 1000/月。我们用 basic + max_results=count。
 */

import type { WebSearchOptions, WebSearchProvider, WebSearchResult } from "./types.js";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

interface TavilyApiResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  published_date?: string;
}

interface TavilyApiResponse {
  answer?: string;
  query: string;
  results: TavilyApiResult[];
}

export const tavilyAdapter: WebSearchProvider = {
  id: "tavily",

  async search(query: string, opts: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error("TAVILY_API_KEY 未配置");
    }
    const count = Math.max(1, Math.min(opts.count ?? 5, 10));
    const tr = opts.timeRange && opts.timeRange !== "all" ? opts.timeRange : null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);  // 15s 超时
    try {
      const res = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: count,
          search_depth: "basic",          // basic 比 advanced 便宜 5x,质量足够
          include_answer: false,
          include_raw_content: false,
          time_range: tr,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Tavily ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = (await res.json()) as TavilyApiResponse;
      const results = Array.isArray(data.results) ? data.results : [];
      return results.map((r) => ({
        title: r.title || r.url,
        url: r.url,
        snippet: (r.content || "").slice(0, 500),
        publishedAt: r.published_date,
      }));
    } finally {
      clearTimeout(timer);
    }
  },
};
