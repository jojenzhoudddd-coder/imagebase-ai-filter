/**
 * TiptapPreview — WYSIWYG preview editor powered by Tiptap/ProseMirror.
 *
 * Does NOT emit markdown on every keystroke. Instead, the parent reads
 * markdown via `ref.getMarkdown()` at save time or on mode switch.
 * This avoids the round-trip normalization that strips blank lines.
 */

import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Underline } from "@tiptap/extension-underline";
// Tiptap 官方表格四件套 —— 共同构成 GFM 表格支持。tiptap-markdown 在
// 解析 markdown 时遇到 `| col |` 语法 / 原生 <table> 都需要这些 Node 类型
// 被注册才能正确渲染。tiptap v3 用 named export(没有 default)。
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Markdown } from "tiptap-markdown";
import { Extension, Mark } from "@tiptap/core";
import Code from "@tiptap/extension-code";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { createImageExtension } from "./extensions/ImageExtension";
import type { ImageUploadResult } from "./extensions/ImageExtension";
import { ChartCodeBlock } from "./extensions/ChartCodeBlockExtension";
import { toMarkdown } from "./markdownBridge";

/**
 * SafeCode — same as @tiptap/extension-code but skips <code> elements that
 * are direct children of <pre> (those belong to codeBlock, not inline code).
 *
 * Without this, ProseMirror's DOMParser matches <pre><code>…</code></pre>
 * as codeBlock + Code mark.  But codeBlock declares `marks: ""` (no marks
 * allowed), so ProseMirror drops the marked text entirely → childCount=0
 * → vega-lite charts render as empty.
 */
const SafeCode = Code.extend({
  parseHTML() {
    return [
      {
        tag: "code",
        getAttrs: (node) => {
          if (node instanceof HTMLElement && node.parentElement?.tagName === "PRE") {
            return false; // skip — this <code> belongs to a code block
          }
          return {};
        },
      },
    ];
  },
});

/**
 * Enter = hardBreak (\n), Shift+Enter = new paragraph (\n\n).
 * This makes preview mode's Enter behavior match source mode's 1:1.
 */
const EnterAsBreak = Extension.create({
  name: "enterAsBreak",
  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.setHardBreak(),
    };
  },
});

/**
 * ReadOnlyButDroppable — makes the editor visually read-only (no text
 * editing) while still accepting image drop/paste. Tiptap's built-in
 * `editable: false` disables ProseMirror plugins entirely, which kills
 * the ImageExtension's handleDrop/handlePaste. This extension keeps the
 * editor technically editable but blocks all text-mutating input at the
 * DOM event level so the user can't type, delete, or paste text.
 *
 * Image insertions go through `view.dispatch(tr)` inside the
 * ImageExtension plugin — those bypass the DOM input pipeline and are
 * therefore not blocked.
 */
const ReadOnlyButDroppable = Extension.create({
  name: "readOnlyButDroppable",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          // Block all keyboard input EXCEPT copy/select-all shortcuts
          handleKeyDown(_view, event) {
            const mod = event.metaKey || event.ctrlKey;
            if (mod && (event.key === "c" || event.key === "a")) return false; // allow copy + select-all
            return true; // block everything else
          },
          // Block text paste (image paste is handled by ImageExtension
          // which runs first due to plugin ordering and calls
          // event.preventDefault() + returns true before we get here)
          handlePaste(_view, event) {
            const hasImage = Array.from(event.clipboardData?.items ?? []).some(
              (it) => it.kind === "file" && it.type.startsWith("image/"),
            );
            if (hasImage) return false; // let ImageExtension handle it
            return true; // block text paste
          },
          // Block text drop; allow image drop (same logic as paste)
          handleDrop(_view, event) {
            const hasImage = Array.from(event.dataTransfer?.files ?? []).some(
              (f) => f.type.startsWith("image/"),
            );
            if (hasImage) return false; // let ImageExtension handle it
            return true; // block text drop
          },
          // Block IME / mobile composition input
          handleTextInput() {
            return true;
          },
        },
      }),
    ];
  },
});

/**
 * Override hardBreak serializer: output plain `\n` instead of `\\\n`.
 * With `breaks: true` in markdown-it, `\n` round-trips as `<br>`.
 */
const HardBreakNewline = Extension.create({
  name: "hardBreakNewline",
  addStorage() {
    return {
      markdown: {
        nodes: {
          hardBreak: {
            serialize(state: any, node: any, parent: any, index: number) {
              // Write plain \n instead of \\\n
              for (let i = index + 1; i < parent.childCount; i++) {
                if (parent.child(i).type !== node.type) {
                  state.write("\n");
                  return;
                }
              }
            },
          },
        },
      },
    };
  },
});
/**
 * Preprocess markdown to preserve multiple consecutive blank lines.
 *
 * Standard markdown collapses `\n\n\n` into a single paragraph break.
 * To make preview match source-mode's visual spacing, we convert each
 * "extra" blank line (beyond the first paragraph-separating one) into
 * a line containing only `&nbsp;`, which markdown-it renders as a `<p>`
 * with visible content — Tiptap keeps it as a real paragraph node.
 *
 * Example:  "A\n\n\n\nB"  (3 blank lines)
 *        →  "A\n\n&nbsp;\n\n&nbsp;\n\nB"
 * Renders:  <p>A</p> <p>&nbsp;</p> <p>&nbsp;</p> <p>B</p>
 */
function preserveBlankLines(md: string): string {
  // Split into lines. Each "extra" blank line (2nd+ consecutive) is
  // replaced with &nbsp; so markdown-it creates a <p>&nbsp;</p> that
  // Tiptap preserves. IMPORTANT: skip fenced code blocks (``` ... ```)
  // — inserting &nbsp; inside JSON/code would break chart rendering.
  const lines = md.split("\n");
  const result: string[] = [];
  let consecutiveEmpty = 0;
  let inFencedBlock = false;

  for (const line of lines) {
    // Track fenced code block boundaries (``` or ~~~)
    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      inFencedBlock = !inFencedBlock;
      consecutiveEmpty = 0;
      result.push(line);
      continue;
    }

    // Inside a code block — pass through untouched
    if (inFencedBlock) {
      result.push(line);
      continue;
    }

    if (line.trim() === "") {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 2) {
        result.push("&nbsp;");
        result.push("");
      } else {
        result.push(line);
      }
    } else {
      consecutiveEmpty = 0;
      result.push(line);
    }
  }
  return result.join("\n");
}

/** Walk the editor DOM and mark &nbsp;-only <p> elements with a class
 *  so CSS can collapse them to just their margin (spacer paragraphs). */
function markSpacerParagraphs(ed: { view: { dom: HTMLElement } }) {
  const root = ed.view.dom;
  root.querySelectorAll("p").forEach((p) => {
    // Check if the paragraph contains only &nbsp; (U+00A0)
    const text = p.textContent ?? "";
    if (text === "\u00A0" && p.childNodes.length === 1 && p.childNodes[0].nodeType === Node.TEXT_NODE) {
      p.classList.add("blank-line-spacer");
    } else {
      p.classList.remove("blank-line-spacer");
    }
  });
}

import { parseMentionHref } from "../Mention/mentionSyntax";
import type { ParsedMention } from "../Mention/mentionSyntax";

export interface TiptapPreviewHandle {
  /** Get current editor content as markdown. */
  getMarkdown: () => string;
  /** Whether user has edited since last load/setContent. */
  isDirty: () => boolean;
  /** Reset dirty flag (call after saving). */
  clearDirty: () => void;
  getCaretSourceOffset: () => number | null;
  setCaretFromSourceOffset: (offset: number) => boolean;
  getRoot: () => HTMLDivElement | null;
  /** Reload content from source prop. */
  reload: () => void;
}

export interface MentionQueryState {
  atIndex: number;
  query: string;
  atRect: { left: number; right: number; top: number; bottom: number };
}

interface Props {
  source: string;
  onMentionClick: (m: ParsedMention) => void;
  editable?: boolean;
  /** Called when user makes any edit (no markdown payload — just a signal). */
  onDirty?: () => void;
  placeholder?: string;
  onUploadFile?: (file: File) => Promise<ImageUploadResult>;
  /** Called when a top-level block is clicked in preview mode. */
  onBlockClick?: (index: number, domNode: HTMLElement) => void;
}

/**
 * BlockHoverClick — ProseMirror plugin that highlights the top-level block
 * under the mouse cursor and dispatches a click callback with the block's
 * index (position among top-level children) and DOM rect.
 */
const blockHoverPluginKey = new PluginKey("blockHoverClick");

function createBlockHoverClickPlugin(
  onBlockClickRef: React.MutableRefObject<((index: number, domNode: HTMLElement) => void) | undefined>,
) {
  /** Resolve the top-level node index from a DOM event target. */
  function resolveTopLevelIndex(
    view: import("@tiptap/pm/view").EditorView,
    event: MouseEvent,
  ): { index: number; from: number; to: number } | null {
    const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (!pos) return null;
    const resolved = view.state.doc.resolve(pos.pos);
    // depth 0 = doc, depth 1 = top-level node
    if (resolved.depth < 1) return null;
    const topDepth = 1;
    const parentOffset = resolved.start(topDepth) - 1; // before the node
    const topIndex = resolved.index(0); // index within doc children
    const topNode = view.state.doc.child(topIndex);
    return { index: topIndex, from: parentOffset, to: parentOffset + topNode.nodeSize };
  }

  return new Plugin({
    key: blockHoverPluginKey,
    state: {
      init() { return { hoveredIndex: -1 as number }; },
      apply(tr, value) {
        const meta = tr.getMeta(blockHoverPluginKey);
        if (meta !== undefined) return { hoveredIndex: meta.hoveredIndex };
        return value;
      },
    },
    props: {
      decorations(state) {
        const pluginState = blockHoverPluginKey.getState(state);
        if (!pluginState || pluginState.hoveredIndex < 0) return DecorationSet.empty;
        const idx = pluginState.hoveredIndex;
        if (idx >= state.doc.childCount) return DecorationSet.empty;
        let pos = 0;
        for (let i = 0; i < idx; i++) pos += state.doc.child(i).nodeSize;
        const node = state.doc.child(idx);
        return DecorationSet.create(state.doc, [
          Decoration.node(pos, pos + node.nodeSize, { class: "idea-block-hover" }),
        ]);
      },
      handleDOMEvents: {
        mousemove(view, event) {
          // Ignore hover on editor root padding/empty area
          const target = event.target as HTMLElement;
          const hit = target === view.dom ? null : resolveTopLevelIndex(view, event);
          const idx = hit ? hit.index : -1;
          const current = blockHoverPluginKey.getState(view.state)?.hoveredIndex ?? -1;
          if (idx !== current) {
            const tr = view.state.tr.setMeta(blockHoverPluginKey, { hoveredIndex: idx });
            tr.setMeta("addToHistory", false);
            view.dispatch(tr);
          }
          return false;
        },
        mouseleave(view) {
          const current = blockHoverPluginKey.getState(view.state)?.hoveredIndex ?? -1;
          if (current !== -1) {
            const tr = view.state.tr.setMeta(blockHoverPluginKey, { hoveredIndex: -1 });
            tr.setMeta("addToHistory", false);
            view.dispatch(tr);
          }
          return false;
        },
        click(view, event) {
          if (!onBlockClickRef.current) return false;
          // Don't intercept clicks on links
          const target = event.target as HTMLElement;
          if (target.closest("a[href]")) return false;

          // Ignore clicks on the editor root itself (padding/empty area)
          if (target === view.dom) return false;

          const hit = resolveTopLevelIndex(view, event);
          if (!hit) return false;

          // Find the DOM node for this top-level block
          let pos = 0;
          for (let i = 0; i < hit.index; i++) pos += view.state.doc.child(i).nodeSize;
          const domAtPos = view.domAtPos(pos + 1); // +1 to get inside the node
          const domNode = domAtPos.node instanceof HTMLElement
            ? domAtPos.node
            : domAtPos.node.parentElement;
          if (!domNode) return false;

          // Walk up to the direct child of the editor root
          let blockDom: HTMLElement = domNode;
          const root = view.dom;
          while (blockDom.parentElement && blockDom.parentElement !== root) {
            blockDom = blockDom.parentElement;
          }

          onBlockClickRef.current(hit.index, blockDom as HTMLElement);
          return false; // don't prevent other handlers
        },
      },
    },
  });
}

const TiptapPreview = forwardRef<TiptapPreviewHandle, Props>(
  function TiptapPreview(
    { source, onMentionClick, editable = false, onDirty, placeholder, onUploadFile, onBlockClick },
    ref,
  ) {
    const suppressRef = useRef(true);
    const dirtyRef = useRef(false);
    const onMentionClickRef = useRef(onMentionClick);
    useEffect(() => { onMentionClickRef.current = onMentionClick; }, [onMentionClick]);
    const onDirtyRef = useRef(onDirty);
    useEffect(() => { onDirtyRef.current = onDirty; }, [onDirty]);
    const onBlockClickRef = useRef(onBlockClick);
    useEffect(() => { onBlockClickRef.current = onBlockClick; }, [onBlockClick]);

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5, 6] },
          // 关掉默认 CodeBlock,下面用 ChartCodeBlock 替换 —— vega-lite /
          // vega 语言走 ChatChartBlock 渲染图表(包含热力图),其它语言仍是
          // 普通 <pre><code>。
          codeBlock: false,
          // 关掉默认 Code mark,下面用 SafeCode 替换 —— 默认的 Code mark
          // 匹配所有 <code> 标签，包括 <pre> 内的 <code>。而 codeBlock 声明
          // marks:""（禁止所有 mark），导致 ProseMirror DOMParser 在解析
          // <pre><code class="language-vega-lite">…</code></pre> 时尝试给
          // 文本加 Code mark → 被 codeBlock 拒绝 → 文本被丢弃 → childCount=0。
          code: false,
        }),
        SafeCode,
        ChartCodeBlock,
        Link.configure({
          openOnClick: false,
          HTMLAttributes: { class: "" },
        }),
        // 内联 HTML <u> —— Markdown 里写 `<u>x</u>` 时,有这个 extension 就
        // 渲染成下划线;没有的话 tiptap-markdown 会丢标签留下纯文本。
        Underline,
        // 表格四件套 —— 注册顺序要 Table 在前(它声明 cell/row/header content schema)
        Table.configure({
          // resizable:false 避免 ProseMirror 注入 column-resize-handle DOM
          // 干扰只读视图;若以后想支持手动调列宽再开。
          resizable: false,
          HTMLAttributes: { class: "idea-preview-table" },
        }),
        TableRow,
        TableHeader,
        TableCell,
        createImageExtension(onUploadFile),
        Placeholder.configure({
          placeholder: placeholder || "",
        }),
        Markdown.configure({
          html: true,
          breaks: true,
          transformPastedText: true,
          transformCopiedText: true,
        }),
        HardBreakNewline,
        // Preview is always read-only for text, but still accepts image
        // drop/paste. Must come AFTER createImageExtension so the image
        // plugin gets first shot at drop/paste events.
        ReadOnlyButDroppable,
        // Block hover highlight + click handler for inline editing
        Extension.create({
          name: "blockHoverClick",
          addProseMirrorPlugins() {
            return [createBlockHoverClickPlugin(onBlockClickRef)];
          },
        }),
      ],
      content: preserveBlankLines(source),
      // Keep technically "editable" so ProseMirror plugins (image
      // drop/paste) still fire. ReadOnlyButDroppable blocks all text input.
      editable: true,
      editorProps: {
        attributes: {
          class: "idea-preview-body",
          spellcheck: "false",
        },
        handleClick(view, pos, event) {
          const target = event.target as HTMLElement;
          const anchor = target.closest("a[href]");
          if (!anchor) return false;
          const href = anchor.getAttribute("href") || "";
          const label = anchor.textContent || "";
          const mention = parseMentionHref(href, label);
          if (mention) {
            event.preventDefault();
            onMentionClickRef.current(mention);
            return true;
          }
          return false;
        },
      },
      onCreate({ editor: ed }) {
        setTimeout(() => { suppressRef.current = false; }, 50);
        markSpacerParagraphs(ed);
      },
      onUpdate({ editor: ed }) {
        markSpacerParagraphs(ed);
        if (suppressRef.current) return;
        if (!dirtyRef.current) {
          dirtyRef.current = true;
          onDirtyRef.current?.();
        }
      },
    });

    // Sync external content changes (SSE, streaming).
    useEffect(() => {
      if (!editor) return;
      if (editor.isFocused) return;
      suppressRef.current = true;
      dirtyRef.current = false;
      editor.commands.setContent(preserveBlankLines(source));
      setTimeout(() => { suppressRef.current = false; }, 50);
    }, [editor, source]);

    useImperativeHandle(ref, () => ({
      getMarkdown: () => {
        if (!editor) return source;
        return toMarkdown(editor);
      },
      isDirty: () => dirtyRef.current,
      clearDirty: () => { dirtyRef.current = false; },
      getCaretSourceOffset: () => {
        if (!editor) return null;
        const { from } = editor.state.selection;
        return editor.state.doc.textBetween(0, from, "\n", "\ufffc").length;
      },
      setCaretFromSourceOffset: (offset: number) => {
        if (!editor) return false;
        const docText = editor.state.doc.textBetween(
          0, editor.state.doc.content.size, "\n", "\ufffc",
        );
        const safeOffset = Math.max(0, Math.min(offset, docText.length));
        let textPos = 0;
        let pmPos = 1;
        editor.state.doc.descendants((node, pos) => {
          if (node.isText) {
            const len = node.text?.length ?? 0;
            if (textPos + len >= safeOffset) {
              pmPos = pos + (safeOffset - textPos);
              return false;
            }
            textPos += len;
          } else if (node.isBlock && pos > 0) {
            textPos += 1;
          }
          return true;
        });
        try {
          editor.commands.setTextSelection(Math.min(pmPos, editor.state.doc.content.size));
          editor.commands.focus();
          return true;
        } catch { return false; }
      },
      getRoot: () => (editor?.view?.dom as HTMLDivElement) ?? null,
      reload: () => {
        if (!editor) return;
        suppressRef.current = true;
        dirtyRef.current = false;
        editor.commands.setContent(preserveBlankLines(source));
        setTimeout(() => { suppressRef.current = false; }, 50);
      },
    }), [editor, source]);

    return (
      <div>
        <EditorContent editor={editor} />
      </div>
    );
  },
);

export default TiptapPreview;
