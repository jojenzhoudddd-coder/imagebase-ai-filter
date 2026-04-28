/**
 * Web search facade —— 默认走 Tavily,可通过 WEB_SEARCH_PROVIDER env 切换。
 */

import type { WebSearchOptions, WebSearchProvider, WebSearchResult } from "./types.js";
import { tavilyAdapter } from "./tavilyAdapter.js";

function pickProvider(): WebSearchProvider {
  const id = (process.env.WEB_SEARCH_PROVIDER || "tavily").toLowerCase();
  switch (id) {
    case "tavily":
    default:
      return tavilyAdapter;
  }
}

const provider = pickProvider();

export async function searchWeb(query: string, opts?: WebSearchOptions): Promise<WebSearchResult[]> {
  return provider.search(query, opts);
}

export function getProviderId(): string {
  return provider.id;
}

export type { WebSearchOptions, WebSearchResult, WebSearchProvider };
