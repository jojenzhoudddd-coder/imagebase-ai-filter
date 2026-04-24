import { Field, FieldConfig, FieldType, TableRecord, View, ViewFilter } from "./types";
import type { IdeaBrief, IdeaDetail, MentionHit } from "./types";

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
  ideas: Array<{ id: string; name: string; order: number; parentId: string | null; workspaceId: string }>;
}

export async function fetchWorkspaceTree(workspaceId: string): Promise<TreeData> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/tree`);
  if (!res.ok) {
    // Fallback: return tables-only if endpoint doesn't exist yet
    const tables = await fetchWorkspaceTables(workspaceId);
    return { tables: tables.map(t => ({ ...t, parentId: null })), folders: [], designs: [], ideas: [] };
  }
  const data = await res.json();
  // Defensive default: backend may not yet include ideas in the response.
  if (!Array.isArray(data.ideas)) data.ideas = [];
  return data;
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
  itemType: "table" | "folder" | "design" | "idea" | "demo",
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

export async function createTasteFromSvg(
  designId: string,
  svg: string,
  name?: string,
): Promise<TasteBrief> {
  const res = await mutationFetch(`${BASE}/designs/${designId}/tastes/from-svg`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ svg, name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to create taste from SVG");
  }
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
  /** Latest progress payload reported by the tool during execution.
   * Analyst P1: tools can emit these for long-running analysis steps so the
   * UI can render a progress bar inside the tool card. */
  progress?: {
    phase?: string;
    message: string;
    progress?: number;
    current?: number;
    total?: number;
    elapsedMs: number;
  };
  /** Set when the tool has gone silent and the server is emitting heartbeats
   * to keep the connection alive. UI shows elapsed time. */
  heartbeat?: { elapsedMs: number };
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

export async function createConversation(
  workspaceId: string,
  agentId?: string
): Promise<ChatConversation> {
  const res = await mutationFetch(`${BASE}/chat/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, ...(agentId ? { agentId } : {}) }),
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

export interface IncomingMentionRef {
  sourceType: string;
  sourceId: string;
  sourceLabel: string;
  rawLabel: string;
  contextExcerpt: string | null;
  createdAt: string;
}

export interface PendingConfirm {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  prompt: string;
  /**
   * Populated by the backend when the danger tool has a target we know how
   * to reverse-index (today: delete_idea). The confirm card renders a
   * collapsible "referenced by" list so the user can see the blast radius
   * without an extra round trip. May be undefined if the agent pre-fetch
   * failed or the tool has no target mapping — callers should gracefully
   * handle the absence and can still fire `fetchIncomingMentions` on demand.
   */
  incomingRefs?: { refs: IncomingMentionRef[]; total: number };
}

/**
 * Fetch incoming references for a (targetType, targetId) pair. Used as a
 * fallback when the confirm event arrives without `incomingRefs` pre-loaded
 * (e.g. the user opens the delete menu themselves rather than asking the
 * agent), and by the frontend delete handlers in App.tsx.
 */
export async function fetchIncomingMentions(
  workspaceId: string,
  targetType: "view" | "taste" | "idea" | "idea-section",
  targetId: string,
  limit = 50
): Promise<{ refs: IncomingMentionRef[]; total: number }> {
  const params = new URLSearchParams({ workspaceId, targetType, targetId, limit: String(limit) });
  const res = await fetch(`${BASE}/mentions/reverse?${params.toString()}`);
  if (!res.ok) throw new Error(`reverse lookup failed: HTTP ${res.status}`);
  return res.json();
}

export interface ToolProgressEvent {
  callId: string;
  phase?: string;
  message: string;
  progress?: number;
  current?: number;
  total?: number;
  elapsedMs: number;
}

export interface ToolHeartbeatEvent {
  callId: string;
  elapsedMs: number;
}

export interface StreamChatOptions {
  conversationId: string;
  message: string;
  onStart?: (messageId: string) => void;
  onThinking?: (delta: string) => void;
  onMessage?: (delta: string) => void;
  onToolStart?: (call: ChatToolCall) => void;
  onToolProgress?: (ev: ToolProgressEvent) => void;
  onToolHeartbeat?: (ev: ToolHeartbeatEvent) => void;
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
          case "tool_progress":
            handlers.onToolProgress?.({
              callId: data.callId,
              phase: data.phase,
              message: data.message || "",
              progress: typeof data.progress === "number" ? data.progress : undefined,
              current: typeof data.current === "number" ? data.current : undefined,
              total: typeof data.total === "number" ? data.total : undefined,
              elapsedMs: typeof data.elapsedMs === "number" ? data.elapsedMs : 0,
            });
            break;
          case "tool_heartbeat":
            handlers.onToolHeartbeat?.({
              callId: data.callId,
              elapsedMs: typeof data.elapsedMs === "number" ? data.elapsedMs : 0,
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
              // Optional reverse-ref pre-load. Shape matches IncomingMentionRef[]
              // + total count; absence is fine — the confirm card tolerates it.
              incomingRefs: data.incomingRefs,
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

// ─── Agents (Phase 1) ──────────────────────────────────────────────
// Agent identity lives at ~/.imagebase/agents/<agentId>/ on the server.
// These wrappers let the UI read/edit soul.md + profile.md + config.json
// so the user can inspect and tweak what the chat Agent "knows about itself"
// and "knows about me". See docs/chatbot-openclaw-plan.md Phase 1.

export interface AgentMeta {
  id: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

export interface AgentConfig {
  language?: "zh" | "en";
  timezone?: string;
  allow_danger_without_confirm?: boolean;
  tool_allowlist?: string[] | null;
  tool_denylist?: string[] | null;
}

export interface AgentIdentity {
  soul: string;
  profile: string;
  config: AgentConfig;
}

export async function listAgents(): Promise<AgentMeta[]> {
  const res = await fetch(`${BASE}/agents`);
  if (!res.ok) throw new Error("Failed to list agents");
  return res.json();
}

export async function getAgent(agentId: string): Promise<AgentMeta> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(agentId)}`);
  if (!res.ok) throw new Error("Failed to load agent");
  return res.json();
}

export async function updateAgent(
  agentId: string,
  patch: { name?: string; avatarUrl?: string | null }
): Promise<AgentMeta> {
  const res = await mutationFetch(`${BASE}/agents/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update agent");
  return res.json();
}

export async function getAgentIdentity(agentId: string): Promise<AgentIdentity> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(agentId)}/identity`);
  if (!res.ok) throw new Error("Failed to load agent identity");
  return res.json();
}

export async function putAgentSoul(agentId: string, content: string): Promise<void> {
  const res = await mutationFetch(
    `${BASE}/agents/${encodeURIComponent(agentId)}/identity/soul`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
}

export async function putAgentProfile(agentId: string, content: string): Promise<void> {
  const res = await mutationFetch(
    `${BASE}/agents/${encodeURIComponent(agentId)}/identity/profile`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
}

export async function putAgentConfig(
  agentId: string,
  patch: Partial<AgentConfig>
): Promise<AgentConfig> {
  const res = await mutationFetch(
    `${BASE}/agents/${encodeURIComponent(agentId)}/identity/config`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Model registry (multi-model picker) ─────────────────────────────

export interface ModelCapabilities {
  thinking: boolean;
  toolUse: boolean;
  contextWindow: number;
  thinkingBudget?: number;
}
export interface ModelSummary {
  id: string;
  displayName: string;
  provider: "ark" | "oneapi";
  group: "volcano" | "anthropic" | "openai";
  available: boolean;
  capabilities: ModelCapabilities;
}
export interface AgentModelSelection {
  selected: string;
  resolved: {
    id: string;
    displayName: string;
    provider: "ark" | "oneapi";
    group: "volcano" | "anthropic" | "openai";
    available: boolean;
  };
  requested: { id: string; displayName: string; available: boolean } | null;
  usedFallback: boolean;
}

export async function listModels(): Promise<{
  models: ModelSummary[];
  defaultModelId: string;
}> {
  const res = await fetch(`${BASE}/agents/models`);
  if (!res.ok) throw new Error("Failed to list models");
  return res.json();
}

// Rename helper for the header pill — thin wrapper on `updateAgent` so the
// AgentNamePill only has to import one name. Also used by the `update_agent_name`
// Tier 0 meta-tool path (via the same DB row).
export async function renameAgent(agentId: string, name: string): Promise<AgentMeta> {
  const res = await mutationFetch(
    `${BASE}/agents/${encodeURIComponent(agentId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function getAgentModel(agentId: string): Promise<AgentModelSelection> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(agentId)}/model`);
  if (!res.ok) throw new Error("Failed to load agent model");
  return res.json();
}

export async function setAgentModel(
  agentId: string,
  modelId: string
): Promise<AgentModelSelection> {
  const res = await mutationFetch(
    `${BASE}/agents/${encodeURIComponent(agentId)}/model`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ═══════════════ Ideas (Markdown 文档 artifact) ═══════════════

export async function createIdea(
  name: string,
  workspaceId: string,
  parentId?: string | null
): Promise<IdeaBrief> {
  const res = await mutationFetch(`${BASE}/ideas`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, workspaceId, parentId: parentId || null }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to create idea");
  }
  const data = await res.json();
  return { ...data, workspaceId };
}

export async function fetchIdea(ideaId: string): Promise<IdeaDetail> {
  const res = await fetch(`${BASE}/ideas/${ideaId}`);
  if (!res.ok) throw new Error("Failed to fetch idea");
  return res.json();
}

/**
 * Save idea content with optimistic version check.
 * Returns `{ ok: true, version }` or `{ conflict: true, latest }`.
 */
export async function saveIdeaContent(
  ideaId: string,
  content: string,
  baseVersion: number
): Promise<
  | { ok: true; version: number; updatedAt: string }
  | { conflict: true; latest: { content: string; version: number } }
> {
  const res = await mutationFetch(`${BASE}/ideas/${ideaId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, baseVersion }),
  });
  if (res.status === 409) {
    const body = await res.json();
    return { conflict: true, latest: body.latest };
  }
  if (!res.ok) throw new Error("Failed to save idea");
  const body = await res.json();
  return { ok: true, version: body.version, updatedAt: body.updatedAt };
}

export async function renameIdea(ideaId: string, name: string): Promise<{ id: string; name: string }> {
  const res = await mutationFetch(`${BASE}/ideas/${ideaId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Failed to rename idea");
  return res.json();
}

export async function deleteIdea(ideaId: string): Promise<void> {
  const res = await mutationFetch(`${BASE}/ideas/${ideaId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete idea");
}

export async function reorderIdeas(
  updates: Array<{ id: string; order: number }>,
  workspaceId: string
): Promise<void> {
  const res = await mutationFetch(`${BASE}/ideas/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates, workspaceId }),
  });
  if (!res.ok) throw new Error("Failed to reorder ideas");
}

// ─── @ Mention search ───
export async function searchMentions(
  workspaceId: string,
  q: string,
  opts?: { types?: Array<MentionHit["type"]>; limit?: number }
): Promise<MentionHit[]> {
  const params = new URLSearchParams();
  params.set("q", q);
  if (opts?.types?.length) params.set("types", opts.types.join(","));
  if (opts?.limit) params.set("limit", String(opts.limit));
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/mentions/search?${params}`);
  if (!res.ok) throw new Error("Failed to search mentions");
  const body = await res.json();
  return body.hits || [];
}

// ─── Vibe Demo (V1) ───
export interface DemoBrief {
  id: string;
  workspaceId: string;
  parentId: string | null;
  order: number;
  name: string;
  template: "static" | "react-spa";
  version: number;
  lastBuildStatus: "idle" | "building" | "success" | "error" | null;
  lastBuildAt: string | null;
  publishSlug: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DemoDetail extends DemoBrief {
  dataTables: string[];
  dataIdeas: string[];
  capabilities: Record<string, string[]>;
  lastBuildError: string | null;
  publishedVersion: number | null;
  files?: Array<{ path: string; size: number; updatedAt: string }>;
}

export async function listDemos(workspaceId: string): Promise<DemoBrief[]> {
  const res = await fetch(`${BASE}/demos?workspaceId=${encodeURIComponent(workspaceId)}`);
  if (!res.ok) throw new Error("Failed to list demos");
  return res.json();
}

export async function fetchDemo(demoId: string, includeFiles = true): Promise<DemoDetail> {
  const res = await fetch(
    `${BASE}/demos/${encodeURIComponent(demoId)}?includeFiles=${includeFiles}`,
  );
  if (!res.ok) throw new Error("Failed to fetch demo");
  return res.json();
}

export async function createDemo(
  workspaceId: string,
  name: string,
  template: "static" | "react-spa" = "static"
): Promise<DemoDetail> {
  const res = await mutationFetch(`${BASE}/demos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, name, template }),
  });
  if (!res.ok) throw new Error("Failed to create demo");
  return res.json();
}

export async function renameDemo(demoId: string, name: string): Promise<void> {
  const res = await mutationFetch(`${BASE}/demos/${encodeURIComponent(demoId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Failed to rename demo");
}

export async function deleteDemo(demoId: string): Promise<void> {
  const res = await mutationFetch(`${BASE}/demos/${encodeURIComponent(demoId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete demo");
}

export async function reorderDemos(
  updates: Array<{ id: string; order: number }>,
  workspaceId: string
): Promise<void> {
  const res = await mutationFetch(`${BASE}/demos/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates, workspaceId }),
  });
  if (!res.ok) throw new Error("Failed to reorder demos");
}

export async function buildDemo(demoId: string): Promise<{
  ok: boolean;
  durationMs: number;
  sizeBytes?: number;
  fileCount?: number;
  logTail?: string;
  error?: string;
}> {
  const res = await mutationFetch(`${BASE}/demos/${encodeURIComponent(demoId)}/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("Failed to build demo");
  return res.json();
}

export async function publishDemo(demoId: string): Promise<{
  ok: true;
  demoId: string;
  slug: string;
  publishedVersion: number;
  publishedAt: string;
  url: string;
}> {
  const res = await mutationFetch(`${BASE}/demos/${encodeURIComponent(demoId)}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error((e as any).error || "Failed to publish demo");
  }
  return res.json();
}

export async function unpublishDemo(demoId: string): Promise<void> {
  const res = await mutationFetch(`${BASE}/demos/${encodeURIComponent(demoId)}/unpublish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("Failed to unpublish demo");
}

/** Export Demo source as zip. Returns blob URL. Caller must revoke. */
export async function exportDemoZip(demoId: string): Promise<string> {
  const res = await fetch(`${BASE}/demos/${encodeURIComponent(demoId)}/export`);
  if (!res.ok) throw new Error("Failed to export demo");
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
