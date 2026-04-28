/**
 * Web search provider abstraction.
 *
 * Default implementation is Tavily (AI-friendly, returns structured results
 * with summary). Other providers (Serper / Brave / Bocha) can be added by
 * implementing this interface.
 */

export interface WebSearchOptions {
  /** Number of results to return. Default 5, max 10. */
  count?: number;
  /** Time range filter. "all" means no filter. */
  timeRange?: "day" | "week" | "month" | "year" | "all";
}

export interface WebSearchResult {
  title: string;
  url: string;
  /** Short snippet/summary; provider-dependent. */
  snippet: string;
  /** Optional: when published (ISO string), if provider returns it. */
  publishedAt?: string;
}

export interface WebSearchProvider {
  /** Provider id, e.g. "tavily" / "serper" — for telemetry. */
  readonly id: string;
  search(query: string, opts?: WebSearchOptions): Promise<WebSearchResult[]>;
}
