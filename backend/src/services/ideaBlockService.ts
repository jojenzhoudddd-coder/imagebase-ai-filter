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

  // 2026-04-29 fix: a naive position-based pairing (parsed[i] ↔ existing[i])
  // mis-shifts IDs whenever a block is inserted or deleted in the middle —
  // the row at position i gets *mutated* to look like the new block, and the
  // FE's stable-ID references go stale (e.g. "delete bullet, then transform
  // quote" turns the bullet's id into a quote and the quote's id into a
  // paragraph; the next FE click hits the wrong row).
  //
  // Greedy content-based matching instead: parsed blocks try to claim a
  // *content-identical* existing row first (closest in position when there
  // are ties), and only unclaimed parsed blocks fall back to remaining
  // unclaimed existing rows in document order. The result is that any block
  // the user didn't touch keeps its id verbatim, and inserts/deletes leave
  // a clean "new id here, old id removed" diff.
  const N = parsed.length;
  const M = existing.length;
  const parsedToExisting = new Array<number>(N).fill(-1);
  const existingClaimed = new Array<boolean>(M).fill(false);

  // Pass 1a: exact content + type match (closest by position when ties).
  for (let i = 0; i < N; i++) {
    let bestJ = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let j = 0; j < M; j++) {
      if (existingClaimed[j]) continue;
      const ex = existing[j];
      const pa = parsed[i];
      if (ex.type === pa.type && ex.content === pa.content) {
        const dist = Math.abs(j - i);
        if (dist < bestDist) {
          bestDist = dist;
          bestJ = j;
        }
      }
    }
    if (bestJ >= 0) {
      parsedToExisting[i] = bestJ;
      existingClaimed[bestJ] = true;
    }
  }
  // Pass 1b: relaxed match — same type, same body when trailing whitespace
  // is stripped. A block move flips the last block's "\n\n" → "\n" (or vice
  // versa) because trailing-block-of-doc has different framing; without this
  // pass, the moved block's id leaks to the new tail and a different id
  // gets pulled to the moved-to position. Stripping trailing `\s+` for the
  // comparison keeps the moved block's id pinned to its content.
  for (let i = 0; i < N; i++) {
    if (parsedToExisting[i] !== -1) continue;
    const pa = parsed[i];
    const paBody = pa.content.replace(/\s+$/, "");
    if (paBody.length === 0) continue; // don't match empty bodies
    let bestJ = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let j = 0; j < M; j++) {
      if (existingClaimed[j]) continue;
      const ex = existing[j];
      if (ex.type !== pa.type) continue;
      if (ex.content.replace(/\s+$/, "") !== paBody) continue;
      const dist = Math.abs(j - i);
      if (dist < bestDist) {
        bestDist = dist;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      parsedToExisting[i] = bestJ;
      existingClaimed[bestJ] = true;
    }
  }

  // Pass 2: assign remaining unclaimed existing rows to unmatched parsed
  // positions in document order — these are the blocks the user *edited*
  // (content changed in place but the row keeps its id, transforms etc.).
  const remainingExisting: number[] = [];
  for (let j = 0; j < M; j++) if (!existingClaimed[j]) remainingExisting.push(j);
  let cursor = 0;
  for (let i = 0; i < N; i++) {
    if (parsedToExisting[i] !== -1) continue;
    if (cursor < remainingExisting.length) {
      const j = remainingExisting[cursor++];
      parsedToExisting[i] = j;
      existingClaimed[j] = true;
    }
  }

  // Apply the diff:
  //   - parsed[i] with a paired existing[j]  → UPDATE in place (keep id)
  //   - parsed[i] with no pair               → CREATE
  //   - existing[j] never claimed            → DELETE
  // Order matters only insofar as the @@index([ideaId, order]) needs to
  // reflect the final positions; no unique constraint, so concurrent
  // identical orders during the loop are fine.
  for (let i = 0; i < N; i++) {
    const j = parsedToExisting[i];
    const pa = parsed[i];
    if (j >= 0) {
      const ex = existing[j];
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
    } else {
      await tx.ideaBlock.create({
        data: {
          ideaId,
          order: i,
          type: pa.type,
          content: pa.content,
          props: pa.props as any,
        },
      });
    }
  }
  for (let j = 0; j < M; j++) {
    if (!existingClaimed[j]) {
      await tx.ideaBlock.delete({ where: { id: existing[j].id } });
    }
  }
  return parsed.length;
}

export interface IdeaBlockRow {
  id: string;
  ideaId: string;
  parentId: string | null;
  order: number;
  type: IdeaBlockType;
  content: string;
  props: Record<string, unknown>;
  version: number;
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

// ─── PR-A: block-level write primitives (tree-aware) ─────────────────────
// These functions provide the block-level write API for the FE block editor
// and the Agent MCP tools. All block writes go through `commitBlockMutation`
// which reassembles content from blocks, rebuilds mentions and sections,
// and increments idea.version — keeping Idea.content as source of truth.

import { extractIdeaSections } from "./ideaSections.js";
import { buildMentionRows } from "./mentionIndex.js";
import { eventBus } from "./eventBus.js";
import type { CreateBlockInput, PatchBlockInput, BatchOperation } from "../schemas/ideaBlock.js";

export class BlockVersionConflictError extends Error {
  actual: number;
  constructor(blockId: string, expected: number, actual: number) {
    super(`block ${blockId}: version conflict (expected ${expected}, actual ${actual})`);
    this.name = "BlockVersionConflictError";
    this.actual = actual;
  }
}

/**
 * Within a Prisma transaction: read all blocks ordered, reassemble content,
 * rebuild sections + mentions, increment idea.version. Returns the updated
 * idea row and emits SSE events.
 *
 * This is the single funnel for all block-level writes so that
 * Idea.content, Idea.sections, Mention rows, and IdeaBlock rows stay
 * atomically consistent.
 */
export async function commitBlockMutation(
  tx: PrismaTxLike,
  ideaId: string,
  clientId: string,
  options?: {
    /** Extra SSE events to emit after the content-change event. */
    blockEvents?: Array<{
      type: "idea:block-update" | "idea:block-create" | "idea:block-delete" | "idea:block-move";
      payload: Record<string, any>;
    }>;
  },
): Promise<{ id: string; version: number; content: string; workspaceId: string }> {
  // Read all blocks in order and reassemble content
  const blocks = await tx.ideaBlock.findMany({
    where: { ideaId },
    orderBy: { order: "asc" },
  });
  const newContent = blocks.map((b: any) => b.content).join("");

  // Rebuild sections and mentions
  const idea = await tx.idea.findUnique({
    where: { id: ideaId },
    select: { id: true, workspaceId: true, version: true },
  });
  if (!idea) throw new Error(`idea not found: ${ideaId}`);

  const sections = extractIdeaSections(newContent);
  const mentionRows = buildMentionRows(newContent, "idea", ideaId, idea.workspaceId);

  const updated = await tx.idea.update({
    where: { id: ideaId },
    data: {
      content: newContent,
      version: { increment: 1 },
      sections: sections as unknown as any,
    },
  });

  // Rebuild mention index
  await tx.mention.deleteMany({ where: { sourceType: "idea", sourceId: ideaId } });
  if (mentionRows.length > 0) {
    await tx.mention.createMany({ data: mentionRows });
  }

  // Emit backward-compatible content-change event (existing FE still listens to this)
  eventBus.emitIdeaChange({
    type: "idea:content-change",
    ideaId,
    clientId,
    timestamp: Date.now(),
    payload: { content: updated.content, version: updated.version },
  });

  // Emit block-specific SSE events if provided.
  // PR-C: enrich each event payload with full block data so remote FE clients
  // can apply incremental updates without a full re-fetch.
  if (options?.blockEvents) {
    // Build a lookup of the committed blocks for enrichment.
    const blockLookup = new Map<string, (typeof blocks)[0]>();
    for (const b of blocks) blockLookup.set((b as any).id, b);

    for (const evt of options.blockEvents) {
      let enrichedPayload: Record<string, any> = { ...evt.payload, ideaVersion: updated.version };
      const blk = evt.payload.blockId ? blockLookup.get(evt.payload.blockId) : undefined;
      if (blk) {
        if (evt.type === "idea:block-update") {
          enrichedPayload = {
            ...enrichedPayload,
            content: (blk as any).content,
            type: (blk as any).type,
            props: (blk as any).props ?? {},
            blockVersion: (blk as any).version ?? 0,
          };
        } else if (evt.type === "idea:block-move") {
          enrichedPayload = {
            ...enrichedPayload,
            newOrder: (blk as any).order,
          };
        }
      }
      if (evt.type === "idea:block-create" && evt.payload.blockId) {
        const created = blockLookup.get(evt.payload.blockId);
        if (created) {
          enrichedPayload = {
            ...enrichedPayload,
            block: {
              id: (created as any).id,
              order: (created as any).order,
              type: (created as any).type,
              content: (created as any).content,
              props: (created as any).props ?? {},
              version: (created as any).version ?? 0,
            },
            afterBlockId: evt.payload.afterBlockId ?? null,
          };
        }
      }
      eventBus.emitIdeaChange({
        type: evt.type as any,
        ideaId,
        clientId,
        timestamp: Date.now(),
        payload: enrichedPayload,
      });
    }
  }

  return {
    id: updated.id,
    version: updated.version,
    content: updated.content,
    workspaceId: idea.workspaceId,
  };
}

/**
 * Compute the fractional order for inserting a block after `afterBlockId`
 * within the given sibling set. If afterBlockId is null, appends to end.
 */
function computeInsertOrder(
  siblings: Array<{ id: string; order: number }>,
  afterBlockId: string | null | undefined,
): number {
  if (!afterBlockId) {
    // Append to end
    if (siblings.length === 0) return 0;
    return Math.max(...siblings.map((s) => s.order)) + 1;
  }
  const afterIdx = siblings.findIndex((s) => s.id === afterBlockId);
  if (afterIdx === -1) {
    // afterBlockId not found in siblings; append to end
    if (siblings.length === 0) return 0;
    return Math.max(...siblings.map((s) => s.order)) + 1;
  }
  const afterOrder = siblings[afterIdx].order;
  if (afterIdx === siblings.length - 1) {
    // After the last sibling
    return afterOrder + 1;
  }
  // Midpoint between afterBlock and the next sibling
  const nextOrder = siblings[afterIdx + 1].order;
  return (afterOrder + nextOrder) / 2;
}

/**
 * Create a new block at a position within an idea, then commitBlockMutation
 * to keep content + mentions + sections in sync. Returns the created block.
 */
export async function createBlock(
  prisma: PrismaTxLike,
  ideaId: string,
  body: CreateBlockInput,
  clientId: string,
): Promise<{ block: IdeaBlockRow; idea: { id: string; version: number; content: string } }> {
  return await (prisma as any).$transaction(async (tx: PrismaTxLike) => {
    // Validate idea exists
    const idea = await tx.idea.findUnique({
      where: { id: ideaId },
      select: { id: true, workspaceId: true },
    });
    if (!idea) throw new Error(`idea not found: ${ideaId}`);

    // Find siblings (blocks with same parentId)
    const parentId = body.parentId ?? null;
    const siblings = await tx.ideaBlock.findMany({
      where: { ideaId, parentId },
      orderBy: { order: "asc" },
      select: { id: true, order: true },
    });

    const order = computeInsertOrder(
      siblings as Array<{ id: string; order: number }>,
      body.afterBlockId,
    );

    const created = await tx.ideaBlock.create({
      data: {
        ideaId,
        parentId,
        order,
        type: body.type || "paragraph",
        content: body.content,
        props: (body.props ?? {}) as any,
        version: 0,
      },
    });

    // Re-sync: re-read all blocks, reassemble content, rebuild mentions
    const result = await commitBlockMutation(tx, ideaId, clientId, {
      blockEvents: [{
        type: "idea:block-create",
        payload: { blockId: created.id, type: created.type, parentId, order, afterBlockId: body.afterBlockId ?? null },
      }],
    });

    return {
      block: created as unknown as IdeaBlockRow,
      idea: { id: result.id, version: result.version, content: result.content },
    };
  });
}

/**
 * Patch a single block's content/type with optional baseVersion optimistic
 * concurrency. Returns 409-equivalent error if baseVersion doesn't match.
 */
export async function patchBlock(
  prisma: PrismaTxLike,
  ideaId: string,
  blockId: string,
  body: PatchBlockInput,
  clientId: string,
): Promise<{ block: IdeaBlockRow; idea: { id: string; version: number; content: string } }> {
  return await (prisma as any).$transaction(async (tx: PrismaTxLike) => {
    const existing = await tx.ideaBlock.findUnique({ where: { id: blockId } });
    if (!existing) throw new IdeaBlockNotFoundError(blockId);
    const block = existing as unknown as IdeaBlockRow;
    if (block.ideaId !== ideaId) {
      throw new Error(`block ${blockId} does not belong to idea ${ideaId}`);
    }

    // Optimistic concurrency check
    if (typeof body.baseVersion === "number" && body.baseVersion !== block.version) {
      throw new BlockVersionConflictError(blockId, body.baseVersion, block.version);
    }

    // Compute new content
    let newBlockContent: string;
    if (typeof body.transformTo === "string") {
      newBlockContent = transformBlockContent(block.content, block.type, body.transformTo);
    } else if (typeof body.content === "string") {
      newBlockContent = body.content;
    } else {
      // No actual change
      const idea = await tx.idea.findUnique({
        where: { id: ideaId },
        select: { id: true, version: true, content: true },
      });
      return { block, idea: idea! };
    }

    // Determine new type from transformTo or re-parse
    let newType = block.type;
    let newProps = block.props;
    if (typeof body.transformTo === "string") {
      // Parse the transformed content to get proper type/props
      const parsed = parseToBlocks(newBlockContent);
      if (parsed.length > 0) {
        newType = parsed[0].type;
        newProps = parsed[0].props;
      }
    } else if (typeof body.content === "string") {
      // Re-parse to detect type changes (e.g. user typed "# " at start)
      const parsed = parseToBlocks(newBlockContent);
      if (parsed.length > 0) {
        newType = parsed[0].type;
        newProps = parsed[0].props;
      }
    }

    const updated = await tx.ideaBlock.update({
      where: { id: blockId },
      data: {
        content: newBlockContent,
        type: newType,
        props: newProps as any,
        version: { increment: 1 },
      },
    });

    const result = await commitBlockMutation(tx, ideaId, clientId, {
      blockEvents: [{
        type: "idea:block-update",
        payload: { blockId, version: (updated as any).version },
      }],
    });

    return {
      block: updated as unknown as IdeaBlockRow,
      idea: { id: result.id, version: result.version, content: result.content },
    };
  });
}

/**
 * Execute multiple block operations in one transaction. Each operation is
 * processed sequentially. After all ops, commitBlockMutation runs once.
 * Returns per-op results (created block IDs, etc.) and the final idea state.
 */
export async function batchBlockUpdate(
  prisma: PrismaTxLike,
  ideaId: string,
  operations: BatchOperation[],
  clientId: string,
): Promise<{
  results: Array<{ op: string; blockId?: string; tempId?: string; error?: string }>;
  idea: { id: string; version: number; content: string };
}> {
  return await (prisma as any).$transaction(async (tx: PrismaTxLike) => {
    const idea = await tx.idea.findUnique({
      where: { id: ideaId },
      select: { id: true, workspaceId: true },
    });
    if (!idea) throw new Error(`idea not found: ${ideaId}`);

    const results: Array<{ op: string; blockId?: string; tempId?: string; error?: string }> = [];
    const blockEvents: Array<{
      type: "idea:block-update" | "idea:block-create" | "idea:block-delete" | "idea:block-move";
      payload: Record<string, any>;
    }> = [];

    for (const operation of operations) {
      try {
        switch (operation.op) {
          case "create": {
            const parentId = operation.parentId ?? null;
            const siblings = await tx.ideaBlock.findMany({
              where: { ideaId, parentId },
              orderBy: { order: "asc" },
              select: { id: true, order: true },
            });
            const order = computeInsertOrder(
              siblings as Array<{ id: string; order: number }>,
              operation.afterBlockId,
            );
            const created = await tx.ideaBlock.create({
              data: {
                ideaId,
                parentId,
                order,
                type: operation.type || "paragraph",
                content: operation.content,
                props: (operation.props ?? {}) as any,
                version: 0,
              },
            });
            results.push({
              op: "create",
              blockId: created.id,
              tempId: operation.tempId || undefined,
            });
            blockEvents.push({
              type: "idea:block-create",
              payload: { blockId: created.id, type: created.type, parentId, order },
            });
            break;
          }
          case "update": {
            const existing = await tx.ideaBlock.findUnique({ where: { id: operation.blockId } });
            if (!existing) {
              results.push({ op: "update", blockId: operation.blockId, error: "not found" });
              continue;
            }
            const block = existing as unknown as IdeaBlockRow;
            if (block.ideaId !== ideaId) {
              results.push({ op: "update", blockId: operation.blockId, error: "wrong idea" });
              continue;
            }
            if (typeof operation.baseVersion === "number" && operation.baseVersion !== block.version) {
              results.push({
                op: "update",
                blockId: operation.blockId,
                error: `version conflict: expected ${operation.baseVersion}, actual ${block.version}`,
              });
              continue;
            }
            let newContent: string;
            let newType = block.type;
            let newProps = block.props;
            if (typeof operation.transformTo === "string") {
              newContent = transformBlockContent(block.content, block.type, operation.transformTo);
              const parsed = parseToBlocks(newContent);
              if (parsed.length > 0) { newType = parsed[0].type; newProps = parsed[0].props; }
            } else if (typeof operation.content === "string") {
              newContent = operation.content;
              const parsed = parseToBlocks(newContent);
              if (parsed.length > 0) { newType = parsed[0].type; newProps = parsed[0].props; }
            } else {
              results.push({ op: "update", blockId: operation.blockId });
              continue;
            }
            await tx.ideaBlock.update({
              where: { id: operation.blockId },
              data: { content: newContent, type: newType, props: newProps as any, version: { increment: 1 } },
            });
            results.push({ op: "update", blockId: operation.blockId });
            blockEvents.push({
              type: "idea:block-update",
              payload: { blockId: operation.blockId },
            });
            break;
          }
          case "delete": {
            const toDelete = await tx.ideaBlock.findUnique({ where: { id: operation.blockId } });
            if (!toDelete) {
              results.push({ op: "delete", blockId: operation.blockId, error: "not found" });
              continue;
            }
            if ((toDelete as any).ideaId !== ideaId) {
              results.push({ op: "delete", blockId: operation.blockId, error: "wrong idea" });
              continue;
            }
            await tx.ideaBlock.delete({ where: { id: operation.blockId } });
            results.push({ op: "delete", blockId: operation.blockId });
            blockEvents.push({
              type: "idea:block-delete",
              payload: { blockId: operation.blockId },
            });
            break;
          }
          case "move": {
            const toMove = await tx.ideaBlock.findUnique({ where: { id: operation.blockId } });
            if (!toMove) {
              results.push({ op: "move", blockId: operation.blockId, error: "not found" });
              continue;
            }
            if ((toMove as any).ideaId !== ideaId) {
              results.push({ op: "move", blockId: operation.blockId, error: "wrong idea" });
              continue;
            }
            // For move, we use the existing splice logic via content manipulation
            const ctx = await getBlockWithContext(tx, operation.blockId);
            const newFullContent = spliceBlockMove(ctx, operation.toIndex);
            if (newFullContent !== ctx.idea.content) {
              // Re-sync blocks from new content
              await syncBlocksForIdea(tx, ideaId, newFullContent);
              // Update idea content directly (commitBlockMutation will re-read)
              await tx.idea.update({
                where: { id: ideaId },
                data: { content: newFullContent },
              });
            }
            results.push({ op: "move", blockId: operation.blockId });
            blockEvents.push({
              type: "idea:block-move",
              payload: { blockId: operation.blockId, toIndex: operation.toIndex },
            });
            break;
          }
        }
      } catch (err: any) {
        results.push({ op: operation.op, blockId: (operation as any).blockId, error: err.message });
      }
    }

    // Final commit: re-read blocks, reassemble, rebuild mentions + sections
    const finalResult = await commitBlockMutation(tx, ideaId, clientId, { blockEvents });

    return {
      results,
      idea: { id: finalResult.id, version: finalResult.version, content: finalResult.content },
    };
  });
}
