import { Router, Request, Response } from "express";
import { eventBus, TableChangeEvent, WorkspaceChangeEvent, IdeaChangeEvent } from "../services/eventBus.js";

const router = Router();

// GET /api/sync/ideas/:ideaId/events?clientId=xxx — per-idea SSE (must be before /:tableId)
router.get("/ideas/:ideaId/events", (req: Request, res: Response) => {
  const { ideaId } = req.params;
  const clientId = req.query.clientId as string;

  if (!clientId) {
    res.status(400).json({ error: "clientId query parameter is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  console.log(`[SSE] client=${clientId} connected (idea=${ideaId})`);
  res.write(
    `event: connected\ndata: ${JSON.stringify({ clientId, timestamp: Date.now() })}\n\n`,
  );

  const unsubscribe = eventBus.subscribeIdea(
    ideaId,
    (event: IdeaChangeEvent) => {
      res.write(
        `event: idea-change\ndata: ${JSON.stringify(event)}\n\n`,
      );
    },
  );

  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: {}\n\n`);
  }, 30_000);

  req.on("close", () => {
    console.log(`[SSE] client=${clientId} disconnected (idea=${ideaId})`);
    unsubscribe();
    clearInterval(heartbeat);
  });
});

// GET /api/sync/workspaces/:workspaceId/events?clientId=xxx — workspace-level SSE (must be before /:tableId)
router.get("/workspaces/:workspaceId/events", (req: Request, res: Response) => {
  const { workspaceId } = req.params;
  const clientId = req.query.clientId as string;

  if (!clientId) {
    res.status(400).json({ error: "clientId query parameter is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  console.log(`[SSE] client=${clientId} connected (workspace=${workspaceId})`);
  res.write(
    `event: connected\ndata: ${JSON.stringify({ clientId, timestamp: Date.now() })}\n\n`,
  );

  const unsubscribe = eventBus.subscribeWorkspace(
    workspaceId,
    (event: WorkspaceChangeEvent) => {
      res.write(
        `event: workspace-change\ndata: ${JSON.stringify(event)}\n\n`,
      );
    },
  );

  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: {}\n\n`);
  }, 30_000);

  req.on("close", () => {
    console.log(`[SSE] client=${clientId} disconnected (workspace=${workspaceId})`);
    unsubscribe();
    clearInterval(heartbeat);
  });
});

// GET /api/sync/:tableId/events?clientId=xxx — table-level SSE
router.get("/:tableId/events", (req: Request, res: Response) => {
  const { tableId } = req.params;
  const clientId = req.query.clientId as string;

  if (!clientId) {
    res.status(400).json({ error: "clientId query parameter is required" });
    return;
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send connected event
  console.log(`[SSE] client=${clientId} connected (table=${tableId})`);
  res.write(
    `event: connected\ndata: ${JSON.stringify({ clientId, timestamp: Date.now() })}\n\n`,
  );

  // Subscribe to table changes
  const unsubscribe = eventBus.subscribe(
    tableId,
    (event: TableChangeEvent) => {
      res.write(
        `event: table-change\ndata: ${JSON.stringify(event)}\n\n`,
      );
    },
  );

  // Heartbeat every 30s to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: {}\n\n`);
  }, 30_000);

  // Cleanup on disconnect
  req.on("close", () => {
    console.log(`[SSE] client=${clientId} disconnected (table=${tableId})`);
    unsubscribe();
    clearInterval(heartbeat);
  });
});

export default router;
