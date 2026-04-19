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

// ─── Figma URL parser ───

interface FigmaParsed {
  fileKey: string;
  nodeId: string | null;
}

function parseFigmaUrl(url: string): FigmaParsed | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("figma.com")) return null;
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg[0] !== "design" && seg[0] !== "file") return null;
    let fileKey: string;
    if (seg[2] === "branch") {
      fileKey = seg[3];
    } else {
      fileKey = seg[1];
    }
    if (!fileKey) return null;
    return { fileKey, nodeId: u.searchParams.get("node-id") };
  } catch {
    return null;
  }
}

function extractNameFromUrl(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean);
    // fileName is the last path segment (URL-encoded)
    const raw = seg[seg.length - 1] || "";
    const decoded = decodeURIComponent(raw).replace(/-/g, " ").replace(/\?.*/, "");
    return decoded || "Untitled Design";
  } catch {
    return "Untitled Design";
  }
}

const router = Router();

// POST /api/designs — create design
router.post("/", async (req: Request, res: Response) => {
  const { name, figmaUrl, documentId, parentId } = req.body;
  if (!figmaUrl || typeof figmaUrl !== "string") {
    res.status(400).json({ error: "Figma URL is required" });
    return;
  }

  const parsed = parseFigmaUrl(figmaUrl.trim());
  if (!parsed) {
    res.status(400).json({ error: "Invalid Figma URL" });
    return;
  }

  const docId = documentId || "doc_default";
  const finalName = (name && typeof name === "string" && name.trim())
    ? name.trim().slice(0, 100)
    : extractNameFromUrl(figmaUrl);

  // Compute next order
  const siblings = await prisma.design.findMany({
    where: { documentId: docId, parentId: parentId || null },
  });
  const maxOrder = siblings.reduce((max, d) => Math.max(max, d.order), -1);

  const design = await prisma.design.create({
    data: {
      name: finalName,
      documentId: docId,
      parentId: parentId || null,
      order: maxOrder + 1,
      figmaUrl: figmaUrl.trim(),
      figmaFileKey: parsed.fileKey,
      figmaNodeId: parsed.nodeId,
    },
  });

  eventBus.emitDocumentChange({
    type: "design:create",
    documentId: docId,
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

// GET /api/designs/:designId — get design details
router.get("/:designId", async (req: Request, res: Response) => {
  const design = await prisma.design.findUnique({ where: { id: req.params.designId } });
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
    const design = await prisma.design.update({
      where: { id: req.params.designId },
      data: { name: name.trim().slice(0, 100) },
    });
    eventBus.emitDocumentChange({
      type: "design:rename",
      documentId: design.documentId,
      clientId: getClientId(req),
      timestamp: Date.now(),
      payload: { designId: design.id, name: design.name },
    });
    res.json({ id: design.id, name: design.name });
  } catch {
    res.status(404).json({ error: "Design not found" });
  }
});

// DELETE /api/designs/:designId
router.delete("/:designId", async (req: Request, res: Response) => {
  const design = await prisma.design.findUnique({ where: { id: req.params.designId } });
  if (!design) {
    res.status(404).json({ error: "Design not found" });
    return;
  }
  await prisma.design.delete({ where: { id: design.id } });
  eventBus.emitDocumentChange({
    type: "design:delete",
    documentId: design.documentId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { designId: design.id },
  });
  res.json({ ok: true });
});

export default router;
