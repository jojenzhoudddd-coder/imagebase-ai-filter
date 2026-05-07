/**
 * /api/knowledge — Agent knowledge base CRUD + search.
 */

import express, { type Request, type Response } from "express";
import { addKnowledge, listKnowledge, getKnowledge, searchKnowledge, deleteKnowledge, updateKnowledge } from "../services/knowledgeService.js";

const router = express.Router();

/** POST /api/knowledge — add knowledge entry */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { agentId, title, content, sourceUrl, sourceType, tags } = req.body ?? {};
    if (!agentId || !title || !content) {
      res.status(400).json({ error: "agentId, title, content required" });
      return;
    }
    const result = await addKnowledge({ agentId, title, content, sourceUrl, sourceType, tags });
    res.status(201).json(result);
  } catch (err: any) {
    console.error("[knowledge] add error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** GET /api/knowledge — list knowledge entries */
router.get("/", async (req: Request, res: Response) => {
  try {
    const agentId = req.query.agentId as string;
    if (!agentId) { res.status(400).json({ error: "agentId required" }); return; }
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const tag = (req.query.tag as string) || undefined;
    const result = await listKnowledge(agentId, { limit, offset, tag });
    res.json(result);
  } catch (err: any) {
    console.error("[knowledge] list error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** GET /api/knowledge/search — semantic search */
router.get("/search", async (req: Request, res: Response) => {
  try {
    const agentId = req.query.agentId as string;
    const query = req.query.query as string;
    if (!agentId || !query) { res.status(400).json({ error: "agentId and query required" }); return; }
    const limit = parseInt(req.query.limit as string) || 5;
    const results = await searchKnowledge(agentId, query, limit);
    res.json({ results });
  } catch (err: any) {
    console.error("[knowledge] search error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** GET /api/knowledge/:id — get full knowledge entry (reassembled from chunks) */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const agentId = req.query.agentId as string;
    if (!agentId) { res.status(400).json({ error: "agentId required" }); return; }
    const entry = await getKnowledge(agentId, req.params.id);
    if (!entry) { res.status(404).json({ error: "not found" }); return; }
    res.json(entry);
  } catch (err: any) {
    console.error("[knowledge] get error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** PUT /api/knowledge/:id — update an existing knowledge entry in place.
 *  Body: { agentId, title?, content?, sourceUrl?, tags?, mode?: "replace"|"append" }
 *  parentId 保持稳定 —— Agent 之前只能 delete + create,会破坏外部对该
 *  knowledge 的引用(memory/activity/未来反向 ref);这个端点让 Agent 真正
 *  "原地修订",外部引用不变。 */
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const { agentId, title, content, sourceUrl, tags, mode } = req.body ?? {};
    if (!agentId) { res.status(400).json({ error: "agentId required" }); return; }
    if (mode && mode !== "replace" && mode !== "append") {
      res.status(400).json({ error: "mode must be 'replace' or 'append'" });
      return;
    }
    const result = await updateKnowledge({
      agentId,
      id: req.params.id,
      title,
      content,
      sourceUrl,
      tags,
      mode,
    });
    if (!result.ok) {
      res.status(404).json({ error: result.error });
      return;
    }
    res.json(result);
  } catch (err: any) {
    console.error("[knowledge] update error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** DELETE /api/knowledge/:id — delete knowledge entry */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const agentId = req.query.agentId as string;
    if (!agentId) { res.status(400).json({ error: "agentId required" }); return; }
    const ok = await deleteKnowledge(agentId, req.params.id);
    if (!ok) { res.status(404).json({ error: "not found" }); return; }
    res.status(204).end();
  } catch (err: any) {
    console.error("[knowledge] delete error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

export default router;
