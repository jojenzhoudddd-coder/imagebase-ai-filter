/**
 * /api/models/custom — user-level custom model CRUD.
 *
 * Per-user storage: each user maintains their own custom model list,
 * shared across all their agents.
 */

import express, { type Request, type Response } from "express";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const router = express.Router();

function currentUser(req: Request): { id: string } | null {
  return (req as any).user ?? null;
}

/** GET /api/models/custom — list current user's custom models */
router.get("/", async (req: Request, res: Response) => {
  try {
    const user = currentUser(req);
    if (!user) { res.status(401).json({ error: "Not authenticated" }); return; }
    const models = await prisma.customModel.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ models });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** POST /api/models/custom — create a custom model */
router.post("/", async (req: Request, res: Response) => {
  try {
    const user = currentUser(req);
    if (!user) { res.status(401).json({ error: "Not authenticated" }); return; }
    const { modelId, displayName, provider, baseUrl, apiKey, providerModelId, capabilities, group, specialty } = req.body ?? {};
    if (!modelId || !displayName || !provider || !baseUrl || !apiKey || !providerModelId) {
      res.status(400).json({ error: "Missing required fields: modelId, displayName, provider, baseUrl, apiKey, providerModelId" });
      return;
    }
    const model = await prisma.customModel.create({
      data: {
        userId: user.id,
        modelId,
        displayName,
        provider,
        baseUrl,
        apiKey,
        providerModelId,
        capabilities: capabilities ?? {},
        group: group ?? "custom",
        specialty: specialty ?? null,
      },
    });
    res.status(201).json(model);
  } catch (err: any) {
    if (err.code === "P2002") {
      res.status(409).json({ error: `Model ID "${req.body?.modelId}" already exists` });
      return;
    }
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** PUT /api/models/custom/:id — update a custom model */
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const user = currentUser(req);
    if (!user) { res.status(401).json({ error: "Not authenticated" }); return; }
    const existing = await prisma.customModel.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== user.id) {
      res.status(404).json({ error: "Model not found" });
      return;
    }
    const { displayName, provider, baseUrl, apiKey, providerModelId, capabilities, group, specialty, visible } = req.body ?? {};
    const model = await prisma.customModel.update({
      where: { id: req.params.id },
      data: {
        ...(displayName !== undefined && { displayName }),
        ...(provider !== undefined && { provider }),
        ...(baseUrl !== undefined && { baseUrl }),
        ...(apiKey !== undefined && { apiKey }),
        ...(providerModelId !== undefined && { providerModelId }),
        ...(capabilities !== undefined && { capabilities }),
        ...(group !== undefined && { group }),
        ...(specialty !== undefined && { specialty }),
        ...(visible !== undefined && { visible }),
      },
    });
    res.json(model);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

/** DELETE /api/models/custom/:id — delete a custom model */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const user = currentUser(req);
    if (!user) { res.status(401).json({ error: "Not authenticated" }); return; }
    const existing = await prisma.customModel.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== user.id) {
      res.status(404).json({ error: "Model not found" });
      return;
    }
    await prisma.customModel.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "internal error" });
  }
});

export default router;
