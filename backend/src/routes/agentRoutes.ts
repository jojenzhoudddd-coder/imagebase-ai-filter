/**
 * /api/agents/* routes — Agent metadata + identity files.
 *
 * MVP (Phase 1) only exposes the default user's agents. When auth lands
 * we'll filter by the authenticated userId.
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
import { listEpisodicMemories, readWorkingMemory } from "../services/agentService.js";
import { allSkills } from "../../mcp-server/src/skills/index.js";
import { listUserSkills, updateUserSkill } from "../services/userSkill/userSkillStore.js";
import {
  listVisibleModels,
  getModel,
  resolveModelForCall,
  DEFAULT_MODEL_ID,
  FALLBACK_MODEL_ID,
} from "../services/modelRegistry.js";

const router = express.Router();

// MVP: hardcode to default user until auth is wired up.
const DEFAULT_USER_ID = "user_default";

// ─── Metadata ───

router.get("/", async (_req: Request, res: Response) => {
  try {
    const agents = await listAgents(DEFAULT_USER_ID);
    res.json(agents);
  } catch (err: any) {
    console.error("[agents] list error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, avatarUrl } = req.body ?? {};
    const agent = await createAgent({
      userId: DEFAULT_USER_ID,
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

    // Non-internal users (related=false) can only see volcano (doubao) models
    const isRelated = !!(user as any)?.related;
    const visibleBuiltin = isRelated
      ? builtinModels
      : builtinModels.filter((m) => m.group === "volcano");
    const visibleCustom = isRelated ? customModels : [];

    res.json({
      models: [...visibleBuiltin, ...visibleCustom],
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
    const isRelated = !!(req as any).user?.related;
    const selected = await getSelectedModel(agent.id);
    let { resolved, requested, usedFallback } = resolveModelForCall(selected);

    // Non-related users: force volcano model
    if (!isRelated && resolved.group !== "volcano") {
      const fb = resolveModelForCall(FALLBACK_MODEL_ID);
      resolved = fb.resolved;
      usedFallback = true;
    }

    res.json({
      selected: isRelated ? selected : resolved.id,
      resolved: {
        id: resolved.id,
        displayName: resolved.displayName,
        provider: resolved.provider,
        group: resolved.group,
        available: resolved.available,
      },
      requested: requested
        ? {
            id: requested.id,
            displayName: requested.displayName,
            available: requested.available,
          }
        : null,
      usedFallback,
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
    const entry = getModel(modelId);
    if (!entry) {
      res.status(400).json({ error: `unknown modelId: ${modelId}` });
      return;
    }
    if (!entry.visible) {
      res.status(400).json({ error: `modelId not selectable: ${modelId}` });
      return;
    }
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    await setSelectedModel(agent.id, modelId);
    // Return the resolved model so UI can surface "using X instead of Y" if
    // the preference is currently unavailable.
    const { resolved, usedFallback } = resolveModelForCall(modelId);
    res.json({
      selected: modelId,
      resolved: {
        id: resolved.id,
        displayName: resolved.displayName,
        provider: resolved.provider,
        group: resolved.group,
        available: resolved.available,
      },
      usedFallback,
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
    const jobs = await listCronJobs(agent.id);
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
    const { schedule, prompt, workspaceId, skills, meta } = req.body ?? {};
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
      workspaceId: typeof workspaceId === "string" ? workspaceId : undefined,
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

    // Episodic (compressed long-term)
    const episodic = await listEpisodicMemories(agentId, { limit, tag });

    // Working (recent turns not yet compressed)
    const working = await readWorkingMemory(agentId);

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
    const result = await listActivities(agentId, { limit, offset, search, dateFrom, dateTo });
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

    // Builtin skills
    const builtinSkills = allSkills.map((s) => ({
      id: s.name,
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      triggers: s.triggers
        .map((t) => (typeof t === "string" ? t : t.source))
        .slice(0, 10),
      lastUsed: null,
      type: "builtin" as const,
      enabled: true,
    }));

    // User skills
    let userSkills: Array<{
      id: string; name: string; displayName: string; description: string;
      triggers: string[]; lastUsed: string | null; type: "builtin" | "user"; enabled: boolean;
    }> = [];
    try {
      const rows = await listUserSkills({ ownerType: "agent", ownerId: agentId });
      userSkills = rows.map((r) => ({
        id: r.id,
        name: r.name,
        displayName: r.name,
        description: r.description,
        triggers: r.triggers.slice(0, 10),
        lastUsed: r.lastInvokedAt?.toISOString() ?? null,
        type: "user" as const,
        enabled: r.enabled,
      }));
    } catch {
      // If user skill loading fails, still return builtins
    }

    res.json({ skills: [...builtinSkills, ...userSkills] });
  } catch (err: any) {
    console.error("[agents] skills error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** PUT /api/agents/:agentId/skills/:skillId/toggle — toggle user skill enabled */
router.put("/:agentId/skills/:skillId/toggle", async (req: Request, res: Response) => {
  try {
    const { agentId, skillId } = req.params;
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be boolean" });
      return;
    }
    await updateUserSkill(skillId, { enabled }, { requireOwnerId: agentId });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[agents] skill toggle error:", err);
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "internal error" });
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
    // Read cron.json, find job, toggle enabled, write back
    const { readCron, writeCron } = await import("../services/agentService.js");
    const cronFile = await readCron(agentId);
    const job = cronFile.jobs.find((j: any) => j.id === jobId);
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    job.enabled = enabled;
    await writeCron(agentId, cronFile);
    res.json({ ok: true });
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
    const { readCron, writeCron } = await import("../services/agentService.js");
    const cronFile = await readCron(agentId);
    const job = cronFile.jobs.find((j: any) => j.id === jobId);
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    job.schedule = schedule.trim();
    await writeCron(agentId, cronFile);
    res.json({ ok: true, schedule: job.schedule });
  } catch (err: any) {
    console.error("[agents] habit schedule update error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

export default router;
