/**
 * /api/agents/* routes — Agent metadata + identity files.
 *
 * Agent list/create is user-scoped through the authenticated request user.
 * Agent-id routes are protected by the global artifact access middleware.
 *
 * Metadata (DB):
 *   GET    /api/agents                            — list agents for default user
 *   POST   /api/agents                            — create agent { name?, avatarUrl? }
 *   GET    /api/agents/:agentId                   — agent metadata
 *   PUT    /api/agents/:agentId                   — rename / update avatar
 *   DELETE /api/agents/:agentId                   — remove DB row (fs preserved)
 *
 * Identity files (filesystem):
 *   GET    /api/agents/:agentId/identity          — { soul, profile, config }
 *   PUT    /api/agents/:agentId/identity/soul     — { content } replaces soul.md
 *   PUT    /api/agents/:agentId/identity/profile  — { content } replaces profile.md
 *   PUT    /api/agents/:agentId/identity/config   — JSON patch merged into config.json
 *
 * Runtime state (filesystem, Phase 4):
 *   GET    /api/agents/:agentId/inbox             — list messages (?unread=1 filter, ?limit=N)
 *   POST   /api/agents/:agentId/inbox/:msgId/ack  — mark one message as read
 *   GET    /api/agents/:agentId/cron              — list cron jobs
 *   POST   /api/agents/:agentId/cron              — add cron { schedule, prompt, workspaceId?, skills? }
 *   DELETE /api/agents/:agentId/cron/:jobId       — remove cron job
 *   GET    /api/agents/:agentId/heartbeat         — recent heartbeat entries (?tail=N)
 *
 * Model selection (multi-model feature):
 *   GET    /api/agents/models                     — visible models + availability
 *   GET    /api/agents/:agentId/model             — { selected, resolved, usedFallback }
 *   PUT    /api/agents/:agentId/model             — body { modelId }, validates whitelist
 */

import express, { type Request, type Response } from "express";
import path from "path";
import fsp from "fs/promises";
import crypto from "crypto";
import { fileURLToPath } from "url";
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgentRow,
  readSoul,
  writeSoul,
  readProfile,
  writeProfile,
  readConfig,
  writeConfig,
  readInbox,
  ackInboxMessage,
  inboxUnreadCount,
  readHeartbeatLog,
  getSelectedModel,
  setSelectedModel,
  getModelStrengthOverrides,
  setModelStrengthOverride,
  getDisabledBuiltinSkills,
  setBuiltinSkillEnabled,
  getUserSkillEnabledOverride,
  setUserSkillEnabledForWorkspace,
  setIntegrationEnabledForWorkspace,
  setHabitOverride,
  type AgentConfig,
} from "../services/agentService.js";

// ESM shim — same pattern as authRoutes for resolving the avatars upload dir.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  addCronJob,
  removeCronJob,
  listCronJobs,
} from "../services/cronScheduler.js";
import { listActivities } from "../services/conversationStore.js";
import { listEpisodicMemories, readWorkingMemoryForWorkspace } from "../services/agentService.js";
import pg from "pg";
import { allSkills } from "../../mcp-server/src/skills/index.js";

// Pool for raw queries (skill last-used lookups)
const _agentPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pg.types.setTypeParser(1114, (str: string) => new Date(str + "Z"));
import { listUserSkills, deleteUserSkill } from "../services/userSkill/userSkillStore.js";
import {
  createAgentIntegration,
  deleteAgentIntegration,
  ensureSystemIntegrations,
  listAgentIntegrations,
  updateAgentIntegration,
} from "../services/integrations/integrationStore.js";
import { testIntegration } from "../services/integrations/integrationRuntime.js";
import { listIntegrationPresets } from "../services/integrations/providerCatalog.js";
import {
  listVisibleModels,
  getModel,
  resolveModelForCall,
  resolveCustomModel,
  DEFAULT_MODEL_ID,
  FALLBACK_MODEL_ID,
} from "../services/modelRegistry.js";
import { currentUser, requireAuth } from "../services/authService.js";

const router = express.Router();

function readWorkspaceId(req: Request): string | undefined {
  const queryValue = req.query.workspaceId;
  const bodyValue = (req.body as any)?.workspaceId;
  const raw = typeof queryValue === "string" ? queryValue : typeof bodyValue === "string" ? bodyValue : "";
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function requireWorkspaceId(req: Request, res: Response): string | null {
  const workspaceId = readWorkspaceId(req);
  if (!workspaceId) {
    res.status(400).json({ error: "workspaceId is required" });
    return null;
  }
  return workspaceId;
}

// ─── Metadata ───

router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = currentUser(req)!;
    const agents = await listAgents(user.id);
    res.json(agents);
  } catch (err: any) {
    console.error("[agents] list error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

router.post("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = currentUser(req)!;
    const { name, avatarUrl } = req.body ?? {};
    const agent = await createAgent({
      userId: user.id,
      name: typeof name === "string" ? name : undefined,
      avatarUrl: typeof avatarUrl === "string" ? avatarUrl : null,
    });
    res.status(201).json(agent);
  } catch (err: any) {
    console.error("[agents] create error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

// ─── Model registry (multi-model feature) ───
//
// Registered BEFORE the `/:agentId` routes so Express doesn't match
// "models" as an agentId.

router.get("/models", async (req: Request, res: Response) => {
  try {
    const builtinModels = listVisibleModels().map((m) => ({
      id: m.id,
      displayName: m.displayName,
      provider: m.provider,
      group: m.group,
      available: m.available === true,
      capabilities: m.capabilities,
      specialty: m.specialty,
      strengths: m.strengths,
      modality: m.modality,
      costHint: m.costHint,
      parallelLimit: m.parallelLimit ?? null,
      type: "builtin" as const,
    }));

    // Merge user's custom models if authenticated
    let customModels: Array<Record<string, unknown>> = [];
    const user = (req as any).user;
    if (user) {
      try {
        const pg2 = await import("pg");
        const { PrismaPg: PA } = await import("@prisma/adapter-pg");
        const { PrismaClient: PC } = await import("../generated/prisma/client.js");
        const p = new pg2.default.Pool({ connectionString: process.env.DATABASE_URL });
        const prisma = new PC({ adapter: new PA(p) });
        const rows = await prisma.customModel.findMany({
          where: { userId: user.id, visible: true },
        });
        customModels = rows.map((r: any) => ({
          id: r.modelId,
          dbId: r.id,
          displayName: r.displayName,
          provider: r.provider,
          group: r.group,
          available: r.available,
          capabilities: r.capabilities ?? {},
          specialty: r.specialty,
          strengths: [],
          modality: ["text"],
          costHint: null,
          parallelLimit: null,
          type: "custom" as const,
        }));
        await p.end();
      } catch { /* non-fatal: just return builtins */ }
    }

    // Non-internal users (related=false) can only see volcano (doubao) builtin models,
    // but custom models are always visible — the user added them themselves.
    const isRelated = !!(user as any)?.related;
    const visibleBuiltin = isRelated
      ? builtinModels
      : builtinModels.filter((m) => m.group === "volcano");

    res.json({
      models: [...visibleBuiltin, ...customModels],
      defaultModelId: isRelated ? DEFAULT_MODEL_ID : FALLBACK_MODEL_ID,
    });
  } catch (err: any) {
    console.error("[agents] list models error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

router.get("/:agentId", async (req: Request, res: Response) => {
  const agent = await getAgent(req.params.agentId);
  if (!agent) {
    res.status(404).json({ error: "agent not found" });
    return;
  }
  res.json(agent);
});

router.put("/:agentId", async (req: Request, res: Response) => {
  const { name, avatarUrl } = req.body ?? {};
  if (name !== undefined && typeof name !== "string") {
    res.status(400).json({ error: "name 必须是字符串" });
    return;
  }
  if (avatarUrl !== undefined && avatarUrl !== null && typeof avatarUrl !== "string") {
    res.status(400).json({ error: "avatarUrl 必须是字符串或 null" });
    return;
  }
  const agent = await updateAgent(req.params.agentId, { name, avatarUrl });
  if (!agent) {
    res.status(404).json({ error: "agent not found" });
    return;
  }
  res.json(agent);
});

// ─── POST /api/agents/:agentId/avatar ───
// Body: { dataUrl }  — data URL (PNG/JPG/GIF/WebP),已由 FE 完成裁剪 + 压缩
// 镜像 /api/auth/avatar 的实现:解码 → 写盘到 /uploads/avatars → 更新 Agent.avatarUrl
router.post("/:agentId/avatar", async (req: Request, res: Response) => {
  const agentId = req.params.agentId;
  const existing = await getAgent(agentId);
  if (!existing) {
    res.status(404).json({ error: "agent not found" });
    return;
  }
  const { dataUrl } = req.body ?? {};
  if (typeof dataUrl !== "string") {
    res.status(400).json({ error: "dataUrl required", code: "MISSING_FIELDS" });
    return;
  }
  const m = /^data:(image\/(png|jpe?g|gif|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) {
    res.status(400).json({ error: "unsupported image format", code: "AVATAR_INVALID" });
    return;
  }
  const ext = m[2] === "jpeg" ? "jpg" : m[2];
  const bytes = Buffer.from(m[3], "base64");
  if (bytes.length > 2 * 1024 * 1024) {
    res.status(413).json({ error: "avatar too large (max 2MB)", code: "AVATAR_TOO_LARGE" });
    return;
  }
  // 与 authRoutes 用同一个 dir,这样静态 mount 不需要新增配置
  const dir = path.resolve(__dirname, "../../../uploads/avatars");
  await fsp.mkdir(dir, { recursive: true });
  const hash = crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 12);
  const fileName = `agent_${agentId}_${hash}.${ext}`;
  const abs = path.join(dir, fileName);
  await fsp.writeFile(abs, bytes);
  const avatarUrl = `/uploads/avatars/${fileName}`;
  const updated = await updateAgent(agentId, { avatarUrl });
  res.json({ agent: updated });
});

router.delete("/:agentId", async (req: Request, res: Response) => {
  const ok = await deleteAgentRow(req.params.agentId);
  if (!ok) {
    res.status(404).json({ error: "agent not found" });
    return;
  }
  res.status(204).end();
});

// ─── Identity bundle ───

router.get("/:agentId/identity", async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const [soul, profile, config] = await Promise.all([
      readSoul(agent.id),
      readProfile(agent.id),
      readConfig(agent.id),
    ]);
    res.json({ soul, profile, config });
  } catch (err: any) {
    console.error("[agents] identity read error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

router.put("/:agentId/identity/soul", async (req: Request, res: Response) => {
  try {
    const { content } = req.body ?? {};
    if (typeof content !== "string") {
      res.status(400).json({ error: "content 必须是字符串" });
      return;
    }
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    await writeSoul(agent.id, content);
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[agents] soul write error:", err);
    res.status(400).json({ error: err.message ?? "write failed" });
  }
});

router.put("/:agentId/identity/profile", async (req: Request, res: Response) => {
  try {
    const { content } = req.body ?? {};
    if (typeof content !== "string") {
      res.status(400).json({ error: "content 必须是字符串" });
      return;
    }
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    await writeProfile(agent.id, content);
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[agents] profile write error:", err);
    res.status(400).json({ error: err.message ?? "write failed" });
  }
});

router.put("/:agentId/identity/config", async (req: Request, res: Response) => {
  try {
    const patch = (req.body ?? {}) as Partial<AgentConfig>;
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      res.status(400).json({ error: "body 必须是 JSON 对象" });
      return;
    }
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const next = await writeConfig(agent.id, patch);
    res.json(next);
  } catch (err: any) {
    console.error("[agents] config write error:", err);
    res.status(400).json({ error: err.message ?? "write failed" });
  }
});

// ─── Per-agent model selection ───
//
// Split out from the generic identity/config PUT so the UI doesn't have to
// understand AgentConfig's shape — it just POSTs a modelId and gets back the
// resolved model (which may differ if the requested one is currently
// unavailable). The saved preference is never overwritten on fallback — the
// next turn auto-recovers when availability flips back.

router.get("/:agentId/model", async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const user = (req as any).user;
    const isRelated = !!user?.related;
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;
    const selected = await getSelectedModel(agent.id, workspaceId);
    let { resolved, requested, usedFallback } = resolveModelForCall(selected);

    // If builtin resolution fell back, try loading as a custom model
    if (usedFallback && selected && user?.id) {
      const custom = await resolveCustomModel(selected, user.id);
      if (custom) {
        resolved = custom;
        usedFallback = false;
      }
    }

    // Non-related users: force volcano model for builtin non-volcano models,
    // but allow custom models (user provided their own API key)
    if (!isRelated && resolved.group !== "volcano" && !resolved.customApiKey) {
      const fb = resolveModelForCall(FALLBACK_MODEL_ID);
      resolved = fb.resolved;
      usedFallback = true;
    }

    res.json({
      selected: (isRelated || resolved.customApiKey) ? selected : resolved.id,
      resolved: {
        id: resolved.id,
        displayName: resolved.displayName,
        provider: resolved.provider,
        group: resolved.group,
        available: resolved.available !== false,
      },
      requested: requested
        ? {
            id: requested.id,
            displayName: requested.displayName,
            available: requested.available,
          }
        : null,
      usedFallback,
      workspaceId: workspaceId ?? null,
    });
  } catch (err: any) {
    console.error("[agents] get model error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

router.put("/:agentId/model", async (req: Request, res: Response) => {
  try {
    const { modelId } = req.body ?? {};
    if (typeof modelId !== "string" || !modelId) {
      res.status(400).json({ error: "modelId is required" });
      return;
    }
    const user = (req as any).user;
    // Check builtin registry first, then user's custom models
    let entry = getModel(modelId);
    let isCustom = false;
    if (!entry && user?.id) {
      const custom = await resolveCustomModel(modelId, user.id);
      if (custom) { entry = custom; isCustom = true; }
    }
    if (!entry) {
      res.status(400).json({ error: `unknown modelId: ${modelId}` });
      return;
    }
    if (!isCustom && !entry.visible) {
      res.status(400).json({ error: `modelId not selectable: ${modelId}` });
      return;
    }
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;
    await setSelectedModel(agent.id, modelId, workspaceId);
    res.json({
      selected: modelId,
      resolved: {
        id: entry.id,
        displayName: entry.displayName,
        provider: entry.provider,
        group: entry.group,
        available: entry.available !== false,
      },
      usedFallback: false,
      workspaceId: workspaceId ?? null,
    });
  } catch (err: any) {
    console.error("[agents] set model error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

// ─── V2.7 B18: per-agent model strength overrides ─────────────────────
// GET 返回 { overrides: { modelId: ["strength", ...] } }
// PUT 单条:body { modelId, strengths: string[] } (空数组 = 重置为 registry 默认)

router.get("/:agentId/model-strengths", async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const overrides = await getModelStrengthOverrides(agent.id);
    res.json({ overrides });
  } catch (err: any) {
    console.error("[agents] get model-strengths error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

router.put("/:agentId/model-strengths", async (req: Request, res: Response) => {
  try {
    const { modelId, strengths } = req.body ?? {};
    if (typeof modelId !== "string" || !modelId) {
      res.status(400).json({ error: "modelId is required" });
      return;
    }
    if (!Array.isArray(strengths)) {
      res.status(400).json({ error: "strengths must be an array" });
      return;
    }
    if (!getModel(modelId)) {
      res.status(400).json({ error: `unknown modelId: ${modelId}` });
      return;
    }
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const next = await setModelStrengthOverride(
      agent.id,
      modelId,
      strengths.map((s: any) => String(s)),
    );
    res.json({ overrides: next });
  } catch (err: any) {
    console.error("[agents] set model-strengths error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

// ─── Runtime state: inbox / cron / heartbeat (Phase 4) ───

router.get("/:agentId/inbox", async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const onlyUnread = req.query.unread === "1" || req.query.unread === "true";
    const limitRaw = req.query.limit;
    const limit = typeof limitRaw === "string" ? parseInt(limitRaw, 10) : undefined;
    const messages = await readInbox(agent.id, {
      onlyUnread,
      limit: Number.isFinite(limit) && limit! > 0 ? limit : undefined,
    });
    const unreadCount = await inboxUnreadCount(agent.id);
    res.json({ messages, unreadCount });
  } catch (err: any) {
    console.error("[agents] inbox read error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

router.post("/:agentId/inbox/:msgId/ack", async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const msg = await ackInboxMessage(agent.id, req.params.msgId);
    if (!msg) {
      res.status(404).json({ error: "message not found" });
      return;
    }
    res.json(msg);
  } catch (err: any) {
    console.error("[agents] inbox ack error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

router.get("/:agentId/cron", async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;
    const jobs = await listCronJobs(agent.id, { workspaceId });
    res.json(jobs);
  } catch (err: any) {
    console.error("[agents] cron list error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

router.post("/:agentId/cron", async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;
    const { schedule, prompt, skills, meta } = req.body ?? {};
    if (typeof schedule !== "string" || !schedule.trim()) {
      res.status(400).json({ error: "schedule 必须是非空字符串 (cron expression)" });
      return;
    }
    if (typeof prompt !== "string" || !prompt.trim()) {
      res.status(400).json({ error: "prompt 必须是非空字符串" });
      return;
    }
    if (skills !== undefined && !Array.isArray(skills)) {
      res.status(400).json({ error: "skills 必须是字符串数组" });
      return;
    }
    const job = await addCronJob(agent.id, {
      schedule: schedule.trim(),
      prompt: prompt.trim(),
      workspaceId,
      skills: Array.isArray(skills) ? skills.filter((s) => typeof s === "string") : undefined,
      meta: typeof meta === "object" && meta !== null && !Array.isArray(meta) ? meta : undefined,
    });
    res.status(201).json(job);
  } catch (err: any) {
    console.error("[agents] cron add error:", err);
    const status = /invalid cron schedule/.test(err?.message ?? "") ? 400 : 500;
    res.status(status).json({ error: err.message ?? "internal error" });
  }
});

router.delete("/:agentId/cron/:jobId", async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const ok = await removeCronJob(agent.id, req.params.jobId);
    if (!ok) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    res.status(204).end();
  } catch (err: any) {
    console.error("[agents] cron remove error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

router.get("/:agentId/heartbeat", async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const tailRaw = req.query.tail;
    const tail = typeof tailRaw === "string" ? parseInt(tailRaw, 10) : 50;
    const entries = await readHeartbeatLog(agent.id, {
      tail: Number.isFinite(tail) && tail > 0 ? tail : 50,
    });
    res.json(entries);
  } catch (err: any) {
    console.error("[agents] heartbeat read error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

// ─── Agent Homepage data endpoints ───

/** GET /api/agents/:agentId/memories — all memories (episodic + working) */
router.get("/:agentId/memories", async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const tag = (req.query.tag as string) || undefined;
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;

    // Episodic (compressed long-term)
    const episodic = await listEpisodicMemories(agentId, { limit, tag, workspaceId });

    // Working (recent turns not yet compressed)
    const working = await readWorkingMemoryForWorkspace(agentId, workspaceId);

    res.json({ episodic, working });
  } catch (err: any) {
    console.error("[agents] memories error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** GET /api/agents/:agentId/activities — conversation turns with metadata */
router.get("/:agentId/activities", async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string) || undefined;
    const dateFrom = (req.query.dateFrom as string) || undefined;
    const dateTo = (req.query.dateTo as string) || undefined;
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;
    const result = await listActivities(agentId, { limit, offset, search, dateFrom, dateTo, workspaceId });
    res.json(result);
  } catch (err: any) {
    console.error("[agents] activities error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** GET /api/agents/:agentId/skills — merged builtin + user skills */
router.get("/:agentId/skills", async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;

    // Query last-used time for builtin skills from message source field
    // source stores "skill:table-skill,analyst-skill" etc.
    const skillLastUsedMap = new Map<string, string>();
    try {
      const sourceSql = `
        SELECT m.source, MAX(m.timestamp) AS last_ts
        FROM messages m
        JOIN conversations c ON m."conversationId" = c.id
        WHERE c."agentId" = $1
          ${workspaceId ? `AND c."workspaceId" = $2` : ""}
          AND m.source IS NOT NULL
          AND m.source LIKE 'skill:%'
          AND m.role = 'assistant'
        GROUP BY m.source
      `;
      const { rows: sourceRows } = await _agentPool.query(sourceSql, workspaceId ? [agentId, workspaceId] : [agentId]);
      for (const row of sourceRows) {
        const skills = (row.source as string).replace("skill:", "").split(",");
        const ts = row.last_ts instanceof Date ? row.last_ts.toISOString() : String(row.last_ts);
        for (const s of skills) {
          const prev = skillLastUsedMap.get(s);
          if (!prev || ts > prev) skillLastUsedMap.set(s, ts);
        }
      }
    } catch { /* non-fatal */ }

    // Builtin skills. The enabled state is per-agent/user config, not global.
    const disabledBuiltinSkills = new Set(await getDisabledBuiltinSkills(agentId, workspaceId));
    const builtinSkills = allSkills.map((s) => ({
      id: s.name,
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      triggers: s.triggers
        .map((t) => (typeof t === "string" ? t : t.source))
        .slice(0, 10),
      lastUsed: skillLastUsedMap.get(s.name) ?? null,
      type: "builtin" as const,
      enabled: !disabledBuiltinSkills.has(s.name),
    }));

    // User skills
    let userSkills: Array<{
      id: string; name: string; displayName: string; description: string;
      triggers: string[]; lastUsed: string | null; type: "builtin" | "user"; enabled: boolean;
    }> = [];
    try {
      const rows = await listUserSkills({ ownerType: "agent", ownerId: agentId });
      for (const r of rows) {
        const override = workspaceId
          ? await getUserSkillEnabledOverride(agentId, workspaceId, r.id)
          : undefined;
        userSkills.push({
          id: r.id,
          name: r.name,
          displayName: r.name,
          description: r.description,
          triggers: r.triggers.slice(0, 10),
          lastUsed: r.lastInvokedAt?.toISOString() ?? null,
          type: "user" as const,
          enabled: override ?? r.enabled,
        });
      }
    } catch {
      // If user skill loading fails, still return builtins
    }

    res.json({ skills: [...builtinSkills, ...userSkills] });
  } catch (err: any) {
    console.error("[agents] skills error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** PUT /api/agents/:agentId/skills/:skillId/toggle — toggle builtin/user skill enabled */
router.put("/:agentId/skills/:skillId/toggle", async (req: Request, res: Response) => {
  try {
    const { agentId, skillId } = req.params;
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be boolean" });
      return;
    }
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;
    const builtin = allSkills.find((s) => s.name === skillId);
    if (builtin) {
      await setBuiltinSkillEnabled(agentId, builtin.name, enabled, workspaceId);
      res.json({ ok: true, type: "builtin", skillId: builtin.name, enabled, workspaceId });
      return;
    }
    const rows = await listUserSkills({ ownerType: "agent", ownerId: agentId });
    if (!rows.some((row) => row.id === skillId)) {
      res.status(404).json({ error: "skill not found" });
      return;
    }
    await setUserSkillEnabledForWorkspace(agentId, workspaceId, skillId, enabled);
    res.json({ ok: true, type: "user", skillId, enabled, workspaceId });
  } catch (err: any) {
    console.error("[agents] skill toggle error:", err);
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "internal error" });
  }
});

/** DELETE /api/agents/:agentId/skills/:skillId — delete a user skill */
router.delete("/:agentId/skills/:skillId", async (req: Request, res: Response) => {
  try {
    const { agentId, skillId } = req.params;
    await deleteUserSkill(skillId, { requireOwnerId: agentId });
    res.status(204).end();
  } catch (err: any) {
    console.error("[agents] skill delete error:", err);
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "internal error" });
  }
});

/** GET /api/agents/:agentId/integrations/presets — builtin provider catalog */
router.get("/:agentId/integrations/presets", async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json({ presets: listIntegrationPresets() });
  } catch (err: any) {
    console.error("[agents] integration presets error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** GET /api/agents/:agentId/integrations — installed integrations */
router.get("/:agentId/integrations", async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    await ensureSystemIntegrations(agent.id);
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;
    const integrations = await listAgentIntegrations(agent.id, { workspaceId });
    res.json({ integrations });
  } catch (err: any) {
    console.error("[agents] integrations list error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** POST /api/agents/:agentId/integrations — install integration */
router.post("/:agentId/integrations", async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;
    const requestedEnabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined;
    const integration = await createAgentIntegration({
      agentId: agent.id,
      providerKey: String(req.body?.providerKey ?? ""),
      displayName: typeof req.body?.displayName === "string" ? req.body.displayName : undefined,
      transport: req.body?.transport,
      enabled: false,
      config: req.body?.config,
      toolManifest: req.body?.toolManifest,
      scopes: req.body?.scopes,
      credentials: req.body?.credentials,
    });
    if (typeof requestedEnabled === "boolean") {
      await setIntegrationEnabledForWorkspace(agent.id, workspaceId, integration.id, requestedEnabled);
      const effective = (await listAgentIntegrations(agent.id, { workspaceId }))
        .find((item) => item.id === integration.id) ?? integration;
      res.status(201).json(effective);
      return;
    }
    res.status(201).json(integration);
  } catch (err: any) {
    console.error("[agents] integration create error:", err);
    const status = err?.name === "IntegrationValidationError" ? 400 : 500;
    res.status(status).json({ error: err.message ?? "internal error", field: err.field });
  }
});

/** PUT /api/agents/:agentId/integrations/:integrationId — patch integration */
router.put("/:agentId/integrations/:integrationId", async (req: Request, res: Response) => {
  try {
    const { agentId, integrationId } = req.params;
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;
    const patch: Record<string, unknown> = {};
    for (const key of ["displayName", "transport", "enabled", "config", "toolManifest", "scopes", "credentials"]) {
      if (key in (req.body ?? {})) patch[key] = req.body[key];
    }
    if (typeof patch.enabled === "boolean") {
      const existing = (await listAgentIntegrations(agentId, { workspaceId }))
        .find((item) => item.id === integrationId);
      if (!existing) {
        res.status(404).json({ error: "integration not found" });
        return;
      }
      await setIntegrationEnabledForWorkspace(agentId, workspaceId, integrationId, patch.enabled);
      delete patch.enabled;
    }
    let integration = null;
    if (Object.keys(patch).length > 0) {
      integration = await updateAgentIntegration(integrationId, patch as any, {
        requireAgentId: agentId,
      });
    }
    integration = (await listAgentIntegrations(agentId, { workspaceId }))
      .find((item) => item.id === integrationId) ?? integration;
    res.json(integration);
  } catch (err: any) {
    console.error("[agents] integration update error:", err);
    const status = err?.name === "IntegrationValidationError" ? 400 : err?.name === "IntegrationNotFoundError" ? 404 : 500;
    res.status(status).json({ error: err.message ?? "internal error", field: err.field });
  }
});

/** POST /api/agents/:agentId/integrations/:integrationId/test — health check */
router.post("/:agentId/integrations/:integrationId/test", async (req: Request, res: Response) => {
  try {
    const { agentId, integrationId } = req.params;
    const result = await testIntegration(integrationId, { requireAgentId: agentId });
    res.json(result);
  } catch (err: any) {
    console.error("[agents] integration test error:", err);
    const status = err?.name === "IntegrationNotFoundError" ? 404 : 500;
    res.status(status).json({ error: err.message ?? "internal error" });
  }
});

/** DELETE /api/agents/:agentId/integrations/:integrationId — remove integration */
router.delete("/:agentId/integrations/:integrationId", async (req: Request, res: Response) => {
  try {
    const { agentId, integrationId } = req.params;
    const result = await deleteAgentIntegration(integrationId, { requireAgentId: agentId });
    if (!result.ok) {
      res.status(404).json({ error: "integration not found" });
      return;
    }
    res.status(204).end();
  } catch (err: any) {
    console.error("[agents] integration delete error:", err);
    const status = err?.name === "IntegrationNotFoundError" ? 404 : 500;
    res.status(status).json({ error: err.message ?? "internal error" });
  }
});

/** PUT /api/agents/:agentId/habits/:jobId/toggle — toggle habit enabled */
router.put("/:agentId/habits/:jobId/toggle", async (req: Request, res: Response) => {
  try {
    const { agentId, jobId } = req.params;
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be boolean" });
      return;
    }
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;
    const { readCron } = await import("../services/agentService.js");
    const cronFile = await readCron(agentId);
    const job = cronFile.jobs.find((j: any) => j.id === jobId);
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    await setHabitOverride(agentId, workspaceId, jobId, { enabled });
    res.json({ ok: true, workspaceId });
  } catch (err: any) {
    console.error("[agents] habit toggle error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** PUT /api/agents/:agentId/habits/:jobId/schedule — update habit schedule */
router.put("/:agentId/habits/:jobId/schedule", async (req: Request, res: Response) => {
  try {
    const { agentId, jobId } = req.params;
    const { schedule } = req.body ?? {};
    if (typeof schedule !== "string" || !schedule.trim()) {
      res.status(400).json({ error: "schedule must be a non-empty string" });
      return;
    }
    // Validate cron expression
    const { parseCron } = await import("../services/cronScheduler.js");
    if (!parseCron(schedule.trim())) {
      res.status(400).json({ error: "Invalid cron expression" });
      return;
    }
    const workspaceId = requireWorkspaceId(req, res);
    if (!workspaceId) return;
    const { readCron } = await import("../services/agentService.js");
    const cronFile = await readCron(agentId);
    const job = cronFile.jobs.find((j: any) => j.id === jobId);
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    const nextSchedule = schedule.trim();
    await setHabitOverride(agentId, workspaceId, jobId, { schedule: nextSchedule });
    res.json({ ok: true, schedule: nextSchedule, workspaceId });
  } catch (err: any) {
    console.error("[agents] habit schedule update error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

export default router;
