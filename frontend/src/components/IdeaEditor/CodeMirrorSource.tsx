/**
 * CodeMirrorSource — Markdown source editor with syntax highlighting.
 *
 * Replaces the plain <textarea> in Source mode with CodeMirror, providing:
 *   - Markdown + GFM syntax highlighting
 *   - Built-in Tab/Shift+Tab indent/outdent
 *   - Paste/drop file upload
 *   - Auto-grow to content height (outer .idea-editor-body scrolls)
 *   - Caret-follow autoscroll
 *
 * Exposes an imperative handle (`CodeMirrorSourceHandle`) so the parent can:
 *   - Read caret position for @mention and mode-toggle
 *   - Get pixel rect of a character for mention picker positioning
 *   - Insert text at caret (for file upload and mention insertion)
 *   - Focus the editor
 */

import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useMemo,
} from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { EditorView, keymap, ViewUpdate } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";

export interface CodeMirrorSourceHandle {
  /** Current caret offset in the document. */
  getCaret: () => number;
  /** Set caret to a given offset and optionally focus. */
  setCaret: (offset: number, focus?: boolean) => void;
  /** Focus the editor. */
  focus: () => void;
  /** Get viewport pixel rect of the character at `index`. Returns null if
   * the position is not currently in view or the editor is unmounted. */
  getCharRect: (index: number) => {
    left: number; right: number; top: number; bottom: number;
  } | null;
  /** Insert text at the current caret position, replacing any selection.
   * Returns the new caret offset after insertion. */
  insertAtCaret: (text: string) => number;
  /** The underlying EditorView, or null. */
  getView: () => EditorView | null;
}

interface Props {
  value: string;
  readOnly?: boolean;
  placeholder?: string;
  onChange: (value: string, caret: number) => void;
  /** Called on caret movement (arrow keys, clicks) without content change. */
  onCursorActivity?: (caret: number) => void;
  /** Called when files are pasted from clipboard. */
  onPasteFiles?: (files: File[]) => void;
  /** Called when files are dropped. */
  onDropFiles?: (files: File[]) => void;
  /** Streaming visual indicator. */
  streaming?: boolean;
}

// ── Editor chrome theme: layout, cursor, selection ──
// Uses CSS custom properties from tokens.css so LM/DM switches automatically.
const ideaEditorTheme = EditorView.theme({
  "&": {
    fontSize: "14px",
    backgroundColor: "var(--surface-2, #fff)",
    color: "var(--text-primary)",
  },
  ".cm-content": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    lineHeight: "1.6",
    padding: "0",
    caretColor: "var(--text-primary)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-scroller": {
    overflow: "auto",
  },
  ".cm-placeholder": {
    color: "var(--text-placeholder)",
    fontFamily: "inherit",
  },
  // 选中态走 --selection-bg token,LM #ADD6FF / DM #264F78,直接对齐 VSCode
  // 和 Chrome macOS 原生 ::selection 的视觉。CSS 系统 keyword(`Highlight` /
  // `SelectedItem`)在 DM 下 Chrome/Safari 不切 dark 变体,放弃。
  // !important 是因为 CodeMirror vendor 默认 `&light.cm-focused > .cm-scroller
  // > .cm-selectionLayer .cm-selectionBackground { background:#d7d4f0 }` 特异
  // 性高,不强制覆盖会显示成紫粉色。
  ".cm-selectionBackground": {
    background: "var(--selection-bg) !important",
  },
  ".cm-content ::selection": {
    background: "var(--selection-bg)",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--text-primary)",
  },
});

// ── Syntax highlighting: NO underline on headings, DM-friendly colors ──
// The default `defaultHighlightStyle` adds `textDecoration: "underline"` to
// headings and links via **inline styles** which CSS can't override. We
// replace it entirely with a custom HighlightStyle.
const ideaHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: "bold", fontSize: "1.4em" },
  { tag: tags.heading2, fontWeight: "bold", fontSize: "1.25em" },
  { tag: tags.heading3, fontWeight: "bold", fontSize: "1.1em" },
  { tag: tags.heading, fontWeight: "bold" },   // h4-h6 fallback
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--primary)" },
  { tag: tags.url, color: "var(--text-muted)" },
  { tag: tags.monospace, fontFamily: "inherit", color: "var(--text-secondary)" },
  { tag: tags.meta, color: "var(--text-muted)" },       // `#`, `- `, `> ` markers
  { tag: tags.comment, color: "var(--text-muted)" },
  { tag: tags.processingInstruction, color: "var(--text-muted)" }, // ``` fences
  { tag: tags.string, color: "var(--success)" },
  { tag: tags.quote, color: "var(--text-secondary)", fontStyle: "italic" },
]);

// ── Paste/Drop file interceptor as CM extension ──
function fileInterceptor(
  onPasteFiles?: (files: File[]) => void,
  onDropFiles?: (files: File[]) => void,
) {
  return EditorView.domEventHandlers({
    paste(event) {
      if (!onPasteFiles) return false;
      const items = Array.from(event.clipboardData?.items ?? []);
      const files = items
        .filter((it) => it.kind === "file")
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length === 0) return false;
      event.preventDefault();
      onPasteFiles(files);
      return true;
    },
    drop(event) {
      if (!onDropFiles) return false;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return false;
      event.preventDefault();
      onDropFiles(files);
      return true;
    },
    dragover(event) {
      if (event.dataTransfer?.types?.includes("Files")) {
        event.preventDefault();
        return true;
      }
      return false;
    },
  });
}

const CodeMirrorSource = forwardRef<CodeMirrorSourceHandle, Props>(
  function CodeMirrorSource(
    {
      value,
      readOnly = false,
      placeholder,
      onChange,
      onCursorActivity,
      onPasteFiles,
      onDropFiles,
      streaming = false,
    },
    ref,
  ) {
    const viewRef = useRef<EditorView | null>(null);
    const bodyRef = useRef<HTMLDivElement | null>(null);

    // Resolve the parent .idea-editor-body scroll container on mount.
    const resolveBody = useCallback((view: EditorView) => {
      let el: HTMLElement | null = view.dom;
      while (el && !el.classList.contains("idea-editor-body")) {
        el = el.parentElement;
      }
      bodyRef.current = el as HTMLDivElement | null;
    }, []);

    // ── Caret-follow autoscroll ──
    const ensureCaretVisible = useCallback((view: EditorView) => {
      const body = bodyRef.current;
      if (!body) return;
      if (!view.hasFocus) return;
      const head = view.state.selection.main.head;
      const coords = view.coordsAtPos(head);
      if (!coords) return;
      const bodyRect = body.getBoundingClientRect();
      const MARGIN = 48;
      if (coords.bottom > bodyRect.bottom - MARGIN) {
        body.scrollTop += coords.bottom - (bodyRect.bottom - MARGIN);
      } else if (coords.top < bodyRect.top + MARGIN) {
        body.scrollTop -= (bodyRect.top + MARGIN) - coords.top;
      }
    }, []);

    const handleUpdate = useCallback(
      (viewUpdate: ViewUpdate) => {
        if (viewUpdate.docChanged) {
          // Only fire onChange for USER-initiated changes, not programmatic
          // value prop syncs. @uiw/react-codemirror syncs the `value` prop
          // via a transaction annotated with `External.of(true)` — those
          // transactions have no userEvent. Real user input always has at
          // least one transaction with a userEvent annotation.
          const isUserChange = viewUpdate.transactions.some(
            (tr) => tr.isUserEvent("input") || tr.isUserEvent("delete") ||
                    tr.isUserEvent("undo") || tr.isUserEvent("redo") ||
                    tr.isUserEvent("move") || tr.isUserEvent("select.pointer")
          );
          if (isUserChange) {
            const doc = viewUpdate.state.doc.toString();
            const caret = viewUpdate.state.selection.main.head;
            onChange(doc, caret);
          }
        }
        if (viewUpdate.selectionSet && !viewUpdate.docChanged && onCursorActivity) {
          const caret = viewUpdate.state.selection.main.head;
          onCursorActivity(caret);
        }
        if (viewUpdate.docChanged || viewUpdate.selectionSet) {
          requestAnimationFrame(() => {
            if (viewRef.current) ensureCaretVisible(viewRef.current);
          });
        }
      },
      [onChange, onCursorActivity, ensureCaretVisible],
    );

    const extensions = useMemo(
      () => [
        markdown({ base: markdownLanguage }),
        keymap.of([indentWithTab]),
        ideaEditorTheme,
        syntaxHighlighting(ideaHighlight),
        EditorView.lineWrapping,  // word wrap — no horizontal scroll
        fileInterceptor(onPasteFiles, onDropFiles),
      ],
      [onPasteFiles, onDropFiles],
    );

    const onCreateEditor = useCallback(
      (view: EditorView) => {
        viewRef.current = view;
        resolveBody(view);
      },
      [resolveBody],
    );

    useEffect(() => {
      return () => { viewRef.current = null; };
    }, []);

    // ── Imperative handle ──
    useImperativeHandle(ref, () => ({
      getCaret: () => {
        const v = viewRef.current;
        return v ? v.state.selection.main.head : 0;
      },
      setCaret: (offset: number, focus = false) => {
        const v = viewRef.current;
        if (!v) return;
        const pos = Math.max(0, Math.min(offset, v.state.doc.length));
        v.dispatch({ selection: { anchor: pos } });
        if (focus) v.focus();
      },
      focus: () => { viewRef.current?.focus(); },
      getCharRect: (index: number) => {
        const v = viewRef.current;
        if (!v) return null;
        const pos = Math.max(0, Math.min(index, v.state.doc.length));
        const coords = v.coordsAtPos(pos);
        if (!coords) return null;
        // coordsAtPos returns {left, right, top, bottom} in viewport pixels
        return {
          left: coords.left,
          right: coords.right ?? coords.left + 8, // right may not be set
          top: coords.top,
          bottom: coords.bottom,
        };
      },
      insertAtCaret: (text: string) => {
        const v = viewRef.current;
        if (!v) return 0;
        const { from, to } = v.state.selection.main;
        v.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        return from + text.length;
      },
      getView: () => viewRef.current,
    }), []);

    return (
      <div
        className={`idea-editor-source${streaming ? " idea-editor-source-streaming" : ""}`}
      >
        <CodeMirror
          value={value}
          readOnly={readOnly || streaming}
          placeholder={placeholder}
          theme="none"
          extensions={extensions}
          onChange={() => {/* handled via onUpdate for caret access */}}
          onUpdate={handleUpdate}
          onCreateEditor={onCreateEditor}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: false,
            autocompletion: false,
            history: true,
            defaultKeymap: true,
            syntaxHighlighting: false,  // disable default → use our custom ideaHighlight
          }}
          className="idea-editor-codemirror"
        />
      </div>
    );
  },
);

export default CodeMirrorSource;
