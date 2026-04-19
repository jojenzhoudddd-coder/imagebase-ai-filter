import { Field, FieldConfig, FieldType, TableRecord, View, ViewFilter } from "./types";

const BASE = "/api";

export const CLIENT_ID =
  crypto.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function mutationFetch(url: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("X-Client-Id", CLIENT_ID);
  return fetch(url, { ...options, headers });
}

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

export interface UpdateFieldDTO {
  name?: string;
  type?: FieldType;
  config?: FieldConfig;
}

export async function updateField(tableId: string, fieldId: string, dto: UpdateFieldDTO): Promise<Field> {
  const res = await mutationFetch(`${BASE}/tables/${tableId}/fields/${fieldId}`, {
    method: "PUT",
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

export async function fetchDocument(
  docId: string
): Promise<{ id: string; name: string }> {
  const res = await fetch(`${BASE}/documents/${docId}`);
  if (!res.ok) throw new Error("Failed to fetch document");
  return res.json();
}

export async function renameDocument(
  docId: string,
  name: string
): Promise<{ id: string; name: string }> {
  const res = await mutationFetch(`${BASE}/documents/${docId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to rename document");
  }
  return res.json();
}

export async function fetchDocumentTables(
  docId: string
): Promise<Array<{ id: string; name: string; order: number }>> {
  const res = await fetch(`${BASE}/documents/${docId}/tables`);
  return res.json();
}

export async function createTable(
  name: string,
  documentId: string,
  language: "en" | "zh"
): Promise<{ id: string; name: string; order: number }> {
  const res = await mutationFetch(`${BASE}/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, documentId, language }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to create table");
  }
  return res.json();
}

export async function reorderTables(
  updates: Array<{ id: string; order: number }>,
  documentId: string
): Promise<void> {
  const res = await mutationFetch(`${BASE}/tables/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates, documentId }),
  });
  if (!res.ok) throw new Error("Failed to reorder tables");
}

export async function deleteTable(tableId: string): Promise<void> {
  const res = await mutationFetch(`${BASE}/tables/${tableId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to delete table");
  }
}

export async function renameTable(
  tableId: string,
  name: string
): Promise<{ id: string; name: string }> {
  const res = await mutationFetch(`${BASE}/tables/${tableId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to rename table");
  }
  return res.json();
}

export async function updateView(
  viewId: string,
  data: { fieldOrder?: string[]; hiddenFields?: string[]; name?: string }
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

// ─── Document Tree (folders + designs) ───

export interface FolderBrief {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
}

export interface TreeData {
  tables: Array<{ id: string; name: string; order: number; parentId: string | null }>;
  folders: FolderBrief[];
  designs: DesignBrief[];
}

export async function fetchDocumentTree(docId: string): Promise<TreeData> {
  const res = await fetch(`${BASE}/documents/${docId}/tree`);
  if (!res.ok) {
    // Fallback: return tables-only if endpoint doesn't exist yet
    const tables = await fetchDocumentTables(docId);
    return { tables: tables.map(t => ({ ...t, parentId: null })), folders: [], designs: [] };
  }
  return res.json();
}

export async function createFolder(
  documentId: string,
  name: string,
  parentId: string | null = null
): Promise<FolderBrief> {
  const res = await mutationFetch(`${BASE}/documents/${documentId}/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parentId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to create folder");
  }
  return res.json();
}

export async function renameFolder(folderId: string, name: string): Promise<{ id: string; name: string }> {
  const res = await mutationFetch(`${BASE}/folders/${folderId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Failed to rename folder");
  return res.json();
}

export async function deleteFolder(folderId: string): Promise<void> {
  const res = await mutationFetch(`${BASE}/folders/${folderId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete folder");
}

export async function moveItem(
  itemId: string,
  itemType: "table" | "folder" | "design",
  newParentId: string | null,
  documentId: string
): Promise<void> {
  const res = await mutationFetch(`${BASE}/documents/${documentId}/move`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemId, itemType, newParentId }),
  });
  if (!res.ok) throw new Error("Failed to move item");
}

// ─── Designs ───

export interface DesignBrief {
  id: string;
  name: string;
  figmaUrl: string;
  parentId: string | null;
  order: number;
}

export interface DesignDetail extends DesignBrief {
  figmaFileKey?: string;
  figmaNodeId?: string;
  thumbnailUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export async function createDesign(
  documentId: string,
  name: string,
  figmaUrl: string,
  parentId: string | null = null
): Promise<DesignBrief> {
  const res = await mutationFetch(`${BASE}/documents/${documentId}/designs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, figmaUrl, parentId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to create design");
  }
  return res.json();
}

export async function fetchDesign(designId: string): Promise<DesignDetail> {
  const res = await fetch(`${BASE}/designs/${designId}`);
  if (!res.ok) throw new Error("Failed to fetch design");
  return res.json();
}

export async function renameDesign(designId: string, name: string): Promise<{ id: string; name: string }> {
  const res = await mutationFetch(`${BASE}/designs/${designId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Failed to rename design");
  return res.json();
}

export async function deleteDesign(designId: string): Promise<void> {
  const res = await mutationFetch(`${BASE}/designs/${designId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete design");
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
  opts?: { title?: string; excludeNames?: string[]; forceRefresh?: boolean },
  signal?: AbortSignal,
): Promise<SuggestFieldsResponse> {
  const res = await fetch(`${BASE}/ai/fields/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableId, title: opts?.title, excludeNames: opts?.excludeNames, forceRefresh: opts?.forceRefresh }),
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

// ─── AI Table Structure Generation ───

export interface GeneratedField {
  name: string;
  type: string;
  isPrimary?: boolean;
  config?: Record<string, any>;
}

export interface GenerateTableOptions {
  tableName: string;
  onFields?: (fields: GeneratedField[]) => void;
  onError?: (code: string, message: string) => void;
  onDone?: () => void;
}

export function generateTableStructure(opts: GenerateTableOptions): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BASE}/ai/table/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tableName: opts.tableName }),
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
            if (currentEvent === "fields") opts.onFields?.(data.fields);
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

export async function resetTable(
  tableId: string,
  fields: GeneratedField[],
  language: "en" | "zh",
): Promise<{ fields: Field[]; records: TableRecord[]; views: View[] }> {
  const res = await mutationFetch(`${BASE}/tables/${tableId}/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields, language }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to reset table");
  }
  return res.json();
}

// ═══════════════════════════════════════════════════════════════════════
// Chat Agent (Table Agent)
// ═══════════════════════════════════════════════════════════════════════

export interface ChatToolCall {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  status?: "running" | "success" | "error" | "awaiting_confirmation";
  error?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  toolCalls?: ChatToolCall[];
  toolResult?: unknown;
  timestamp: number;
}

export interface ChatConversation {
  id: string;
  documentId: string;
  title: string;
  summary?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export async function listConversations(documentId: string): Promise<ChatConversation[]> {
  const res = await fetch(`${BASE}/chat/conversations?documentId=${encodeURIComponent(documentId)}`);
  if (!res.ok) throw new Error("Failed to list conversations");
  return res.json();
}

export async function createConversation(documentId: string): Promise<ChatConversation> {
  const res = await mutationFetch(`${BASE}/chat/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId }),
  });
  if (!res.ok) throw new Error("Failed to create conversation");
  return res.json();
}

export async function getConversationMessages(
  conversationId: string
): Promise<{ conversation: ChatConversation; messages: ChatMessage[] }> {
  const res = await fetch(`${BASE}/chat/conversations/${encodeURIComponent(conversationId)}/messages`);
  if (!res.ok) throw new Error("Failed to load messages");
  return res.json();
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const res = await mutationFetch(`${BASE}/chat/conversations/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete conversation");
}

export interface PendingConfirm {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  prompt: string;
}

export interface StreamChatOptions {
  conversationId: string;
  message: string;
  onStart?: (messageId: string) => void;
  onThinking?: (delta: string) => void;
  onMessage?: (delta: string) => void;
  onToolStart?: (call: ChatToolCall) => void;
  onToolResult?: (callId: string, success: boolean, result: unknown) => void;
  onConfirm?: (pending: PendingConfirm) => void;
  onError?: (code: string, message: string) => void;
  onDone?: () => void;
}

/**
 * Generic SSE reader that parses `event:`/`data:` line pairs and dispatches
 * callbacks. Shared between streamChatMessage() and sendChatConfirmation().
 */
async function readChatSseStream(
  res: Response,
  handlers: Omit<StreamChatOptions, "conversationId" | "message">
) {
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
        let data: any;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        switch (currentEvent) {
          case "start":
            handlers.onStart?.(data.messageId);
            break;
          case "thinking":
            handlers.onThinking?.(data.text || "");
            break;
          case "message":
            handlers.onMessage?.(data.text || "");
            break;
          case "tool_start":
            handlers.onToolStart?.({
              callId: data.callId,
              tool: data.tool,
              args: data.args || {},
              status: "running",
            });
            break;
          case "tool_result":
            handlers.onToolResult?.(data.callId, Boolean(data.success), data.result);
            break;
          case "confirm":
            handlers.onConfirm?.({
              callId: data.callId,
              tool: data.tool,
              args: data.args || {},
              prompt: data.prompt || "",
            });
            break;
          case "error":
            handlers.onError?.(data.code || "UNKNOWN", data.message || "");
            break;
          case "done":
            handlers.onDone?.();
            break;
        }
      }
    }
  }
}

/** Send a user message; stream agent response events back. Returns an abort fn. */
export function streamChatMessage(opts: StreamChatOptions): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await mutationFetch(`${BASE}/chat/conversations/${encodeURIComponent(opts.conversationId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: opts.message }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        opts.onError?.("HTTP_ERROR", (err as any).error || `HTTP ${res.status}`);
        opts.onDone?.();
        return;
      }
      await readChatSseStream(res, opts);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        opts.onError?.("NETWORK_ERROR", "网络请求失败，请检查后端服务");
      }
    }
    opts.onDone?.();
  })();

  return () => controller.abort();
}

export interface SendConfirmOptions extends Omit<StreamChatOptions, "message"> {
  callId: string;
  confirmed: boolean;
}

/** User confirmed (or cancelled) a danger tool — resume the agent stream. */
export function sendChatConfirmation(opts: SendConfirmOptions): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await mutationFetch(`${BASE}/chat/conversations/${encodeURIComponent(opts.conversationId)}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId: opts.callId, confirmed: opts.confirmed }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        opts.onError?.("HTTP_ERROR", (err as any).error || `HTTP ${res.status}`);
        opts.onDone?.();
        return;
      }
      await readChatSseStream(res, opts);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        opts.onError?.("NETWORK_ERROR", "网络请求失败");
      }
    }
    opts.onDone?.();
  })();

  return () => controller.abort();
}

/** Abort an in-progress agent turn on the server side. */
export async function stopChatTurn(conversationId: string): Promise<void> {
  await mutationFetch(`${BASE}/chat/conversations/${encodeURIComponent(conversationId)}/stop`, {
    method: "POST",
  });
}
