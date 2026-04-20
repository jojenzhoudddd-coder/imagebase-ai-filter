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
 */

import express, { type Request, type Response } from "express";
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
  type AgentConfig,
} from "../services/agentService.js";
import {
  addCronJob,
  removeCronJob,
  listCronJobs,
} from "../services/cronScheduler.js";

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

export default router;
