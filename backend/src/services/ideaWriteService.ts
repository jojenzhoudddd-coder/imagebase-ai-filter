/**
 * Idea write service — lets the Chat Agent insert content into an existing
 * idea doc at a named anchor (a heading, by slug) without having to rewrite
 * the whole doc. Anchor semantics match `extractIdeaSections` exactly so
 * slugs the agent sees via `list_ideas` / `get_idea` can be passed straight
 * back into `insert_into_idea` without translation.
 *
 * Design notes:
 *
 * 1. All mutation paths flow through `applyIdeaWrite()`, which returns the
 *    new content string. The caller is responsible for persisting it (via
 *    the same code path as `PUT /api/ideas/:id` — version bump, sections
 *    re-extraction, mention diff, event emit). This keeps the "save" logic
 *    in one place instead of duplicating it into every MCP tool handler.
 *
 * 2. HTML-aware boundaries: if the anchor's section ends inside an open
 *    HTML block (e.g. `<div>…</div>` spanning headings, or an unclosed
 *    fenced code block), naïve line-splicing would corrupt the document.
 *    We detect the cases we care about (fenced code + balanced block-level
 *    HTML) and push the insertion point past the closing marker rather than
 *    injecting halfway through a block element.
 *
 * 3. Anchor shapes:
 *      - `{ position: "end" }`                 → append, guaranteed safe.
 *      - `{ position: "start" }`               → prepend, ditto.
 *      - `{ section: "<slug>", mode: "append" | "replace" | "after" }`
 *           append   → last position inside that section (before next heading)
 *           replace  → replace everything between the heading and next heading
 *                      (heading itself kept)
 *           after    → immediately after the heading, before first child content
 *
 *    If `section` doesn't match any heading we error out — no silent fallback
 *    to end-of-doc, which would surprise the agent. The tool surfaces the
 *    error and the agent can re-query sections.
 */

import { extractIdeaSections, type IdeaSection } from "./ideaSections.js";

export type IdeaAnchor =
  | { position: "end" }
  | { position: "start" }
  | {
      section: string; // slug from Idea.sections
      /**
       * - append: insert at the end of the section body (default)
       * - after:  insert right after the heading line, before the body
       * - replace: replace the section body (heading preserved)
       */
      mode?: "append" | "after" | "replace";
    };

export interface IdeaWriteResult {
  /** New full content. Caller persists via the same PUT pipeline. */
  content: string;
  /** Human summary: "appended 120 chars to section 'xxx'" — fed back to agent. */
  description: string;
  /** Index range (offsets) the write touched, for future diff UI. */
  range: { start: number; end: number };
}

/**
 * Compute line-level ranges for each heading: the line containing the `#`
 * marker, and where the section body ends (exclusive). Mirrors the scan
 * loop in `extractIdeaSections` so slugs line up.
 *
 * Returned offsets are character offsets into `content` (not line numbers),
 * which lets the splice helpers work on substrings without re-splitting.
 */
interface HeadingRange {
  slug: string;
  headingStart: number; // first char of the heading line
  bodyStart: number;    // first char after the heading's trailing newline
  bodyEnd: number;      // first char of next heading (or content.length)
}

function computeHeadingRanges(content: string, sections: IdeaSection[]): HeadingRange[] {
  if (sections.length === 0) return [];
  // Re-scan to find each heading's line boundary, pairing by order.
  const lines = content.split(/\r?\n/);
  // Track cumulative offsets so we can translate (lineIndex → charOffset).
  const lineStarts: number[] = [];
  let acc = 0;
  for (const l of lines) {
    lineStarts.push(acc);
    acc += l.length + 1; // approximate — works correctly for both \n and \r\n as long as we don't exceed content.length below
  }
  const isFence = (line: string) => /^\s{0,3}(`{3,}|~{3,})/.test(line);
  const headingRe = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

  let inFence = false;
  let orderCursor = 0;
  const ranges: HeadingRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFence(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!headingRe.test(line)) continue;
    // Match to sections[orderCursor] (extractIdeaSections walks in the same order)
    const sec = sections[orderCursor];
    if (!sec) break;
    const headingStart = Math.min(lineStarts[i], content.length);
    const bodyStart = Math.min(lineStarts[i] + line.length + 1, content.length); // include the \n after heading
    ranges.push({ slug: sec.slug, headingStart, bodyStart, bodyEnd: content.length });
    orderCursor++;
  }
  // Fill in bodyEnd = next heading's headingStart
  for (let i = 0; i < ranges.length - 1; i++) {
    ranges[i].bodyEnd = ranges[i + 1].headingStart;
  }
  return ranges;
}

/**
 * Push `offset` past any open HTML block or fenced code that starts inside
 * `[sectionStart, offset)` so inserting at `offset` doesn't land inside an
 * open element. We only care about open-but-unclosed ranges — fully-closed
 * blocks don't matter.
 *
 * This is a heuristic (no real HTML parse), but covers the cases sanitize.ts
 * already allows: `<div>`, `<figure>`, `<table>`, `<pre>`, `<code>` blocks
 * plus fenced Markdown code. Inline tags (`<span>`, `<strong>`) are left
 * alone because inserting a newline after them is still syntactically valid.
 */
const BLOCK_HTML_TAGS = [
  "div", "section", "article", "aside", "header", "footer", "figure",
  "blockquote", "pre", "table", "thead", "tbody", "tr", "td", "th",
  "ul", "ol", "details", "summary",
];
function skipPastOpenBlocks(content: string, sectionStart: number, offset: number): number {
  const slice = content.slice(sectionStart, offset);
  // 1) Fenced code — count backtick/tilde fences.
  const fenceMatches = slice.match(/^\s{0,3}(`{3,}|~{3,})/gm) ?? [];
  if (fenceMatches.length % 2 === 1) {
    // There's an open fence. Find its close after `offset`.
    const closeRe = /^\s{0,3}(`{3,}|~{3,})/m;
    const rest = content.slice(offset);
    const m = closeRe.exec(rest);
    if (m) {
      // Advance to end of the closing fence line.
      const abs = offset + m.index + m[0].length;
      const nl = content.indexOf("\n", abs);
      offset = nl >= 0 ? nl + 1 : content.length;
    } else {
      offset = content.length; // unterminated; best we can do is append at EOF
    }
  }
  // 2) Block-level HTML — naive opens-vs-closes by tag name.
  for (const tag of BLOCK_HTML_TAGS) {
    const opens = (slice.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length;
    const closes = (slice.match(new RegExp(`</${tag}\\b`, "gi")) ?? []).length;
    if (opens > closes) {
      const closeTag = new RegExp(`</${tag}\\s*>`, "i");
      const rest = content.slice(offset);
      const m = closeTag.exec(rest);
      if (m) {
        offset = offset + m.index + m[0].length;
        // Also consume trailing newline if present, so caller appends on a fresh line.
        if (content[offset] === "\n") offset++;
      } else {
        offset = content.length;
      }
    }
  }
  return offset;
}

/**
 * Normalize a write payload so the result reads as proper Markdown: every
 * insertion ends with exactly one trailing newline and the boundary with
 * existing content has exactly one separating newline. Prevents the
 * "everything gets crammed onto one line" failure mode when the agent
 * forgets trailing \n.
 */
function ensureSurroundingNewlines(content: string, insertAt: number, text: string): {
  text: string;
  before: string;
  after: string;
} {
  const charBefore = insertAt > 0 ? content[insertAt - 1] : "\n";
  const charAfter = insertAt < content.length ? content[insertAt] : "\n";
  let payload = text;
  // Leading
  let before = "";
  if (charBefore !== "\n") before = "\n";
  // Trailing
  if (!payload.endsWith("\n")) payload = payload + "\n";
  let after = "";
  if (charAfter !== "\n" && charAfter !== "" && !payload.endsWith("\n\n")) {
    after = "\n";
  }
  return { text: payload, before, after };
}

function splice(content: string, start: number, end: number, insert: string): string {
  return content.slice(0, start) + insert + content.slice(end);
}

export function applyIdeaWrite(
  currentContent: string,
  anchor: IdeaAnchor,
  payload: string
): IdeaWriteResult {
  const content = currentContent ?? "";
  const sections = extractIdeaSections(content);

  // ── Shortcut anchors ──
  if ("position" in anchor) {
    if (anchor.position === "start") {
      const { text, before, after } = ensureSurroundingNewlines(content, 0, payload);
      const full = before + text + after + content;
      return {
        content: full,
        description: `prepended ${payload.length} chars to doc start`,
        range: { start: 0, end: before.length + text.length + after.length },
      };
    }
    // end (default)
    const { text, before, after } = ensureSurroundingNewlines(content, content.length, payload);
    const full = content + before + text + after;
    return {
      content: full,
      description: `appended ${payload.length} chars to doc end`,
      range: { start: content.length, end: full.length },
    };
  }

  // ── Section-anchored ──
  const ranges = computeHeadingRanges(content, sections);
  const target = ranges.find((r) => r.slug === anchor.section);
  if (!target) {
    const available = sections.map((s) => s.slug).join(", ") || "(no headings)";
    throw new Error(
      `Section "${anchor.section}" not found. Available sections: ${available}`
    );
  }

  const mode = anchor.mode ?? "append";

  if (mode === "replace") {
    // Keep heading line, replace body.
    const { text, before, after } = ensureSurroundingNewlines(content, target.bodyStart, payload);
    const insert = before + text + after;
    const next = splice(content, target.bodyStart, target.bodyEnd, insert);
    return {
      content: next,
      description: `replaced body of section "${anchor.section}" with ${payload.length} chars`,
      range: { start: target.bodyStart, end: target.bodyStart + insert.length },
    };
  }

  if (mode === "after") {
    // Right after heading, before existing body. Skip past any html/fence
    // that starts in the first line of the body — rare, but keeps us safe.
    const safeOffset = skipPastOpenBlocks(content, target.bodyStart, target.bodyStart);
    const { text, before, after } = ensureSurroundingNewlines(content, safeOffset, payload);
    const insert = before + text + after;
    const next = splice(content, safeOffset, safeOffset, insert);
    return {
      content: next,
      description: `inserted ${payload.length} chars after heading "${anchor.section}"`,
      range: { start: safeOffset, end: safeOffset + insert.length },
    };
  }

  // mode === "append"
  // Move `insertAt` past any open fenced code / HTML block so we don't crack a
  // block element in half.
  const rawEnd = target.bodyEnd;
  const safeOffset = skipPastOpenBlocks(content, target.bodyStart, rawEnd);
  // Also trim trailing blank lines at end of section so appended content hugs
  // the existing text rather than leaving a growing blank-line tail.
  let insertAt = safeOffset;
  while (insertAt > target.bodyStart && (content[insertAt - 1] === "\n" || content[insertAt - 1] === "\r")) {
    insertAt--;
  }
  const { text, before, after } = ensureSurroundingNewlines(content, insertAt, payload);
  const insert = before + text + after;
  const next = splice(content, insertAt, insertAt, insert);
  return {
    content: next,
    description: `appended ${payload.length} chars to section "${anchor.section}"`,
    range: { start: insertAt, end: insertAt + insert.length },
  };
}
