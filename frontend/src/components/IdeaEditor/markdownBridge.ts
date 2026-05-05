/**
 * markdownBridge — Markdown ↔ Tiptap helpers.
 *
 * Limitation: CommonMark collapses multiple blank lines into one paragraph
 * break. Tiptap's serializer cannot distinguish "empty paragraph" from
 * "paragraph separator". We accept this trade-off:
 *   - Source → Preview: blank lines show as normal paragraph spacing
 *   - Preview → Source (if user edited): Tiptap's serialized markdown is
 *     canonical; extra blank lines from source are normalized to \n\n
 *   - Preview → Source (no edit): original source preserved verbatim
 */

import type { Editor } from "@tiptap/core";

/** Serialize editor content to markdown string. */
export function toMarkdown(editor: Editor): string {
  const storage = editor.storage as Record<string, any>;
  return storage.markdown?.getMarkdown?.() ?? "";
}
