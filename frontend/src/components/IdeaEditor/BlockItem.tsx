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

  const handleBlur = useCallback(() => {
    if (editing) {
      void commitEdit();
    }
  }, [editing, commitEdit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
      return;
    }

    const isMultiLine = block.type === "code" || block.type === "list" ||
      block.type === "quote" || block.type === "table" || block.type === "html";

    if (isMultiLine) {
      // Cmd/Ctrl+Enter to save multi-line blocks
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void commitEdit();
      }
    } else {
      // Enter to save single-line blocks (headings, paragraphs, dividers)
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void commitEdit();
        // After committing a single-line block, create a new paragraph after it
        if (editValue.trim() !== "") {
          void createIdeaBlock(ideaId, {
            type: "paragraph",
            content: "\n",
            afterBlockId: block.id,
          }).then((res) => {
            onCreatedAfter?.({
              id: res.block.id,
              order: res.block.order,
              type: res.block.type,
              content: res.block.content,
              props: res.block.props as Record<string, unknown>,
              version: res.block.version,
            });
          }).catch((err) => {
            console.error("[BlockItem] create after failed:", err);
          });
        }
      }
    }

    // Arrow up at start → focus previous block
    if (e.key === "ArrowUp") {
      const ta = textareaRef.current;
      if (ta && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        e.preventDefault();
        void commitEdit();
        onFocusPrev?.();
      }
    }
    // Arrow down at end → focus next block
    if (e.key === "ArrowDown") {
      const ta = textareaRef.current;
      if (ta && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length) {
        e.preventDefault();
        void commitEdit();
        onFocusNext?.();
      }
    }
    // Backspace on empty → delete block
    if (e.key === "Backspace" && editValue.trim() === "") {
      e.preventDefault();
      setEditing(false);
      void deleteIdeaBlock(ideaId, block.id).then(() => {
        onDeleted?.(block.id);
        onFocusPrev?.();
      }).catch((err) => {
        console.error("[BlockItem] delete failed:", err);
      });
    }
  }, [block.type, block.id, editValue, ideaId, cancelEdit, commitEdit, onFocusPrev, onFocusNext, onDeleted, onCreatedAfter]);

  const handleTextareaInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, []);

  // Render markdown to HTML for view mode. Trim trailing newlines for cleaner render.
  const renderedHtml = md.render(block.content.replace(/\n+$/, "").trim() || " ");

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
    outlineOffset: 4,
    transition: "outline-color 0.12s ease",
  };

  const viewStyle: React.CSSProperties = {
    lineHeight: 1.6,
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
    outlineOffset: 4,
    boxSizing: "border-box" as const,
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
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          onInput={handleTextareaInput}
          style={textareaStyle}
          spellCheck={false}
        />
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
            className="idea-preview-body"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )}
      </div>
    </div>
  );
});

export default BlockItem;
