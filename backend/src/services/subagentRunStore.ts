/**
 * SubagentRun store —— PR3 Agent Workflow 基础设施。
 *
 * 一行 SubagentRun 表示 host agent (或更深嵌套层) 通过 spawn_subagent 拉起的
 * 一次子 agent 调用。子 agent 自己在跑的过程中:
 *   - 思考 / 文本 / 工具调用全部 emit 成 SSE 事件给前端实时展示
 *   - 同时累计到 toolCallsJson + finalText + thinkingText 字段供刷新 / 回放
 *
 * 完成后:
 *   - 父 agent 的 tool_result 字段就是 subagent 的 finalText
 *   - 父 agent 不会污染自己的 conversation history (subagent 消息不进 messages 表)
 *
 * 字段语义:
 *   - parentMessageId  父 host 消息的 id —— 标定这一回合
 *   - parentSubagentRunId  当 depth>0,指向父 subagent (V1 上限 depth=1,即 host 直调)
 *   - allowedTools  [] 表示继承全部 (PR3 默认),非空数组则白名单
 *   - status  pending / running / success / error / aborted / danger-paused
 */

import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export type SubagentStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "aborted"
  | "danger-paused";

export interface SubagentRunCreate {
  parentMessageId: string;
  parentConversationId: string;
  hostAgentId: string;
  subagentModel: string;
  requestedModel: string;
  systemPrompt: string;
  userPrompt: string;
  allowedTools?: string[];
  maxRounds?: number;
  parentSubagentRunId?: string | null;
  depth?: number;
  workflowNodeId?: string | null;
  // V3.0 multi-conv
  kind?: string | null;
  branchId?: string | null;
  workflowRunId?: string | null;
}

export interface SubagentRunUpdate {
  status?: SubagentStatus;
  finalText?: string | null;
  thinkingText?: string | null;
  toolCallsJson?: any;
  errorMessage?: string | null;
  completedAt?: Date | null;
  durationMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
}

export interface SubagentRunRow {
  id: string;
  parentMessageId: string;
  parentConversationId: string;
  hostAgentId: string;
  subagentModel: string;
  requestedModel: string;
  systemPrompt: string;
  userPrompt: string;
  allowedTools: string[];
  maxRounds: number;
  parentSubagentRunId: string | null;
  depth: number;
  workflowNodeId: string | null;
  status: SubagentStatus;
  finalText: string | null;
  thinkingText: string | null;
  toolCallsJson: any;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

export async function createSubagentRun(input: SubagentRunCreate): Promise<SubagentRunRow> {
  const row = await prisma.subagentRun.create({
    data: {
      parentMessageId: input.parentMessageId,
      parentConversationId: input.parentConversationId,
      hostAgentId: input.hostAgentId,
      subagentModel: input.subagentModel,
      requestedModel: input.requestedModel,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      allowedTools: input.allowedTools ?? [],
      maxRounds: input.maxRounds ?? 10,
      parentSubagentRunId: input.parentSubagentRunId ?? null,
      depth: input.depth ?? 0,
      workflowNodeId: input.workflowNodeId ?? null,
      // V3.0
      kind: input.kind ?? null,
      branchId: input.branchId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      status: "running",
    },
  });
  return row as unknown as SubagentRunRow;
}

export async function updateSubagentRun(
  id: string,
  patch: SubagentRunUpdate,
): Promise<void> {
  await prisma.subagentRun.update({
    where: { id },
    data: patch,
  });
}

export async function getSubagentRun(id: string): Promise<SubagentRunRow | null> {
  const row = await prisma.subagentRun.findUnique({ where: { id } });
  return row as unknown as SubagentRunRow | null;
}

export async function listSubagentRunsForMessage(
  parentMessageId: string,
): Promise<SubagentRunRow[]> {
  const rows = await prisma.subagentRun.findMany({
    where: { parentMessageId },
    orderBy: { startedAt: "asc" },
  });
  return rows as unknown as SubagentRunRow[];
}

export async function listSubagentRunsForConversation(
  parentConversationId: string,
  limit = 200,
): Promise<SubagentRunRow[]> {
  const rows = await prisma.subagentRun.findMany({
    where: { parentConversationId },
    orderBy: { startedAt: "asc" },
    take: limit,
  });
  return rows as unknown as SubagentRunRow[];
}
