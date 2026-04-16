import { Field, FieldConfig, FieldType, TableRecord, View, ViewFilter } from "./types";

const BASE = "/api";

export interface TableBrief {
  id: string;
  name: string;
  fieldCount: number;
  recordCount: number;
}

export async function fetchTables(): Promise<TableBrief[]> {
  const res = await fetch(`${BASE}/tables`);
  return res.json();
}

export async function fetchFields(tableId: string): Promise<Field[]> {
  const res = await fetch(`${BASE}/tables/${tableId}/fields`);
  return res.json();
}

export async function fetchRecords(tableId: string): Promise<TableRecord[]> {
  const res = await fetch(`${BASE}/tables/${tableId}/records`);
  return res.json();
}

export interface CreateFieldDTO {
  name: string;
  type: FieldType;
  config?: FieldConfig;
}

export interface ApiError extends Error {
  code?: string;
  path?: string;
}

export async function createField(tableId: string, dto: CreateFieldDTO): Promise<Field> {
  const res = await fetch(`${BASE}/tables/${tableId}/fields`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dto),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || body.error || `HTTP ${res.status}`) as ApiError;
    err.code = body.error;
    err.path = body.path;
    throw err;
  }
  return res.json();
}

export async function queryRecords(
  tableId: string,
  filter: ViewFilter
): Promise<{ records: TableRecord[]; total: number }> {
  const res = await fetch(`${BASE}/tables/${tableId}/records/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filter }),
  });
  return res.json();
}

export async function fetchViews(tableId: string): Promise<View[]> {
  const res = await fetch(`${BASE}/tables/${tableId}/views`);
  return res.json();
}

export async function deleteField(
  tableId: string,
  fieldId: string
): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/tables/${tableId}/fields/${fieldId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to delete field");
  }
  return res.json();
}

export async function updateViewFilter(
  viewId: string,
  filter: ViewFilter
): Promise<View> {
  const res = await fetch(`${BASE}/tables/views/${viewId}/filter`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(filter),
  });
  return res.json();
}

// ─── AI Field Suggestions ───

export interface FieldSuggestion {
  name: string;
  type: string;
}

export interface SuggestFieldsResponse {
  suggestions: FieldSuggestion[];
  hasMore: boolean;
}

export async function suggestFields(
  tableId: string,
  opts?: { title?: string; excludeNames?: string[] },
  signal?: AbortSignal,
): Promise<SuggestFieldsResponse> {
  const res = await fetch(`${BASE}/ai/fields/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableId, title: opts?.title, excludeNames: opts?.excludeNames }),
    signal,
  });
  if (!res.ok) return { suggestions: [], hasMore: false };
  return res.json();
}

export interface AIGenerateOptions {
  tableId: string;
  query: string;
  existingFilter?: ViewFilter;
  onThinking?: (text: string) => void;
  onResult?: (filter: ViewFilter) => void;
  onError?: (code: string, message: string) => void;
  onDone?: () => void;
}

export function generateFilter(opts: AIGenerateOptions): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BASE}/ai/filter/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableId: opts.tableId,
          query: opts.query,
          existingFilter: opts.existingFilter,
        }),
        signal: controller.signal,
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (currentEvent === "thinking") opts.onThinking?.(data.text);
            if (currentEvent === "result") opts.onResult?.(data.filter);
            if (currentEvent === "error") opts.onError?.(data.code, data.message);
            if (currentEvent === "done") opts.onDone?.();
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        opts.onError?.("NETWORK_ERROR", "网络请求失败，请检查后端服务");
      }
    }
    opts.onDone?.();
  })();

  return () => controller.abort();
}
