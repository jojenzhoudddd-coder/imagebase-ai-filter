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

import { useCallback, useEffect, useRef, useState, memo } from "react";
import MarkdownIt from "markdown-it";
import { useTranslation } from "../../i18n";

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
  /** Callback when user initiates drag from selected state. */
  onDragStart?: (blockId: string) => void;
  /** Whether this block is currently being dragged (hide it). */
  isDragging?: boolean;
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
  focusTrigger = 0,
  focusCursorPos = null,
  onDragStart,
  isDragging = false,
}: BlockItemProps) {
  const { t } = useTranslation();
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const blockVersionRef = useRef<number>((block as any).version ?? 0);
  const deletingRef = useRef(false);
  const editing = mode === "editing";
  const selected = mode === "selected";

  // Keep blockVersion ref in sync with block prop
  useEffect(() => {
    blockVersionRef.current = (block as any).version ?? 0;
  }, [block]);

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
    const ta = textareaRef.current;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
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
  }, [editing, saving, editValue, block.content, block.id, ideaId, onSaved, onConflict, onFocusChange]);

  // Source mode: auto-save on blur (unless block is being deleted/navigated away)
  const handleBlur = useCallback(() => {
    if (deletingRef.current) return;
    if (sourceMode && editing) void commitEdit();
  }, [sourceMode, editing, commitEdit]);

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
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, []);

  // Must be before any early return to keep hook count stable
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (selected && !sourceMode && onDragStart) {
      e.preventDefault();
      onDragStart(block.id);
    }
  }, [selected, sourceMode, onDragStart, block.id]);

  // Render markdown to HTML.
  const trimmedContent = block.content.replace(/\n+$/, "").trim();
  const isEmptyBlock = trimmedContent.length === 0;
  const renderedHtml = isEmptyBlock
    ? '<p style="margin:0;min-height:1em">&nbsp;</p>'
    : md.render(trimmedContent);

  // Determine if this is a divider (just render <hr>)
  const isDivider = block.type === "divider";

  const showHover = hovered && !editing && !selected && !readOnly;
  const containerStyle: React.CSSProperties = {
    position: "relative",
    cursor: readOnly ? "default" : editing ? "text" : (selected && hovered) ? "grab" : selected ? "default" : "pointer",
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
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onInput={handleTextareaInput}
          style={textareaStyle}
          spellCheck={false}
        />
        {!sourceMode && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <span style={{ flex: 1, fontSize: 12, color: "var(--text-muted)", lineHeight: "32px" }}>
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

  return (
    <div
      style={containerStyle}
      data-block-id={block.id}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
    >
      <div style={outlineStyle}>
        {selected && <div style={{
          position: "absolute", inset: -2, borderRadius: 4,
          backgroundColor: "rgba(20, 86, 240, 0.10)",
          pointerEvents: "none",
          transition: "background-color 0.12s ease",
        }} />}
        {isDivider ? (
          <hr style={{ border: "none", borderTop: "0.5px solid var(--border-light)", margin: "8px 0" }} />
        ) : (
          <div
            style={viewStyle}
            className="idea-preview-body block-item-view"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )}
      </div>
    </div>
  );
});

export default BlockItem;
