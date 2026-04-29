/**
 * Idea block parser + sync (PR6).
 *
 * `parseToBlocks(markdown)` splits a Markdown string into a sequence of
 * top-level "blocks" while preserving the original bytes per-block. The
 * critical invariant: `blocks.map(b => b.content).join("") === input`.
 * That guarantees:
 *   - source-mode editing in IdeaEditor is byte-stable (no reparse drift)
 *   - GitHub-style external diffs work
 *   - Round-trip via `Idea.content` (still source of truth) is exact
 *
 * Block types we recognise (V1):
 *   heading | paragraph | list | code | quote | divider | html | table
 *
 * `syncBlocksForIdea(ideaId, content, tx)` is called inside the existing
 * write-path `$transaction` (PUT /content, /write anchor, stream finalize)
 * so the IdeaBlock table stays consistent with Idea.content atomically.
 *
 * 详见 docs/roadmap-post-skill-v1.md PR6.
 */

import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

export type IdeaBlockType =
  | "heading"
  | "paragraph"
  | "list"
  | "code"
  | "quote"
  | "divider"
  | "html"
  | "table";

export interface ParsedBlock {
  type: IdeaBlockType;
  /** Raw Markdown bytes for this block, including its trailing blank line(s).
   *  `parsedBlocks.map(b => b.content).join("")` === original input. */
  content: string;
  /** Type-specific metadata. Shape depends on type:
   *   heading: { level: number, slug: string, text: string }
   *   list:    { ordered: bool, startsAt?: number }
   *   code:    { language: string | null }
   *   table:   { columns: number, hasHeader: bool }
   *   quote / divider / html / paragraph: {}
   */
  props: Record<string, unknown>;
}

// ─── Parser ──────────────────────────────────────────────────────────────

/** Pre-compute heading slug (kebab-cased, ASCII + CJK preserved, deduped via
 *  caller's running counter). Mirror the same logic as `extractIdeaSections`
 *  so existing slug-based mentions keep working. */
function slugify(text: string, used: Map<string, number>): string {
  let base = text
    .toLowerCase()
    .trim()
    .replace(/[#*_`~\[\]()<>"']/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) base = "section";
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/** Top-level block tokenizer. Walks line-by-line tracking state; emits a
 *  block whenever the current state ends. Always preserves byte-for-byte
 *  content (each block carries its raw substring including trailing newlines).
 *
 *  Edge cases handled:
 *   - leading blank lines → first paragraph absorbs them (cheaper than
 *     a separate "blank" block; round-trip preserved either way)
 *   - input not ending in newline → last block's content lacks trailing \n
 *   - fenced code blocks with arbitrary content (must not be mis-parsed
 *     as headings / lists / etc. inside)
 *   - HTML blocks: opening `<tag>` on its own line starts an html block
 *     that runs until `</tag>` on its own line (sufficient for our
 *     rehype-raw + sanitize use case; not a full HTML parser)
 *   - tables: detected by header row + separator row of `---`/`:--:`
 *   - lists: consecutive bullets group into one block; blank line breaks the list
 */
export function parseToBlocks(input: string): ParsedBlock[] {
  if (input.length === 0) return [];

  // Split keeping line-end info so we can reassemble exactly.
  const lines: { text: string; raw: string }[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const nl = input.indexOf("\n", cursor);
    if (nl === -1) {
      lines.push({ text: input.slice(cursor), raw: input.slice(cursor) });
      break;
    }
    // raw includes the \n; text excludes it (for matching)
    const text = input.slice(cursor, nl);
    const raw = input.slice(cursor, nl + 1);
    lines.push({ text, raw });
    cursor = nl + 1;
  }

  const blocks: ParsedBlock[] = [];
  const headingSlugs = new Map<string, number>();
  let i = 0;

  function pushBlock(type: IdeaBlockType, startLine: number, endLineEx: number, props: Record<string, unknown> = {}): void {
    const content = lines.slice(startLine, endLineEx).map(l => l.raw).join("");
    blocks.push({ type, content, props });
  }

  while (i < lines.length) {
    const ln = lines[i];

    // ── 1. Blank line — absorb into preceding paragraph or skip ──
    if (ln.text.trim() === "") {
      // Lone blank between blocks: attach to previous block to preserve
      // bytes. If no previous block, create a tiny "paragraph" placeholder
      // (lossy alternative would be skipping, breaking round-trip).
      if (blocks.length > 0) {
        blocks[blocks.length - 1].content += ln.raw;
      } else {
        blocks.push({ type: "paragraph", content: ln.raw, props: {} });
      }
      i++;
      continue;
    }

    // ── 2. Fenced code (```...``` or ~~~...~~~) ──
    const codeFence = ln.text.match(/^(\s*)(```|~~~)([^`~\s]*)\s*$/);
    if (codeFence) {
      const indent = codeFence[1];
      const fence = codeFence[2];
      const language = (codeFence[3] || "").trim() || null;
      const start = i;
      i++;
      // Walk until matching fence (same char, ≥ same length, same indent).
      while (i < lines.length) {
        const l = lines[i].text;
        if (new RegExp(`^${indent}${fence}+\\s*$`).test(l)) {
          i++;
          break;
        }
        i++;
      }
      pushBlock("code", start, i, { language });
      continue;
    }

    // ── 3. Heading (#-style only; setext omitted for V1) ──
    const heading = ln.text.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const slug = slugify(text, headingSlugs);
      pushBlock("heading", i, i + 1, { level, slug, text });
      i++;
      continue;
    }

    // ── 4. Horizontal rule ──
    if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(ln.text)) {
      pushBlock("divider", i, i + 1, {});
      i++;
      continue;
    }

    // ── 5. Block quote (> ...) ──
    if (/^\s*>\s?/.test(ln.text)) {
      const start = i;
      while (i < lines.length && /^\s*>\s?/.test(lines[i].text)) i++;
      pushBlock("quote", start, i, {});
      continue;
    }

    // ── 6. List (bullet or ordered) ──
    const bulletStart = ln.text.match(/^(\s*)([-*+])\s+/);
    const orderedStart = ln.text.match(/^(\s*)(\d+)[.)]\s+/);
    if (bulletStart || orderedStart) {
      const ordered = !!orderedStart;
      const startsAt = ordered ? Number(orderedStart![2]) : undefined;
      const start = i;
      while (i < lines.length) {
        const l = lines[i].text;
        if (l.trim() === "") {
          // Blank line ends list (per CommonMark loose-list rules — close
          // enough for our render needs; nested loose lists aren't a
          // priority for V1).
          break;
        }
        if (
          /^(\s*)([-*+])\s+/.test(l) ||
          /^(\s*)(\d+)[.)]\s+/.test(l) ||
          // Continuation lines (indented) belong to the list.
          /^\s{2,}/.test(l)
        ) {
          i++;
          continue;
        }
        break;
      }
      const props: Record<string, unknown> = { ordered };
      if (typeof startsAt === "number") props.startsAt = startsAt;
      pushBlock("list", start, i, props);
      continue;
    }

    // ── 7. Table ──
    // Header row contains `|` and the next line is a separator (---|---).
    if (i + 1 < lines.length && /\|/.test(ln.text)) {
      const sep = lines[i + 1].text;
      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(sep)) {
        const start = i;
        // Header + separator
        i += 2;
        // Rows: until blank line or non-pipe line
        while (i < lines.length) {
          const l = lines[i].text;
          if (l.trim() === "" || !/\|/.test(l)) break;
          i++;
        }
        // Column count from header
        const cols = ln.text.split("|").filter(s => s.trim() !== "").length;
        pushBlock("table", start, i, { columns: cols, hasHeader: true });
        continue;
      }
    }

    // ── 8. HTML block (opening tag on its own line) ──
    // We support a small set of block-level tags: div / section / article
    // / figure / aside / nav / header / footer / details / blockquote /
    // pre / script (nope, sanitize will strip) / svg.
    const htmlOpen = ln.text.match(/^\s*<(div|section|article|figure|aside|nav|header|footer|details|pre|svg|table)\b/i);
    if (htmlOpen) {
      const tag = htmlOpen[1].toLowerCase();
      const start = i;
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      // Scan until matching close tag (single-line close also OK).
      // Same-line close handled below.
      if (closeRe.test(ln.text)) {
        i++;
        pushBlock("html", start, i, { tag });
        continue;
      }
      i++;
      while (i < lines.length) {
        if (closeRe.test(lines[i].text)) {
          i++;
          break;
        }
        i++;
      }
      pushBlock("html", start, i, { tag });
      continue;
    }

    // ── 9. Paragraph (default) ──
    const start = i;
    while (i < lines.length) {
      const l = lines[i].text;
      if (l.trim() === "") break;
      // Stop at the start of any block-level construct.
      if (
        /^#{1,6}\s/.test(l) ||
        /^(\s*)(```|~~~)/.test(l) ||
        /^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(l) ||
        /^\s*>/.test(l) ||
        /^(\s*)([-*+])\s+/.test(l) ||
        /^(\s*)(\d+)[.)]\s+/.test(l)
      ) {
        break;
      }
      i++;
    }
    pushBlock("paragraph", start, i, {});
  }

  return blocks;
}

/** Reassemble blocks into the original Markdown. Trivial concat — relies on
 *  parseToBlocks preserving raw bytes. Useful for round-trip tests. */
export function reassembleBlocks(blocks: ParsedBlock[]): string {
  return blocks.map(b => b.content).join("");
}

// ─── Sync into DB ────────────────────────────────────────────────────────

type PrismaTxLike = Prisma.TransactionClient | PrismaClient;

/**
 * Replace all IdeaBlock rows for `ideaId` with the parsed result of
 * `content`. Caller must run inside a `$transaction` together with the
 * Idea.content update so reads never see a half-updated state.
 *
 * Returns the number of blocks written.
 */
export async function syncBlocksForIdea(
  tx: PrismaTxLike,
  ideaId: string,
  content: string,
): Promise<number> {
  const parsed = parseToBlocks(content);
  await tx.ideaBlock.deleteMany({ where: { ideaId } });
  if (parsed.length === 0) return 0;
  // createMany doesn't return ids in Postgres; we don't need them here, the
  // FE will fetch via `GET /api/ideas/:id/blocks` which reads ordered by
  // (ideaId, order). For deterministic order assign integer 0,1,2... — PR8
  // will switch to fractional indexing on drag.
  await tx.ideaBlock.createMany({
    data: parsed.map((b, idx) => ({
      ideaId,
      order: idx,
      type: b.type,
      content: b.content,
      props: b.props as any,
    })),
  });
  return parsed.length;
}

export interface IdeaBlockRow {
  id: string;
  ideaId: string;
  order: number;
  type: IdeaBlockType;
  content: string;
  props: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Fetch all blocks for an idea, ordered. */
export async function listBlocksForIdea(
  prisma: PrismaTxLike,
  ideaId: string,
): Promise<IdeaBlockRow[]> {
  const rows = await prisma.ideaBlock.findMany({
    where: { ideaId },
    orderBy: { order: "asc" },
  });
  return rows as unknown as IdeaBlockRow[];
}
