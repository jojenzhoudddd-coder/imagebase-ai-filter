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

/**
 * Ensure folder name is unique within the workspace. Mirrors the table naming
 * behaviour in `dbStore.generateTableName`: if `baseName` already exists,
 * append " 1", " 2", … until free. Optional `excludeId` lets rename-flows
 * skip over the folder's own current name.
 */
async function generateUniqueFolderName(
  workspaceId: string,
  baseName: string,
  excludeId?: string,
): Promise<string> {
  const existing = await prisma.folder.findMany({
    where: { workspaceId, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { name: true },
  });
  const names = new Set(existing.map(f => f.name));
  if (!names.has(baseName)) return baseName;
  let i = 1;
  while (names.has(`${baseName} ${i}`)) i++;
  return `${baseName} ${i}`;
}

const router = Router();

// POST /api/folders — create folder
router.post("/", async (req: Request, res: Response) => {
  const { name, parentId, workspaceId } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "文件夹名不能为空" });
    return;
  }
  const docId = workspaceId || "doc_default";

  // New folder should appear at the bottom of the sidebar at its level, so
  // compute the max order across all sibling items (folders + tables +
  // designs) rather than only folder siblings. This matches user expectation
  // that "new folder appears at the bottom just like new tables/designs".
  const parentFilter = { workspaceId: docId, parentId: parentId || null };
  const [folderSibs, tableSibs, designSibs, ideaSibs] = await Promise.all([
    prisma.folder.findMany({ where: parentFilter, select: { order: true } }),
    prisma.table.findMany({ where: parentFilter, select: { order: true } }),
    prisma.design.findMany({ where: parentFilter, select: { order: true } }),
    prisma.idea.findMany({ where: parentFilter, select: { order: true } }),
  ]);
  const maxOrder = [...folderSibs, ...tableSibs, ...designSibs, ...ideaSibs]
    .reduce((max, x) => Math.max(max, x.order), -1);

  const trimmed = name.trim().slice(0, 100);
  const uniqueName = await generateUniqueFolderName(docId, trimmed);

  const folder = await prisma.folder.create({
    data: {
      name: uniqueName,
      workspaceId: docId,
      parentId: parentId || null,
      order: maxOrder + 1,
    },
  });

  eventBus.emitWorkspaceChange({
    type: "folder:create",
    workspaceId: docId,
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
  } else if (itemType === "idea") {
    await prisma.idea.update({
      where: { id: itemId },
      data: { parentId },
    });
  } else {
    res.status(400).json({ error: "itemType must be 'table', 'folder', 'design', or 'idea'" });
    return;
  }

  eventBus.emitWorkspaceChange({
    type: "item:move",
    workspaceId: "doc_default",
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { itemId, itemType, newParentId: parentId },
  });

  res.json({ ok: true });
});

// PUT /api/folders/reorder — batch reorder folders (must be before /:folderId)
router.put("/reorder", async (req: Request, res: Response) => {
  const { updates, workspaceId } = req.body;
  if (!Array.isArray(updates)) {
    res.status(400).json({ error: "updates must be an array" });
    return;
  }
  const docId = workspaceId || "doc_default";
  await Promise.all(
    updates.map((u: { id: string; order: number }) =>
      prisma.folder.update({ where: { id: u.id }, data: { order: u.order } })
    )
  );
  eventBus.emitWorkspaceChange({
    type: "folder:reorder",
    workspaceId: docId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { updates },
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
    const existing = await prisma.folder.findUnique({
      where: { id: req.params.folderId },
      select: { workspaceId: true },
    });
    if (!existing) throw new Error("not found");
    const trimmed = name.trim().slice(0, 100);
    const uniqueName = await generateUniqueFolderName(existing.workspaceId, trimmed, req.params.folderId);
    const folder = await prisma.folder.update({
      where: { id: req.params.folderId },
      data: { name: uniqueName },
    });
    eventBus.emitWorkspaceChange({
      type: "folder:rename",
      workspaceId: folder.workspaceId,
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

  // Promote child designs to parent
  await prisma.design.updateMany({
    where: { parentId: folder.id },
    data: { parentId: folder.parentId },
  });

  // Promote child ideas to parent
  await prisma.idea.updateMany({
    where: { parentId: folder.id },
    data: { parentId: folder.parentId },
  });

  await prisma.folder.delete({ where: { id: folder.id } });

  eventBus.emitWorkspaceChange({
    type: "folder:delete",
    workspaceId: folder.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { folderId: folder.id },
  });

  res.json({ ok: true });
});

export default router;
