import { Router, Request, Response } from "express";
import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { parseFigmaUrl } from "../utils/figmaParser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Multer config: store SVGs to uploads/svgs/{designId}/ ───

const uploadsRoot = path.resolve(__dirname, "../../../uploads/svgs");

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const designId = _req.params.designId;
    const dir = path.join(uploadsRoot, designId);
    await fs.mkdir(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    // cuid-like unique name + original extension
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${unique}.svg`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const isSvg =
      file.mimetype === "image/svg+xml" ||
      file.originalname.toLowerCase().endsWith(".svg");
    cb(null, isSvg);
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
});

// ─── Helpers ───

/** Decode multer's originalname (Latin-1) back to UTF-8. */
function decodeFileName(raw: string): string {
  try {
    return Buffer.from(raw, "latin1").toString("utf-8");
  } catch {
    return raw;
  }
}

/** Generate a unique taste name within a design. Appends " 1", " 2", etc. */
async function uniqueTasteName(designId: string, baseName: string): Promise<string> {
  const existing = await prisma.taste.findMany({
    where: { designId },
    select: { name: true },
  });
  const names = new Set(existing.map((t) => t.name));
  if (!names.has(baseName)) return baseName;
  let i = 1;
  while (names.has(`${baseName} ${i}`)) i++;
  return `${baseName} ${i}`;
}

/** Parse SVG string to extract width/height from viewBox or explicit attrs. */
function parseSvgDimensions(svgContent: string): { width: number; height: number } {
  // Try viewBox first: viewBox="minX minY width height"
  const vbMatch = svgContent.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  if (vbMatch) {
    const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  // Fallback: explicit width/height attributes
  const wMatch = svgContent.match(/\bwidth\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i);
  const hMatch = svgContent.match(/\bheight\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i);
  if (wMatch && hMatch) {
    return { width: parseFloat(wMatch[1]), height: parseFloat(hMatch[1]) };
  }
  return { width: 200, height: 200 };
}

const router = Router();

// GET /api/designs/:designId/tastes — list all tastes for a design
router.get("/:designId/tastes", async (req: Request, res: Response) => {
  const tastes = await prisma.taste.findMany({
    where: { designId: req.params.designId },
    orderBy: { order: "asc" },
  });
  res.json(tastes);
});

// POST /api/designs/:designId/tastes/upload — upload SVG file(s)
router.post(
  "/:designId/tastes/upload",
  upload.array("files", 20),
  async (req: Request, res: Response) => {
    const { designId } = req.params;
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: "No SVG files provided" });
      return;
    }

    // Compute starting order + x offset
    const existing = await prisma.taste.findMany({
      where: { designId },
      orderBy: { order: "asc" },
    });
    let nextOrder = existing.length;
    let nextX = 0;
    if (existing.length > 0) {
      const last = existing[existing.length - 1];
      nextX = last.x + last.width + 40; // 40px gap
    }

    const created = [];
    for (const file of files) {
      const svgContent = await fs.readFile(file.path, "utf-8");
      const dims = parseSvgDimensions(svgContent);
      const relativePath = `uploads/svgs/${designId}/${file.filename}`;

      const decoded = decodeFileName(file.originalname);
      const baseName = decoded.replace(/\.svg$/i, "");
      const name = await uniqueTasteName(designId, baseName);

      const taste = await prisma.taste.create({
        data: {
          designId,
          name,
          fileName: decoded,
          filePath: relativePath,
          x: nextX,
          y: 0,
          width: dims.width,
          height: dims.height,
          order: nextOrder,
          source: "upload",
        },
      });
      created.push(taste);
      nextX += dims.width + 40;
      nextOrder++;
    }

    res.status(201).json(created);
  },
);

// POST /api/designs/:designId/tastes/from-figma — import SVG from Figma URL
router.post("/:designId/tastes/from-figma", async (req: Request, res: Response) => {
  const { designId } = req.params;
  const { figmaUrl } = req.body;

  if (!figmaUrl || typeof figmaUrl !== "string") {
    res.status(400).json({ error: "figmaUrl is required" });
    return;
  }

  const parsed = parseFigmaUrl(figmaUrl.trim());
  if (!parsed) {
    res.status(400).json({ error: "Invalid Figma URL" });
    return;
  }

  const figmaToken = process.env.FIGMA_API_TOKEN;
  if (!figmaToken) {
    res.status(400).json({ error: "FIGMA_API_TOKEN not configured on server" });
    return;
  }

  try {
    // Step 1: Get SVG export URL from Figma
    const nodeId = parsed.nodeId || "";
    const imagesUrl = `https://api.figma.com/v1/images/${parsed.fileKey}?ids=${encodeURIComponent(nodeId)}&format=svg`;
    const imagesRes = await fetch(imagesUrl, {
      headers: { "X-Figma-Token": figmaToken },
    });

    if (!imagesRes.ok) {
      const errText = await imagesRes.text();
      res.status(502).json({ error: `Figma API error: ${imagesRes.status}`, detail: errText });
      return;
    }

    const imagesData = (await imagesRes.json()) as { images: Record<string, string | null> };
    const svgExportUrl = Object.values(imagesData.images).find(Boolean);
    if (!svgExportUrl) {
      res.status(400).json({ error: "Figma returned no SVG for this node" });
      return;
    }

    // Step 2: Download actual SVG content
    const svgRes = await fetch(svgExportUrl);
    if (!svgRes.ok) {
      res.status(502).json({ error: "Failed to download SVG from Figma CDN" });
      return;
    }
    const svgContent = await svgRes.text();

    // Step 3: Write to disk
    const dir = path.join(uploadsRoot, designId);
    await fs.mkdir(dir, { recursive: true });
    const fileName = `figma-${Date.now()}.svg`;
    const filePath = path.join(dir, fileName);
    await fs.writeFile(filePath, svgContent, "utf-8");

    // Step 4: Parse dimensions + create record
    const dims = parseSvgDimensions(svgContent);
    const existing = await prisma.taste.findMany({
      where: { designId },
      orderBy: { order: "asc" },
    });
    let nextX = 0;
    if (existing.length > 0) {
      const last = existing[existing.length - 1];
      nextX = last.x + last.width + 40;
    }

    const taste = await prisma.taste.create({
      data: {
        designId,
        name: await uniqueTasteName(designId, "Figma Import"),
        fileName,
        filePath: `uploads/svgs/${designId}/${fileName}`,
        x: nextX,
        y: 0,
        width: dims.width,
        height: dims.height,
        order: existing.length,
        source: "figma",
        figmaUrl: figmaUrl.trim(),
      },
    });

    res.status(201).json(taste);
  } catch (err: any) {
    console.error("[figma-import]", err);
    res.status(500).json({ error: "Failed to import from Figma", detail: err.message });
  }
});

// PUT /api/designs/:designId/tastes/batch-update — batch update positions (for auto-layout)
// NOTE: must be registered BEFORE /:tasteId to avoid Express matching "batch-update" as a tasteId
router.put("/:designId/tastes/batch-update", async (req: Request, res: Response) => {
  const { updates } = req.body;
  if (!Array.isArray(updates)) {
    res.status(400).json({ error: "updates must be an array" });
    return;
  }
  await Promise.all(
    updates.map((u: { id: string; x: number; y: number }) =>
      prisma.taste.update({ where: { id: u.id }, data: { x: u.x, y: u.y } }),
    ),
  );
  res.json({ ok: true });
});

// PUT /api/designs/:designId/tastes/:tasteId — update position/size/name
router.put("/:designId/tastes/:tasteId", async (req: Request, res: Response) => {
  const { x, y, width, height, name } = req.body;
  const data: Record<string, unknown> = {};
  if (typeof x === "number") data.x = x;
  if (typeof y === "number") data.y = y;
  if (typeof width === "number") data.width = width;
  if (typeof height === "number") data.height = height;
  if (typeof name === "string" && name.trim()) data.name = name.trim();

  try {
    const taste = await prisma.taste.update({
      where: { id: req.params.tasteId },
      data,
    });
    res.json(taste);
  } catch {
    res.status(404).json({ error: "Taste not found" });
  }
});

// DELETE /api/designs/:designId/tastes/:tasteId — delete taste + file
router.delete("/:designId/tastes/:tasteId", async (req: Request, res: Response) => {
  const taste = await prisma.taste.findUnique({ where: { id: req.params.tasteId } });
  if (!taste) {
    res.status(404).json({ error: "Taste not found" });
    return;
  }
  await prisma.taste.delete({ where: { id: taste.id } });

  // Best-effort file cleanup
  if (taste.filePath) {
    const absPath = path.resolve(__dirname, "../../..", taste.filePath);
    fs.unlink(absPath).catch(() => {});
  }

  res.json({ ok: true });
});

// GET /api/designs/:designId/tastes/:tasteId/source — get raw SVG source
router.get("/:designId/tastes/:tasteId/source", async (req: Request, res: Response) => {
  const taste = await prisma.taste.findUnique({ where: { id: req.params.tasteId } });
  if (!taste || !taste.filePath) {
    res.status(404).json({ error: "Taste not found or no file" });
    return;
  }
  try {
    const absPath = path.resolve(__dirname, "../../..", taste.filePath);
    const content = await fs.readFile(absPath, "utf-8");
    res.type("text/plain").send(content);
  } catch {
    res.status(404).json({ error: "SVG file not found on disk" });
  }
});

export default router;
