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

// Inject a scoped style to remove bottom margin from the last child in each
// block view — avoids double spacing between blocks. Done once at module load.
if (typeof document !== "undefined" && !document.getElementById("block-item-style")) {
  const s = document.createElement("style");
  s.id = "block-item-style";
  s.textContent = ".block-item-view > *:last-child { margin-bottom: 0 !important; }";
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
}: BlockItemProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [hovered, setHovered] = useState(false);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const blockVersionRef = useRef<number>((block as any).version ?? 0);

  // Keep blockVersion ref in sync with block prop
  useEffect(() => {
    blockVersionRef.current = (block as any).version ?? 0;
  }, [block]);

  // Auto-focus on mount if requested
  useEffect(() => {
    if (autoFocus && !readOnly) {
      setEditing(true);
      setEditValue(block.content);
    }
  }, [autoFocus, readOnly, block.content]);

  // Auto-grow textarea and focus
  useEffect(() => {
    if (!editing || !textareaRef.current) return;
    const ta = textareaRef.current;
    ta.focus();
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
    // Place cursor at end
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  }, [editing]);

  const enterEdit = useCallback(() => {
    if (readOnly || editing) return;
    setEditValue(block.content);
    setEditing(true);
    onFocusChange?.(block.id, true);
  }, [readOnly, editing, block.content, block.id, onFocusChange]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setEditValue("");
    setHovered(false);
    onFocusChange?.(block.id, false);
  }, [block.id, onFocusChange]);

  const commitEdit = useCallback(async () => {
    if (!editing || saving) return;
    const trimmed = editValue;
    // No change → just close
    if (trimmed === block.content) {
      setEditing(false);
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
      setEditing(false);
      setHovered(false);
      onFocusChange?.(block.id, false);
      onSaved?.(res);
    } catch (err: any) {
      if (err?.status === 409) {
        setEditing(false);
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

  const showHover = hovered && !editing && !readOnly;
  const containerStyle: React.CSSProperties = {
    position: "relative",
    cursor: readOnly ? "default" : "text",
    minHeight: isDivider ? 20 : 24,
  };

  // Outline wraps the content div tightly, outlineOffset adds 4px breathing room
  const outlineStyle: React.CSSProperties = {
    borderRadius: 4,
    outline: showHover ? "1px solid var(--color-primary, #3778FB)" : "1px solid transparent",
    outlineOffset: 2,
    transition: "outline-color 0.12s ease",
  };

  const viewStyle: React.CSSProperties = {
    lineHeight: 1.6,
    padding: 0,       // override .idea-preview-body's 60px padding
    minHeight: "auto", // override .idea-preview-body's min-height: 100%
  };

  const textareaStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    minHeight: 32,
    padding: "2px 0",
    margin: 0,
    border: "none",
    borderRadius: 4,
    background: "var(--bg-body, #fff)",
    color: "var(--text-primary, #1f2329)",
    fontFamily: "var(--font-mono, 'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace)",
    fontSize: 13,
    lineHeight: "1.6",
    resize: "none",
    overflow: "hidden",
    outline: "1px solid var(--color-primary, #3778FB)",
    outlineOffset: 2,
    boxSizing: "border-box" as const,
  };

  const btnBase: React.CSSProperties = {
    padding: "3px 10px",
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
    border: "none",
    lineHeight: "18px",
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
            ⚠ Updated by another user
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
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, padding: "6px 0 2px" }}>
          <span style={{ flex: 1, fontSize: 11, color: "var(--text-muted, #8f959e)", lineHeight: "24px" }}>
            Alt+Enter 提交 · Esc 取消
          </span>
          <button
            type="button"
            style={{ ...btnBase, background: "var(--surface-3, #f0f1f3)", color: "var(--text-secondary, #646a73)" }}
            onClick={(e) => { e.stopPropagation(); cancelEdit(); }}
            disabled={saving}
          >取消</button>
          <button
            type="button"
            style={{ ...btnBase, background: "var(--color-primary, #3778FB)", color: "#fff" }}
            onClick={(e) => { e.stopPropagation(); void commitEdit(); }}
            disabled={saving}
          >{saving ? "保存中…" : "提交"}</button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={containerStyle}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onClick={enterEdit}
    >
      <div style={outlineStyle}>
        {isDivider ? (
          <hr style={{ border: "none", borderTop: "1px solid var(--border-divider, #dee0e3)", margin: "8px 0" }} />
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
