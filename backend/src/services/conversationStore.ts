/**
 * In-memory conversation store for Chat Agent (Table Agent).
 *
 * See docs/chat-sidebar-plan.md Phase 3:
 *  - One document (e.g. doc_default) holds multiple conversations
 *  - Each conversation holds a list of messages (user / assistant / tool)
 *  - Persistence: in-memory Map (sibling to mockData.ts pattern); future
 *    migration to Prisma models is mechanical once contract stabilizes.
 */

import { v4 as uuidv4 } from "uuid";

export interface ToolCall {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  confirmed?: boolean;
  result?: unknown;
  status?: "running" | "success" | "error" | "awaiting_confirmation";
  error?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolResult?: unknown;
  timestamp: number;
}

export interface Conversation {
  id: string;
  documentId: string;
  title: string;
  summary?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

// ─── Storage ─────────────────────────────────────────────────────────────

const conversations = new Map<string, Conversation>();
const messagesByConv = new Map<string, Message[]>();

// ─── Public API ──────────────────────────────────────────────────────────

export function listConversations(documentId: string): Conversation[] {
  return Array.from(conversations.values())
    .filter((c) => c.documentId === documentId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createConversation(documentId: string, title?: string): Conversation {
  const now = Date.now();
  const conv: Conversation = {
    id: `conv_${uuidv4()}`,
    documentId,
    title: title || "新对话",
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  conversations.set(conv.id, conv);
  messagesByConv.set(conv.id, []);
  return conv;
}

export function getConversation(id: string): Conversation | undefined {
  return conversations.get(id);
}

export function deleteConversation(id: string): boolean {
  messagesByConv.delete(id);
  return conversations.delete(id);
}

export function updateConversation(
  id: string,
  patch: Partial<Pick<Conversation, "title" | "summary">>
): Conversation | undefined {
  const conv = conversations.get(id);
  if (!conv) return undefined;
  if (patch.title !== undefined) conv.title = patch.title;
  if (patch.summary !== undefined) conv.summary = patch.summary;
  conv.updatedAt = Date.now();
  return conv;
}

export function appendMessage(
  conversationId: string,
  msg: Omit<Message, "id" | "conversationId" | "timestamp"> & { timestamp?: number }
): Message | undefined {
  const conv = conversations.get(conversationId);
  if (!conv) return undefined;
  const list = messagesByConv.get(conversationId) || [];
  const full: Message = {
    id: `msg_${uuidv4()}`,
    conversationId,
    timestamp: msg.timestamp ?? Date.now(),
    ...msg,
  };
  list.push(full);
  messagesByConv.set(conversationId, list);
  conv.messageCount = list.length;
  conv.updatedAt = full.timestamp;
  // Auto-title: use the first user message (capped at 24 chars)
  if (!conv.title || conv.title === "新对话") {
    if (full.role === "user" && full.content) {
      conv.title = full.content.trim().slice(0, 24) || conv.title;
    }
  }
  return full;
}

export function getMessages(conversationId: string, limit?: number): Message[] {
  const list = messagesByConv.get(conversationId) || [];
  if (limit && limit > 0 && list.length > limit) {
    return list.slice(list.length - limit);
  }
  return [...list];
}
