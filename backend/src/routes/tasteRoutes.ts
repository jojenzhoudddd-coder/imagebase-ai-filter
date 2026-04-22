import { Router, Request, Response } from "express";
import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { parseFigmaUrl } from "../utils/figmaParser.js";
import { enqueueMetaGeneration, getMeta, regenerateMeta } from "../services/tasteMetaService.js";
import { eventBus } from "../services/eventBus.js";
import { computeGridLayout } from "../services/autoLayoutService.js";

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

/**
 * 在已有 taste 的画布里，为一个新矩形（w × h）找一个不与任何已存在矩形重叠的位置。
 *
 * 策略：
 *   - 把已有 taste 看作障碍矩形（外扩 gap 作为呼吸空间）
 *   - 候选位置 = (0,0) + 每个已有矩形的 4 条边的外侧贴边点（右 / 下 / 左 / 上）
 *   - 按 y 升序、x 升序排序（优先放靠上靠左），取第一个与所有障碍都不重叠的点
 *   - 全都碰撞则回退到 "所有 taste 的底边 + gap"，另起一行
 *
 * 够用、可读、O(n²) 的简单算法；n 在 taste 画布场景里不会大。
 */
function findEmptyPosition(
  existing: { x: number; y: number; width: number; height: number }[],
  w: number,
  h: number,
  gap: number = 40,
): { x: number; y: number } {
  if (existing.length === 0) return { x: 0, y: 0 };

  // 障碍矩形 = 已存在 taste 外扩 gap（让 candidate 只要贴着边就不会重叠）
  type Box = { x: number; y: number; w: number; h: number };
  const obstacles: Box[] = existing.map((t) => ({
    x: t.x - gap,
    y: t.y - gap,
    w: t.width + 2 * gap,
    h: t.height + 2 * gap,
  }));

  const overlaps = (x: number, y: number): boolean =>
    obstacles.some(
      (b) => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y,
    );

  const candidates: { x: number; y: number }[] = [{ x: 0, y: 0 }];
  for (const t of existing) {
    candidates.push({ x: t.x + t.width + gap, y: t.y }); // 右
    candidates.push({ x: t.x, y: t.y + t.height + gap }); // 下
    candidates.push({ x: t.x - w - gap, y: t.y });        // 左
    candidates.push({ x: t.x, y: t.y - h - gap });        // 上
  }
  // 优先靠上、其次靠左
  candidates.sort((a, b) => a.y - b.y || a.x - b.x);

  for (const c of candidates) {
    if (!overlaps(c.x, c.y)) return c;
  }

  // 全都撞 → 所有 taste 的底边下方另起一行，从 x=0 开始
  const maxBottom = existing.reduce((m, t) => Math.max(m, t.y + t.height), 0);
  return { x: 0, y: maxBottom + gap };
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

    // 已有 taste 作为 findEmptyPosition 的障碍列表
    const existing = await prisma.taste.findMany({
      where: { designId },
      orderBy: { order: "asc" },
    });
    let nextOrder = existing.length;
    // 每放一张，都把它加入 obstacles，保证同一批内多张不会互相覆盖
    const obstacles = existing.map((t) => ({
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
    }));

    const created = [];
    for (const file of files) {
      const svgContent = await fs.readFile(file.path, "utf-8");
      const dims = parseSvgDimensions(svgContent);
      const relativePath = `uploads/svgs/${designId}/${file.filename}`;

      const decoded = decodeFileName(file.originalname);
      const baseName = decoded.replace(/\.svg$/i, "");
      const name = await uniqueTasteName(designId, baseName);

      const pos = findEmptyPosition(obstacles, dims.width, dims.height);

      const taste = await prisma.taste.create({
        data: {
          designId,
          name,
          fileName: decoded,
          filePath: relativePath,
          x: pos.x,
          y: pos.y,
          width: dims.width,
          height: dims.height,
          order: nextOrder,
          source: "upload",
        },
      });
      created.push(taste);
      obstacles.push({ x: pos.x, y: pos.y, width: dims.width, height: dims.height });
      nextOrder++;

      // Background meta generation — fire-and-forget
      enqueueMetaGeneration(taste.id);
    }

    // Broadcast taste:create events so other clients refresh the canvas
    const design = await prisma.design.findUnique({
      where: { id: designId },
      select: { workspaceId: true },
    });
    if (design?.workspaceId) {
      for (const t of created) {
        eventBus.emitWorkspaceChange({
          type: "taste:create",
          workspaceId: design.workspaceId,
          clientId: (req.headers["x-client-id"] as string) || "unknown",
          timestamp: Date.now(),
          payload: { designId, taste: t },
        });
      }
    }

    res.status(201).json(created);
  },
);

// POST /api/designs/:designId/tastes/from-svg — create taste from pasted SVG source
router.post("/:designId/tastes/from-svg", async (req: Request, res: Response) => {
  const { designId } = req.params;
  const { svg, name: requestedName } = req.body as { svg?: unknown; name?: unknown };

  if (typeof svg !== "string" || !svg.trim()) {
    res.status(400).json({ error: "svg is required" });
    return;
  }

  const svgContent = svg.trim();
  // Must look like SVG — cheap early-reject so we don't write garbage to disk
  if (!/<svg[\s>]/i.test(svgContent)) {
    res.status(400).json({ error: "Not valid SVG content" });
    return;
  }

  // Soft size cap (match multer's 5MB file limit)
  if (Buffer.byteLength(svgContent, "utf-8") > 5 * 1024 * 1024) {
    res.status(413).json({ error: "SVG content too large (max 5MB)" });
    return;
  }

  try {
    const dir = path.join(uploadsRoot, designId);
    await fs.mkdir(dir, { recursive: true });
    const fileName = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.svg`;
    const filePath = path.join(dir, fileName);
    await fs.writeFile(filePath, svgContent, "utf-8");

    const dims = parseSvgDimensions(svgContent);
    const existing = await prisma.taste.findMany({
      where: { designId },
      orderBy: { order: "asc" },
    });
    const obstacles = existing.map((t) => ({
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
    }));
    const pos = findEmptyPosition(obstacles, dims.width, dims.height);

    const baseName =
      typeof requestedName === "string" && requestedName.trim()
        ? requestedName.trim().replace(/\.svg$/i, "")
        : "Pasted SVG";
    const name = await uniqueTasteName(designId, baseName);

    const taste = await prisma.taste.create({
      data: {
        designId,
        name,
        fileName,
        filePath: `uploads/svgs/${designId}/${fileName}`,
        x: pos.x,
        y: pos.y,
        width: dims.width,
        height: dims.height,
        order: existing.length,
        source: "paste",
      },
    });

    enqueueMetaGeneration(taste.id);

    const design = await prisma.design.findUnique({
      where: { id: designId },
      select: { workspaceId: true },
    });
    if (design?.workspaceId) {
      eventBus.emitWorkspaceChange({
        type: "taste:create",
        workspaceId: design.workspaceId,
        clientId: (req.headers["x-client-id"] as string) || "unknown",
        timestamp: Date.now(),
        payload: { designId, taste },
      });
    }

    res.status(201).json(taste);
  } catch (err: any) {
    console.error("[paste-svg]", err);
    res.status(500).json({ error: "Failed to create taste from SVG", detail: err.message });
  }
});

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
    const obstacles = existing.map((t) => ({
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
    }));
    const pos = findEmptyPosition(obstacles, dims.width, dims.height);

    const taste = await prisma.taste.create({
      data: {
        designId,
        name: await uniqueTasteName(designId, "Figma Import"),
        fileName,
        filePath: `uploads/svgs/${designId}/${fileName}`,
        x: pos.x,
        y: pos.y,
        width: dims.width,
        height: dims.height,
        order: existing.length,
        source: "figma",
        figmaUrl: figmaUrl.trim(),
      },
    });

    enqueueMetaGeneration(taste.id);

    const design = await prisma.design.findUnique({
      where: { id: designId },
      select: { workspaceId: true },
    });
    if (design?.workspaceId) {
      eventBus.emitWorkspaceChange({
        type: "taste:create",
        workspaceId: design.workspaceId,
        clientId: (req.headers["x-client-id"] as string) || "unknown",
        timestamp: Date.now(),
        payload: { designId, taste },
      });
    }

    res.status(201).json(taste);
  } catch (err: any) {
    console.error("[figma-import]", err);
    res.status(500).json({ error: "Failed to import from Figma", detail: err.message });
  }
});

// PUT /api/designs/:designId/tastes/batch-update — batch update positions (for auto-layout)
// NOTE: must be registered BEFORE /:tasteId to avoid Express matching "batch-update" as a tasteId
router.put("/:designId/tastes/batch-update", async (req: Request, res: Response) => {
  const { designId } = req.params;
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

  const design = await prisma.design.findUnique({
    where: { id: designId },
    select: { workspaceId: true },
  });
  if (design?.workspaceId) {
    eventBus.emitWorkspaceChange({
      type: "taste:update",
      workspaceId: design.workspaceId,
      clientId: (req.headers["x-client-id"] as string) || "unknown",
      timestamp: Date.now(),
      payload: { designId, updates, batch: true },
    });
  }

  res.json({ ok: true });
});

// PUT /api/designs/:designId/tastes/:tasteId — update position/size/name
router.put("/:designId/tastes/:tasteId", async (req: Request, res: Response) => {
  const { designId, tasteId } = req.params;
  const { x, y, width, height, name } = req.body;
  const data: Record<string, unknown> = {};
  if (typeof x === "number") data.x = x;
  if (typeof y === "number") data.y = y;
  if (typeof width === "number") data.width = width;
  if (typeof height === "number") data.height = height;
  if (typeof name === "string" && name.trim()) data.name = name.trim();

  try {
    const taste = await prisma.taste.update({
      where: { id: tasteId },
      data,
    });

    const design = await prisma.design.findUnique({
      where: { id: designId },
      select: { workspaceId: true },
    });
    if (design?.workspaceId) {
      eventBus.emitWorkspaceChange({
        type: "taste:update",
        workspaceId: design.workspaceId,
        clientId: (req.headers["x-client-id"] as string) || "unknown",
        timestamp: Date.now(),
        payload: { designId, taste },
      });
    }

    res.json(taste);
  } catch {
    res.status(404).json({ error: "Taste not found" });
  }
});

// ─── Meta endpoints (Taste × Chatbot Phase 1) ───

// GET /api/designs/:designId/tastes/:tasteId/meta[?sync=1]
// Returns the design-style meta. If meta is missing and `sync=1`, blocks on a
// one-shot generation. Used by MCP `get_taste(includeMeta:true)` and the
// optional regenerate UI.
router.get("/:designId/tastes/:tasteId/meta", async (req: Request, res: Response) => {
  const { tasteId } = req.params;
  const sync = req.query.sync === "1" || req.query.sync === "true";
  try {
    const result = await getMeta(tasteId, { syncIfMissing: sync });
    res.json({
      meta: result.meta,
      generatedAt: result.generatedAt?.toISOString() ?? null,
      status: result.status,
    });
  } catch (err: any) {
    console.error("[taste-meta:get]", err);
    res.status(500).json({ error: "Failed to read meta", detail: err.message });
  }
});

// POST /api/designs/:designId/tastes/:tasteId/meta/regenerate
// Force regeneration regardless of svgHash. Broadcasts taste:meta-updated on success.
router.post("/:designId/tastes/:tasteId/meta/regenerate", async (req: Request, res: Response) => {
  const { tasteId } = req.params;
  try {
    const result = await regenerateMeta(tasteId);
    res.json({ meta: result.meta, status: result.status });
  } catch (err: any) {
    console.error("[taste-meta:regenerate]", err);
    res.status(500).json({ error: "Failed to regenerate meta", detail: err.message });
  }
});

// POST /api/designs/:designId/auto-layout — grid-tidy all tastes in this design
// Writes back taste positions via batch update, broadcasts design:auto-layout.
router.post("/:designId/auto-layout", async (req: Request, res: Response) => {
  const { designId } = req.params;
  const design = await prisma.design.findUnique({
    where: { id: designId },
    select: { workspaceId: true },
    // @ts-ignore
  });
  if (!design) {
    res.status(404).json({ error: "Design not found" });
    return;
  }

  const tastes = await prisma.taste.findMany({
    where: { designId },
    orderBy: { order: "asc" },
  });
  const { updates, bounds } = computeGridLayout(
    tastes.map((t) => ({ id: t.id, x: t.x, y: t.y, width: t.width, height: t.height })),
  );

  await Promise.all(
    updates.map((u) =>
      prisma.taste.update({ where: { id: u.id }, data: { x: u.x, y: u.y } }),
    ),
  );

  eventBus.emitWorkspaceChange({
    type: "design:auto-layout",
    workspaceId: design.workspaceId,
    clientId: (req.headers["x-client-id"] as string) || "unknown",
    timestamp: Date.now(),
    payload: { designId, updates, bounds },
  });

  res.json({ designId, updatedCount: updates.length, bounds });
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

  const design = await prisma.design.findUnique({
    where: { id: taste.designId },
    select: { workspaceId: true },
  });
  if (design?.workspaceId) {
    eventBus.emitWorkspaceChange({
      type: "taste:delete",
      workspaceId: design.workspaceId,
      clientId: (req.headers["x-client-id"] as string) || "unknown",
      timestamp: Date.now(),
      payload: { designId: taste.designId, tasteId: taste.id },
    });
  }

  res.json({ ok: true });
});

export default router;
