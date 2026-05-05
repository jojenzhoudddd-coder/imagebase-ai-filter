/**
 * BlankLineExtension — Override paragraph serializer to preserve blank lines.
 *
 * Problem: prosemirror-markdown's default paragraph serializer treats empty
 * paragraphs identically to paragraph breaks — both produce `\n\n`. So when
 * the user presses Enter to create a blank line in preview mode, it's
 * indistinguishable from a normal paragraph break in the markdown output.
 *
 * Fix: Override the paragraph serializer. When a paragraph node is EMPTY
 * (no text content), serialize it as an extra `\n` — this stacks with the
 * `\n\n` from `closeBlock`, producing `\n\n\n` which renders as a visible
 * blank line in source mode.
 *
 * For parsing (markdown → Tiptap), we also configure markdown-it to produce
 * empty paragraph tokens for consecutive blank lines by using a custom plugin.
 */

import { Extension } from "@tiptap/core";

/**
 * markdown-it plugin: insert empty paragraph tokens for blank lines.
 *
 * Standard markdown-it collapses `\n\n\n` to a single paragraph break.
 * This plugin walks the token stream and inserts `paragraph_open` +
 * `paragraph_close` pairs for each extra blank line, so Tiptap creates
 * actual empty paragraph nodes that the user can see and edit.
 */
function blankLinePlugin(md: any) {
  md.core.ruler.after("block", "blank_lines", (state: any) => {
    const src = state.src;
    const tokens = state.tokens;
    const newTokens: any[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      newTokens.push(token);

      // After a block close (e.g. paragraph_close), check if there are
      // extra blank lines before the next block opens.
      if (
        token.type === "paragraph_close" &&
        i + 1 < tokens.length &&
        tokens[i + 1].type === "paragraph_open"
      ) {
        const endOfThis = token.map ? token.map[1] : -1;
        const startOfNext = tokens[i + 1].map ? tokens[i + 1].map[0] : -1;

        if (endOfThis >= 0 && startOfNext >= 0) {
          // Count blank lines between the two paragraphs.
          // Each "blank line" = a line in the source that is empty.
          let blankCount = 0;
          for (let line = endOfThis; line < startOfNext; line++) {
            // Get the line content from source
            const lineStart = line === 0 ? 0 : src.indexOf("\n", getLineOffset(src, line - 1)) + 1;
            const lineEnd = src.indexOf("\n", lineStart);
            const lineContent = lineEnd === -1
              ? src.slice(lineStart)
              : src.slice(lineStart, lineEnd);
            if (lineContent.trim() === "") blankCount++;
          }

          // Standard paragraph break = 1 blank line. Extra blank lines
          // beyond that get empty paragraphs.
          const extraBlanks = Math.max(0, blankCount - 1);
          for (let b = 0; b < extraBlanks; b++) {
            const open = new state.Token("paragraph_open", "p", 1);
            open.map = [endOfThis, endOfThis];
            const close = new state.Token("paragraph_close", "p", -1);
            newTokens.push(open, close);
          }
        }
      }
    }

    state.tokens = newTokens;
  });
}

/** Get the byte offset of the start of a given line number in src. */
function getLineOffset(src: string, line: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const nl = src.indexOf("\n", offset);
    if (nl === -1) return src.length;
    offset = nl + 1;
  }
  return offset;
}

/**
 * Tiptap extension that preserves blank lines across markdown round-trips.
 */
export const BlankLineExtension = Extension.create({
  name: "blankLinePreservation",

  addStorage() {
    return {
      markdown: {
        // Override paragraph serialization: empty paragraphs get an extra \n
        // so they produce visible blank lines in source mode.
        nodes: {
          paragraph: {
            serialize(state: any, node: any) {
              const textContent = node.textContent;
              if (textContent === "" && node.childCount === 0) {
                // Empty paragraph → write nothing, just close the block.
                // closeBlock adds \n\n, so an empty paragraph between two
                // content paragraphs produces \n\n\n\n (visible blank line).
                state.closeBlock(node);
              } else {
                state.renderInline(node);
                state.closeBlock(node);
              }
            },
          },
        },
        // Add our blank-line markdown-it plugin to the parser config.
        parse: {
          setup(markdownit: any) {
            markdownit.use(blankLinePlugin);
          },
        },
      },
    };
  },
});
