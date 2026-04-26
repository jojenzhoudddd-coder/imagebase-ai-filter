/**
 * WorkflowRun store —— V2.1 Agent Workflow.
 *
 * 持久化每次 `execute_workflow_template` 调用。SubagentRun 通过
 * `workflowNodeId` 跨表关联回 WorkflowRun.id —— 应用层 join,无 FK 以便
 * cleanup 顺序解耦。
 */

import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export type WorkflowStatus = "running" | "success" | "error" | "aborted";

export interface WorkflowRunCreate {
  id: string; // caller-supplied (matches the runtime runId)
  parentMessageId: string;
  parentConversationId: string;
  hostAgentId: string;
  templateId: string;
  paramsJson?: any;
  docJson?: any;
}

export interface WorkflowRunUpdate {
  status?: WorkflowStatus;
  errorMessage?: string | null;
  finalSummary?: string | null;
  nodeEventsJson?: any;
  completedAt?: Date | null;
  durationMs?: number | null;
}

export interface WorkflowRunRow {
  id: string;
  parentMessageId: string;
  parentConversationId: string;
  hostAgentId: string;
  templateId: string;
  paramsJson: any;
  docJson: any;
  nodeEventsJson: any;
  status: WorkflowStatus;
  errorMessage: string | null;
  finalSummary: string | null;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
}

export async function createWorkflowRun(input: WorkflowRunCreate): Promise<WorkflowRunRow> {
  const row = await prisma.workflowRun.create({
    data: {
      id: input.id,
      parentMessageId: input.parentMessageId,
      parentConversationId: input.parentConversationId,
      hostAgentId: input.hostAgentId,
      templateId: input.templateId,
      paramsJson: input.paramsJson ?? {},
      docJson: input.docJson ?? {},
      status: "running",
    },
  });
  return row as unknown as WorkflowRunRow;
}

export async function updateWorkflowRun(id: string, patch: WorkflowRunUpdate): Promise<void> {
  await prisma.workflowRun.update({
    where: { id },
    data: patch,
  });
}

export async function getWorkflowRun(id: string): Promise<WorkflowRunRow | null> {
  const row = await prisma.workflowRun.findUnique({ where: { id } });
  return row as unknown as WorkflowRunRow | null;
}

export async function listWorkflowRunsForMessage(parentMessageId: string): Promise<WorkflowRunRow[]> {
  const rows = await prisma.workflowRun.findMany({
    where: { parentMessageId },
    orderBy: { startedAt: "asc" },
  });
  return rows as unknown as WorkflowRunRow[];
}

export async function listWorkflowRunsForConversation(
  parentConversationId: string,
  limit = 200,
): Promise<WorkflowRunRow[]> {
  const rows = await prisma.workflowRun.findMany({
    where: { parentConversationId },
    orderBy: { startedAt: "asc" },
    take: limit,
  });
  return rows as unknown as WorkflowRunRow[];
}
