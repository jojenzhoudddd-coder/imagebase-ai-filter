import { Field, TableRecord, View, ViewFilter } from "./types";

const BASE = "/api";

export const CLIENT_ID =
  crypto.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function mutationFetch(url: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("X-Client-Id", CLIENT_ID);
  return fetch(url, { ...options, headers });
}

export async function fetchFields(tableId: string): Promise<Field[]> {
  const res = await fetch(`${BASE}/tables/${tableId}/fields`);
  return res.json();
}

export async function fetchRecords(tableId: string): Promise<TableRecord[]> {
  const res = await fetch(`${BASE}/tables/${tableId}/records`);
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
  const res = await mutationFetch(`${BASE}/tables/${tableId}/fields/${fieldId}`, {
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
  const res = await mutationFetch(`${BASE}/tables/views/${viewId}/filter`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(filter),
  });
  return res.json();
}

export async function updateView(
  viewId: string,
  data: { fieldOrder?: string[]; hiddenFields?: string[] }
): Promise<View> {
  const res = await mutationFetch(`${BASE}/tables/views/${viewId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function batchDeleteFields(
  tableId: string,
  fieldIds: string[]
): Promise<{ deleted: number; snapshot: any }> {
  const res = await mutationFetch(`${BASE}/tables/${tableId}/fields/batch-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fieldIds }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to delete fields");
  }
  return res.json();
}

export async function batchRestoreFields(
  tableId: string,
  snapshot: any
): Promise<{ ok: boolean }> {
  const res = await mutationFetch(`${BASE}/tables/${tableId}/fields/batch-restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snapshot }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to restore fields");
  }
  return res.json();
}

export async function updateRecord(
  tableId: string,
  recordId: string,
  cells: Record<string, any>
): Promise<TableRecord> {
  const res = await mutationFetch(`${BASE}/tables/${tableId}/records/${recordId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cells }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || `Failed to update record ${recordId}`);
  }
  return res.json();
}

export async function deleteRecords(
  tableId: string,
  recordIds: string[]
): Promise<{ deleted: number }> {
  const res = await mutationFetch(`${BASE}/tables/${tableId}/records/batch-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recordIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to delete records");
  }
  return res.json();
}

export async function batchCreateRecords(
  tableId: string,
  records: { id: string; cells: Record<string, any>; createdAt: number; updatedAt: number }[]
): Promise<{ created: number }> {
  const res = await mutationFetch(`${BASE}/tables/${tableId}/records/batch-create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ records }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to restore records");
  }
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
