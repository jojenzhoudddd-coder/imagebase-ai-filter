/**
 * Prisma-backed conversation store for Chat Agent (Table Agent).
 *
 * See docs/chat-sidebar-plan.md Phase 3. Originally implemented as an
 * in-memory Map; migrated to Prisma (Postgres) so conversations survive
 * backend restarts / pm2 reloads / tsx watch recompiles.
 *
 * Public contract is preserved so callers only need to `await` — the DTO
 * shape (string id, numeric epoch-ms timestamps, message roles, toolCalls
 * as JSON) is identical to the previous in-memory version.
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

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
  workspaceId: string;
  /** Owning Agent. Nullable on legacy rows; runtime falls back to the
   * default agent when unset. */
  agentId: string | null;
  title: string;
  summary?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

// ─── Prisma client (own instance; Prisma recommends per-module or singleton) ──

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Row → DTO helpers ──────────────────────────────────────────────────

function toConversation(row: {
  id: string;
  workspaceId: string;
  agentId?: string | null;
  title: string;
  summary: string | null;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}): Conversation {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId ?? null,
    title: row.title,
    summary: row.summary ?? undefined,
    messageCount: row.messageCount,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toMessage(row: {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  thinking: string | null;
  toolCalls: unknown;
  toolResult: unknown;
  timestamp: Date;
}): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as Message["role"],
    content: row.content,
    thinking: row.thinking ?? undefined,
    toolCalls: (row.toolCalls as ToolCall[] | null) ?? undefined,
    toolResult: row.toolResult ?? undefined,
    timestamp: row.timestamp.getTime(),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────

export async function listConversations(workspaceId: string): Promise<Conversation[]> {
  const rows = await prisma.conversation.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(toConversation);
}

export async function createConversation(
  workspaceId: string,
  title?: string,
  agentId?: string | null
): Promise<Conversation> {
  const row = await prisma.conversation.create({
    data: {
      workspaceId,
      agentId: agentId ?? null,
      title: title || "新对话",
    },
  });
  return toConversation(row);
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const row = await prisma.conversation.findUnique({ where: { id } });
  return row ? toConversation(row) : undefined;
}

export async function deleteConversation(id: string): Promise<boolean> {
  try {
    await prisma.conversation.delete({ where: { id } });
    return true;
  } catch {
    // P2025 (record not found) — return false per the previous Map.delete contract.
    return false;
  }
}

export async function updateConversation(
  id: string,
  patch: Partial<Pick<Conversation, "title" | "summary">>
): Promise<Conversation | undefined> {
  try {
    const row = await prisma.conversation.update({
      where: { id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      },
    });
    return toConversation(row);
  } catch {
    return undefined;
  }
}

export async function appendMessage(
  conversationId: string,
  msg: Omit<Message, "id" | "conversationId" | "timestamp"> & { timestamp?: number }
): Promise<Message | undefined> {
  // Ensure the conversation exists — keeps the old Map-era null-return behavior.
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv) return undefined;

  const ts = msg.timestamp ? new Date(msg.timestamp) : new Date();

  // Transaction: insert message + bump count/updatedAt + auto-title
  // so concurrent appends don't race on messageCount.
  const [message] = await prisma.$transaction(async (tx) => {
    const row = await tx.message.create({
      data: {
        conversationId,
        role: msg.role,
        content: msg.content,
        thinking: msg.thinking ?? null,
        toolCalls: (msg.toolCalls ?? undefined) as never,
        toolResult: (msg.toolResult ?? undefined) as never,
        timestamp: ts,
      },
    });
    const count = await tx.message.count({ where: { conversationId } });

    // Auto-title: reuse the first user message (capped at 24 chars) if
    // the conversation still has the default title.
    let nextTitle: string | undefined;
    if ((conv.title === "新对话" || !conv.title) && msg.role === "user" && msg.content) {
      nextTitle = msg.content.trim().slice(0, 24) || undefined;
    }

    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        messageCount: count,
        updatedAt: ts,
        ...(nextTitle ? { title: nextTitle } : {}),
      },
    });
    return [row];
  });

  return toMessage(message);
}

/**
 * 拉对话历史。三种模式：
 *   1. 默认（无 limit / before） → 拉全部（保留旧行为给 chatAgentService 内部 用,
 *      它需要完整窗口做滑动裁剪 + summary 拼接,这条路径不裁剪 toolResult）。
 *   2. limit=N → 拉最新 N 条（按 timestamp asc 返回,直接渲染顺序）。
 *   3. limit=N + before=<msgId> → 拉 before 这条之前的最新 N 条。前端 ChatSidebar
 *      初次以 limit=20 拉,用户向上滚到顶时再以 before=<最早 id>+limit=20 拉一页。
 *
 * 分页路径下,巨型 toolResult / toolCalls.result 会被裁剪到 4 KB —— 一条 demo build
 * 输出 / 大表 query 可以达到 200KB,30 条历史就 6MB,拉一次要十几秒。截断后前端展示
 * "查看全文"再单独 fetch 完整内容（V2 接口）。
 */
const TOOL_PAYLOAD_TRIM_BYTES = 4096;
function trimToolPayload(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= TOOL_PAYLOAD_TRIM_BYTES) return value;
    return value.slice(0, TOOL_PAYLOAD_TRIM_BYTES) + `\n…[truncated, original ${value.length} chars]`;
  }
  if (Array.isArray(value)) {
    return value.map(trimToolPayload);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = trimToolPayload(v);
    }
    return out;
  }
  return value;
}

export async function getMessages(
  conversationId: string,
  opts: { limit?: number; before?: string } | number = {}
): Promise<{ messages: Message[]; hasMore: boolean }> {
  // 兼容旧调用方 getMessages(id, 20) —— 直接传数字
  const o: { limit?: number; before?: string } =
    typeof opts === "number" ? { limit: opts } : opts;
  const limit = o.limit && o.limit > 0 ? o.limit : undefined;

  // 解析 before 锚点的 timestamp(Prisma 的 DateTime 字段)
  let beforeTs: Date | null = null;
  if (o.before) {
    const anchor = await prisma.message.findUnique({
      where: { id: o.before },
      select: { timestamp: true, conversationId: true },
    });
    if (anchor && anchor.conversationId === conversationId) {
      beforeTs = anchor.timestamp;
    }
  }

  if (!limit && !beforeTs) {
    // 全量(legacy 路径):chatAgentService 用,顺序 asc。
    const rows = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { timestamp: "asc" },
    });
    return { messages: rows.map(toMessage), hasMore: false };
  }

  // 分页路径 —— DB 端 take + orderBy desc,然后 reverse 得到 asc
  const where: any = { conversationId };
  if (beforeTs !== null) where.timestamp = { lt: beforeTs };
  const rows = await prisma.message.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: limit ?? 20,
  });
  // hasMore：DB 是否还有更老的消息
  let hasMore = false;
  if (rows.length > 0) {
    const oldest = rows[rows.length - 1].timestamp;
    const olderCount = await prisma.message.count({
      where: { conversationId, timestamp: { lt: oldest } },
    });
    hasMore = olderCount > 0;
  }
  // 分页路径下裁剪超大 tool payload —— 见上方注释
  const trimmed: Message[] = rows.reverse().map(toMessage).map((m) => ({
    ...m,
    toolCalls: m.toolCalls?.map((c) => ({ ...c, result: trimToolPayload(c.result) as any })),
    toolResult: trimToolPayload(m.toolResult),
  }));
  return { messages: trimmed, hasMore };
}
