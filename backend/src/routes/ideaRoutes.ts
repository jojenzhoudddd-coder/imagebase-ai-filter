import { Router, Request, Response, NextFunction, RequestHandler } from "express";
import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { eventBus } from "../services/eventBus.js";
import { extractIdeaSections } from "../services/ideaSections.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function getClientId(req: Request): string {
  return (req.headers["x-client-id"] as string) || "unknown";
}

/**
 * Wraps an async Express handler so Prisma/DB errors land in the error
 * middleware instead of becoming unhandled rejections that kill the node
 * process. Without this, a single FK violation (e.g. bad workspaceId) takes
 * the whole backend down — which happened during smoke testing on 2026-04-21.
 */
const asyncHandler = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

/**
 * Idea name dedup within a workspace. Mirrors `generateUniqueDesignName`:
 * append " 1", " 2", … until free. `excludeId` lets rename ignore the
 * idea's own current name.
 */
async function generateUniqueIdeaName(
  workspaceId: string,
  baseName: string,
  excludeId?: string,
): Promise<string> {
  const existing = await prisma.idea.findMany({
    where: { workspaceId, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { name: true },
  });
  const names = new Set(existing.map(i => i.name));
  if (!names.has(baseName)) return baseName;
  let i = 1;
  while (names.has(`${baseName} ${i}`)) i++;
  return `${baseName} ${i}`;
}

const router = Router();

// POST /api/ideas — create idea
// body: { name?: string, workspaceId: string, parentId?: string }
router.post("/", asyncHandler(async (req: Request, res: Response) => {
  const { name, workspaceId, parentId } = req.body;

  const wsId = workspaceId || "doc_default";
  const baseName = (name && typeof name === "string" && name.trim())
    ? name.trim().slice(0, 100)
    : "Idea"; // default label; frontend passes localized default

  // Compute next order across all sibling artifact types at this level.
  const parentFilter = { workspaceId: wsId, parentId: parentId || null };
  const [folderSibs, tableSibs, designSibs, ideaSibs] = await Promise.all([
    prisma.folder.findMany({ where: parentFilter, select: { order: true } }),
    prisma.table.findMany({ where: parentFilter, select: { order: true } }),
    prisma.design.findMany({ where: parentFilter, select: { order: true } }),
    prisma.idea.findMany({ where: parentFilter, select: { order: true } }),
  ]);
  const maxOrder = [...folderSibs, ...tableSibs, ...designSibs, ...ideaSibs]
    .reduce((max, x) => Math.max(max, x.order), -1);

  const uniqueName = await generateUniqueIdeaName(wsId, baseName);

  const idea = await prisma.idea.create({
    data: {
      name: uniqueName,
      workspaceId: wsId,
      parentId: parentId || null,
      order: maxOrder + 1,
    },
  });

  eventBus.emitWorkspaceChange({
    type: "idea:create",
    workspaceId: wsId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { idea: { id: idea.id, name: idea.name, parentId: idea.parentId, order: idea.order } },
  });

  res.status(201).json({
    id: idea.id,
    name: idea.name,
    parentId: idea.parentId,
    order: idea.order,
  });
}));

// PUT /api/ideas/reorder — batch reorder (must be before /:ideaId)
router.put("/reorder", asyncHandler(async (req: Request, res: Response) => {
  const { updates, workspaceId } = req.body;
  if (!Array.isArray(updates)) {
    res.status(400).json({ error: "updates must be an array" });
    return;
  }
  const wsId = workspaceId || "doc_default";
  await Promise.all(
    updates.map((u: { id: string; order: number }) =>
      prisma.idea.update({ where: { id: u.id }, data: { order: u.order } })
    )
  );
  eventBus.emitWorkspaceChange({
    type: "idea:reorder",
    workspaceId: wsId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { updates },
  });
  res.json({ ok: true });
}));

// GET /api/ideas/:ideaId — idea detail (includes content + version)
router.get("/:ideaId", asyncHandler(async (req: Request, res: Response) => {
  const idea = await prisma.idea.findUnique({ where: { id: req.params.ideaId } });
  if (!idea) {
    res.status(404).json({ error: "Idea not found" });
    return;
  }
  res.json({
    id: idea.id,
    workspaceId: idea.workspaceId,
    name: idea.name,
    parentId: idea.parentId,
    order: idea.order,
    content: idea.content,
    version: idea.version,
    createdAt: idea.createdAt.toISOString(),
    updatedAt: idea.updatedAt.toISOString(),
  });
}));

// PUT /api/ideas/:ideaId — save content (optimistic versioning)
// body: { content: string, baseVersion: number }
// 409 on version mismatch: { conflict:true, latest:{content,version} }
router.put("/:ideaId", asyncHandler(async (req: Request, res: Response) => {
  const { content, baseVersion } = req.body;
  if (typeof content !== "string") {
    res.status(400).json({ error: "content must be a string" });
    return;
  }
  if (typeof baseVersion !== "number") {
    res.status(400).json({ error: "baseVersion must be a number" });
    return;
  }

  const existing = await prisma.idea.findUnique({ where: { id: req.params.ideaId } });
  if (!existing) {
    res.status(404).json({ error: "Idea not found" });
    return;
  }

  if (existing.version !== baseVersion) {
    res.status(409).json({
      conflict: true,
      latest: {
        content: existing.content,
        version: existing.version,
      },
    });
    return;
  }

  const nextVersion = existing.version + 1;
  // Re-derive sections from the new content and persist alongside — this
  // keeps `Idea.sections` authoritative without forcing clients to compute
  // or send it, and avoids any drift with the rendered preview (the slug
  // algorithm is shared via `extractIdeaSections`).
  const sections = extractIdeaSections(content);
  const updated = await prisma.idea.update({
    where: { id: existing.id },
    data: { content, version: nextVersion, sections: sections as unknown as any },
  });

  eventBus.emitIdeaChange({
    type: "idea:content-change",
    ideaId: updated.id,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { content: updated.content, version: updated.version },
  });

  res.json({ id: updated.id, version: updated.version, updatedAt: updated.updatedAt.toISOString() });
}));

// PATCH /api/ideas/:ideaId — rename (only)
// body: { name: string }
router.patch("/:ideaId", asyncHandler(async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  const existing = await prisma.idea.findUnique({
    where: { id: req.params.ideaId },
    select: { workspaceId: true },
  });
  if (!existing) {
    res.status(404).json({ error: "Idea not found" });
    return;
  }
  const trimmed = name.trim().slice(0, 100);
  const uniqueName = await generateUniqueIdeaName(existing.workspaceId, trimmed, req.params.ideaId);
  const idea = await prisma.idea.update({
    where: { id: req.params.ideaId },
    data: { name: uniqueName },
  });
  eventBus.emitWorkspaceChange({
    type: "idea:rename",
    workspaceId: idea.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { ideaId: idea.id, name: idea.name },
  });
  // Also push to the entity channel so open editors refresh the title.
  eventBus.emitIdeaChange({
    type: "idea:rename",
    ideaId: idea.id,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { name: idea.name },
  });
  res.json({ id: idea.id, name: idea.name });
}));

// DELETE /api/ideas/:ideaId
router.delete("/:ideaId", asyncHandler(async (req: Request, res: Response) => {
  const idea = await prisma.idea.findUnique({ where: { id: req.params.ideaId } });
  if (!idea) {
    res.status(404).json({ error: "Idea not found" });
    return;
  }
  await prisma.idea.delete({ where: { id: idea.id } });
  eventBus.emitWorkspaceChange({
    type: "idea:delete",
    workspaceId: idea.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { ideaId: idea.id },
  });
  res.json({ ok: true });
}));

export default router;
