import "dotenv/config";
import {
  installAsyncErrorBoundary,
  globalErrorHandler,
} from "./middleware/asyncErrorBoundary.js";
// CRITICAL: must run before any Router is constructed (i.e. before any of the
// route imports below). Without it Express 4 lets async route throws escape
// into unhandledRejection — the request never sends a response, nginx upstream
// times out, browser gets HTML 504, FE chokes on `r.json()`. See
// docs/changelog.md 2026-04-28 hotfix for the original symptom report.
installAsyncErrorBoundary();
import express from "express";
import compression from "compression";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import tableRoutes from "./routes/tableRoutes.js";
import aiRoutes from "./routes/aiRoutes.js";
import sseRoutes from "./routes/sseRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import folderRoutes from "./routes/folderRoutes.js";
import agentRoutes from "./routes/agentRoutes.js";
import customModelRoutes from "./routes/customModelRoutes.js";
import knowledgeRoutes from "./routes/knowledgeRoutes.js";
import chatAttachmentRoutes, { serveChatUploads } from "./routes/chatAttachmentRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import designRoutes from "./routes/designRoutes.js";
import tasteRoutes from "./routes/tasteRoutes.js";
import ideaRoutes from "./routes/ideaRoutes.js";
import {
  ideaAttachmentRouter,
  ideaAttachmentTopRouter,
} from "./routes/ideaAttachmentRoutes.js";
import mentionRoutes from "./routes/mentionRoutes.js";
import mentionReverseRoutes from "./routes/mentionReverseRoutes.js";
import analystRoutes from "./routes/analystRoutes.js";
import demoRoutes from "./routes/demoRoutes.js";
import demoRuntimeRoutes from "./routes/demoRuntimeRoutes.js";
import publicDemoRoutes from "./routes/publicDemoRoutes.js";
import svgToDemoRoutes from "./routes/svgToDemoRoutes.js";
import agencyRoutes from "./routes/agencyRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import { attachUser, ensureSeedUserCredentials } from "./services/authService.js";
import { requireWorkspaceAccess } from "./middleware/requireWorkspaceAccess.js";
import { requireArtifactAccess } from "./middleware/requireArtifactAccess.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { mockTable } from "./mockData.js";
import { connectDB, loadTable, getTable, getWorkspace, updateWorkspace, listTablesForWorkspace, ensureDefaults } from "./services/dbStore.js";
import { eventBus } from "./services/eventBus.js";
import { startSuggestionScheduler } from "./services/suggestionService.js";
import { ensureDefaultAgent } from "./services/agentService.js";
import { startHeartbeat, stopHeartbeat } from "./services/runtimeService.js";
import { startModelProbe, stopModelProbe } from "./services/modelRegistry.js";
import { regenerateMissingSummaries } from "./services/workspaceSummaryService.js";
// Side-effect import: registers every provider adapter with the registry at
// boot. Must happen before the first runAgent() call.
import "./services/providers/index.js";
import { evaluateCron } from "./services/cronScheduler.js";
import { consumeFiredJobs, recoverOrphanedJobs } from "./services/inboxConsumer.js";
import { startAnalystCleanup, stopAnalystCleanup } from "./services/analyst/cleanupCron.js";
import { startWorktreeCleanupCron, stopWorktreeCleanupCron } from "./services/worktreeManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// Prisma client for tree queries (folders, designs)
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const treePrisma = new PrismaClient({ adapter } as any);
// Alias —— /workspaces/:id/stats 用同一个 client，避免多实例 pool。
const prismaForStats = treePrisma;

app.use(cors());
// gzip 压缩 ALL JSON / HTML / CSS / JS responses。nginx 没配 gzip,后端这里
// 兜底压一下;SSE 流（text/event-stream）会自动跳过(compression 内置识别)。
// 实测：chat /messages 响应 5.2MB → ~150KB(34×),延迟从 160s 降到 ~2s。
app.use(compression({
  // 不要压 SSE —— 否则浏览器一直等到全段才解,实时性破坏
  filter: (req, res) => {
    const ct = res.getHeader("content-type");
    if (typeof ct === "string" && ct.includes("text/event-stream")) return false;
    return compression.filter(req, res);
  },
  threshold: 1024, // < 1KB 不压(没必要)
}));
// Bumped body limit to 10mb so large SVG pastes (Figma exports, embedded <image>
// blobs, verbose path data) fit. The /tastes/from-svg endpoint still validates
// the payload and caps it at 5mb in its own handler.
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

// Parse the auth cookie on every /api request so downstream handlers can
// check req.user without each one reaching into cookies manually. Put this
// BEFORE any /api/* route mount so every handler sees the decoded user.
app.use("/api", attachUser);

// Workspace access guard —— 只要请求带 workspaceId（URL/body/query 任一位置）
// 就校验登录用户对该 workspace 是否有权。/api/auth/* 和 share 路径豁免。
app.use("/api", requireWorkspaceAccess);

// Artifact access guard —— URL 路径里有 :tableId / :ideaId / :designId /
// :demoId / :recordId / :tasteId / :conversationId / :folderId / :agentId
// 但没有显式 workspaceId 的请求，反查 artifact.workspaceId 后做归属校验。
// 与上一条共同覆盖整个 /api/* 表面（之前 artifact-only 路由是裸的）。
app.use("/api", requireArtifactAccess);

// ── Request logging middleware ──
function gmt8() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 23);
}
app.use("/api", (req, res, next) => {
  // Skip SSE and health check from verbose logging
  if (req.path.includes("/events") || req.path === "/health") return next();

  const start = Date.now();
  const clientId = req.headers["x-client-id"] || "-";
  const method = req.method;
  const path = req.originalUrl;

  // Log request body for mutations
  if (method !== "GET") {
    const bodySnippet = JSON.stringify(req.body).slice(0, 500);
    console.log(`[${gmt8()}] → ${method} ${path} client=${clientId} body=${bodySnippet}`);
  }

  // Capture response
  const origJson = res.json.bind(res);
  res.json = (body: any) => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const respSnippet = JSON.stringify(body).slice(0, 300);
    const level = status >= 400 ? "⚠️" : "✓";
    console.log(`[${gmt8()}] ${level} ${method} ${path} → ${status} (${ms}ms) client=${clientId} resp=${respSnippet}`);
    return origJson(body);
  };

  next();
});

app.use("/api/auth", authRoutes);
app.use("/api/tables", tableRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/sync", sseRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/folders", folderRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/models/custom", customModelRoutes);
app.use("/api/knowledge", knowledgeRoutes);
app.use("/api/chat/attachments", chatAttachmentRoutes);
app.use("/uploads/chat", serveChatUploads());
// V2.7 admin: SubagentRun / WorkflowRun list + aggregated metrics. Read-only.
// Auth currently inherits from `attachUser` upstream; tighten before prod.
app.use("/api/admin", adminRoutes);
// designRoutes 和 tasteRoutes 都挂在 /api/designs 下：
//  - designRoutes: 基础 CRUD (POST /, PUT /:designId, DELETE /:designId, PUT /reorder)
//  - tasteRoutes : /:designId/tastes/* (upload / from-figma / batch-update / 单条 CRUD / source)
// 路径不冲突，Express 会按 handler 顺序匹配。
app.use("/api/designs", designRoutes);
app.use("/api/designs", tasteRoutes);
app.use("/api/ideas", ideaRoutes);
// PR5: Idea attachment 上传 (multipart) 挂在 /api/ideas/:ideaId/attachments
// (parent route 已经做过 workspace access check)。
app.use("/api/ideas", ideaAttachmentRouter);
// 静态读取 / 删除单个附件挂在 top-level /api/idea-attachments
app.use("/api/idea-attachments", ideaAttachmentTopRouter);
app.use("/api/workspaces", mentionRoutes);
// Reverse mention lookup (workspace-agnostic path since callers already know
// the workspace — keeps the URL shape flat and search-friendly for logs).
app.use("/api/mentions", mentionReverseRoutes);
// Analyst P1 — DuckDB-backed analysis routes. See docs/analyst-skill-plan.md.
app.use("/api/analyst", analystRoutes);
// Vibe Demo V1 — see docs/vibe-demo-plan.md.
// /api/demos/*             owner-facing CRUD + file ops + build + publish
// /api/demo-runtime/*      runtime SDK endpoints (capability-gated, 7+2 handlers)
// /share/:slug/*           public anonymous serve of published snapshots
app.use("/api/demos", demoRoutes);
app.use("/api/demo-runtime", demoRuntimeRoutes);
app.use("/share", publicDemoRoutes);
// SVG → Demo conversion entries (Path B's UI right-click "Make interactive"
// uses this; Path A's MCP `create_demo_from_taste` proxies to it via HTTP).
// See docs/svg-to-demo-plan.md.
app.use("/api/svg-to-demo", svgToDemoRoutes);
app.use("/api/agency", agencyRoutes);

// Serve uploaded SVG files
app.use("/uploads", express.static(path.resolve(__dirname, "../../uploads")));

// ═══════ Workspace API ═══════

// GET /api/workspaces/:workspaceId
app.get("/api/workspaces/:workspaceId", async (req, res) => {
  const ws = await getWorkspace(req.params.workspaceId);
  if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
  res.json(ws);
});

// PUT /api/workspaces/:workspaceId — rename workspace
app.put("/api/workspaces/:workspaceId", async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "工作空间名不能为空" }); return;
  }
  const ws = await updateWorkspace(req.params.workspaceId, { name: name.trim() });
  if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
  const clientId = (req.headers["x-client-id"] as string) || "unknown";
  // Broadcast to all tables under this workspace
  eventBus.emitChange({
    type: "workspace:update",
    tableId: "tbl_requirements", // primary table for SSE channel
    clientId,
    timestamp: Date.now(),
    payload: { workspaceId: ws.id, name: ws.name },
  });
  res.json(ws);
});

// GET /api/workspaces/:workspaceId/tables — list tables in workspace
app.get("/api/workspaces/:workspaceId/tables", async (req, res) => {
  const tables = await listTablesForWorkspace(req.params.workspaceId);
  res.json(tables);
});

// GET /api/workspaces/:workspaceId/stats —— 顶栏右栏的指标和 AI 摘要
//   { tables, ideas, designs, demos, totalTokens, summary, slogan, summaryAt }
// totalTokens 是 token_usage 表里 workspace 累计总和（Phase B 之后才会
// 有非零数据）；summary / slogan 在 Phase C 上线前显示默认值。
app.get("/api/workspaces/:workspaceId/stats", async (req, res) => {
  const { workspaceId } = req.params;
  try {
    const [ws, tables, ideas, designs, demos, published, tokenAgg] = await Promise.all([
      // 直接查 workspace 拿 aiSummary / aiSlogan / aiSummaryAt 字段 ——
      // dbStore.getWorkspace 只返回 {id, name},aiSummary 永远是 undefined,
      // 之前 stats 端点读出来都是 null 就是这个原因。
      prismaForStats.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true, aiSummary: true, aiSlogan: true, aiSummaryAt: true },
      }),
      prismaForStats.table.count({ where: { workspaceId } }),
      prismaForStats.idea.count({ where: { workspaceId } }),
      prismaForStats.design.count({ where: { workspaceId } }),
      prismaForStats.demo.count({ where: { workspaceId } }),
      // workend = 已发布作品数量（V1 仅 demo 有 publishSlug 概念；后续多种 artifact
      // 都能 publish 时这里改成跨类型聚合）
      prismaForStats.demo.count({ where: { workspaceId, publishSlug: { not: null } } }),
      prismaForStats.tokenUsage
        .aggregate({
          _sum: { totalTokens: true },
          where: { workspaceId },
        })
        .catch(() => ({ _sum: { totalTokens: 0 } } as { _sum: { totalTokens: number | null } })),
    ]);
    if (!ws) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const artifacts = tables + ideas + designs + demos;
    res.json({
      workspaceId,
      // 合并后的两个核心数字
      artifacts,
      published,
      // 细分明细保留 —— 内部接口可能要看
      tables,
      ideas,
      designs,
      demos,
      totalTokens: tokenAgg._sum.totalTokens ?? 0,
      summary: ws.aiSummary ?? null,
      slogan: ws.aiSlogan ?? null,
      summaryAt: ws.aiSummaryAt ?? null,
    });
  } catch (err) {
    console.error("[/workspaces/:id/stats]", err);
    res.status(500).json({ error: "stats failed" });
  }
});

// Admin endpoint —— 手动触发 boot-time 那一遍 regenerateMissingSummaries。
// 用于运营 / 调试,把 aiSummary 仍为 null 的 workspace 全部补一遍。fire-and-forget,
// 立即返回(LLM 调用很慢,等会刷新就能看到结果)。
app.post("/api/admin/regenerate-summaries", async (_req, res) => {
  void regenerateMissingSummaries().catch((err) =>
    console.warn("[admin] regenerate-summaries failed:", err),
  );
  res.json({ ok: true, note: "kicked off; check logs / stats after a minute" });
});

// GET /api/workspaces/:workspaceId/tree — full tree (folders + tables + designs + ideas)
app.get("/api/workspaces/:workspaceId/tree", async (req, res) => {
  try {
    const wsId = req.params.workspaceId;
    const [folders, tables, designs, ideas] = await Promise.all([
      treePrisma.folder.findMany({ where: { workspaceId: wsId }, orderBy: { order: "asc" } }),
      treePrisma.table.findMany({ where: { workspaceId: wsId }, orderBy: { order: "asc" } }),
      treePrisma.design.findMany({ where: { workspaceId: wsId }, orderBy: { order: "asc" } }),
      treePrisma.idea.findMany({
        where: { workspaceId: wsId },
        orderBy: { order: "asc" },
        // exclude content — brief only (tree is for sidebar)
        select: { id: true, workspaceId: true, name: true, parentId: true, order: true, createdAt: true, updatedAt: true },
      }),
    ]);
    res.json({ folders, tables, designs, ideas });
  } catch (err: any) {
    console.error("[tree] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// Serve frontend static files in production
const publicDir = path.resolve(__dirname, "../../frontend/dist");
app.use(express.static(publicDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// LAST middleware in the chain — catches any error forwarded via next(err)
// (including async throws auto-forwarded by installAsyncErrorBoundary above).
// Always returns 500 JSON so FE never parses an HTML 502/504 from nginx.
app.use(globalErrorHandler);

async function start() {
  // Connect to PostgreSQL
  await connectDB();
  console.log("Connected to PostgreSQL");

  // Seed mock data only if the table doesn't exist yet
  const existing = await getTable(mockTable.id);
  if (!existing) {
    await loadTable(mockTable);
    console.log("Mock data seeded (first run)");
  } else {
    console.log("Table already exists, skipping seed");
  }

  // Ensure the default Agent exists (DB row + identity filesystem).
  // ensureDefaults() seeds the default user/org/workspace the agent depends on.
  try {
    await ensureDefaults();
    const agent = await ensureDefaultAgent();
    console.log(`Default agent ready: ${agent.id} (${agent.name})`);
  } catch (err) {
    console.error("Failed to ensure default agent:", err);
  }

  // One-shot seed: make sure `user_default` (the legacy seed user) is
  // login-capable as quan / 12345qwert so existing deployments can sign
  // in right after the user-system lands. Idempotent — only stamps fields
  // that are missing (never overwrites a user-set password).
  try {
    await ensureSeedUserCredentials({
      userId: "user_default",
      defaultUsername: "quan",
      defaultPassword: "12345qwert",
      defaultEmail: "quan@imagebase.local",
      defaultName: "Quan",
    });
  } catch (err) {
    console.warn("Failed to seed user credentials (non-fatal):", err);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`AI Filter running on http://0.0.0.0:${PORT}`);
  });

  // Kick off the chat-sidebar prompt-suggestion scheduler. Runs an initial
  // pass on `doc_default` after a short delay and refreshes every 10 min.
  startSuggestionScheduler(["doc_default"]);

  // Phase 4 Day 1+2 · Agent heartbeat. Day 1 plumbing + Day 2 cron handler:
  // on each tick we read the agent's state/cron.json and fire any due jobs
  // into state/inbox.jsonl. More subsystems (inbox consumers, haiku triage)
  // compose into the same handler in later days. Disabled via
  // RUNTIME_DISABLED=1 so smoke tests and one-off scripts don't spawn a
  // background timer.
  // Kick off the model-availability probe. Fires immediately (non-blocking)
  // then every 10 min. Honors RUNTIME_DISABLED so one-off scripts don't spin
  // up a background fetch loop.
  if (process.env.RUNTIME_DISABLED !== "1") {
    startModelProbe();
  }

  // Analyst P1 — DuckDB session + snapshot cleanup cron.
  startAnalystCleanup();
  // V2.6 B14 — worktree stale cleanup (no-op when WORKTREE_REPO_PATH unset)
  startWorktreeCleanupCron();

  if (process.env.RUNTIME_DISABLED !== "1") {
    startHeartbeat({
      onTick: async (ctx) => {
        // V4.6: workspace slogan 不再走 heartbeat 自带的 hidden scheduler,
        // 改为 system habit `habit_system_slogan`(08:00),在 inboxConsumer
        // 里 special-case 直接调用 generateForWorkspace。这样用户能在
        // Habits tab 看到它、toggle 它,跟其他 system habit 一致。
        const cronResult = await evaluateCron(ctx.agentId, ctx.firedAt);
        const details: Record<string, unknown> = {};
        // Recovery: pick up unread cron inbox messages from previous ticks
        // that were dropped by the per-agent lock(老 bug:single module-
        // level boolean,跨 agent 串行 → 慢 agent 跑时其它 agent 的 fire
        // 全被 skip)。merge orphans + 新 fired 一起送 consumer。
        const orphans = await recoverOrphanedJobs(ctx.agentId);
        // Deduplicate: orphans may contain inbox messages that evaluateCron
        // just created (they're already unread in inbox.jsonl by the time
        // recoverOrphanedJobs scans). Without this filter every habit fires twice.
        const freshIds = new Set(cronResult.fired.map((f) => f.inboxMessage.id));
        const dedupedOrphans = orphans.filter((o) => !freshIds.has(o.inboxMessage.id));
        const allJobs = [...dedupedOrphans, ...cronResult.fired];
        if (allJobs.length > 0) {
          details.cronFired = allJobs.map(({ job, inboxMessage }) => ({
            jobId: job.id,
            schedule: job.schedule,
            inboxMessageId: inboxMessage.id,
            recovered: dedupedOrphans.some((o) => o.inboxMessage.id === inboxMessage.id),
          }));
          // Fire-and-forget: run the agent for each fired habit.
          // Don't await — LLM calls can take minutes; we must not block the
          // heartbeat re-entrancy guard.
          void consumeFiredJobs(ctx.agentId, allJobs);
        }
        const invalid = cronResult.skipped.filter((s) => s.reason === "invalid-expression");
        if (invalid.length > 0) {
          details.cronInvalid = invalid.map((s) => ({
            jobId: s.job.id,
            schedule: s.job.schedule,
          }));
        }
        const outcome = cronResult.fired.length > 0 ? "triggered" : "idle";
        return Object.keys(details).length > 0
          ? { outcome, details }
          : { outcome };
      },
    });
  } else {
    console.log("[runtime] heartbeat disabled via RUNTIME_DISABLED=1");
  }

  // Boot-time 补全：扫描 aiSummary IS NULL 的 workspace 并生成。已有摘要的
  // 直接跳过（幂等,重启不浪费 token,不覆盖已有内容）。30s 延迟避免启动期
  // 抢资源；之后由 heartbeat 在 UTC+8 04:00 接管日常刷新。
  if (process.env.RUNTIME_DISABLED !== "1") {
    setTimeout(() => {
      void regenerateMissingSummaries()
        .catch((err) => console.warn("[boot] missing-summary fill failed:", err));
    }, 30_000).unref();
  }

  // Graceful shutdown: let any in-flight tick finish before exiting so we
  // don't leave a half-written heartbeat.log line on SIGTERM.
  const shutdown = async (signal: string) => {
    console.log(`[runtime] received ${signal}, stopping heartbeat + model probe…`);
    try {
      await stopHeartbeat();
      stopModelProbe();
      await stopAnalystCleanup();
      stopWorktreeCleanupCron();
    } catch (err) {
      console.error("[runtime] error during shutdown:", err);
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // Last-line-of-defense: one bad request that throws through an un-
  // wrapped async handler used to kill the whole backend → every user
  // got 502 until pm2 restarted. Log loudly but keep the server up;
  // the bad request itself is already lost (res was never sent) but
  // every other in-flight / subsequent request stays happy.
  process.on("uncaughtException", (err) => {
    console.error("[process] uncaughtException — keeping server alive:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[process] unhandledRejection — keeping server alive:", reason);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
