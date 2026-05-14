/**
 * mdSourceLineMap — uses markdown-it to parse markdown and extract
 * top-level block line ranges. This is the single source of truth for
 * mapping rendered ProseMirror nodes back to source lines.
 *
 * markdown-it tokens carry `map: [startLine, endLine]` (0-based, endLine
 * exclusive). We collect only the outermost block-level tokens.
 */

import MarkdownIt from "markdown-it";

const md = new MarkdownIt();

export interface SourceBlock {
  startLine: number;   // 0-based inclusive
  endLine: number;     // 0-based inclusive
  raw: string;         // original source lines joined
}

/**
 * Parse markdown source and return line ranges for each top-level block.
 * The order matches markdown-it's token stream, which is the same order
 * that tiptap-markdown produces ProseMirror nodes.
 */
export function extractSourceBlocks(source: string): SourceBlock[] {
  const tokens = md.parse(source, {});
  const lines = source.split("\n");
  const blocks: SourceBlock[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.map) continue;

    // Block with open/close pair (paragraph_open, heading_open, list_open, etc.)
    if (tok.nesting === 1) {
      const [start, end] = tok.map; // end is exclusive in markdown-it
      blocks.push({
        startLine: start,
        endLine: end - 1,
        raw: lines.slice(start, end).join("\n"),
      });
    }
    // Self-closing block (fence, hr, code_block, html_block)
    else if (tok.nesting === 0 && tok.block) {
      const [start, end] = tok.map;
      blocks.push({
        startLine: start,
        endLine: end - 1,
        raw: lines.slice(start, end).join("\n"),
      });
    }
  }

  return blocks;
}
