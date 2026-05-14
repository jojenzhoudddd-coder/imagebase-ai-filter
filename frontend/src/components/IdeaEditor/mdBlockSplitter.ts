/**
 * mdBlockSplitter — splits markdown into top-level blocks.
 *
 * Each block has { index, startLine, endLine, raw }.
 * Lines are 0-indexed. endLine is inclusive.
 *
 * Rules:
 * - Paragraphs separated by blank lines
 * - Headings (#) are their own block
 * - Fenced code blocks (``` or ~~~) are one block (inclusive of fences)
 * - Consecutive list lines (- or 1.) are one block
 * - Consecutive table lines (|) are one block
 * - Consecutive blockquote lines (>) are one block
 * - Horizontal rules (---, ***, ___) are their own block
 */

export interface MdBlock {
  index: number;
  startLine: number;
  endLine: number;
  raw: string;
}

type BlockKind = "paragraph" | "heading" | "fence" | "list" | "table" | "blockquote" | "hr";

function lineKind(line: string): BlockKind | "blank" | null {
  const trimmed = line.trimStart();
  if (trimmed === "") return "blank";
  if (/^#{1,6}\s/.test(trimmed)) return "heading";
  if (/^(`{3,}|~{3,})/.test(trimmed)) return "fence";
  if (/^([-*_])\s*\1\s*\1[\s\-*_]*$/.test(trimmed)) return "hr";
  if (/^(\d+\.\s|[-*+]\s)/.test(trimmed)) return "list";
  if (/^\|/.test(trimmed)) return "table";
  if (/^>/.test(trimmed)) return "blockquote";
  return null; // plain text -> paragraph
}

/** Returns true if `kind` is a continuable block type (consecutive lines merge) */
function isContinuable(kind: BlockKind): boolean {
  return kind === "list" || kind === "table" || kind === "blockquote";
}

export function splitMarkdownBlocks(content: string): MdBlock[] {
  const lines = content.split("\n");
  const blocks: MdBlock[] = [];

  let i = 0;

  function pushBlock(startLine: number, endLine: number) {
    const raw = lines.slice(startLine, endLine + 1).join("\n");
    blocks.push({ index: blocks.length, startLine, endLine, raw });
  }

  while (i < lines.length) {
    const kind = lineKind(lines[i]);

    // Skip blank lines between blocks
    if (kind === "blank") {
      i++;
      continue;
    }

    // Fenced code block — consume until closing fence
    if (kind === "fence") {
      const startLine = i;
      const fenceMatch = lines[i].trimStart().match(/^(`{3,}|~{3,})/);
      const fenceChar = fenceMatch![1][0];
      const fenceLen = fenceMatch![1].length;
      i++;
      while (i < lines.length) {
        const trimmed = lines[i].trimStart();
        const closingMatch = trimmed.match(new RegExp(`^${fenceChar === '`' ? '`' : '~'}{${fenceLen},}\\s*$`));
        if (closingMatch) {
          break;
        }
        i++;
      }
      // i is now at closing fence or past end
      pushBlock(startLine, Math.min(i, lines.length - 1));
      i++;
      continue;
    }

    // Heading — standalone block
    if (kind === "heading") {
      pushBlock(i, i);
      i++;
      continue;
    }

    // Horizontal rule — standalone block
    if (kind === "hr") {
      pushBlock(i, i);
      i++;
      continue;
    }

    // Continuable block types: list, table, blockquote
    if (kind !== null && isContinuable(kind)) {
      const startLine = i;
      i++;
      while (i < lines.length) {
        const nextKind = lineKind(lines[i]);
        // Continue if same kind, or if it's a continuation line (indented, for lists)
        if (nextKind === kind) {
          i++;
        } else if (kind === "list" && nextKind === "blank") {
          // Check if next non-blank line continues the list
          let peek = i + 1;
          while (peek < lines.length && lineKind(lines[peek]) === "blank") peek++;
          if (peek < lines.length && lineKind(lines[peek]) === "list") {
            // Include blank lines within a list
            i++;
          } else {
            break;
          }
        } else if (kind === "list" && nextKind === null && /^\s{2,}/.test(lines[i])) {
          // Indented continuation of a list item
          i++;
        } else {
          break;
        }
      }
      pushBlock(startLine, i - 1);
      continue;
    }

    // Paragraph — plain text lines until blank line or different block type
    {
      const startLine = i;
      i++;
      while (i < lines.length) {
        const nextKind = lineKind(lines[i]);
        if (nextKind === "blank" || nextKind === "heading" || nextKind === "fence" ||
            nextKind === "hr" || (nextKind !== null && isContinuable(nextKind))) {
          break;
        }
        i++;
      }
      pushBlock(startLine, i - 1);
    }
  }

  return blocks;
}
