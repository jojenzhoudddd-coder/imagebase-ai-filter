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

export async function fetchWorkspace(
  workspaceId: string
): Promise<{ id: string; name: string }> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}`);
  if (!res.ok) throw new Error("Failed to fetch workspace");
  return res.json();
}

export async function renameWorkspace(
  workspaceId: string,
  name: string
): Promise<{ id: string; name: string }> {
  const res = await mutationFetch(`${BASE}/workspaces/${workspaceId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to rename workspace");
  }
  return res.json();
}

export async function fetchWorkspaceTables(
  workspaceId: string
): Promise<Array<{ id: string; name: string; order: number }>> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/tables`);
  return res.json();
}

export async function createTable(
  name: string,
  workspaceId: string,
  language: "en" | "zh"
): Promise<{ id: string; name: string; order: number }> {
  const res = await mutationFetch(`${BASE}/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, workspaceId, language }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to create table");
  }
  return res.json();
}

export async function reorderTables(
  updates: Array<{ id: string; order: number }>,
  workspaceId: string
): Promise<void> {
  const res = await mutationFetch(`${BASE}/tables/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates, workspaceId }),
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

export async function createRecord(
  tableId: string,
  cells: Record<string, any>
): Promise<TableRecord> {
  const res = await mutationFetch(`${BASE}/tables/${tableId}/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cells }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || `Failed to create record`);
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

// ─── Workspace Tree (folders + designs) ───

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

export async function fetchWorkspaceTree(workspaceId: string): Promise<TreeData> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/tree`);
  if (!res.ok) {
    // Fallback: return tables-only if endpoint doesn't exist yet
    const tables = await fetchWorkspaceTables(workspaceId);
    return { tables: tables.map(t => ({ ...t, parentId: null })), folders: [], designs: [] };
  }
  return res.json();
}

export async function createFolder(
  name: string,
  workspaceId: string,
  parentId?: string | null
): Promise<FolderBrief> {
  const res = await mutationFetch(`${BASE}/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, workspaceId, parentId: parentId || null }),
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
  newParentId: string | null
): Promise<void> {
  const res = await mutationFetch(`${BASE}/folders/move`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemId, itemType, newParentId }),
  });
  if (!res.ok) throw new Error("Failed to move item");
}

export async function reorderFolders(
  updates: Array<{ id: string; order: number }>,
  workspaceId: string
): Promise<void> {
  const res = await mutationFetch(`${BASE}/folders/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates, workspaceId }),
  });
  if (!res.ok) throw new Error("Failed to reorder folders");
}

export async function reorderDesigns(
  updates: Array<{ id: string; order: number }>,
  workspaceId: string
): Promise<void> {
  const res = await mutationFetch(`${BASE}/designs/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates, workspaceId }),
  });
  if (!res.ok) throw new Error("Failed to reorder designs");
}

// ─── Designs ───

export interface DesignBrief {
  id: string;
  name: string;
  figmaUrl: string;
  parentId: string | null;
  order: number;
}

export interface TasteBrief {
  id: string;
  designId: string;
  name: string;
  fileName: string;
  filePath: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  order: number;
  source: "upload" | "figma";
  figmaUrl: string | null;
}

export interface DesignDetail extends DesignBrief {
  figmaFileKey?: string;
  figmaNodeId?: string;
  thumbnailUrl?: string;
  tastes?: TasteBrief[];
  createdAt: number;
  updatedAt: number;
}

export async function createDesign(
  name: string,
  figmaUrl: string,
  workspaceId: string,
  parentId?: string | null
): Promise<DesignDetail> {
  const res = await mutationFetch(`${BASE}/designs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, figmaUrl, workspaceId, parentId: parentId || null }),
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

// ─── Tastes (SVG artifacts within a Design canvas) ───

export async function fetchTastes(designId: string): Promise<TasteBrief[]> {
  const res = await fetch(`${BASE}/designs/${designId}/tastes`);
  if (!res.ok) throw new Error("Failed to fetch tastes");
  return res.json();
}

export async function uploadTastes(designId: string, files: File[]): Promise<TasteBrief[]> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const res = await mutationFetch(`${BASE}/designs/${designId}/tastes/upload`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw new Error("Failed to upload SVG files");
  return res.json();
}

export async function importFigmaSvg(designId: string, figmaUrl: string): Promise<TasteBrief> {
  const res = await mutationFetch(`${BASE}/designs/${designId}/tastes/from-figma`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ figmaUrl }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to import from Figma");
  }
  return res.json();
}

export async function updateTaste(
  designId: string,
  tasteId: string,
  data: Partial<Pick<TasteBrief, "x" | "y" | "width" | "height" | "name">>,
): Promise<TasteBrief> {
  const res = await mutationFetch(`${BASE}/designs/${designId}/tastes/${tasteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update taste");
  return res.json();
}

export async function batchUpdateTastes(
  designId: string,
  updates: Array<{ id: string; x: number; y: number }>,
): Promise<void> {
  const res = await mutationFetch(`${BASE}/designs/${designId}/tastes/batch-update`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  if (!res.ok) throw new Error("Failed to batch update tastes");
}

export async function deleteTaste(designId: string, tasteId: string): Promise<void> {
  const res = await mutationFetch(`${BASE}/designs/${designId}/tastes/${tasteId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete taste");
}

export async function fetchTasteSource(designId: string, tasteId: string): Promise<string> {
  const res = await fetch(`${BASE}/designs/${designId}/tastes/${tasteId}/source`);
  if (!res.ok) throw new Error("Failed to fetch taste source");
  return res.text();
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
  workspaceId: string;
  title: string;
  summary?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export async function listConversations(workspaceId: string): Promise<ChatConversation[]> {
  const res = await fetch(`${BASE}/chat/conversations?workspaceId=${encodeURIComponent(workspaceId)}`);
  if (!res.ok) throw new Error("Failed to list conversations");
  return res.json();
}

export interface ChatContextSnapshot {
  workspaceId: string;
  tableCount: number;
  fieldCount: number;
  recordCount: number;
}

/** Warm-up endpoint used by the chat sidebar's refresh / new-conversation
 * flow to show "已加载 N 张表、M 个字段" as an affordance before the user's
 * first prompt. The Agent still rebuilds its own Workspace Snapshot on each
 * request — this is purely a UX hint. */
export async function fetchChatContextSnapshot(workspaceId: string): Promise<ChatContextSnapshot> {
  const res = await fetch(`${BASE}/chat/context-snapshot?workspaceId=${encodeURIComponent(workspaceId)}`);
  if (!res.ok) throw new Error("Failed to fetch context snapshot");
  return res.json();
}

export interface ChatSuggestion {
  label: string;
  prompt: string;
}

export interface ChatSuggestionResponse {
  workspaceId: string;
  suggestions: ChatSuggestion[];
  updatedAt: number;
  stale: boolean;
}

/** Fetch AI-generated prompt suggestions for the chat welcome page.
 * Backend runs a scheduled refresh every 10 min; this call returns the
 * cached pack (stale=false) or a default pack (stale=true) on cache miss. */
export async function fetchChatSuggestions(workspaceId: string): Promise<ChatSuggestionResponse> {
  const res = await fetch(`${BASE}/chat/suggestions?workspaceId=${encodeURIComponent(workspaceId)}`);
  if (!res.ok) throw new Error("Failed to fetch chat suggestions");
  return res.json();
}

export async function createConversation(workspaceId: string): Promise<ChatConversation> {
  const res = await mutationFetch(`${BASE}/chat/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
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
