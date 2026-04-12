import { Router, Request, Response } from "express";
import * as store from "../services/dataStore.js";
import { generateFilter } from "../services/aiService.js";
import { FilterGenerateRequest } from "../types.js";

const router = Router();

// POST /api/ai/filter/generate  — SSE streaming
router.post("/filter/generate", async (req: Request, res: Response) => {
  const body: FilterGenerateRequest = req.body;

  if (!body.query?.trim()) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  const table = store.getTable(body.tableId);
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

  await generateFilter(body, fields, sendEvent);

  res.write("event: done\ndata: {}\n\n");
  res.end();
});

export default router;
