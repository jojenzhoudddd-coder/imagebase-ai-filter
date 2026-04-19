import { Router, Request, Response } from "express";
import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { eventBus } from "../services/eventBus.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function getClientId(req: Request): string {
  return (req.headers["x-client-id"] as string) || "unknown";
}

const router = Router();

// POST /api/folders — create folder
router.post("/", async (req: Request, res: Response) => {
  const { name, parentId, documentId } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "文件夹名不能为空" });
    return;
  }
  const docId = documentId || "doc_default";

  // Compute next order within the same parent
  const siblings = await prisma.folder.findMany({
    where: { documentId: docId, parentId: parentId || null },
  });
  const maxOrder = siblings.reduce((max, f) => Math.max(max, f.order), -1);

  const folder = await prisma.folder.create({
    data: {
      name: name.trim().slice(0, 100),
      documentId: docId,
      parentId: parentId || null,
      order: maxOrder + 1,
    },
  });

  eventBus.emitDocumentChange({
    type: "folder:create",
    documentId: docId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { folder: { id: folder.id, name: folder.name, parentId: folder.parentId, order: folder.order } },
  });

  res.status(201).json({
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    order: folder.order,
  });
});

// PUT /api/folders/move — move item (table or folder) to a new parent
// NOTE: must be before /:folderId to avoid "move" being interpreted as a folder ID
router.put("/move", async (req: Request, res: Response) => {
  const { itemId, itemType, newParentId } = req.body;
  if (!itemId || !itemType) {
    res.status(400).json({ error: "itemId and itemType are required" });
    return;
  }

  const parentId = newParentId || null;

  if (itemType === "table") {
    await prisma.table.update({
      where: { id: itemId },
      data: { parentId },
    });
  } else if (itemType === "folder") {
    // Prevent moving a folder into itself or its descendants
    if (parentId) {
      let current: string | null = parentId;
      while (current) {
        if (current === itemId) {
          res.status(400).json({ error: "Cannot move folder into itself or its descendants" });
          return;
        }
        const parent = await prisma.folder.findUnique({ where: { id: current }, select: { parentId: true } });
        current = parent?.parentId ?? null;
      }
    }
    await prisma.folder.update({
      where: { id: itemId },
      data: { parentId },
    });
  } else if (itemType === "design") {
    await prisma.design.update({
      where: { id: itemId },
      data: { parentId },
    });
  } else {
    res.status(400).json({ error: "itemType must be 'table', 'folder', or 'design'" });
    return;
  }

  eventBus.emitDocumentChange({
    type: "item:move",
    documentId: "doc_default",
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { itemId, itemType, newParentId: parentId },
  });

  res.json({ ok: true });
});

// PUT /api/folders/:folderId — rename folder
router.put("/:folderId", async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "文件夹名不能为空" });
    return;
  }
  try {
    const folder = await prisma.folder.update({
      where: { id: req.params.folderId },
      data: { name: name.trim().slice(0, 100) },
    });
    eventBus.emitDocumentChange({
      type: "folder:rename",
      documentId: folder.documentId,
      clientId: getClientId(req),
      timestamp: Date.now(),
      payload: { folderId: folder.id, name: folder.name },
    });
    res.json({ id: folder.id, name: folder.name });
  } catch {
    res.status(404).json({ error: "Folder not found" });
  }
});

// DELETE /api/folders/:folderId — delete folder (children promoted to parent)
router.delete("/:folderId", async (req: Request, res: Response) => {
  const folder = await prisma.folder.findUnique({ where: { id: req.params.folderId } });
  if (!folder) {
    res.status(404).json({ error: "Folder not found" });
    return;
  }

  // Promote child folders to parent
  await prisma.folder.updateMany({
    where: { parentId: folder.id },
    data: { parentId: folder.parentId },
  });

  // Promote child tables to parent
  await prisma.table.updateMany({
    where: { parentId: folder.id },
    data: { parentId: folder.parentId },
  });

  await prisma.folder.delete({ where: { id: folder.id } });

  eventBus.emitDocumentChange({
    type: "folder:delete",
    documentId: folder.documentId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { folderId: folder.id },
  });

  res.json({ ok: true });
});

export default router;
