/**
 * Reverse mention lookup — "who points at this entity?"
 *
 * Powers the delete-confirmation UI and the MCP `list_incoming_mentions`
 * tool. The same Mention rows that `mentionIndex.buildMentionRows` writes
 * on every idea save are indexed by (workspaceId, targetType, targetId), so
 * this read is a single indexed scan.
 *
 * We denormalize the source side on the way out — returning the bare
 * `sourceId` would force every caller to do a second round-trip just to
 * render "referenced by: Roadmap".
 */

import { Router, Request, Response, RequestHandler } from "express";
import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const asyncHandler = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { Promise.resolve(fn(req, res)).catch(next); };

const router = Router();

export interface IncomingMentionRef {
  /** The kind of entity holding the mention (currently always "idea"). */
  sourceType: string;
  sourceId: string;
  /** Resolved display name of the source (e.g. the idea's name), so the UI
   *  doesn't need a second fetch just to render "Referenced by: <X>". */
  sourceLabel: string;
  /** Label as written inside the mention link (`[@label]`). */
  rawLabel: string;
  /** Short preview of the surrounding prose, stripped of mention syntax. */
  contextExcerpt: string | null;
  createdAt: string; // ISO
}

/**
 * GET /api/mentions/reverse
 *   ?workspaceId=<id>              (required)
 *   &targetType=<type>             (required — view | taste | idea | idea-section)
 *   &targetId=<id>                 (required — composite for idea-section: "<ideaId>#<slug>")
 *   &limit=<n>                     (default 50, cap 200)
 *
 * Response: { refs: IncomingMentionRef[], total: number }
 *
 * `total` is the raw count matching the filter (so the UI can render
 * "showing 50 of 127" if we ever cap low). The array is ordered by newest
 * reference first so the most-recently-authored context shows up top in the
 * delete-confirm modal.
 */
router.get("/reverse", asyncHandler(async (req: Request, res: Response) => {
  const workspaceId = String(req.query.workspaceId || "");
  const targetType = String(req.query.targetType || "");
  const targetId = String(req.query.targetId || "");
  const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200);

  if (!workspaceId || !targetType || !targetId) {
    res.status(400).json({ error: "workspaceId, targetType, targetId are required" });
    return;
  }

  const where = { workspaceId, targetType, targetId };
  const [rows, total] = await Promise.all([
    prisma.mention.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.mention.count({ where }),
  ]);

  // Resolve source labels. Today sourceType is only "idea"; we leave the
  // switch structure in place so adding "table-record" or similar later is
  // a one-line extension. Unknown/missing sources surface as empty string
  // rather than crashing the panel.
  const ideaIds = rows.filter((r) => r.sourceType === "idea").map((r) => r.sourceId);
  const ideaName = new Map<string, string>();
  if (ideaIds.length > 0) {
    const ideas = await prisma.idea.findMany({
      where: { id: { in: ideaIds } },
      select: { id: true, name: true },
    });
    for (const i of ideas) ideaName.set(i.id, i.name);
  }

  const refs: IncomingMentionRef[] = rows.map((r) => ({
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    sourceLabel:
      r.sourceType === "idea" ? (ideaName.get(r.sourceId) || "(已删除)") : r.sourceId,
    rawLabel: r.rawLabel,
    contextExcerpt: r.contextExcerpt,
    createdAt: r.createdAt.toISOString(),
  }));

  res.json({ refs, total });
}));

export default router;
