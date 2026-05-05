/**
 * MentionExtension — Tiptap extension for `mention://` links.
 *
 * In the Markdown source, mentions are encoded as ordinary links:
 *   `[@label](mention://type/id?...)`
 *
 * In Tiptap's rendered view, they display as non-editable chip buttons
 * with the same CSS class (`idea-mention-chip`) as the old MarkdownPreview.
 *
 * This extension does NOT use @tiptap/extension-mention's suggestion system
 * (which requires a custom popup). Instead, the parent IdeaEditor detects `@`
 * via text analysis and shows MentionPicker itself — on selection, the parent
 * calls `editor.commands.insertContent()` with the mention link text, and
 * tiptap-markdown's parser turns it into a rendered link → which the custom
 * `link` rendering below displays as a chip.
 *
 * This means mentions round-trip as plain markdown links — no custom node
 * type needed, which keeps the markdown bridge simple and lossless.
 */

// The mention rendering is handled by TiptapPreview's custom link renderer.
// This file is kept as a placeholder for future mention-specific logic
// (e.g. suggestion popup, custom node type).

export {};
