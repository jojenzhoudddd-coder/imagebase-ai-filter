import { Router, Request, Response } from "express";
import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { eventBus } from "../services/eventBus.js";
import { parseFigmaUrl, extractNameFromUrl } from "../utils/figmaParser.js";
import path from "path";
import fs from "fs/promises";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function getClientId(req: Request): string {
  return (req.headers["x-client-id"] as string) || "unknown";
}

/**
 * Ensure design name is unique within the workspace. Mirrors the folder/table
 * dedup rule: append " 1", " 2", … until free. `excludeId` lets renames
 * ignore the design's own current name.
 */
async function generateUniqueDesignName(
  workspaceId: string,
  baseName: string,
  excludeId?: string,
): Promise<string> {
  const existing = await prisma.design.findMany({
    where: { workspaceId, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { name: true },
  });
  const names = new Set(existing.map(d => d.name));
  if (!names.has(baseName)) return baseName;
  let i = 1;
  while (names.has(`${baseName} ${i}`)) i++;
  return `${baseName} ${i}`;
}

const router = Router();

// POST /api/designs — create design (figmaUrl is optional; blank canvas if omitted)
router.post("/", async (req: Request, res: Response) => {
  const { name, figmaUrl, workspaceId, parentId } = req.body;

  let parsed: { fileKey: string; nodeId: string | null } | null = null;
  if (figmaUrl && typeof figmaUrl === "string" && figmaUrl.trim()) {
    parsed = parseFigmaUrl(figmaUrl.trim());
    if (!parsed) {
      res.status(400).json({ error: "Invalid Figma URL" });
      return;
    }
  }

  const docId = workspaceId || "doc_default";
  const finalName = (name && typeof name === "string" && name.trim())
    ? name.trim().slice(0, 100)
    : (figmaUrl ? extractNameFromUrl(figmaUrl) : "Untitled Canvas");

  // Compute next order
  const siblings = await prisma.design.findMany({
    where: { workspaceId: docId, parentId: parentId || null },
  });
  const maxOrder = siblings.reduce((max, d) => Math.max(max, d.order), -1);

  const uniqueName = await generateUniqueDesignName(docId, finalName);

  const design = await prisma.design.create({
    data: {
      name: uniqueName,
      workspaceId: docId,
      parentId: parentId || null,
      order: maxOrder + 1,
      figmaUrl: parsed ? figmaUrl.trim() : null,
      figmaFileKey: parsed?.fileKey || null,
      figmaNodeId: parsed?.nodeId || null,
    },
  });

  eventBus.emitWorkspaceChange({
    type: "design:create",
    workspaceId: docId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { design: { id: design.id, name: design.name, parentId: design.parentId, order: design.order } },
  });

  res.status(201).json({
    id: design.id,
    name: design.name,
    parentId: design.parentId,
    order: design.order,
    figmaUrl: design.figmaUrl,
    figmaFileKey: design.figmaFileKey,
    figmaNodeId: design.figmaNodeId,
  });
});

// PUT /api/designs/reorder — batch reorder designs (must be before /:designId)
router.put("/reorder", async (req: Request, res: Response) => {
  const { updates, workspaceId } = req.body;
  if (!Array.isArray(updates)) {
    res.status(400).json({ error: "updates must be an array" });
    return;
  }
  const docId = workspaceId || "doc_default";
  await Promise.all(
    updates.map((u: { id: string; order: number }) =>
      prisma.design.update({ where: { id: u.id }, data: { order: u.order } })
    )
  );
  eventBus.emitWorkspaceChange({
    type: "design:reorder",
    workspaceId: docId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { updates },
  });
  res.json({ ok: true });
});

// GET /api/designs/:designId — get design details (includes tastes)
router.get("/:designId", async (req: Request, res: Response) => {
  const design = await prisma.design.findUnique({
    where: { id: req.params.designId },
    include: { tastes: { orderBy: { order: "asc" } } },
  });
  if (!design) {
    res.status(404).json({ error: "Design not found" });
    return;
  }
  res.json({
    id: design.id,
    name: design.name,
    parentId: design.parentId,
    order: design.order,
    figmaUrl: design.figmaUrl,
    figmaFileKey: design.figmaFileKey,
    figmaNodeId: design.figmaNodeId,
    tastes: design.tastes,
  });
});

// PUT /api/designs/:designId — rename design
router.put("/:designId", async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  try {
    const existing = await prisma.design.findUnique({
      where: { id: req.params.designId },
      select: { workspaceId: true },
    });
    if (!existing) throw new Error("not found");
    const trimmed = name.trim().slice(0, 100);
    const uniqueName = await generateUniqueDesignName(existing.workspaceId, trimmed, req.params.designId);
    const design = await prisma.design.update({
      where: { id: req.params.designId },
      data: { name: uniqueName },
    });
    eventBus.emitWorkspaceChange({
      type: "design:rename",
      workspaceId: design.workspaceId,
      clientId: getClientId(req),
      timestamp: Date.now(),
      payload: { designId: design.id, name: design.name },
    });
    res.json({ id: design.id, name: design.name });
  } catch {
    res.status(404).json({ error: "Design not found" });
  }
});

// DELETE /api/designs/:designId (cascade deletes tastes; also cleans up uploaded files)
router.delete("/:designId", async (req: Request, res: Response) => {
  const design = await prisma.design.findUnique({ where: { id: req.params.designId } });
  if (!design) {
    res.status(404).json({ error: "Design not found" });
    return;
  }
  await prisma.design.delete({ where: { id: design.id } });

  // Best-effort cleanup of uploaded SVG files
  const uploadsDir = path.resolve(__dirname, "../../../uploads/svgs", design.id);
  fs.rm(uploadsDir, { recursive: true, force: true }).catch(() => {});

  eventBus.emitWorkspaceChange({
    type: "design:delete",
    workspaceId: design.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { designId: design.id },
  });
  res.json({ ok: true });
});

export default router;
