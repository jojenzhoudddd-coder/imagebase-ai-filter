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

export interface BlockItemProps {
  block: IdeaBlockBrief;
  ideaId: string;
  readOnly?: boolean;
  /** Focus this block on mount (e.g. just created). */
  autoFocus?: boolean;
  /** PR-C: another user updated this block while we're editing it. */
  remoteUpdatePending?: boolean;
  onSaved?: (res: PatchBlockResponse) => void;
  onDeleted?: (blockId: string) => void;
  onCreatedAfter?: (newBlock: { id: string; order: number; type: string; content: string; props: Record<string, unknown>; version: number }) => void;
  /** Navigate to previous block. */
  onFocusPrev?: () => void;
  /** Navigate to next block. */
  onFocusNext?: () => void;
  /** Notify parent of conflict (409) so it can reload blocks. */
  onConflict?: () => void;
  /** PR-C: notify parent when this block gains/loses focus. */
  onFocusChange?: (blockId: string, focused: boolean) => void;
  /** When another block is being edited, show toast on click instead of entering edit. */
  onEditBlocked?: () => void;
  /** True if another block is currently being edited. */
  editLocked?: boolean;
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
  onConflict,
  onFocusChange,
  onEditBlocked,
  editLocked = false,
}: BlockItemProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"view" | "selected" | "editing">("view");
  const [editValue, setEditValue] = useState("");
  const [hovered, setHovered] = useState(false);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const blockVersionRef = useRef<number>((block as any).version ?? 0);
  const editing = mode === "editing";
  const selected = mode === "selected";

  // Keep blockVersion ref in sync with block prop
  useEffect(() => {
    blockVersionRef.current = (block as any).version ?? 0;
  }, [block]);

  // Auto-focus: only for newly created blocks (autoFocus=true on first mount).
  // Uses a ref to fire only once and not re-trigger on parent re-renders.
  const didAutoFocus = useRef(false);
  useEffect(() => {
    if (autoFocus && !didAutoFocus.current && !readOnly && !editLocked) {
      didAutoFocus.current = true;
      setEditValue(block.content);
      setMode("editing");
      onFocusChange?.(block.id, true);
    }
  }, [autoFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-grow textarea and focus
  useEffect(() => {
    if (!editing || !textareaRef.current) return;
    const ta = textareaRef.current;
    ta.focus();
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  }, [editing]);

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

  const handleClick = useCallback(() => {
    if (readOnly) return;
    if (editLocked) { onEditBlocked?.(); return; }
    if (mode === "view") {
      setMode("selected");
      onFocusChange?.(block.id, true);
    } else if (mode === "selected") {
      setEditValue(block.content);
      setMode("editing");
    }
  }, [readOnly, editLocked, mode, block.content, block.id, onFocusChange, onEditBlocked]);

  const cancelEdit = useCallback(() => {
    setMode("view");
    setEditValue("");
    setHovered(false);
    onFocusChange?.(block.id, false);
  }, [block.id, onFocusChange]);

  const commitEdit = useCallback(async () => {
    if (!editing || saving) return;
    const trimmed = editValue;
    // No change → just close
    if (trimmed === block.content) {
      setMode("view");
      setHovered(false);
      onFocusChange?.(block.id, false);
      return;
    }
    setSaving(true);
    try {
      const res = await patchIdeaBlock(ideaId, block.id, {
        content: trimmed,
        baseVersion: blockVersionRef.current,
      });
      blockVersionRef.current = res.blockVersion;
      setMode("view");
      setHovered(false);
      onFocusChange?.(block.id, false);
      onSaved?.(res);
    } catch (err: any) {
      if (err?.status === 409) {
        setMode("view");
        setHovered(false);
        onFocusChange?.(block.id, false);
        onConflict?.();
      } else {
        // Keep editing on other errors so user doesn't lose work
        console.error("[BlockItem] save failed:", err);
      }
    } finally {
      setSaving(false);
    }
  }, [editing, saving, editValue, block.content, block.id, ideaId, onSaved, onConflict, onFocusChange]);

  // No blur-to-commit — editing is a stable state with explicit commit/cancel buttons

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
    // Enter is always newline (default textarea behavior) — no interception
  }, [cancelEdit, commitEdit]);

  const handleTextareaInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, []);

  // Render markdown to HTML. Strip trailing newlines + empty <p> tags.
  const renderedHtml = md.render(block.content.replace(/\n+$/, "").trim() || " ")
    .replace(/(<p>\s*<\/p>\s*)+$/, "");

  // Determine if this is a divider (just render <hr>)
  const isDivider = block.type === "divider";

  const showHover = hovered && !editing && !selected && !readOnly;
  const containerStyle: React.CSSProperties = {
    position: "relative",
    cursor: readOnly ? "default" : editing ? "text" : "pointer",
    minHeight: isDivider ? 20 : 24,
  };

  const outlineStyle: React.CSSProperties = {
    borderRadius: 4,
    outline: showHover ? "1px solid var(--primary)" : "1px solid transparent",
    outlineOffset: 2,
    transition: "outline-color 0.12s ease",
  };

  const viewStyle: React.CSSProperties = {
    lineHeight: 1.6,
    padding: selected ? "2px 4px" : 0,  // slight padding when selected for breathing room
    minHeight: "auto",
    borderRadius: selected ? 4 : 0,
    background: selected ? "var(--primary-bg)" : "transparent",
    transition: "background 0.12s ease",
  };

  const textareaStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    minHeight: 32,
    padding: "2px 0",
    margin: 0,
    border: "none",
    borderRadius: 4,
    background: "var(--surface-2)",
    color: "var(--text-primary)",
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, ui-monospace, monospace",
    fontSize: 13,
    lineHeight: "1.6",
    resize: "none",
    overflow: "hidden",
    outline: "1px solid var(--primary)",
    outlineOffset: 2,
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
      <div style={containerStyle}>
        {remoteUpdatePending && (
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
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleTextareaInput}
          style={textareaStyle}
          spellCheck={false}
        />
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
    >
      <div style={outlineStyle}>
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
