import { Router, Request, Response, NextFunction, RequestHandler } from "express";
import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { eventBus } from "../services/eventBus.js";
import { extractIdeaSections } from "../services/ideaSections.js";
import { buildMentionRows } from "../services/mentionIndex.js";
import { applyIdeaWrite } from "../services/ideaWriteService.js";
import { withArtifactWriteLock } from "../services/artifactWriteQueue.js";
import * as ideaStream from "../services/ideaStreamSessionService.js";

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

// GET /api/ideas?workspaceId=<id>[&includeSections=1][&includeContent=1]
// List ideas for a workspace. Content is omitted by default (can be huge);
// callers that need it pass includeContent=1. Sections are cheap (JSONB
// snapshot) and default off so the sidebar/MCP nav can stay small.
router.get("/", asyncHandler(async (req: Request, res: Response) => {
  const workspaceId = String(req.query.workspaceId || "");
  if (!workspaceId) {
    res.status(400).json({ error: "workspaceId is required" });
    return;
  }
  const includeSections = req.query.includeSections === "1";
  const includeContent = req.query.includeContent === "1";
  const ideas = await prisma.idea.findMany({
    where: { workspaceId },
    orderBy: { order: "asc" },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      parentId: true,
      order: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      content: includeContent,
      sections: includeSections,
    },
  });
  res.json({
    ideas: ideas.map((i) => ({
      ...i,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    })),
  });
}));

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

  // NOTE: include `version` — the Agent chains create_idea → begin_idea_stream_write
  // and needs this to pass as baseVersion. Without it the model guesses wrong
  // (tends to assume 1) and hits the 400 "stale baseVersion" guard on the first
  // stream-begin call.
  res.status(201).json({
    id: idea.id,
    name: idea.name,
    parentId: idea.parentId,
    order: idea.order,
    version: idea.version,
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

  // Soft lock: if the Agent is actively streaming into this idea, reject user
  // saves so we don't clobber the stream. The FE already puts the editor into
  // read-only mode on `idea:stream-begin`, so hitting this path means a
  // cross-tab save or a stale autosave — both safe to drop with 423.
  const activeStream = ideaStream.isIdeaLocked(req.params.ideaId);
  if (activeStream) {
    res.status(423).json({
      locked: true,
      reason: "stream-in-progress",
      sessionId: activeStream,
    });
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
  // Re-derive the outgoing mention edges for this idea. We just replace the
  // whole set on every save (diff = delete all + insert parsed), which is
  // cheaper than a set-diff in SQL once you account for round-trips, and the
  // content payload is already bounded. Wrapped in a transaction with the
  // content update so readers never see a half-updated state.
  const mentionRows = buildMentionRows(content, "idea", existing.id, existing.workspaceId);
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.idea.update({
      where: { id: existing.id },
      data: { content, version: nextVersion, sections: sections as unknown as any },
    });
    await tx.mention.deleteMany({ where: { sourceType: "idea", sourceId: existing.id } });
    if (mentionRows.length > 0) {
      await tx.mention.createMany({ data: mentionRows });
    }
    return u;
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

// POST /api/ideas/:ideaId/write — anchor-based insert/append/replace
// body: { anchor: IdeaAnchor, payload: string }
//
// This is the single write path for the Chat Agent's idea-skill tools.
// Keeping it server-side means:
//   (a) the agent doesn't have to ship the full content back + bumpversion
//       (avoids any race with a human editor on the same doc)
//   (b) mention diff + sections re-extraction happen atomically with the
//       content update, same as the interactive PUT
//   (c) anchor resolution (slug → character offset, HTML-aware boundary) is
//       centralized in `applyIdeaWrite` and not reimplemented in MCP tools.
router.post("/:ideaId/write", asyncHandler(async (req: Request, res: Response) => {
  const { anchor, payload } = req.body as { anchor?: unknown; payload?: unknown };
  if (!anchor || typeof anchor !== "object") {
    res.status(400).json({ error: "anchor is required" });
    return;
  }
  if (typeof payload !== "string") {
    res.status(400).json({ error: "payload must be a string" });
    return;
  }

  // V2.5 B8: per-idea write serialiser. 多个 subagent 并发改同一 idea 时,
  // 各自的 read-modify-write 完整段串行化,避免基于过期 base content 的写
  // 互相覆盖。同 idea 写排队;不同 idea 完全并发。
  try {
    const result = await withArtifactWriteLock("idea", req.params.ideaId, async () => {
      const existing = await prisma.idea.findUnique({ where: { id: req.params.ideaId } });
      if (!existing) {
        return { kind: "404" as const };
      }

      let write;
      try {
        write = applyIdeaWrite(existing.content, anchor as any, payload);
      } catch (err: any) {
        return { kind: "400" as const, error: err?.message || "applyIdeaWrite failed" };
      }

      const nextVersion = existing.version + 1;
      const sections = extractIdeaSections(write.content);
      const mentionRows = buildMentionRows(write.content, "idea", existing.id, existing.workspaceId);
      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.idea.update({
          where: { id: existing.id },
          data: { content: write.content, version: nextVersion, sections: sections as unknown as any },
        });
        await tx.mention.deleteMany({ where: { sourceType: "idea", sourceId: existing.id } });
        if (mentionRows.length > 0) {
          await tx.mention.createMany({ data: mentionRows });
        }
        return u;
      });
      return { kind: "ok" as const, updated, write };
    });

    if (result.kind === "404") {
      res.status(404).json({ error: "Idea not found" });
      return;
    }
    if (result.kind === "400") {
      res.status(400).json({ error: result.error });
      return;
    }

    const { updated, write } = result;
    eventBus.emitIdeaChange({
      type: "idea:content-change",
      ideaId: updated.id,
      clientId: getClientId(req),
      timestamp: Date.now(),
      payload: { content: updated.content, version: updated.version },
    });

    res.json({
      id: updated.id,
      version: updated.version,
      description: write.description,
      range: write.range,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "applyIdeaWrite failed unexpectedly" });
  }
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
// Also tears down any Mention rows that reference this idea — both as source
// (outgoing edges from this doc) and as target (incoming edges from other
// docs, including `idea-section` targets whose composite key starts with
// `<ideaId>#`). Orphan rows are cheap to keep, but leaving them behind means
// the @ picker and reverse-ref panel would show phantom refs until the next
// content save of the pointing doc re-diffs — user-surprising, so we clean
// eagerly.
router.delete("/:ideaId", asyncHandler(async (req: Request, res: Response) => {
  const idea = await prisma.idea.findUnique({ where: { id: req.params.ideaId } });
  if (!idea) {
    res.status(404).json({ error: "Idea not found" });
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.mention.deleteMany({ where: { sourceType: "idea", sourceId: idea.id } });
    await tx.mention.deleteMany({
      where: {
        OR: [
          { targetType: "idea", targetId: idea.id },
          { targetType: "idea-section", targetId: { startsWith: `${idea.id}#` } },
        ],
      },
    });
    await tx.idea.delete({ where: { id: idea.id } });
  });
  eventBus.emitWorkspaceChange({
    type: "idea:delete",
    workspaceId: idea.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { ideaId: idea.id },
  });
  res.json({ ok: true });
}));

// ─── Streaming write protocol (V2) ─────────────────────────────────────────
// Thin HTTP proxies over ideaStreamSessionService so the MCP server (separate
// process) can open/close streams. Deltas do NOT go through HTTP — the chat
// agent service forwards model text_delta events directly to `pushDelta()`
// in-process, and FE subscribes via the existing per-idea SSE channel to
// receive the broadcast.

// POST /api/ideas/:ideaId/stream/begin
// body: { baseVersion: number, anchor: IdeaAnchor, conversationId?: string, clientId: string }
// → { sessionId, startOffset, baseContent, baseVersion }
router.post("/:ideaId/stream/begin", asyncHandler(async (req: Request, res: Response) => {
  const { baseVersion, anchor, conversationId, clientId } = req.body ?? {};
  if (typeof baseVersion !== "number") {
    res.status(400).json({ error: "baseVersion must be a number" });
    return;
  }
  if (!anchor || typeof anchor !== "object") {
    res.status(400).json({ error: "anchor required" });
    return;
  }
  if (typeof clientId !== "string" || !clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  // Look up workspaceId so the session can buildMentionRows on commit without
  // a second round-trip.
  const idea = await prisma.idea.findUnique({
    where: { id: req.params.ideaId },
    select: { workspaceId: true },
  });
  if (!idea) {
    res.status(404).json({ error: "Idea not found" });
    return;
  }

  try {
    const result = await ideaStream.begin({
      ideaId: req.params.ideaId,
      workspaceId: idea.workspaceId,
      baseVersion,
      anchor,
      conversationId: conversationId ?? null,
      clientId,
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Stale baseVersion / section not found → 400 so the caller retries.
    res.status(400).json({ error: msg });
  }
}));

// POST /api/ideas/stream/:sessionId/end
// body: { commit: boolean }
// → { ok, newVersion?, discarded, reason? }
router.post("/stream/:sessionId/end", asyncHandler(async (req: Request, res: Response) => {
  const { commit } = req.body ?? {};
  if (typeof commit !== "boolean") {
    res.status(400).json({ error: "commit must be a boolean" });
    return;
  }
  const result = await ideaStream.finalize(req.params.sessionId, { commit });
  res.json(result);
}));

export default router;
