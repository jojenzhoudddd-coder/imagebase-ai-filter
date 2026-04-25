import { Router, Request, Response } from "express";
import * as store from "../services/dbStore.js";
import { generateFilter } from "../services/aiService.js";
import { suggestFields } from "../services/fieldSuggestService.js";
import { generateTableFields } from "../services/tableGenerateService.js";
import { FilterGenerateRequest } from "../types.js";

const router = Router();

// POST /api/ai/filter/generate  — SSE streaming
router.post("/filter/generate", async (req: Request, res: Response) => {
  const body: FilterGenerateRequest = req.body;

  if (!body.query?.trim()) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  const table = await store.getTable(body.tableId);
  if (!table) {
    res.status(404).json({ error: "Table not found" });
    return;
  }

  const fields = table.fields;

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendEvent = (event: string, data: object) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("start", { requestId: `req-${Date.now()}` });

  const userId = (req as any).user?.id ?? null;
  await generateFilter(body, fields, sendEvent, {
    userId,
    workspaceId: (table as any).workspaceId ?? null,
  });

  res.write("event: done\ndata: {}\n\n");
  res.end();
});

// POST /api/ai/fields/suggest  — AI field recommendations
router.post("/fields/suggest", async (req: Request, res: Response) => {
  const { tableId, title, excludeNames, forceRefresh } = req.body;

  if (!tableId) {
    res.status(400).json({ error: "tableId is required" });
    return;
  }

  const table = await store.getTable(tableId);
  if (!table) {
    res.status(404).json({ error: "Table not found" });
    return;
  }

  try {
    const userId = (req as any).user?.id ?? null;
    const result = await suggestFields(
      { tableId, title, excludeNames, forceRefresh },
      { userId, workspaceId: (table as any).workspaceId ?? null },
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// POST /api/ai/table/generate  — SSE streaming (AI table structure generation)
router.post("/table/generate", async (req: Request, res: Response) => {
  const { tableName } = req.body;

  if (!tableName?.trim()) {
    res.status(400).json({ error: "tableName is required" });
    return;
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendEvent = (event: string, data: object) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("start", { requestId: `req-${Date.now()}` });

  try {
    const userId = (req as any).user?.id ?? null;
    const workspaceId = (typeof req.body?.workspaceId === "string" ? req.body.workspaceId : null) ?? null;
    const fields = await generateTableFields(tableName.trim(), {
      userId,
      workspaceId,
    });
    sendEvent("fields", { fields });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    sendEvent("error", { code: "AI_ERROR", message });
  }

  res.write("event: done\ndata: {}\n\n");
  res.end();
});

export default router;
