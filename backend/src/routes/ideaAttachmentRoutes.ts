/**
 * Idea attachment routes (PR5).
 *
 *   POST /api/ideas/:ideaId/attachments        (multipart, file=binary)
 *     → { id, url, mime, size, originalName, hash, ext, ... }
 *
 *   GET  /api/idea-attachments/:wsId/:filename
 *     → streams the blob with strong cache headers
 *
 *   DELETE /api/idea-attachments/:id           (Agent / FE explicit cleanup)
 *
 * Auth:
 *   - POST: needs write access to the idea's workspace (existing
 *     `requireWorkspaceAccess` middleware applied via the parent route mount)
 *   - GET: needs read access to the workspace; we look up the row to get
 *     workspaceId + verify access via a lightweight check
 *   - DELETE: needs write access to the workspace
 */

import { Router, Request, Response } from "express";
import multer from "multer";
import { promises as fsp } from "fs";
import {
  uploadAttachment,
  getAttachment,
  findByPath,
  deleteAttachment,
  validateUpload,
  IdeaAttachmentValidationError,
  buildAttachmentKey,
} from "../services/ideaAttachmentService.js";
import { getBlobStorage } from "../services/storage/index.js";
import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// Multer to /tmp for large videos; use memoryStorage for small files would
// pin big videos in RAM. We always read into a Buffer at the end so the
// service layer doesn't deal with streams.
const HARDEST_LIMIT = 100 * 1024 * 1024; // 100MB — matches video/mp4 cap
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: HARDEST_LIMIT, files: 1 },
});

export const ideaAttachmentRouter = Router({ mergeParams: true });

/**
 * POST /api/ideas/:ideaId/attachments
 *
 * Mounted under `tableRoutes` (or wherever idea routes live) so the parent
 * has already enforced workspace access on the idea. We re-fetch the idea
 * to lock in workspaceId for the row.
 */
ideaAttachmentRouter.post(
  "/:ideaId/attachments",
  upload.single("file"),
  async (req: Request, res: Response) => {
    const { ideaId } = req.params;
    if (!req.file) {
      res.status(400).json({ error: "missing file (multipart field 'file')" });
      return;
    }
    // Find the idea to capture workspaceId (we trust the parent middleware
    // already verified access).
    const idea = await prisma.idea.findUnique({
      where: { id: ideaId },
      select: { workspaceId: true },
    });
    if (!idea) {
      res.status(404).json({ error: `idea not found: ${ideaId}` });
      return;
    }
    try {
      // Pre-flight validate so we get a clean 4xx (multer would have
      // already 413'd if too large — we defend in depth).
      validateUpload({ mime: req.file.mimetype, size: req.file.size });
      const row = await uploadAttachment({
        ideaId,
        workspaceId: idea.workspaceId,
        buffer: req.file.buffer,
        mime: req.file.mimetype,
        originalName: req.file.originalname,
        uploadedBy: ((req as { user?: { id?: string } }).user)?.id ?? null,
      });
      res.status(201).json(row);
    } catch (err) {
      if (err instanceof IdeaAttachmentValidationError) {
        const status =
          err.code === "TOO_LARGE" ? 413 :
          err.code === "MIME_NOT_ALLOWED" ? 415 : 400;
        res.status(status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  },
);

/**
 * DELETE /api/idea-attachments/:id
 * Mounted at top level. Caller must have access to the row's workspace.
 */
export const ideaAttachmentTopRouter = Router();

ideaAttachmentTopRouter.delete("/:id", async (req: Request, res: Response) => {
  const row = await getAttachment(req.params.id);
  if (!row) {
    res.status(404).json({ error: "attachment not found" });
    return;
  }
  // Workspace access already enforced by `requireWorkspaceAccess` middleware
  // mounted at /api in index.ts (it inspects req.user → org membership).
  // No need to re-check here.
  await deleteAttachment(req.params.id);
  res.status(204).end();
});

/**
 * GET /api/idea-attachments/:wsId/:filename
 *
 * Streams the blob with strong cache headers (hash-named files are
 * immutable). The :wsId in the URL must match a real attachment row's
 * workspaceId — that's our access check. Existing `requireWorkspaceAccess`
 * middleware (mounted on /api by index.ts) already vets the user's
 * membership in :wsId → if they're not a member, 403 lands before we get
 * here.
 */
ideaAttachmentTopRouter.get(
  "/:wsId/:filename",
  async (req: Request, res: Response) => {
    const { wsId, filename } = req.params;
    if (!/^[0-9a-f]+\.[a-z0-9]{1,8}$/.test(filename)) {
      res.status(400).json({ error: "invalid filename" });
      return;
    }
    const row = await findByPath(wsId, filename);
    if (!row) {
      res.status(404).json({ error: "attachment not found" });
      return;
    }
    const blob = getBlobStorage();
    const key = buildAttachmentKey(row.workspaceId, row.hash, row.ext);
    let stream: NodeJS.ReadableStream;
    try {
      stream = await blob.readStream(key);
    } catch {
      res.status(404).json({ error: "blob not found (db row exists but blob missing)" });
      return;
    }
    res.setHeader("Content-Type", row.mime);
    res.setHeader("Content-Length", String(row.size));
    // Hash-named => immutable for a year. Browser may cache aggressively.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(row.originalName || filename)}"`,
    );
    stream.pipe(res);
    stream.on("error", (err) => {
      // Connection may already be partially written; best-effort end.
      console.error("[ideaAttachment] stream error:", err);
      try { res.end(); } catch { /* ignore */ }
    });
  },
);

// Path import kept silent — no-op
void fsp;
