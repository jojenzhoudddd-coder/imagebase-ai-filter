import { Router, Request, Response, RequestHandler } from "express";
import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Wrap async handlers so Prisma errors reach the error middleware instead of
// taking down the node process.
const asyncHandler = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { Promise.resolve(fn(req, res)).catch(next); };

const router = Router();

/**
 * Mention hit — v3 scope.
 *
 * The @ picker surfaces four kinds of workspace-level targets. Labels are
 * always the fully-qualified "Parent.Child" form (or just the artifact name
 * for leaf entities) so the dropdown + chip read naturally in one glance:
 *
 *   - view          → "<TableName>.<ViewName>"
 *   - taste         → "<DesignName>.<TasteName>"
 *   - idea          → "<IdeaName>"
 *   - idea-section  → "<IdeaName>.<HeadingText>"   (new in v3)
 *
 * idea-section lets users cross-link into a specific heading inside a long
 * idea doc. The heading slug (stable-ish within a doc) is the hit's `id`;
 * the parent idea's id rides along in `ideaId` for navigation.
 */
interface MentionHit {
  type: "view" | "taste" | "idea" | "idea-section";
  id: string;
  label: string;
  tableId?: string;   // for view
  designId?: string;  // for taste
  ideaId?: string;    // for idea-section
  headingText?: string; // raw heading body for idea-section
  /**
   * Canonical URI the frontend chip + MCP tools both emit into Markdown.
   * Mirrors exactly what `MentionPicker` inserts — that way the agent can
   * echo a hit straight back into an insert call without re-deriving the
   * URI shape. For idea-section we tuck the parent ideaId into the query
   * string (`?idea=<ideaId>`) so the composite key can be rebuilt later.
   */
  mentionUri: string;
  /** Ready-to-paste Markdown: `[@<label>](<mentionUri>)`. */
  markdown: string;
}

function buildMentionUri(h: Omit<MentionHit, "mentionUri" | "markdown">): string {
  if (h.type === "idea-section" && h.ideaId) {
    return `mention://idea-section/${h.id}?idea=${encodeURIComponent(h.ideaId)}`;
  }
  if (h.type === "view" && h.tableId) {
    return `mention://view/${h.id}?table=${encodeURIComponent(h.tableId)}`;
  }
  if (h.type === "taste" && h.designId) {
    return `mention://taste/${h.id}?design=${encodeURIComponent(h.designId)}`;
  }
  return `mention://${h.type}/${h.id}`;
}
function decorate(h: Omit<MentionHit, "mentionUri" | "markdown">): MentionHit {
  const mentionUri = buildMentionUri(h);
  return { ...h, mentionUri, markdown: `[@${h.label}](${mentionUri})` };
}

// Section snapshots are persisted on every `PUT /api/ideas/:id` via the
// shared `extractIdeaSections` helper, so this route just reads them from
// the Idea.sections JSONB column — no re-parsing on every search call, and
// the slugs stay identical to what the frontend preview renders.
type PersistedSection = { slug: string; text: string; level: number; order: number };

/**
 * GET /api/workspaces/:workspaceId/mentions/search
 *
 * Query params:
 *   q      — case-insensitive search string (trimmed; empty returns top-N recents)
 *   types  — comma-separated subset of view,taste,idea,idea-section (default: all)
 *   limit  — max total hits to return (default 10, cap 30)
 *
 * Response: { hits: MentionHit[] }
 *
 * Ranking: each type is ranked internally (exact-prefix > substring > length
 * > alphabetical), then results are interleaved round-robin across types so
 * the top-10 always shows a balanced mix — with ~30 views and a handful of
 * tastes / ideas, a pure global sort would starve everything but views.
 */
router.get("/:workspaceId/mentions/search", asyncHandler(async (req: Request, res: Response) => {
  const { workspaceId } = req.params;
  const qRaw = (req.query.q as string) || "";
  const q = qRaw.trim().toLowerCase();
  const typesRaw = (req.query.types as string) || "view,taste,idea,idea-section";
  const types = new Set(typesRaw.split(",").map(s => s.trim()).filter(Boolean));
  const limit = Math.min(parseInt((req.query.limit as string) || "10", 10), 30);

  const matchesAny = (facets: string[]) => {
    if (!q) return true;
    return facets.some(s => s.toLowerCase().includes(q));
  };

  // Each type maintains its own ranked bucket — we interleave them at the end
  // so no single type (views, usually) can crowd out the others.
  const viewHits: MentionHit[] = [];
  const tasteHits: MentionHit[] = [];
  const ideaHits: MentionHit[] = [];
  const sectionHits: MentionHit[] = [];

  // ── Views (inside each table's JSONB views[]) ──
  // Tables with 0 records are filtered out: an empty table has nothing
  // behind its views, so referencing them adds noise to the picker. We
  // pull `_count.records` instead of the full records relation to keep
  // this cheap.
  if (types.has("view")) {
    const tables = await prisma.table.findMany({
      where: { workspaceId },
      select: { id: true, name: true, views: true, _count: { select: { records: true } } },
    });
    for (const t of tables) {
      if (t._count.records === 0) continue;
      const views = (t.views as unknown as Array<{ id: string; name: string }>) || [];
      for (const v of views) {
        if (!v?.id || !v?.name) continue;
        const label = `${t.name}.${v.name}`;
        if (matchesAny([label, t.name, v.name])) {
          viewHits.push(decorate({ type: "view", id: v.id, label, tableId: t.id }));
        }
      }
    }
  }

  // ── Tastes (SVGs inside designs) ──
  // Tastes without a `filePath` have no SVG payload to reference — they
  // exist as placeholders but carry no content, so hide them from the
  // picker.
  if (types.has("taste")) {
    const designs = await prisma.design.findMany({
      where: { workspaceId },
      select: {
        id: true,
        name: true,
        tastes: { select: { id: true, name: true, filePath: true } },
      },
    });
    for (const d of designs) {
      for (const tst of d.tastes) {
        if (!tst.filePath) continue;
        const label = `${d.name}.${tst.name}`;
        if (matchesAny([label, d.name, tst.name])) {
          tasteHits.push(decorate({ type: "taste", id: tst.id, label, designId: d.id }));
        }
      }
    }
  }

  // ── Ideas + their sections ──
  // Sections are stored on Idea.sections (JSONB, refreshed on every content
  // save), so one cheap findMany gives us both idea and idea-section hits
  // without parsing content at read time. Ideas with empty (whitespace-only)
  // content are filtered out — they have no body to jump to and no sections,
  // so surfacing them would just be dead weight in the picker.
  const needIdeas = types.has("idea") || types.has("idea-section");
  if (needIdeas) {
    const ideas = await prisma.idea.findMany({
      where: { workspaceId },
      select: {
        id: true,
        name: true,
        content: true,
        sections: types.has("idea-section"),
      },
    });
    for (const i of ideas) {
      if (!i.content || !i.content.trim()) continue;
      if (types.has("idea") && matchesAny([i.name])) {
        ideaHits.push(decorate({ type: "idea", id: i.id, label: i.name }));
      }
      if (types.has("idea-section")) {
        const sections = ((i as { sections?: unknown }).sections
          ?? []) as PersistedSection[];
        if (!Array.isArray(sections)) continue;
        for (const s of sections) {
          if (!s?.slug || !s?.text) continue;
          const label = `${i.name}.${s.text}`;
          if (matchesAny([label, i.name, s.text])) {
            sectionHits.push(decorate({
              type: "idea-section",
              id: s.slug,
              label,
              ideaId: i.id,
              headingText: s.text,
            }));
          }
        }
      }
    }
  }

  // ── Rank within each bucket ──
  const rankCmp = (a: MentionHit, b: MentionHit) => {
    if (!q) return a.label.localeCompare(b.label);
    const aLc = a.label.toLowerCase();
    const bLc = b.label.toLowerCase();
    const aPrefix = aLc.startsWith(q) ? 0 : 1;
    const bPrefix = bLc.startsWith(q) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    if (a.label.length !== b.label.length) return a.label.length - b.label.length;
    return a.label.localeCompare(b.label);
  };
  viewHits.sort(rankCmp);
  tasteHits.sort(rankCmp);
  ideaHits.sort(rankCmp);
  sectionHits.sort(rankCmp);

  // ── Interleave buckets round-robin until we hit the limit ──
  // Order (view → taste → idea → idea-section) mirrors how the picker groups
  // them visually, so early takes from each bucket surface representatively.
  const buckets = [viewHits, tasteHits, ideaHits, sectionHits];
  const hits: MentionHit[] = [];
  let progress = true;
  while (hits.length < limit && progress) {
    progress = false;
    for (const b of buckets) {
      if (b.length === 0) continue;
      hits.push(b.shift()!);
      progress = true;
      if (hits.length >= limit) break;
    }
  }

  res.json({ hits });
}));

export default router;
