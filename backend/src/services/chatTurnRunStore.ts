import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { generateId } from "./idGenerator.js";
import {
  type ChatTurnSnapshot,
  type ChatTurnStatus,
  createInitialTurnSnapshot,
  reduceChatTurnSnapshot,
} from "./chatTurnSnapshot.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export type { ChatTurnSnapshot, ChatTurnStatus };

export interface ChatTurnRunRow {
  id: string;
  conversationId: string;
  workspaceId: string;
  agentId: string | null;
  status: ChatTurnStatus;
  requestText: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  modelId: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastSeq: number;
  snapshotJson: ChatTurnSnapshot;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatTurnEventRow {
  id: string;
  conversationId: string;
  turnRunId: string | null;
  seq: number;
  event: string;
  payloadJson: Record<string, unknown>;
  createdAt: Date;
}

const ACTIVE_STATUSES = ["queued", "doing", "awaiting_confirmation"];

function toRun(row: any): ChatTurnRunRow {
  return {
    ...row,
    status: row.status as ChatTurnStatus,
    snapshotJson: row.snapshotJson as ChatTurnSnapshot,
  };
}

function toEvent(row: any): ChatTurnEventRow {
  return {
    ...row,
    payloadJson: (row.payloadJson ?? {}) as Record<string, unknown>,
  };
}

export async function createTurnRun(input: {
  conversationId: string;
  workspaceId: string;
  agentId?: string | null;
  requestText: string;
  modelId?: string | null;
  status: Extract<ChatTurnStatus, "queued" | "doing">;
}): Promise<ChatTurnRunRow> {
  const id = await generateId("chatTurnRun");
  const now = Date.now();
  const snapshot = createInitialTurnSnapshot({
    turnRunId: id,
    conversationId: input.conversationId,
    requestText: input.requestText,
    modelId: input.modelId ?? null,
    status: input.status,
    now,
  });
  const row = await prisma.chatTurnRun.create({
    data: {
      id,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      agentId: input.agentId ?? null,
      status: input.status,
      requestText: input.requestText,
      modelId: input.modelId ?? null,
      startedAt: input.status === "doing" ? new Date(now) : null,
      snapshotJson: snapshot as never,
    },
  });
  await refreshConversationStatus(input.conversationId);
  return toRun(row);
}

export async function promoteTurnRun(id: string): Promise<void> {
  const row = await prisma.chatTurnRun.findUnique({ where: { id } });
  if (!row) return;
  const snapshot = reduceChatTurnSnapshot(
    row.snapshotJson as unknown as ChatTurnSnapshot,
    "turn_promoted",
    { turnRunId: id },
  );
  await prisma.chatTurnRun.update({
    where: { id },
    data: {
      status: "doing",
      startedAt: row.startedAt ?? new Date(),
      snapshotJson: snapshot as never,
    },
  });
  await refreshConversationStatus(row.conversationId);
}

export async function markTurnStatus(
  id: string,
  status: Extract<ChatTurnStatus, "done" | "error" | "aborted" | "awaiting_confirmation">,
  patch: {
    errorMessage?: string | null;
    assistantMessageId?: string | null;
    durationMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  } = {},
): Promise<void> {
  const row = await prisma.chatTurnRun.findUnique({ where: { id } });
  if (!row) return;
  const completed = status === "done" || status === "error" || status === "aborted";
  await prisma.chatTurnRun.update({
    where: { id },
    data: {
      status,
      ...(patch.assistantMessageId !== undefined ? { assistantMessageId: patch.assistantMessageId } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
      ...(patch.promptTokens !== undefined ? { promptTokens: patch.promptTokens } : {}),
      ...(patch.completionTokens !== undefined ? { completionTokens: patch.completionTokens } : {}),
      ...(patch.totalTokens !== undefined ? { totalTokens: patch.totalTokens } : {}),
      ...(completed ? { completedAt: new Date() } : {}),
    },
  });
  await refreshConversationStatus(row.conversationId);
}

export async function appendTurnEvent(input: {
  conversationId: string;
  turnRunId?: string | null;
  event: string;
  data: Record<string, unknown>;
}): Promise<ChatTurnEventRow> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = await prisma.$transaction(async (tx) => {
        const turnRunId = input.turnRunId ?? await resolveActiveTurnRunId(tx, input.conversationId);
        const maxSeq = await tx.chatTurnEvent.aggregate({
          where: { conversationId: input.conversationId },
          _max: { seq: true },
        });
        const seq = (maxSeq._max.seq ?? 0) + 1;
        const eventRow = await tx.chatTurnEvent.create({
          data: {
            id: await generateId("chatTurnEvent"),
            conversationId: input.conversationId,
            turnRunId,
            seq,
            event: input.event,
            payloadJson: { ...input.data, seq, turnRunId } as never,
          },
        });
        if (turnRunId) {
          const run = await tx.chatTurnRun.findUnique({ where: { id: turnRunId } });
          if (run) {
            const snapshot = reduceChatTurnSnapshot(
              run.snapshotJson as unknown as ChatTurnSnapshot,
              input.event,
              { ...input.data, seq, turnRunId },
              { seq },
            );
            const status = snapshot.status;
            await tx.chatTurnRun.update({
              where: { id: turnRunId },
              data: {
                status,
                lastSeq: seq,
                snapshotJson: snapshot as never,
                assistantMessageId: snapshot.assistant.messageId ?? run.assistantMessageId,
                modelId: snapshot.modelId ?? run.modelId,
                errorMessage: snapshot.errorMessage ?? run.errorMessage,
                durationMs: snapshot.turnMeta.durationMs,
                promptTokens: snapshot.turnMeta.promptTokens,
                completionTokens: snapshot.turnMeta.completionTokens,
                totalTokens: snapshot.turnMeta.totalTokens,
                ...(snapshot.startedAt && !run.startedAt ? { startedAt: new Date(snapshot.startedAt) } : {}),
                ...(snapshot.completedAt ? { completedAt: new Date(snapshot.completedAt) } : {}),
              },
            });
          }
        }
        return eventRow;
      });
      await refreshConversationStatus(input.conversationId);
      return toEvent(row);
    } catch (err) {
      lastErr = err;
      if (!String((err as any)?.code ?? "").includes("P2002")) break;
    }
  }
  throw lastErr;
}

export async function listEventsAfter(
  conversationId: string,
  afterSeq: number,
  limit = 500,
): Promise<ChatTurnEventRow[]> {
  const rows = await prisma.chatTurnEvent.findMany({
    where: { conversationId, seq: { gt: afterSeq } },
    orderBy: { seq: "asc" },
    take: limit,
  });
  return rows.map(toEvent);
}

export async function getConversationLastSeq(conversationId: string): Promise<number> {
  const maxSeq = await prisma.chatTurnEvent.aggregate({
    where: { conversationId },
    _max: { seq: true },
  });
  return maxSeq._max.seq ?? 0;
}

export async function listLiveTurnRuns(conversationId: string): Promise<ChatTurnRunRow[]> {
  const rows = await prisma.chatTurnRun.findMany({
    where: { conversationId, status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toRun);
}

export async function listRecentTurnRuns(conversationId: string, limit = 5): Promise<ChatTurnRunRow[]> {
  const rows = await prisma.chatTurnRun.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toRun).reverse();
}

export async function abortActiveTurnRuns(conversationId: string, reason = "user_stop"): Promise<void> {
  const runs = await prisma.chatTurnRun.findMany({
    where: { conversationId, status: { in: ACTIVE_STATUSES } },
    select: { id: true },
  });
  for (const run of runs) {
    await appendTurnEvent({
      conversationId,
      turnRunId: run.id,
      event: "error",
      data: { code: "ABORTED", message: reason },
    }).catch(() => undefined);
  }
  await prisma.chatTurnRun.updateMany({
    where: { conversationId, status: { in: ACTIVE_STATUSES } },
    data: { status: "aborted", completedAt: new Date(), errorMessage: reason },
  });
  await refreshConversationStatus(conversationId);
}

export async function refreshConversationStatus(conversationId: string): Promise<void> {
  const active = await prisma.chatTurnRun.count({
    where: { conversationId, status: { in: ACTIVE_STATUSES } },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: active > 0 ? "generating" : "idle" },
  }).catch(() => undefined);
}

async function resolveActiveTurnRunId(tx: any, conversationId: string): Promise<string | null> {
  const row = await tx.chatTurnRun.findFirst({
    where: { conversationId, status: { in: ["doing", "awaiting_confirmation"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return row?.id ?? null;
}
