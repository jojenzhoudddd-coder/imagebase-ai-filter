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
 * Sync IdeaBlock rows for `ideaId` to match the parsed result of `content`.
 *
 * 2026-04-29 fix:we used to do `deleteMany + createMany`, which regenerated
 * every block's primary key on every write. Any FE state that held a block
 * id from before the save (drag, BlockMenu, mention chip) would 404 on the
 * next API call. The fix: align rows by **position** and update in place.
 * - position i present in both old + new → UPDATE existing row (id stays)
 * - position i only in new → INSERT new row
 * - position i only in old → DELETE extra row
 *
 * This means a row's id is tied to its position, not its content. After
 * a drag-reorder via POST /move, the row at position N has new content but
 * the same id as before the move — which is fine for drag UX and mention
 * stability (a `mention://idea-block/<id>` link refers to "this position",
 * which is a reasonable identity for block-level anchors).
 *
 * Caller must run inside the `$transaction` that also writes Idea.content
 * so readers never see a half-updated state. Returns the row count.
 */
export async function syncBlocksForIdea(
  tx: PrismaTxLike,
  ideaId: string,
  content: string,
): Promise<number> {
  const parsed = parseToBlocks(content);
  const existing = (await tx.ideaBlock.findMany({
    where: { ideaId },
    orderBy: { order: "asc" },
  })) as unknown as IdeaBlockRow[];

  const max = Math.max(parsed.length, existing.length);
  for (let i = 0; i < max; i++) {
    const pa = parsed[i];
    const ex = existing[i];
    if (pa && ex) {
      // Update in place if anything changed. Cheap equality checks first.
      const propsChanged =
        JSON.stringify(ex.props ?? {}) !== JSON.stringify(pa.props ?? {});
      if (
        ex.type !== pa.type ||
        ex.content !== pa.content ||
        ex.order !== i ||
        propsChanged
      ) {
        await tx.ideaBlock.update({
          where: { id: ex.id },
          data: {
            type: pa.type,
            content: pa.content,
            order: i,
            props: pa.props as any,
          },
        });
      }
    } else if (pa) {
      // New block at position i → insert
      await tx.ideaBlock.create({
        data: {
          ideaId,
          order: i,
          type: pa.type,
          content: pa.content,
          props: pa.props as any,
        },
      });
    } else if (ex) {
      // Removed block at position i → delete
      await tx.ideaBlock.delete({ where: { id: ex.id } });
    }
  }
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

/** Fetch a list of blocks by id (used by chatAgentService when injecting
 *  idea-block mention content into the system prompt). Order preserved
 *  per the input ids array. Missing ids skipped silently. */
export async function getBlocksByIds(
  prisma: PrismaTxLike,
  ids: string[],
): Promise<IdeaBlockRow[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.ideaBlock.findMany({ where: { id: { in: ids } } });
  const byId = new Map((rows as IdeaBlockRow[]).map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is IdeaBlockRow => !!r);
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

// ─── PR8: block-level mutation primitives ─────────────────────────────────
// These are the building blocks for the FE hover-⋮ menu (copy link / delete
// / convert type) and the Agent's `update_idea_block` / `delete_idea_block` /
// `move_idea_block` tools. They all operate by recomputing `Idea.content`
// (still source of truth) — the IdeaBlock table is then synced via
// `syncBlocksForIdea` so reads stay consistent.
//
// Critical: each call must run inside a `$transaction` together with the
// content + mention update so readers never see a half-state. Helpers
// return the new full content + version so the route handler can broadcast
// SSE / response correctly.

export class IdeaBlockNotFoundError extends Error {
  constructor(blockId: string) {
    super(`idea block not found: ${blockId}`);
    this.name = "IdeaBlockNotFoundError";
  }
}

export interface BlockContext {
  block: IdeaBlockRow;
  /** The owning Idea (id + content + version). */
  idea: { id: string; content: string; version: number; workspaceId: string };
  /** Zero-based position in the ordered list. */
  index: number;
  /** Byte offset of this block's start in `idea.content`. */
  byteStart: number;
  /** Byte offset of this block's end (exclusive) in `idea.content`. */
  byteEnd: number;
  /** All blocks in order (so callers can do their own splicing). */
  ordered: IdeaBlockRow[];
}

/**
 * Look up a block + compute its byte position within the parent idea's
 * content. Throws `IdeaBlockNotFoundError` if missing.
 *
 * `byteStart` is computed from the prefix sum of the ordered blocks'
 * `content` lengths — relies on PR6's byte-stable parser invariant
 * (`blocks.map(b => b.content).join("") === idea.content`).
 */
export async function getBlockWithContext(
  prisma: PrismaTxLike,
  blockId: string,
): Promise<BlockContext> {
  const found = await prisma.ideaBlock.findUnique({ where: { id: blockId } });
  if (!found) throw new IdeaBlockNotFoundError(blockId);
  const block = found as unknown as IdeaBlockRow;
  const idea = await prisma.idea.findUnique({
    where: { id: block.ideaId },
    select: { id: true, content: true, version: true, workspaceId: true },
  });
  if (!idea) throw new IdeaBlockNotFoundError(blockId); // idea gone but block lingered? defensive
  const ordered = await listBlocksForIdea(prisma, block.ideaId);
  const index = ordered.findIndex((b) => b.id === blockId);
  if (index === -1) throw new IdeaBlockNotFoundError(blockId);
  let byteStart = 0;
  for (let i = 0; i < index; i++) byteStart += ordered[i].content.length;
  const byteEnd = byteStart + ordered[index].content.length;
  return { block, idea, index, byteStart, byteEnd, ordered };
}

/**
 * Replace one block's raw Markdown content with `newBlockContent`. The new
 * content is parsed and inserted as one or more blocks at the same position.
 * (One paragraph could become two by adding a blank line in the middle —
 * we let the parser decide; the block table picks up the change after sync.)
 *
 * Returns the new full content. Caller is responsible for running the
 * surrounding $transaction (including mention rebuild + sync).
 */
export function spliceBlockContent(
  ctx: BlockContext,
  newBlockContent: string,
): string {
  const { idea, byteStart, byteEnd } = ctx;
  return idea.content.slice(0, byteStart) + newBlockContent + idea.content.slice(byteEnd);
}

/**
 * Delete one block from the parent idea's content. Returns new full content.
 */
export function spliceBlockDelete(ctx: BlockContext): string {
  return spliceBlockContent(ctx, "");
}

/**
 * Move a block to a new position in the ordered list. `targetIndex` is the
 * desired *final* index (0-based). Returns new full content with all blocks
 * reassembled in the new order.
 *
 * Boundary cases:
 *   - targetIndex === ctx.index → returns identical content (no-op)
 *   - targetIndex < 0 → clamped to 0 (move to start)
 *   - targetIndex >= ordered.length → clamped to last (move to end)
 */
export function spliceBlockMove(
  ctx: BlockContext,
  targetIndex: number,
): string {
  const { ordered, index } = ctx;
  const len = ordered.length;
  let to = targetIndex;
  if (to < 0) to = 0;
  if (to > len - 1) to = len - 1;
  if (to === index) return ctx.idea.content;

  // Preserve the original "document tail" convention so the post-move file
  // ends the way it did before. Without this, moving the last block away
  // can introduce or strip trailing newlines that changes how source view
  // displays the file (and accumulates aesthetic noise across many moves).
  const originalLast = ordered[len - 1];
  const originalTrailing = (originalLast.content.match(/[ \t]*\n*$/)?.[0]) ?? "";

  const reordered = [...ordered];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(to, 0, moved);

  // Normalize each block's tail:
  //   - non-last → exactly "\n\n" so heading-level constructs stay visually
  //     separated (otherwise two `# X` lines would adhere)
  //   - last    → original document trailing (could be "", "\n", or "\n\n")
  return reordered
    .map((b, i) => {
      const isLast = i === reordered.length - 1;
      const stripped = b.content.replace(/[ \t]*\n*$/, "");
      return stripped + (isLast ? originalTrailing : "\n\n");
    })
    .join("");
}

/**
 * Type-conversion helpers — produce new block content for a target type
 * by stripping / reapplying common Markdown markers. Best-effort: we try to
 * preserve the user's text while changing the wrapper.
 *
 * Supported transforms:
 *   paragraph ↔ heading-1..6
 *   paragraph ↔ quote
 *   paragraph ↔ list-bullet
 *   any ↔ paragraph (strip markers)
 *
 * Code blocks / tables / dividers / html are special — converting from
 * those is lossy, so we accept the loss gracefully (the marker text becomes
 * raw paragraph text). Converting *to* code/table/divider/html via this path
 * is intentionally NOT supported (use the regular editor for that).
 */
export function transformBlockContent(
  current: string,
  fromType: string,
  toType:
    | "paragraph"
    | "heading-1"
    | "heading-2"
    | "heading-3"
    | "heading-4"
    | "heading-5"
    | "heading-6"
    | "quote"
    | "list-bullet"
    | "divider",
): string {
  // Step 1: strip the leading marker(s) from the current block to get the
  // "naked" text. Operate per-line.
  const trailing = current.match(/\s*$/)?.[0] ?? "";
  const body = current.slice(0, current.length - trailing.length);
  const naked = body
    .split("\n")
    .map((line) => {
      // strip heading markers
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) return heading[2];
      // strip quote markers
      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) return quote[1];
      // strip bullet
      const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (bullet) return bullet[2];
      // strip ordered
      const ord = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
      if (ord) return ord[2];
      return line;
    })
    .join("\n");
  // Step 2: reapply the target marker.
  let next: string;
  if (toType === "divider") {
    // Discard text — divider has none.
    next = "---";
  } else if (toType.startsWith("heading-")) {
    const level = parseInt(toType.slice("heading-".length), 10);
    const hashes = "#".repeat(Math.max(1, Math.min(6, level)));
    // Headings are single-line — collapse multi-line to first non-empty line.
    const firstLine = naked.split("\n").find((l) => l.trim()) ?? "";
    next = `${hashes} ${firstLine.trim()}`;
  } else if (toType === "quote") {
    next = naked
      .split("\n")
      .map((l) => (l.trim() ? `> ${l}` : ">"))
      .join("\n");
  } else if (toType === "list-bullet") {
    next = naked
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => `- ${l.trim()}`)
      .join("\n");
  } else {
    // paragraph
    next = naked.trim();
  }
  // Step 3: reattach the trailing whitespace so block boundaries stay clean.
  // If the original had no trailing newline (last block of file) keep that
  // behaviour; otherwise ensure exactly one trailing newline.
  if (trailing) return next + (trailing.includes("\n") ? trailing : "\n");
  // Fallback for last-block-no-trailing-newline case.
  void fromType;
  return next;
}
