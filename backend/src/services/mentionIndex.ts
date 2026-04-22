/**
 * Mention index — parses `[@label](mention://type/id?qs)` links out of an
 * idea's Markdown and maintains the `Mention` table in sync with what the
 * document actually says. The mention picker + frontend chip renderer
 * (`MarkdownPreview.tsx`) produce exactly this anchor shape, so we parse the
 * same literal that's on disk rather than trying to reconstruct semantic
 * mentions from a Markdown AST.
 *
 * Scope rules:
 *   - Only ATX-style Markdown links whose href starts with `mention://` are
 *     treated as mentions. HTML `<a href="mention://...">` is NOT matched —
 *     keeps this parser O(n) with one regex pass. If a future feature emits
 *     HTML mention chips, we'll extend here.
 *   - Mentions inside fenced code blocks (``` / ~~~) are ignored. They're
 *     documentation about mentions, not actual mentions.
 *   - targetId normalization for `idea-section` uses the composite
 *     "<ideaId>#<slug>" key so reverse-lookup indexing is uniform across
 *     target types (every row has a single indexable string).
 *
 * This module is pure — no DB, no side effects. Callers (ideaRoutes PUT,
 * ideaWriteService) diff the parsed list against the current DB state and
 * fan out the writes themselves, inside the same transaction that persists
 * the content. Keeps the "content + mentions" write atomic.
 */

export type MentionTargetType = "view" | "taste" | "idea" | "idea-section";

/** One parsed mention, addressable by composite targetId. */
export interface ParsedMention {
  targetType: MentionTargetType;
  /** Composite key. For idea-section: `<ideaId>#<slug>`. Else: the raw id. */
  targetId: string;
  /** Label inside `[@label]`. Kept verbatim — renderers decide display. */
  rawLabel: string;
  /** Character offset of `[` in the source content, for contextExcerpt. */
  sourceOffset: number;
}

// Canonical order so `dedupeKey` is stable across renders.
function queryToRecord(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!qs) return out;
  for (const pair of qs.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Normalize `[@label](mention://type/id?qs)` into a ParsedMention.
 * Returns null if the href isn't a recognized mention scheme or the type
 * isn't one we support — keeps bad links from polluting the reverse index.
 */
function normalizeHref(
  href: string,
  label: string,
  offset: number
): ParsedMention | null {
  // Expected: mention://<type>/<id>?<query>
  if (!href.startsWith("mention://")) return null;
  const rest = href.slice("mention://".length);
  const qsStart = rest.indexOf("?");
  const pathPart = qsStart >= 0 ? rest.slice(0, qsStart) : rest;
  const qs = qsStart >= 0 ? rest.slice(qsStart + 1) : "";
  const slashIdx = pathPart.indexOf("/");
  if (slashIdx < 0) return null;
  const type = pathPart.slice(0, slashIdx) as MentionTargetType;
  const id = pathPart.slice(slashIdx + 1);
  if (!id) return null;

  const query = queryToRecord(qs);
  let targetId: string;
  switch (type) {
    case "view":
    case "taste":
    case "idea":
      targetId = id;
      break;
    case "idea-section": {
      // Picker encodes section links as `mention://idea-section/<slug>?idea=<ideaId>`.
      // We flatten to "<ideaId>#<slug>" so reverse lookups index one string.
      const ideaId = query.idea;
      if (!ideaId) return null;
      targetId = `${ideaId}#${id}`;
      break;
    }
    default:
      return null;
  }

  return {
    targetType: type,
    targetId,
    rawLabel: label,
    sourceOffset: offset,
  };
}

/**
 * Extract all `[@label](mention://...)` mentions from Markdown content.
 * Skips fenced-code blocks (``` / ~~~) so example mention syntax in docs
 * doesn't get recorded as real references.
 *
 * Duplicates are preserved in the returned list (so contextExcerpt per
 * occurrence can differ); callers typically dedupe by `mentionDedupeKey`
 * before writing to the DB.
 */
export function parseMentions(content: string | null | undefined): ParsedMention[] {
  if (!content) return [];
  const out: ParsedMention[] = [];

  // Pre-compute fenced-code ranges so the link regex below can skip them.
  const codeRanges: Array<[number, number]> = [];
  {
    const lines = content.split(/\r?\n/);
    let offset = 0;
    let openStart = -1;
    for (const line of lines) {
      const m = /^\s{0,3}(`{3,}|~{3,})/.test(line);
      if (m) {
        if (openStart < 0) openStart = offset;
        else {
          codeRanges.push([openStart, offset + line.length]);
          openStart = -1;
        }
      }
      offset += line.length + 1; // +1 for \n (approx; \r\n double-counted but harmless here — we only use it for range check)
    }
    if (openStart >= 0) codeRanges.push([openStart, content.length]);
  }
  const inCode = (idx: number) => codeRanges.some(([s, e]) => idx >= s && idx < e);

  // Match `[label](href)`. href is non-greedy and stops at first `)` (no
  // support for escaped parens inside href, which mention:// links never have).
  const linkRe = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(content)) !== null) {
    if (inCode(m.index)) continue;
    const normalized = normalizeHref(m[2], m[1], m.index);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * Stable string key that identifies a mention edge uniquely. Used to dedupe
 * when a single target is referenced multiple times in the same source doc —
 * we only want one row per (sourceType, sourceId, targetType, targetId).
 */
export function mentionDedupeKey(m: {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
}): string {
  return `${m.sourceType}::${m.sourceId}::${m.targetType}::${m.targetId}`;
}

/**
 * Extract a short excerpt around the mention for the reverse-ref UI. We
 * take ~80 chars before + 80 after, collapse internal newlines so the
 * preview stays one-line, and strip the `[...](mention://...)` boilerplate
 * from the excerpt so it reads as prose rather than Markdown syntax.
 */
export function buildContextExcerpt(content: string, offset: number): string {
  const WINDOW = 80;
  const start = Math.max(0, offset - WINDOW);
  // Find the end of the link at `offset`: it's `[...](...)`
  const end = (() => {
    const paren = content.indexOf(")", offset);
    const after = paren >= 0 ? Math.min(content.length, paren + 1 + WINDOW) : Math.min(content.length, offset + WINDOW);
    return after;
  })();
  let excerpt = content.slice(start, end);
  // Strip the mention-link syntax itself so reverse UI shows "…foo @bar baz…"
  excerpt = excerpt.replace(/\[([^\]\n]+)\]\(mention:\/\/[^)\s]+\)/g, "@$1");
  // Collapse whitespace runs to single spaces for one-line preview.
  excerpt = excerpt.replace(/\s+/g, " ").trim();
  if (start > 0) excerpt = "…" + excerpt;
  if (end < content.length) excerpt = excerpt + "…";
  return excerpt.slice(0, 240); // hard cap — DB column is not constrained but UI is
}

/** Convenience: parse + dedupe + attach excerpts in one pass. */
export function buildMentionRows(
  content: string,
  sourceType: string,
  sourceId: string,
  workspaceId: string
): Array<{
  workspaceId: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  rawLabel: string;
  contextExcerpt: string | null;
}> {
  const parsed = parseMentions(content);
  const byKey = new Map<
    string,
    {
      workspaceId: string;
      sourceType: string;
      sourceId: string;
      targetType: string;
      targetId: string;
      rawLabel: string;
      contextExcerpt: string | null;
    }
  >();
  for (const p of parsed) {
    const key = mentionDedupeKey({
      sourceType,
      sourceId,
      targetType: p.targetType,
      targetId: p.targetId,
    });
    if (byKey.has(key)) continue; // first occurrence wins for excerpt
    byKey.set(key, {
      workspaceId,
      sourceType,
      sourceId,
      targetType: p.targetType,
      targetId: p.targetId,
      rawLabel: p.rawLabel,
      contextExcerpt: buildContextExcerpt(content, p.sourceOffset) || null,
    });
  }
  return [...byKey.values()];
}
