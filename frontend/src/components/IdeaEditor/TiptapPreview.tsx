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
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { createImageExtension } from "./extensions/ImageExtension";
import type { ImageUploadResult } from "./extensions/ImageExtension";
import { ChartCodeBlock } from "./extensions/ChartCodeBlockExtension";
import { toMarkdown } from "./markdownBridge";

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
          // Block all keyboard input (typing, backspace, enter, etc.)
          handleKeyDown() {
            return true; // consume → prevent
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
}

const TiptapPreview = forwardRef<TiptapPreviewHandle, Props>(
  function TiptapPreview(
    { source, onMentionClick, editable = false, onDirty, placeholder, onUploadFile },
    ref,
  ) {
    const suppressRef = useRef(true);
    const dirtyRef = useRef(false);
    const onMentionClickRef = useRef(onMentionClick);
    useEffect(() => { onMentionClickRef.current = onMentionClick; }, [onMentionClick]);
    const onDirtyRef = useRef(onDirty);
    useEffect(() => { onDirtyRef.current = onDirty; }, [onDirty]);

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5, 6] },
          // 关掉默认 CodeBlock,下面用 ChartCodeBlock 替换 —— vega-lite /
          // vega 语言走 ChatChartBlock 渲染图表(包含热力图),其它语言仍是
          // 普通 <pre><code>。
          codeBlock: false,
        }),
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
      ],
      content: source,
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
      onCreate() {
        setTimeout(() => { suppressRef.current = false; }, 50);
      },
      onUpdate() {
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
      editor.commands.setContent(source);
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
        editor.commands.setContent(source);
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
