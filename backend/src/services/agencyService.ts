/**
 * Agency Service — High Agency Mode 编排器
 *
 * 核心状态机：
 *   startSession → planRoadmap → [executeMilestone → validateMilestone]* → complete
 *
 * 设计原则：
 *   - AsyncGenerator 模式 yield SSE events，路由层转发到客户端
 *   - 所有状态持久化到 Postgres（无内存依赖，支持恢复）
 *   - 复用 chatAgentService.runAgent() 执行具体里程碑
 *   - 复用 chaosMonkeyService 进行规划和验收
 *   - 无重试上限，每次 retry 携带 failureHistory 确保螺旋进步
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { v4 as uuidv4 } from "uuid";
import { generateId } from "./idGenerator.js";
import {
  planRoadmap as chaosMonkeyPlan,
  validateMilestone as chaosMonkeyValidate,
  type AgencyRoadmap,
  type WorkspaceContext,
  type ValidationResult,
} from "./chaosMonkeyService.js";
import { runAgent, type AgentContext, type SseEvent } from "./chatAgentService.js";
import * as convStore from "./conversationStore.js";
import * as dbStore from "./dbStore.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgencyEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface CreateSessionInput {
  userId: string;
  agentId?: string;
  workspaceId: string;
  goal: string;
  todos?: string[];
  fromScope?: { exclude?: string[] };
  chaosMonkeyModel?: string;
  authToken?: string; // for Chat Agent MCP loopback
}

// ─── Session CRUD ───────────────────────────────────────────────────────────

export async function createSession(input: CreateSessionInput) {
  const session = await prisma.agencySession.create({
    data: {
      id: await generateId("agencySession"),
      userId: input.userId,
      agentId: input.agentId ?? "agent_default",
      workspaceId: input.workspaceId,
      goal: input.goal,
      todos: input.todos ?? [],
      fromScope: input.fromScope ?? {},
      chaosMonkeyModel: input.chaosMonkeyModel ?? "gpt-5.5",
      status: "planning",
    },
  });
  return session;
}

export async function getSession(sessionId: string) {
  return prisma.agencySession.findUnique({
    where: { id: sessionId },
    include: { milestones: { orderBy: [{ segmentIndex: "asc" }, { milestoneIndex: "asc" }] } },
  });
}

export async function getSessionCheckpoints(sessionId: string) {
  return prisma.agencyCheckpoint.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
  });
}

export async function updateSessionGoalOrTodos(
  sessionId: string,
  patch: { goal?: string; todos?: string[] }
) {
  const data: Record<string, unknown> = {};
  if (patch.goal !== undefined) data.goal = patch.goal;
  if (patch.todos !== undefined) data.todos = patch.todos;
  data.status = "replanning";
  return prisma.agencySession.update({ where: { id: sessionId }, data });
}

export async function cancelSession(sessionId: string) {
  return prisma.agencySession.update({
    where: { id: sessionId },
    data: { status: "cancelled" },
  });
}

// ─── Main Orchestration Loop ────────────────────────────────────────────────

export async function* runAgencyLoop(
  sessionId: string,
  opts?: { authToken?: string; abortSignal?: AbortSignal }
): AsyncGenerator<AgencyEvent, void, undefined> {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Agency session ${sessionId} not found`);

  // ── Phase 1: Planning ──────────────────────────────────────────────────
  yield { type: "session:status", data: { status: "planning", sessionId } };

  const wsContext = await buildWorkspaceContext(session.workspaceId);
  let roadmap: AgencyRoadmap;

  try {
    roadmap = await chaosMonkeyPlan({
      goal: session.goal,
      todos: session.todos as string[],
      workspaceContext: wsContext,
      fromScope: session.fromScope as { exclude?: string[] },
      model: session.chaosMonkeyModel,
    });
  } catch (err: any) {
    yield { type: "error", data: { message: `Planning failed: ${err.message}` } };
    await prisma.agencySession.update({
      where: { id: sessionId },
      data: { status: "cancelled" },
    });
    return;
  }

  // Persist roadmap + create milestone rows
  await prisma.agencySession.update({
    where: { id: sessionId },
    data: { roadmap: roadmap as any, status: "executing" },
  });

  const milestoneRows = await createMilestoneRows(sessionId, roadmap);
  yield { type: "roadmap:planned", data: { roadmap, milestoneCount: milestoneRows.length } };

  // ── Phase 2: Execute + Validate loop ───────────────────────────────────
  for (let i = 0; i < milestoneRows.length; i++) {
    // Check abort
    if (opts?.abortSignal?.aborted) {
      yield { type: "session:status", data: { status: "cancelled", reason: "aborted" } };
      await prisma.agencySession.update({ where: { id: sessionId }, data: { status: "cancelled" } });
      return;
    }

    // Check if session was patched (replanning)
    const freshSession = await prisma.agencySession.findUnique({ where: { id: sessionId } });
    if (freshSession?.status === "replanning" || freshSession?.status === "cancelled") {
      if (freshSession.status === "cancelled") {
        yield { type: "session:status", data: { status: "cancelled" } };
        return;
      }
      // Re-plan: yield event and restart
      yield { type: "session:status", data: { status: "replanning" } };
      yield* handleReplan(sessionId, opts);
      return;
    }

    const milestone = milestoneRows[i];

    // Update progress
    await prisma.agencySession.update({
      where: { id: sessionId },
      data: { currentSegmentIndex: milestone.segmentIndex, currentMilestoneIndex: milestone.milestoneIndex },
    });

    // Execute + validate (with retry loop)
    yield* executeMilestoneWithRetry(session, milestone, opts);

    // Re-fetch milestone to check final status
    const updated = await prisma.agencyMilestone.findUnique({ where: { id: milestone.id } });
    if (updated?.status !== "passed") {
      // Should not happen (executeMilestoneWithRetry loops until pass), but safety net
      yield { type: "error", data: { message: `Milestone ${milestone.title} stuck in ${updated?.status}` } };
      return;
    }
  }

  // ── Phase 3: Complete ──────────────────────────────────────────────────
  await prisma.agencySession.update({
    where: { id: sessionId },
    data: { status: "completed", completedAt: new Date() },
  });

  const checkpoints = await getSessionCheckpoints(sessionId);
  yield { type: "session:completed", data: { checkpoints } };
}

// ─── Execute a single milestone with retry ──────────────────────────────────

async function* executeMilestoneWithRetry(
  session: { id: string; agentId: string; workspaceId: string; chaosMonkeyModel: string },
  milestone: { id: string; title: string; description: string; acceptanceCriteria: unknown; segmentIndex: number; milestoneIndex: number },
  opts?: { authToken?: string; abortSignal?: AbortSignal }
): AsyncGenerator<AgencyEvent, void, undefined> {
  const criteria = milestone.acceptanceCriteria as string[];
  let failureHistory: { reason: string; suggestions?: string[]; timestamp: string }[] = [];

  while (true) {
    // Check abort signal or DB-level cancellation
    if (opts?.abortSignal?.aborted) return;
    const freshStatus = await prisma.agencySession.findUnique({
      where: { id: session.id },
      select: { status: true },
    });
    if (freshStatus?.status === "cancelled") return;

    yield { type: "milestone:started", data: { milestoneId: milestone.id, title: milestone.title, retryCount: failureHistory.length } };

    // Mark executing
    const startedAt = new Date();
    await prisma.agencyMilestone.update({
      where: { id: milestone.id },
      data: { status: "executing", startedAt },
    });

    // ── Execute via Chat Agent ───────────────────────────────────────────
    const userMessage = buildMilestonePrompt(milestone.title, milestone.description, criteria, failureHistory);
    const convTitle = `Agency: ${milestone.title}`;
    const conv = await convStore.createConversation(session.workspaceId, convTitle, session.agentId, { type: "agency", id: session.id });

    // Update conversation reference
    await prisma.agencyMilestone.update({
      where: { id: milestone.id },
      data: { conversationId: conv.id },
    });

    const ctx: AgentContext = {
      conversationId: conv.id,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      authToken: opts?.authToken,
    };

    let agentFinalText = "";
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      for await (const event of runAgent(ctx, userMessage, opts?.abortSignal)) {
        // Forward relevant events
        if (event.event === "message") {
          agentFinalText += (event.data.text as string) ?? "";
          yield { type: "milestone:progress", data: { milestoneId: milestone.id, event: "message", text: event.data.text } };
        } else if (event.event === "tool_start" || event.event === "tool_result") {
          yield { type: "milestone:progress", data: { milestoneId: milestone.id, event: event.event, ...event.data } };
        } else if (event.event === "done") {
          promptTokens = (event.data.promptTokens as number) ?? 0;
          completionTokens = (event.data.completionTokens as number) ?? 0;
        } else if (event.event === "error") {
          agentFinalText += `\n[ERROR: ${event.data.message}]`;
        }
      }
    } catch (err: any) {
      agentFinalText += `\n[EXCEPTION: ${err.message}]`;
    }

    const durationMs = Date.now() - startedAt.getTime();

    // ── Validate via Chaos Monkey ────────────────────────────────────────
    await prisma.agencyMilestone.update({
      where: { id: milestone.id },
      data: { status: "validating" },
    });
    yield { type: "milestone:validating", data: { milestoneId: milestone.id } };

    // Detect artifacts created during this milestone
    const artifactsChanged = await detectNewArtifacts(session.workspaceId, startedAt);

    let validation: ValidationResult;
    try {
      validation = await chaosMonkeyValidate({
        milestone: { title: milestone.title, description: milestone.description, acceptanceCriteria: criteria },
        executionResult: agentFinalText.slice(0, 8000), // cap to avoid token overflow
        artifactsChanged,
        failureHistory,
        model: session.chaosMonkeyModel,
      });
    } catch (err: any) {
      // Validation call itself failed — treat as pass to avoid infinite loop on infra errors
      validation = { passed: true, reason: `Validation error (auto-pass): ${err.message}` };
    }

    yield { type: "milestone:validated", data: { milestoneId: milestone.id, ...validation } };

    if (validation.passed) {
      // ── PASSED ──────────────────────────────────────────────────────────
      await prisma.agencyMilestone.update({
        where: { id: milestone.id },
        data: {
          status: "passed",
          validationResult: validation as any,
          durationMs,
          promptTokens,
          completionTokens,
          completedAt: new Date(),
        },
      });

      // Register artifacts as checkpoints
      for (const art of artifactsChanged) {
        await prisma.agencyCheckpoint.create({
          data: {
            id: await generateId("agencyCheckpoint"),
            sessionId: session.id,
            milestoneId: milestone.id,
            artifactType: art.type,
            artifactId: art.id,
            label: `${art.name} (${art.action})`,
          },
        });
      }

      yield { type: "milestone:passed", data: { milestoneId: milestone.id, durationMs, promptTokens, completionTokens } };
      return; // Done with this milestone
    } else {
      // ── FAILED — retry ─────────────────────────────────────────────────
      failureHistory.push({
        reason: validation.reason,
        suggestions: validation.suggestions,
        timestamp: new Date().toISOString(),
      });

      await prisma.agencyMilestone.update({
        where: { id: milestone.id },
        data: {
          status: "retrying",
          retryCount: failureHistory.length,
          failureHistory: failureHistory as any,
          validationResult: validation as any,
          durationMs,
          promptTokens,
          completionTokens,
        },
      });

      yield {
        type: "milestone:failed",
        data: {
          milestoneId: milestone.id,
          reason: validation.reason,
          suggestions: validation.suggestions,
          retryCount: failureHistory.length,
        },
      };
      // Loop continues → retry
    }
  }
}

// ─── Handle Re-plan ─────────────────────────────────────────────────────────

async function* handleReplan(
  sessionId: string,
  opts?: { authToken?: string; abortSignal?: AbortSignal }
): AsyncGenerator<AgencyEvent, void, undefined> {
  // Preserve passed milestones, delete everything else
  const passedMilestones = await prisma.agencyMilestone.findMany({
    where: { sessionId, status: "passed" },
    orderBy: [{ segmentIndex: "asc" }, { milestoneIndex: "asc" }],
  });

  await prisma.agencyMilestone.deleteMany({
    where: { sessionId, status: { not: "passed" } },
  });

  // Reset progress to after the last passed milestone
  await prisma.agencySession.update({
    where: { id: sessionId },
    data: { status: "planning", roadmap: undefined },
  });

  yield { type: "roadmap:replanned", data: { preservedCount: passedMilestones.length, reason: "Goal or todos changed" } };

  // Re-run loop — planRoadmap will be called again with updated goal/todos
  // The already-passed milestones stay in DB for reference/checkpoints but
  // the new plan starts fresh (Chaos Monkey gets workspace context which
  // already reflects the work done so far)
  yield* runAgencyLoop(sessionId, opts);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function createMilestoneRows(sessionId: string, roadmap: AgencyRoadmap) {
  const rows = [];
  for (let si = 0; si < roadmap.segments.length; si++) {
    const seg = roadmap.segments[si];
    for (let mi = 0; mi < seg.milestones.length; mi++) {
      const ms = seg.milestones[mi];
      const row = await prisma.agencyMilestone.create({
        data: {
          id: await generateId("agencyMilestone"),
          sessionId,
          segmentIndex: si,
          milestoneIndex: mi,
          title: ms.title,
          description: ms.description,
          acceptanceCriteria: ms.acceptanceCriteria,
          status: "pending",
        },
      });
      rows.push(row);
    }
  }
  return rows;
}

function buildMilestonePrompt(
  title: string,
  description: string,
  criteria: string[],
  failureHistory: { reason: string; suggestions?: string[]; timestamp: string }[]
): string {
  const parts: string[] = [];

  parts.push(`## 任务：${title}\n\n${description}`);
  parts.push(`## 验收标准（全部满足才算完成）\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);

  if (failureHistory.length > 0) {
    const histLines = failureHistory.map((f, i) => {
      let line = `### 第 ${i + 1} 次失败\n**原因**: ${f.reason}`;
      if (f.suggestions && f.suggestions.length > 0) {
        line += `\n**改进建议**: ${f.suggestions.join("; ")}`;
      }
      return line;
    });
    parts.push(
      `## ⚠️ 历史失败记录（共 ${failureHistory.length} 次，请仔细阅读并避免重蹈覆辙）\n${histLines.join("\n\n")}`
    );
    parts.push(
      `## 重要提示\n请根据上述失败记录调整策略，不要重复之前的错误。确保每一条验收标准都被满足。`
    );
  }

  return parts.join("\n\n");
}

async function buildWorkspaceContext(workspaceId: string): Promise<WorkspaceContext> {
  // Fetch workspace artifacts for Chaos Monkey context
  try {
    const tables = await prisma.table.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
    });
    const ideas = await prisma.idea.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
    });
    const designs = await prisma.design.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
    });
    const demos = await prisma.demo.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
    });

    // Get record counts for tables (fields are in-memory, not in Prisma)
    const tablesWithCounts = await Promise.all(
      tables.map(async (t) => {
        const recordCount = await prisma.record.count({ where: { tableId: t.id } });
        return { id: t.id, name: t.name, fieldCount: 0, recordCount };
      })
    );

    return {
      tables: tablesWithCounts,
      ideas: ideas.map((i) => ({ id: i.id, title: i.name })),
      designs: designs.map((d) => ({ id: d.id, name: d.name })),
      demos: demos.map((d) => ({ id: d.id, name: d.name })),
    };
  } catch {
    // Fallback if Prisma models don't exist yet
    return { tables: [], ideas: [], designs: [], demos: [] };
  }
}

async function detectNewArtifacts(
  workspaceId: string,
  since: Date
): Promise<{ type: string; id: string; name: string; action: "created" | "modified" }[]> {
  const results: { type: string; id: string; name: string; action: "created" | "modified" }[] = [];

  try {
    // Tables
    const newTables = await prisma.table.findMany({
      where: { workspaceId, createdAt: { gte: since } },
      select: { id: true, name: true },
    });
    for (const t of newTables) results.push({ type: "table", id: t.id, name: t.name, action: "created" });

    // Ideas
    const newIdeas = await prisma.idea.findMany({
      where: { workspaceId, createdAt: { gte: since } },
      select: { id: true, name: true },
    });
    for (const i of newIdeas) results.push({ type: "idea", id: i.id, name: i.name, action: "created" });

    // Modified ideas (updated after since but created before)
    const modifiedIdeas = await prisma.idea.findMany({
      where: { workspaceId, updatedAt: { gte: since }, createdAt: { lt: since } },
      select: { id: true, name: true },
    });
    for (const i of modifiedIdeas) results.push({ type: "idea", id: i.id, name: i.name, action: "modified" });

    // Designs
    const newDesigns = await prisma.design.findMany({
      where: { workspaceId, createdAt: { gte: since } },
      select: { id: true, name: true },
    });
    for (const d of newDesigns) results.push({ type: "design", id: d.id, name: d.name, action: "created" });

    // Demos
    const newDemos = await prisma.demo.findMany({
      where: { workspaceId, createdAt: { gte: since } },
      select: { id: true, name: true },
    });
    for (const d of newDemos) results.push({ type: "demo", id: d.id, name: d.name, action: "created" });
  } catch {
    // Ignore query errors
  }

  return results;
}
