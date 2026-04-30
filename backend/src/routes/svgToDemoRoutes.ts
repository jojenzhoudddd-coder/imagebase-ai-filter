/**
 * /api/svg-to-demo/* — entry points that produce a Vibe Demo from SVG content.
 *
 * Two endpoints today (Phase 1):
 *   POST /from-taste/:tasteId   — UI right-click "Make interactive"
 *                                 (Path B). The MCP `create_demo_from_taste`
 *                                 tool calls this same code path so Path A
 *                                 and Path B converge on identical output.
 *
 * Future (Phase 2):
 *   POST /from-taste/:tasteId/faithful   — kicks off the LLM workflow
 *                                          (Path C) instead of the
 *                                          deterministic converter.
 *
 * Why a flat namespace `/api/svg-to-demo/` rather than nesting under
 * `/api/designs/:designId/tastes/:tasteId/...` like the rest of taste
 * ops? The right-click handler only has a tasteId in hand and looking
 * up the parent designId on the FE just to satisfy URL nesting is
 * busywork. The nested form would also imply this endpoint mutates
 * the taste, which it doesn't — it READS the taste's SVG and writes
 * to a NEW Demo. Different concern, different namespace.
 */

import { Router, type Request, type Response } from "express";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { createDemoFromSvg } from "../services/svgToDemo/createDemoFromSvg.js";
import { currentUser, userCanAccessWorkspace } from "../services/authService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const router = Router();

/**
 * Read a taste's SVG bytes from disk. Mirrors the helper in
 * tasteMetaService.ts (reuse via export would be nicer; for Phase 1
 * we duplicate to keep the change set self-contained — fold together
 * once we confirm the flow works).
 */
async function readTasteSvg(taste: { filePath: string | null }): Promise<string | null> {
  if (!taste.filePath) return null;
  // tasteRoutes stores files relative to the backend dir; resolve up two
  // levels from /backend/src/routes/ to land in the project root and
  // append the relative path.
  const abs = path.resolve(__dirname, "../../..", taste.filePath);
  try {
    return await fs.readFile(abs, "utf-8");
  } catch {
    return null;
  }
}

/**
 * POST /api/svg-to-demo/from-taste/:tasteId
 *
 * Body (optional):
 *   { name?: string, parentId?: string }
 *
 * Response:
 *   { demoId, filesWritten, manifest, droppedFeatures, stats }
 *
 * Auth: the global `requireWorkspaceAccess` middleware in src/index.ts
 * handles workspace-scoping for any route under /api whose URL includes
 * a workspaceId or that we can resolve to one. This endpoint resolves
 * via taste → design → workspaceId; we re-check ourselves below since
 * the middleware can't see the path-derived workspace.
 */
router.post("/from-taste/:tasteId", async (req: Request, res: Response) => {
  const { tasteId } = req.params;
  const { name: nameOverride, parentId } = (req.body ?? {}) as {
    name?: string;
    parentId?: string;
  };

  // 1. Look up the taste + its design's workspaceId.
  const taste = await prisma.taste.findUnique({
    where: { id: tasteId },
    include: {
      design: { select: { id: true, workspaceId: true, name: true } },
    },
  });
  if (!taste) {
    res.status(404).json({ error: "Taste not found", code: "TASTE_NOT_FOUND" });
    return;
  }

  // 2. Auth + workspace access. The global `requireWorkspaceAccess`
  //    middleware doesn't fire on this URL because the workspaceId
  //    isn't in the path / body / query — we resolved it via taste →
  //    design lookup. Re-check by calling userCanAccessWorkspace
  //    directly.
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" });
    return;
  }
  const wsOk = await userCanAccessWorkspace(user.id, taste.design.workspaceId);
  if (!wsOk) {
    res.status(403).json({
      error: "You don't have access to this workspace",
      code: "WORKSPACE_DENIED",
    });
    return;
  }

  // 3. Read the SVG bytes. Tastes can theoretically have null filePath
  //    (e.g. failed upload) — surface a clear error.
  const svg = await readTasteSvg(taste);
  if (!svg) {
    res.status(422).json({
      error: "Taste has no readable SVG content",
      code: "TASTE_NO_SVG",
    });
    return;
  }

  // 4. Run the deterministic converter. This is the same code path the
  //    MCP `create_demo_from_taste` tool calls.
  try {
    const result = await createDemoFromSvg({
      workspaceId: taste.design.workspaceId,
      name: nameOverride ?? `${taste.name} Demo`,
      svg,
      sourceTasteId: tasteId,
      parentId: parentId ?? null,
      clientId: (req.headers["x-client-id"] as string) || "ui",
    });
    res.status(201).json(result);
  } catch (err: any) {
    // Distinguish "bad SVG" from "internal failure". parseSvgTree throws
    // a labelled error for malformed XML.
    if (typeof err?.message === "string" && err.message.startsWith("parseSvgTree:")) {
      res.status(422).json({
        error: "Failed to parse SVG",
        code: "SVG_PARSE_ERROR",
        detail: err.message,
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.error("[svg-to-demo:from-taste]", err);
    res.status(500).json({
      error: "Failed to create demo",
      code: "INTERNAL",
      detail: typeof err?.message === "string" ? err.message : String(err),
    });
  }
});

export default router;
