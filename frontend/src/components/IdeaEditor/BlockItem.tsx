/**
 * BlockItem — single block inline editor (PR-B).
 *
 * View mode: renders the block's markdown as HTML via markdown-it.
 * Edit mode: a textarea showing raw markdown.
 *
 * Click → edit mode; blur / Cmd+Enter → save via patchIdeaBlock.
 * Escape → cancel (revert to original content).
 * Hover → subtle blue outline.
 */

import { useCallback, useEffect, useRef, useState, memo, lazy, Suspense, useMemo } from "react";
import { createPortal } from "react-dom";
import MarkdownIt from "markdown-it";
import { useTranslation } from "../../i18n";
import { useToast } from "../Toast/index";
import SwipeDelete from "../SwipeDelete/index";

// Lazy-load vega-lite chart renderer (same as MarkdownPreview)
const ChatChartBlock = lazy(
  () => import("../ChatSidebar/ChatMessage/ChatChartBlock"),
);

// Inject a scoped style to remove bottom margin from the last child in each
// block view — avoids double spacing between blocks. Done once at module load.
if (typeof document !== "undefined" && !document.getElementById("block-item-style")) {
  const s = document.createElement("style");
  s.id = "block-item-style";
  s.textContent = [
    ".block-item-view > *:first-child { margin-top: 0 !important; }",
    ".block-item-view > *:last-child { margin-bottom: 0 !important; }",
    ".block-edit-btn-cancel { background: var(--surface-3); color: var(--text-secondary); transition: background 0.12s, color 0.12s; }",
    ".block-edit-btn-cancel:hover { background: var(--border-default); color: var(--text-primary); }",
    ".block-edit-btn-commit { background: var(--primary); color: var(--text-on-primary); transition: background 0.12s; }",
    ".block-edit-btn-commit:hover { background: var(--primary-hover); }",
    ".block-edit-btn-cancel:disabled, .block-edit-btn-commit:disabled { opacity: 0.5; cursor: not-allowed; }",
  ].join("\n");
  document.head.appendChild(s);
}

import type { IdeaBlockBrief, PatchBlockResponse } from "../../api";
import { patchIdeaBlock, createIdeaBlock, deleteIdeaBlock } from "../../api";

// Shared markdown-it instance for rendering block content → HTML.
const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
});

function resizeTextareaToContent(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
  // Chrome can preserve an internal textarea scroll position after pasting a
  // long markdown source. Since the textarea is auto-grown and overflow is
  // hidden, that clips the first line until the component remounts.
  ta.scrollTop = 0;
}

// All links open in new tab
const defaultRender = md.renderer.rules.link_open || ((tokens: any, idx: any, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens: any, idx: any, options: any, env: any, self: any) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultRender(tokens, idx, options, env, self);
};

export interface BlockItemProps {
  block: IdeaBlockBrief;
  ideaId: string;
  readOnly?: boolean;
  /** Focus this block on mount (e.g. just created). */
  autoFocus?: boolean;
  /** Increment to request focus (source mode: focus existing textarea). */
  focusTrigger?: number;
  /** Cursor position to set when focus is triggered. null = start (default). */
  focusCursorPos?: number | null;
  /** PR-C: another user updated this block while we're editing it. */
  remoteUpdatePending?: boolean;
  onSaved?: (res: PatchBlockResponse) => void;
  onDeleted?: (blockId: string) => void;
  onCreatedAfter?: (newBlock: { id: string; order: number; type: string; content: string; props: Record<string, unknown>; version: number }) => void;
  /** Navigate to previous block. */
  onFocusPrev?: () => void;
  /** Navigate to next block. */
  onFocusNext?: () => void;
  /** Source mode: split block at cursor — contentBefore stays, contentAfter goes to new block. */
  onSplit?: (blockId: string, contentBefore: string, contentAfter: string) => void;
  /** Source mode: merge this block's content into the previous block, then delete this one. */
  onMergeIntoPrev?: (blockId: string, contentToAppend: string) => void;
  /** Notify parent of conflict (409) so it can reload blocks. */
  onConflict?: () => void;
  /** PR-C: notify parent when this block gains/loses focus. */
  onFocusChange?: (blockId: string, focused: boolean) => void;
  /** When another block is being edited, show toast on click instead of entering edit. */
  onEditBlocked?: () => void;
  /** True if another block is currently being edited. */
  editLocked?: boolean;
  /** Source mode: always show raw markdown, click to focus (no two-click flow). */
  sourceMode?: boolean;
  /** Source mode: report the live raw block content to the parent document model. */
  onSourceChange?: (blockId: string, content: string) => void;
  /** Callback when user initiates drag from selected state. */
  onDragStart?: (blockId: string) => void;
  /** Whether this block is currently being dragged (hide it). */
  isDragging?: boolean;
  /** True when any block is being dragged — suppresses hover on all blocks. */
  dragInProgress?: boolean;
}

const BlockItem = memo(function BlockItem({
  block,
  ideaId,
  readOnly = false,
  autoFocus = false,
  remoteUpdatePending = false,
  onSaved,
  onDeleted,
  onCreatedAfter,
  onFocusPrev,
  onFocusNext,
  onSplit,
  onMergeIntoPrev,
  onConflict,
  onFocusChange,
  onEditBlocked,
  editLocked = false,
  sourceMode = false,
  onSourceChange,
  focusTrigger = 0,
  focusCursorPos = null,
  onDragStart,
  isDragging = false,
  dragInProgress = false,
}: BlockItemProps) {
  const { t } = useTranslation();
  const toast = useToast();
  /** Strip the trailing \n that blocks store for markdown concatenation —
   *  it shows as an empty line in the textarea. Re-added on save. */
  const displayContent = (s: string) => s.replace(/\n+$/, "");

  const [mode, setMode] = useState<"view" | "selected" | "editing">(sourceMode ? "editing" : "view");
  const [editValue, setEditValue] = useState(sourceMode ? displayContent(block.content) : "");

  // Sync mode when sourceMode prop changes (e.g. toggle source ↔ preview)
  useEffect(() => {
    if (sourceMode) {
      setMode("editing");
      setEditValue(displayContent(block.content));
    } else {
      setMode("view");
      setEditValue("");
    }
  }, [sourceMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hovered, setHovered] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const blockVersionRef = useRef<number>((block as any).version ?? 0);
  const deletingRef = useRef(false);
  const editing = mode === "editing";
  const selected = mode === "selected";

  // Keep blockVersion ref in sync with block prop
  useEffect(() => {
    blockVersionRef.current = (block as any).version ?? 0;
  }, [block]);

  // ── Context menu (right-click) ──
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // Close context menu on click-outside or Escape
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onClick = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", onClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const handleCtxAddBlock = useCallback(async () => {
    setCtxMenu(null);
    try {
      const res = await createIdeaBlock(ideaId, {
        afterBlockId: block.id,
        type: "paragraph",
        content: "\n",
      });
      onCreatedAfter?.({
        id: res.block.id,
        order: res.block.order,
        type: res.block.type,
        content: res.block.content,
        props: res.block.props,
        version: res.block.version,
      });
    } catch { /* ignore */ }
  }, [ideaId, block.id, onCreatedAfter]);

  const handleCtxDeleteBlock = useCallback(() => {
    setCtxMenu(null);
    if (deletingRef.current) return;
    deletingRef.current = true;
    deleteIdeaBlock(ideaId, block.id)
      .then(() => {
        onDeleted?.(block.id);
        toast.success(t("idea.block.deleted"));
      })
      .catch(() => { deletingRef.current = false; });
  }, [ideaId, block.id, onDeleted, toast, t]);

  // Pending cursor: set by focusTrigger, consumed by content sync or layout effect
  const pendingCursorRef = useRef<{ pos: number; trigger: number } | null>(null);

  // When focusTrigger increments (or is set on first mount), record desired cursor position
  const prevFocusTrigger = useRef(0);
  if (focusTrigger > 0 && focusTrigger !== prevFocusTrigger.current) {
    prevFocusTrigger.current = focusTrigger;
    if (sourceMode) {
      pendingCursorRef.current = { pos: focusCursorPos ?? 0, trigger: focusTrigger };
    }
  }

  // Source mode: sync editValue when block content changes externally,
  // then apply pending cursor in the same commit
  useEffect(() => {
    if (!sourceMode || saving) return;
    setEditValue(displayContent(block.content));
  }, [sourceMode, block.content, saving]);

  // Apply pending cursor after React has committed the new editValue to DOM
  useEffect(() => {
    if (!sourceMode || !pendingCursorRef.current) return;
    const pending = pendingCursorRef.current;
    pendingCursorRef.current = null;
    const ta = textareaRef.current;
    if (!ta) return;
    // Use microtask to run after React's DOM flush for this commit
    queueMicrotask(() => {
      ta.focus();
      const pos = Math.min(pending.pos, ta.value.length);
      ta.selectionStart = ta.selectionEnd = pos;
    });
  }, [sourceMode, editValue]); // fires after editValue changes from content sync

  // Auto-focus: only for newly created blocks (autoFocus=true on first mount).
  const didAutoFocus = useRef(false);
  useEffect(() => {
    if (autoFocus && !didAutoFocus.current && !readOnly && !editLocked) {
      didAutoFocus.current = true;
      setEditValue(displayContent(block.content));
      setMode("editing");
      onFocusChange?.(block.id, true);
    }
  }, [autoFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-grow textarea height to fit content
  useEffect(() => {
    if (!editing || !textareaRef.current) return;
    resizeTextareaToContent(textareaRef.current);
  }, [editing, editValue]);

  // Focus textarea when entering edit mode (non-source only)
  useEffect(() => {
    if (!editing || sourceMode || !textareaRef.current) return;
    const ta = textareaRef.current;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  }, [editing, sourceMode]);

  // Click outside selected block → deselect
  useEffect(() => {
    if (!selected) return;
    const handler = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest("[data-block-id]");
      if (!el || el.getAttribute("data-block-id") !== block.id) {
        setMode("view");
      }
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [selected, block.id]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (readOnly) return;
    // Clicking a link → let it navigate, don't enter selected/edit
    if ((e.target as HTMLElement).closest("a[href]")) return;
    // If user selected text (drag to select for copy), skip state transition
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    if (mode === "view") {
      setMode("selected");
    } else if (mode === "selected") {
      if (editLocked) { onEditBlocked?.(); return; }
      setEditValue(displayContent(block.content));
      setMode("editing");
      onFocusChange?.(block.id, true);
    }
  }, [readOnly, editLocked, mode, block.content, block.id, onFocusChange, onEditBlocked]);

  const cancelEdit = useCallback(() => {
    if (sourceMode) {
      // Source mode: revert content but stay in editing
      setEditValue(displayContent(block.content));
      return;
    }
    setMode("view");
    setEditValue("");
    setHovered(false);
    onFocusChange?.(block.id, false);
  }, [block.id, block.content, onFocusChange, sourceMode]);

  const commitEdit = useCallback(async () => {
    if (!editing || saving) return;
    // Re-add the trailing \n that was stripped for display
    const contentToSave = editValue.replace(/\n+$/, "") + "\n";
    // No change → just close (or stay in source mode)
    if (contentToSave === block.content) {
      if (!sourceMode) {
        setMode("view");
        setHovered(false);
        onFocusChange?.(block.id, false);
      }
      return;
    }
    setSaving(true);
    try {
      const res = await patchIdeaBlock(ideaId, block.id, {
        content: contentToSave,
        baseVersion: blockVersionRef.current,
      });
      blockVersionRef.current = res.blockVersion;
      if (!sourceMode) {
        setMode("view");
        setHovered(false);
        onFocusChange?.(block.id, false);
      }
      onSaved?.(res);
    } catch (err: any) {
      if (err?.status === 409) {
        if (!sourceMode) {
          setMode("view");
          setHovered(false);
          onFocusChange?.(block.id, false);
        }
        onConflict?.();
      } else {
        // Keep editing on other errors so user doesn't lose work
        console.error("[BlockItem] save failed:", err);
      }
    } finally {
      setSaving(false);
    }
  }, [editing, saving, editValue, block.content, block.id, ideaId, onSaved, onConflict, onFocusChange, sourceMode]);

  // Source mode: auto-save on blur (unless block is being deleted/navigated away)
  const handleBlur = useCallback(() => {
    if (deletingRef.current) return;
    // Source mode is saved by the parent full-document autosave. Committing
    // individual blocks on blur races with source -> preview refetch and can
    // render stale/empty preview content.
    if (sourceMode) return;
    if (editing) void commitEdit();
  }, [sourceMode, editing, commitEdit]);

  const toStoredBlockContent = useCallback((value: string) => (
    value.replace(/\n+$/, "") + "\n"
  ), []);

  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setEditValue(next);
    if (sourceMode) {
      onSourceChange?.(block.id, toStoredBlockContent(next));
    }
  }, [sourceMode, onSourceChange, block.id, toStoredBlockContent]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
      return;
    }
    // Alt+Enter → commit (all block types)
    if (e.altKey && e.key === "Enter") {
      e.preventDefault();
      void commitEdit();
      return;
    }

    const ta = textareaRef.current;
    if (!ta) return;

    // ArrowUp at first line → focus previous block
    if (e.key === "ArrowUp") {
      // Check if cursor is on the first line (no \n before cursor)
      if (!editValue.slice(0, ta.selectionStart).includes("\n")) {
        e.preventDefault();
        onFocusPrev?.();
      }
      return;
    }

    // ArrowDown at last line → focus next block
    if (e.key === "ArrowDown") {
      // Check if cursor is on the last line (no \n after cursor)
      if (!editValue.slice(ta.selectionEnd).includes("\n")) {
        e.preventDefault();
        onFocusNext?.();
      }
      return;
    }

    if (!sourceMode) return; // remaining shortcuts are source-mode only

    // Enter → split block at cursor position (except lists — Enter adds new list item)
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (block.type === "list") return; // default textarea behavior = new line = new list item
      e.preventDefault();
      const pos = ta.selectionStart;
      const before = editValue.slice(0, pos);
      const after = editValue.slice(ta.selectionEnd);
      deletingRef.current = true;
      onSplit?.(block.id, before, after);
      return;
    }

    // Backspace at start → merge into previous block
    if (e.key === "Backspace" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      e.preventDefault();
      deletingRef.current = true;
      onMergeIntoPrev?.(block.id, editValue);
      return;
    }

  }, [cancelEdit, commitEdit, sourceMode, editValue, ideaId, block.id, onCreatedAfter, onDeleted, onFocusPrev, onFocusNext]);

  const handleTextareaInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    resizeTextareaToContent(ta);
  }, []);

  // Drag handle pointerdown — initiates drag directly (no need for selected state)
  const handleDragHandleDown = useCallback((e: React.PointerEvent) => {
    if (sourceMode || readOnly || !onDragStart) return;
    e.preventDefault();
    e.stopPropagation();
    onDragStart(block.id);
  }, [sourceMode, readOnly, onDragStart, block.id]);

  // Render markdown to HTML.
  const trimmedContent = block.content.replace(/\n+$/, "").trim();
  const isEmptyBlock = trimmedContent.length === 0;
  const renderedHtml = isEmptyBlock
    ? '<p style="margin:0;min-height:1em">&nbsp;</p>'
    : md.render(trimmedContent);

  // Determine if this is a divider (just render <hr>)
  const isDivider = block.type === "divider";

  // Detect vega-lite chart blocks: ```vega-lite\n{...}\n```
  const chartSpec = useMemo(() => {
    if (block.type !== "code") return null;
    const m = trimmedContent.match(/^```vega(?:-lite)?\s*\n([\s\S]*?)```$/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }, [block.type, trimmedContent]);

  const showHover = hovered && !editing && !selected && !readOnly && !dragInProgress;
  const containerStyle: React.CSSProperties = {
    position: "relative",
    cursor: readOnly ? "default" : editing ? "text" : "pointer",
    minHeight: isDivider ? 20 : 24,
    opacity: isDragging ? 0.3 : 1,
    transition: "opacity 0.15s ease",
  };

  const outlineStyle: React.CSSProperties = {
    borderRadius: 4,
    position: "relative",
    outline: showHover ? "1px solid var(--primary)" : "1px solid transparent",
    outlineOffset: 2,
    transition: "outline-color 0.12s ease",
  };

  const viewStyle: React.CSSProperties = {
    lineHeight: 1.6,
    padding: 0,
    minHeight: "auto",
  };

  const textareaStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    minHeight: sourceMode ? 16 : 32,
    padding: sourceMode ? "0" : "2px 0",
    margin: 0,
    border: "none",
    borderRadius: sourceMode ? 0 : 4,
    background: sourceMode ? "transparent" : "var(--surface-2)",
    color: "var(--text-primary)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    fontSize: sourceMode ? 14 : 13,
    lineHeight: "1.6",
    resize: "none",
    overflow: "hidden",
    outline: sourceMode ? "none" : "1px solid var(--primary)",
    outlineOffset: sourceMode ? 0 : 2,
    boxSizing: "border-box" as const,
  };

  const btnBase: React.CSSProperties = {
    padding: "6px 16px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    border: "none",
    lineHeight: "20px",
  };

  if (editing) {
    return (
      <div style={containerStyle} data-block-id={block.id}>
        {remoteUpdatePending && !sourceMode && (
          <div style={{
            fontSize: 11,
            color: "var(--color-warning, #f59e0b)",
            padding: "2px 4px",
            lineHeight: 1.4,
          }}>
            ⚠ {t("idea.block.remoteUpdate")}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={editValue}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onInput={handleTextareaInput}
          style={textareaStyle}
          spellCheck={false}
        />
        {!sourceMode && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <span
              title={t("idea.block.editHint")}
              style={{
                flex: 1, minWidth: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: "32px",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >
              {t("idea.block.editHint")}
            </span>
            <button
              type="button"
              className="block-edit-btn-cancel"
              style={btnBase}
              onClick={(e) => { e.stopPropagation(); cancelEdit(); }}
              disabled={saving}
            >{t("idea.block.cancel")}</button>
            <button
              type="button"
              className="block-edit-btn-commit"
              style={btnBase}
              onClick={(e) => { e.stopPropagation(); void commitEdit(); }}
              disabled={saving}
            >{saving ? t("idea.block.saving") : t("idea.block.commit")}</button>
          </div>
        )}
      </div>
    );
  }

  const showDragHandle = hovered && !editing && !sourceMode && !readOnly && !isDragging && !dragInProgress;

  return (
    <div
      style={{ position: "relative", marginLeft: sourceMode ? 0 : -36 }}
      data-block-id={block.id}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onContextMenu={handleContextMenu}
    >
      {/* Drag handle — 8px left of hover outline, aligned to top */}
      {!sourceMode && showDragHandle && (
        <div
          onPointerDown={handleDragHandleDown}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 28, height: 28,
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "grab", borderRadius: 6,
            color: "var(--text-muted)",
            background: "transparent",
            transition: "color 0.12s, background 0.12s",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--surface-3)"; (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="5" cy="3" r="1.2" fill="currentColor"/>
            <circle cx="9" cy="3" r="1.2" fill="currentColor"/>
            <circle cx="5" cy="7" r="1.2" fill="currentColor"/>
            <circle cx="9" cy="7" r="1.2" fill="currentColor"/>
            <circle cx="5" cy="11" r="1.2" fill="currentColor"/>
            <circle cx="9" cy="11" r="1.2" fill="currentColor"/>
          </svg>
        </div>
      )}
      {/* Block content area */}
      <div data-block-content={block.id} style={{ ...containerStyle, marginLeft: sourceMode ? 0 : 36 }} onClick={handleClick}>
      <div style={outlineStyle}>
        {selected && <div style={{
          position: "absolute", inset: -2, borderRadius: 4,
          backgroundColor: "rgba(20, 86, 240, 0.10)",
          pointerEvents: "none",
          transition: "background-color 0.12s ease",
        }} />}
        {isDivider ? (
          <hr style={{ border: "none", borderTop: "0.5px solid var(--border-light)", margin: "8px 0" }} />
        ) : chartSpec ? (
          <div className="idea-chart-embed" style={{ minHeight: 200 }}>
            <Suspense fallback={<div style={{ padding: 12, color: "var(--text-muted)", fontSize: 13 }}>Loading chart…</div>}>
              <ChatChartBlock spec={chartSpec} />
            </Suspense>
          </div>
        ) : (
          <div
            style={viewStyle}
            className="idea-preview-body block-item-view"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )}
      </div>
      </div>
      {/* Context menu */}
      {ctxMenu && createPortal(
        <BlockContextMenu
          ref={ctxMenuRef}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onAddBlock={handleCtxAddBlock}
          onDeleteBlock={handleCtxDeleteBlock}
          t={t}
        />,
        document.body,
      )}
    </div>
  );
});

// ─── Context menu (right-click) ─────────────────────────────────────────

interface BlockContextMenuProps {
  x: number;
  y: number;
  onAddBlock: () => void;
  onDeleteBlock: () => void;
  t: (key: string) => string;
}

import { forwardRef } from "react";

const BlockContextMenu = forwardRef<HTMLDivElement, BlockContextMenuProps>(
  function BlockContextMenu({ x, y, onAddBlock, onDeleteBlock, t }, ref) {
    // Clamp position to viewport
    const menuW = 180, menuH = 80;
    const left = Math.min(x, window.innerWidth - menuW - 8);
    const top = Math.min(y, window.innerHeight - menuH - 8);

    return (
      <div
        ref={ref}
        className="field-context-menu"
        style={{ left, top, minWidth: menuW }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className="field-context-menu-item" onClick={onAddBlock}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          {t("idea.block.add")}
        </button>
        <div className="field-context-menu-divider" />
        <SwipeDelete
          label={t("idea.block.delete")}
          onDelete={onDeleteBlock}
        />
      </div>
    );
  },
);

export default BlockItem;
