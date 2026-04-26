import { Router, Request, Response, RequestHandler } from "express";
import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { listVisibleModels } from "../services/modelRegistry.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Wrap async handlers so Prisma errors reach the error middleware instead of
// taking down the node process.
const asyncHandler = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { Promise.resolve(fn(req, res)).catch(next); };

const router = Router();

/**
 * Mention hit — v4 scope (PR1 of agent-workflow series).
 *
 * v4 changes vs v3:
 *   - `view` removed → replaced by `table` (whole-table mention)
 *   - `design` added (whole-design mention,与 taste 平级,精度 = 整个画布)
 *   - `model` is added in PR2 (chat input only)
 *
 * Labels:
 *   - table        → "<TableName>"
 *   - design       → "<DesignName>"
 *   - taste        → "<DesignName>.<TasteName>"
 *   - idea         → "<IdeaName>"
 *   - idea-section → "<IdeaName>.<HeadingText>"
 */
type V4MentionType = "table" | "design" | "taste" | "idea" | "idea-section" | "model";

interface MentionHit {
  type: V4MentionType;
  id: string;
  label: string;
  tableId?: string;   // legacy field, no longer set on table hits (id IS the tableId)
  designId?: string;  // for taste
  ideaId?: string;    // for idea-section
  headingText?: string; // raw heading body for idea-section
  // Model-only fields
  modelId?: string;
  modelSpecialty?: string;
  /**
   * Canonical URI the frontend chip + MCP tools both emit into Markdown.
   * Mirrors exactly what `MentionPicker` inserts.
   */
  mentionUri: string;
  /** Ready-to-paste Markdown: `[@<label>](<mentionUri>)`. */
  markdown: string;
}

function buildMentionUri(h: Omit<MentionHit, "mentionUri" | "markdown">): string {
  if (h.type === "idea-section" && h.ideaId) {
    return `mention://idea-section/${h.id}?idea=${encodeURIComponent(h.ideaId)}`;
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
 * Type alias normalisation —— old clients may still send `?types=view`. We
 * silently rewrite to `table` so existing callers (e.g. an Agent prompt that
 * was tested in the v3 era) keep working without 400s.
 */
function normaliseTypesParam(raw: string): Set<V4MentionType> {
  const out = new Set<V4MentionType>();
  for (const seg of raw.split(",").map(s => s.trim()).filter(Boolean)) {
    if (seg === "view" || seg === "table") out.add("table");
    else if (seg === "design") out.add("design");
    else if (seg === "taste") out.add("taste");
    else if (seg === "idea") out.add("idea");
    else if (seg === "idea-section") out.add("idea-section");
    else if (seg === "model") out.add("model");
  }
  return out;
}

/**
 * GET /api/workspaces/:workspaceId/mentions/search
 *
 * Query params:
 *   q      — case-insensitive search string (trimmed; empty returns top-N recents)
 *   types  — comma-separated subset of table,design,taste,idea,idea-section
 *            (default: all). Legacy `view` is silently rewritten to `table`.
 *   limit  — max total hits to return (default 10, cap 30)
 *
 * Response: { hits: MentionHit[] }
 *
 * Ranking: each type is ranked internally (exact-prefix > substring > length
 * > alphabetical), then results are interleaved round-robin across types so
 * the top-10 always shows a balanced mix.
 */
router.get("/:workspaceId/mentions/search", asyncHandler(async (req: Request, res: Response) => {
  const { workspaceId } = req.params;
  const qRaw = (req.query.q as string) || "";
  const q = qRaw.trim().toLowerCase();
  // Default types intentionally exclude `model` — only the chat input
  // explicitly asks for it (`?types=table,design,...,model`). Idea editor
  // doesn't need model mentions and including them would add noise.
  const typesRaw = (req.query.types as string) || "table,design,taste,idea,idea-section";
  const types = normaliseTypesParam(typesRaw);
  const limit = Math.min(parseInt((req.query.limit as string) || "10", 10), 30);

  const matchesAny = (facets: string[]) => {
    if (!q) return true;
    return facets.some(s => s.toLowerCase().includes(q));
  };

  // Per-type ranked buckets, interleaved at the end.
  const tableHits: MentionHit[] = [];
  const designHits: MentionHit[] = [];
  const tasteHits: MentionHit[] = [];
  const ideaHits: MentionHit[] = [];
  const sectionHits: MentionHit[] = [];
  const modelHits: MentionHit[] = [];

  // ── Tables (whole-table mention,not view-level) ──
  // Tables with 0 records are filtered out: an empty table has nothing
  // behind it, so referencing them adds noise.
  if (types.has("table")) {
    const tables = await prisma.table.findMany({
      where: { workspaceId },
      select: { id: true, name: true, _count: { select: { records: true } } },
    });
    for (const t of tables) {
      if (t._count.records === 0) continue;
      if (matchesAny([t.name])) {
        tableHits.push(decorate({ type: "table", id: t.id, label: t.name }));
      }
    }
  }

  // ── Designs (whole-design mention) ──
  // Designs with 0 tastes are filtered: empty canvas has nothing to show.
  if (types.has("design")) {
    const designs = await prisma.design.findMany({
      where: { workspaceId },
      select: {
        id: true,
        name: true,
        _count: { select: { tastes: true } },
      },
    });
    for (const d of designs) {
      if (d._count.tastes === 0) continue;
      if (matchesAny([d.name])) {
        designHits.push(decorate({ type: "design", id: d.id, label: d.name }));
      }
    }
  }

  // ── Tastes (SVGs inside designs) ──
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

  // ── Models (chat input only) ──
  // listVisibleModels() filters `visible:false` (e.g. nano-banana / gemini-flash
  // stubs while available:false). We DO include `available:false` visible models
  // so the user can still mention them as a "preferred but offline" hint;
  // workflow-skill will route around availability at execution time.
  if (types.has("model")) {
    for (const m of listVisibleModels()) {
      // Filter both displayName and id to be picker-friendly
      if (matchesAny([m.displayName, m.id])) {
        modelHits.push(decorate({
          type: "model",
          id: m.id,
          label: m.displayName,
          modelId: m.id,
          modelSpecialty: m.specialty,
        }));
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
  tableHits.sort(rankCmp);
  designHits.sort(rankCmp);
  tasteHits.sort(rankCmp);
  ideaHits.sort(rankCmp);
  sectionHits.sort(rankCmp);
  modelHits.sort(rankCmp);

  // Order (model → table → design → taste → idea → idea-section). Models go
  // first so they're easy to find in chat input where they're the most
  // intentional cross-cutting mention. (Idea editor never asks for `model`
  // so its order is unchanged.)
  const buckets = [modelHits, tableHits, designHits, tasteHits, ideaHits, sectionHits];
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
