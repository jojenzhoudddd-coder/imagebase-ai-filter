/**
 * Admin routes (V2.7 C18 + C19).
 *
 * 给 host 自己 / dev / 管理员看 SubagentRun + WorkflowRun 历史 + 聚合指标。
 * 当前阶段没有专门的管理员鉴权 —— 项目仍在 dev / demo 阶段,所有 agent 共
 * 享一套数据。生产环境上线前需补 admin role check (config.json 里加
 * `admin: true` 或加专属 token)。
 *
 * Endpoints:
 *   GET /api/admin/subagent-runs?limit=&offset=&status=&hostAgentId=
 *   GET /api/admin/workflow-runs?limit=&offset=&status=&templateId=&hostAgentId=
 *   GET /api/admin/metrics?windowDays=7
 *
 * 默认 limit=50,硬上限 200。
 */

import express, { type Request, type Response } from "express";
import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const router = express.Router();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function parseLimit(req: Request): number {
  const raw = Number(req.query.limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
}

function parseOffset(req: Request): number {
  const raw = Number(req.query.offset ?? 0);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

router.get("/subagent-runs", async (req: Request, res: Response) => {
  try {
    const limit = parseLimit(req);
    const offset = parseOffset(req);
    const where: any = {};
    if (typeof req.query.status === "string" && req.query.status) {
      where.status = req.query.status;
    }
    if (typeof req.query.hostAgentId === "string" && req.query.hostAgentId) {
      where.hostAgentId = req.query.hostAgentId;
    }
    const [rows, total] = await Promise.all([
      prisma.subagentRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.subagentRun.count({ where }),
    ]);
    res.json({
      total,
      limit,
      offset,
      rows: rows.map((r) => ({
        id: r.id,
        hostAgentId: r.hostAgentId,
        parentConversationId: r.parentConversationId,
        subagentModel: r.subagentModel,
        requestedModel: r.requestedModel,
        status: r.status,
        depth: r.depth,
        workflowNodeId: r.workflowNodeId,
        userPromptPreview:
          r.userPrompt.length > 200 ? r.userPrompt.slice(0, 200) + "…" : r.userPrompt,
        finalTextPreview: r.finalText
          ? r.finalText.length > 200
            ? r.finalText.slice(0, 200) + "…"
            : r.finalText
          : null,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        durationMs: r.durationMs,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        errorMessage: r.errorMessage,
      })),
    });
  } catch (err: any) {
    console.error("[admin] subagent-runs error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

router.get("/workflow-runs", async (req: Request, res: Response) => {
  try {
    const limit = parseLimit(req);
    const offset = parseOffset(req);
    const where: any = {};
    if (typeof req.query.status === "string" && req.query.status) {
      where.status = req.query.status;
    }
    if (typeof req.query.templateId === "string" && req.query.templateId) {
      where.templateId = req.query.templateId;
    }
    if (typeof req.query.hostAgentId === "string" && req.query.hostAgentId) {
      where.hostAgentId = req.query.hostAgentId;
    }
    const [rows, total] = await Promise.all([
      prisma.workflowRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.workflowRun.count({ where }),
    ]);
    res.json({
      total,
      limit,
      offset,
      rows: rows.map((r) => ({
        id: r.id,
        hostAgentId: r.hostAgentId,
        parentConversationId: r.parentConversationId,
        templateId: r.templateId,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        durationMs: r.durationMs,
        nodeCount: Array.isArray(r.nodeEventsJson) ? (r.nodeEventsJson as any[]).length : 0,
        finalSummary: r.finalSummary,
        errorMessage: r.errorMessage,
      })),
    });
  } catch (err: any) {
    console.error("[admin] workflow-runs error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

router.get("/metrics", async (req: Request, res: Response) => {
  try {
    const days = Math.max(1, Math.min(90, Number(req.query.windowDays) || 7));
    const since = new Date(Date.now() - days * 86400_000);
    // SubagentRun aggregates
    const subRuns = await prisma.subagentRun.findMany({
      where: { startedAt: { gte: since } },
      select: {
        status: true,
        durationMs: true,
        promptTokens: true,
        completionTokens: true,
        subagentModel: true,
        depth: true,
      },
    });
    const wfRuns = await prisma.workflowRun.findMany({
      where: { startedAt: { gte: since } },
      select: { status: true, durationMs: true, templateId: true },
    });

    // Aggregate
    const subagentByModel = new Map<string, { runs: number; success: number; promptTok: number; completionTok: number; durationMs: number }>();
    let subagentTotalDuration = 0;
    let subagentSuccess = 0;
    let subagentPromptTokens = 0;
    let subagentCompletionTokens = 0;
    const depthHist = new Map<number, number>();
    for (const r of subRuns) {
      if (r.status === "success") subagentSuccess++;
      subagentTotalDuration += r.durationMs ?? 0;
      subagentPromptTokens += r.promptTokens ?? 0;
      subagentCompletionTokens += r.completionTokens ?? 0;
      depthHist.set(r.depth, (depthHist.get(r.depth) ?? 0) + 1);
      const slot = subagentByModel.get(r.subagentModel) ?? {
        runs: 0,
        success: 0,
        promptTok: 0,
        completionTok: 0,
        durationMs: 0,
      };
      slot.runs += 1;
      if (r.status === "success") slot.success += 1;
      slot.promptTok += r.promptTokens ?? 0;
      slot.completionTok += r.completionTokens ?? 0;
      slot.durationMs += r.durationMs ?? 0;
      subagentByModel.set(r.subagentModel, slot);
    }

    const workflowByTemplate = new Map<string, { runs: number; success: number; durationMs: number }>();
    let workflowSuccess = 0;
    let workflowTotalDuration = 0;
    for (const r of wfRuns) {
      if (r.status === "success") workflowSuccess++;
      workflowTotalDuration += r.durationMs ?? 0;
      const key = r.templateId ?? "(custom)";
      const slot = workflowByTemplate.get(key) ?? { runs: 0, success: 0, durationMs: 0 };
      slot.runs += 1;
      if (r.status === "success") slot.success += 1;
      slot.durationMs += r.durationMs ?? 0;
      workflowByTemplate.set(key, slot);
    }

    res.json({
      windowDays: days,
      since: since.toISOString(),
      subagent: {
        totalRuns: subRuns.length,
        successRate: subRuns.length > 0 ? subagentSuccess / subRuns.length : 0,
        avgDurationMs: subRuns.length > 0 ? subagentTotalDuration / subRuns.length : 0,
        totalPromptTokens: subagentPromptTokens,
        totalCompletionTokens: subagentCompletionTokens,
        depthHistogram: Array.from(depthHist.entries())
          .sort(([a], [b]) => a - b)
          .map(([depth, count]) => ({ depth, count })),
        byModel: Array.from(subagentByModel.entries()).map(([model, s]) => ({
          model,
          runs: s.runs,
          successRate: s.runs > 0 ? s.success / s.runs : 0,
          avgDurationMs: s.runs > 0 ? s.durationMs / s.runs : 0,
          totalPromptTokens: s.promptTok,
          totalCompletionTokens: s.completionTok,
        })),
      },
      workflow: {
        totalRuns: wfRuns.length,
        successRate: wfRuns.length > 0 ? workflowSuccess / wfRuns.length : 0,
        avgDurationMs: wfRuns.length > 0 ? workflowTotalDuration / wfRuns.length : 0,
        byTemplate: Array.from(workflowByTemplate.entries()).map(([templateId, s]) => ({
          templateId,
          runs: s.runs,
          successRate: s.runs > 0 ? s.success / s.runs : 0,
          avgDurationMs: s.runs > 0 ? s.durationMs / s.runs : 0,
        })),
      },
    });
  } catch (err: any) {
    console.error("[admin] metrics error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

export default router;
