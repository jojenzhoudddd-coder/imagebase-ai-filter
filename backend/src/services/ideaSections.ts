/**
 * Idea section extractor.
 *
 * Parses ATX-style Markdown headings (`# H1` … `###### H6`) out of idea
 * content and returns a compact snapshot used for (a) persisting to
 * `Idea.sections` on every content save and (b) feeding the @mention picker's
 * "Idea" category with section-level targets.
 *
 * The slug algorithm must stay byte-for-byte identical to the frontend
 * `slugifyBase` in `frontend/src/components/IdeaEditor/MarkdownPreview.tsx`
 * so `mention://idea-section/<slug>?idea=<ideaId>` URLs resolve via
 * `document.getElementById(slug)` in the rendered preview DOM.
 *
 * Setext-style headings (`Heading\n=====`) and headings inside fenced code
 * blocks are intentionally ignored — they're rare in practice and would
 * require a real Markdown AST parse to handle correctly. This regex pass
 * runs in O(n) over content size, cheap enough to invoke on every save.
 */

export interface IdeaSection {
  /** Stable anchor slug, unique within a single idea doc. */
  slug: string;
  /** Heading text as it appears in source (trimmed, operator stripped). */
  text: string;
  /** Heading level, 1..6. */
  level: number;
  /** Sequential order in document (0-indexed). Lets callers sort without
   *  needing to re-scan content. */
  order: number;
}

function slugifyBase(raw: string): string {
  const base = raw
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff_\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "section";
}

export function extractIdeaSections(content: string | null | undefined): IdeaSection[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  const out: IdeaSection[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  let order = 0;
  for (const line of lines) {
    // Toggle fenced code state on ``` / ~~~ so `# title` inside code doesn't
    // surface as a real heading.
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    const text = m[2].trim();
    if (!text) continue;
    const base = slugifyBase(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    out.push({ slug, text, level, order: order++ });
  }
  return out;
}
