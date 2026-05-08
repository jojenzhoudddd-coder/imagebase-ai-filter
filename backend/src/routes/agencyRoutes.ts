/**
 * Agency Routes — High Agency Mode REST + SSE API
 *
 * POST   /api/agency/sessions          — 创建并启动 agency session
 * GET    /api/agency/sessions/:id       — 获取 session 状态
 * PATCH  /api/agency/sessions/:id       — 中途修改 goal/todos（触发重规划）
 * DELETE /api/agency/sessions/:id       — 取消 session
 * GET    /api/agency/sessions/:id/milestones  — 里程碑列表
 * GET    /api/agency/sessions/:id/checkpoints — 产物列表
 * GET    /api/agency/sessions/:id/events      — SSE 实时事件流
 */

import express, { type Request, type Response } from "express";
import {
  createSession,
  getSession,
  getSessionCheckpoints,
  updateSessionGoalOrTodos,
  cancelSession,
  runAgencyLoop,
  type AgencyEvent,
} from "../services/agencyService.js";

const router = express.Router();

// ─── POST /api/agency/sessions ──────────────────────────────────────────────

router.post("/sessions", async (req: Request, res: Response) => {
  const { userId, agentId, workspaceId, goal, todos, fromScope, chaosMonkeyModel } = req.body;

  if (!workspaceId || !goal) {
    res.status(400).json({ error: "workspaceId and goal are required" });
    return;
  }

  try {
    const session = await createSession({
      userId: userId ?? (req as any).user?.id ?? "user_default",
      agentId,
      workspaceId,
      goal,
      todos,
      fromScope,
      chaosMonkeyModel,
      authToken: (req as any).cookies?.ibase_auth,
    });

    res.status(201).json(session);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agency/sessions/:id ───────────────────────────────────────────

router.get("/sessions/:id", async (req: Request, res: Response) => {
  const session = await getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(session);
});

// ─── PATCH /api/agency/sessions/:id ─────────────────────────────────────────

router.patch("/sessions/:id", async (req: Request, res: Response) => {
  const { goal, todos } = req.body;
  if (goal === undefined && todos === undefined) {
    res.status(400).json({ error: "Provide goal or todos to update" });
    return;
  }

  try {
    const updated = await updateSessionGoalOrTodos(req.params.id, { goal, todos });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/agency/sessions/:id ────────────────────────────────────────

router.delete("/sessions/:id", async (req: Request, res: Response) => {
  try {
    await cancelSession(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agency/sessions/:id/milestones ────────────────────────────────

router.get("/sessions/:id/milestones", async (req: Request, res: Response) => {
  const session = await getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(session.milestones);
});

// ─── GET /api/agency/sessions/:id/checkpoints ───────────────────────────────

router.get("/sessions/:id/checkpoints", async (req: Request, res: Response) => {
  const checkpoints = await getSessionCheckpoints(req.params.id);
  res.json(checkpoints);
});

// ─── GET /api/agency/sessions/:id/events (SSE) ──────────────────────────────

// Active SSE connections per session (for broadcasting from external triggers)
const sseConnections = new Map<string, Set<Response>>();

export function broadcastAgencyEvent(sessionId: string, event: AgencyEvent) {
  const conns = sseConnections.get(sessionId);
  if (!conns) return;
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  for (const res of conns) {
    try { res.write(payload); } catch { /* connection closed */ }
  }
}

router.get("/sessions/:id/events", async (req: Request, res: Response) => {
  const sessionId = req.params.id;
  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ sessionId, status: session.status })}\n\n`);

  // Register connection
  if (!sseConnections.has(sessionId)) sseConnections.set(sessionId, new Set());
  sseConnections.get(sessionId)!.add(res);

  // SSE heartbeat — prevent browser/nginx from closing idle connections.
  // Agency milestones can take 60s+ with no events; without heartbeat the
  // TCP connection silently dies after ~42s (browser keep-alive timeout).
  const heartbeat = setInterval(() => {
    try { res.write(`:heartbeat\n\n`); } catch { /* connection closed */ }
  }, 15_000);

  // Cleanup on close
  req.on("close", () => {
    clearInterval(heartbeat);
    sseConnections.get(sessionId)?.delete(res);
    if (sseConnections.get(sessionId)?.size === 0) sseConnections.delete(sessionId);
  });

  // If session is in planning status, start the loop in background.
  // The loop runs independently of any single SSE connection — browser
  // disconnect / refresh / network blip will NOT abort it. Events are
  // broadcast to all connected SSE listeners via broadcastAgencyEvent.
  if (session.status === "planning") {
    (async () => {
      try {
        for await (const event of runAgencyLoop(sessionId, {
          authToken: (req as any).cookies?.ibase_auth,
          // No abortSignal — loop is not tied to any SSE connection
        })) {
          broadcastAgencyEvent(sessionId, event);
        }
      } catch (err: any) {
        broadcastAgencyEvent(sessionId, { type: "error", data: { message: err.message } });
      }
    })();
  }

  // Keep SSE connection open for receiving broadcast events.
  // Works for both first-connect and reconnect scenarios.
});

// ─── POST /api/agency/sessions/:id/start — manually start/resume ────────────

router.post("/sessions/:id/start", async (req: Request, res: Response) => {
  const sessionId = req.params.id;
  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  if (session.status !== "planning" && session.status !== "replanning") {
    res.status(409).json({ error: `Session is in ${session.status} status, cannot start` });
    return;
  }

  // Start loop in background, broadcast to SSE connections
  res.json({ ok: true, message: "Agency loop started" });

  // Fire and forget — events go to SSE connections
  (async () => {
    try {
      for await (const event of runAgencyLoop(sessionId, {
        authToken: (req as any).cookies?.ibase_auth,
      })) {
        broadcastAgencyEvent(sessionId, event);
      }
    } catch (err: any) {
      broadcastAgencyEvent(sessionId, { type: "error", data: { message: err.message } });
    }
  })();
});

export default router;
