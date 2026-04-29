/**
 * Virtualized block-list renderer (PR7 + PR8).
 *
 * PR7: replace single full-document MarkdownPreview with one MarkdownPreview
 *      per block, virtualized via @tanstack/react-virtual.
 * PR8: per-block hover ⋮ handle → BlockMenu (copy link / delete / convert
 *      type) + HTML5 native drag-and-drop reorder + block-link scroll/flash.
 *
 * Source-of-truth invariant from PR6: `blocks.map(b=>b.content).join("") ===
 * idea.content`. Mutations here go through the dedicated PR8 routes
 * (`PATCH /blocks/:blockId`, `DELETE /blocks/:blockId`, `POST move`) which
 * recompute content server-side and trigger SSE refetch via useIdeaBlocks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import MarkdownPreview from "../MarkdownPreview";
import BlockMenu, { type BlockTransformTarget } from "./BlockMenu";
import type { ParsedMention } from "../../Mention/mentionSyntax";
import type { IdeaBlockBrief } from "../../../api";
import { patchIdeaBlock, deleteIdeaBlock, moveIdeaBlock } from "../../../api";
import { useToast } from "../../Toast/index";
import { useTranslation } from "../../../i18n/index";
import "./BlockList.css";

interface Props {
  ideaId: string;
  blocks: IdeaBlockBrief[];
  scrollRef: React.RefObject<HTMLElement | null>;
  onMentionClick: (m: ParsedMention) => void;
  /** Whether mutations are allowed (false during streaming). */
  readOnly?: boolean;
  placeholder?: string;
  /** Optional callback after a successful block mutation — useful for
   *  parent IdeaEditor to refresh state if needed (refetch happens via
   *  SSE so this is mostly a hook for telemetry / toasts). */
  onAfterMutate?: () => void;
  /** When true, each block is contentEditable. Edits get spliced back
   *  into the full document and surfaced via `onContentChange`. */
  editable?: boolean;
  /** Fires when a block edit produced a new full-document content.
   *  Parent (IdeaEditor) is responsible for setContent + scheduleSave. */
  onContentChange?: (newFullContent: string) => void;
}

const ESTIMATED_BLOCK_HEIGHT = 64;
const OVERSCAN = 6;
const FLASH_DURATION_MS = 1800;

export default function BlockList({
  ideaId,
  blocks,
  scrollRef,
  onMentionClick,
  readOnly = false,
  placeholder,
  onAfterMutate,
  editable = false,
  onContentChange,
}: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const innerRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef<Map<string, HTMLElement>>(new Map());

  // ── Hover state — only one block can be "hot" at a time so ⋮ doesn't flash ──
  const [hoverBlockId, setHoverBlockId] = useState<string | null>(null);
  // ── Menu state ──
  const [menuFor, setMenuFor] = useState<{ blockId: string; anchor: DOMRect } | null>(null);
  // ── Block-link flash highlight ──
  const [flashId, setFlashId] = useState<string | null>(null);
  // ── Drag state ──
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ blockId: string; pos: "above" | "below" } | null>(null);
  // ── Drag state ──

  // ── Per-block byte offsets (for editable splice) ──
  // Source-of-truth invariant from PR6: blocks[i].content concatenated ===
  // idea.content. So block N starts at sum(blocks[0..N-1].content.length).
  // We snapshot offsets + the assembled full content for THIS render,
  // referenced by the per-block onEditableInput closure. Each edit
  // recomputes the new full content and forwards it to the parent.
  const fullContentSnapshot = blocks.map((b) => b.content).join("");
  const blockStarts: number[] = [];
  let acc = 0;
  for (const b of blocks) {
    blockStarts.push(acc);
    acc += b.content.length;
  }

  const handleBlockEdit = useCallback(
    (idx: number, newBlockSource: string) => {
      if (!onContentChange) return;
      const start = blockStarts[idx] ?? 0;
      const end = start + (blocks[idx]?.content.length ?? 0);
      const next =
        fullContentSnapshot.slice(0, start) +
        newBlockSource +
        fullContentSnapshot.slice(end);
      onContentChange(next);
    },
    // blockStarts / fullContentSnapshot intentionally NOT in deps — we
    // capture the snapshot at the time of render, which is correct: the
    // user is editing what they see. Re-render replaces the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blocks, onContentChange],
  );

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_BLOCK_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (i) => blocks[i].id,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [blocks.length, virtualizer]);

  // ── Block-link routing: parse `#block-<id>` from URL, scroll + flash ──
  // We support two URL shapes:
  //   - location.hash:    `#block-<blockId>`
  //   - search param:     `?focusBlock=<blockId>`
  // Both written by the "copy link" action below.
  useEffect(() => {
    const pickFromUrl = (): string | null => {
      const hash = window.location.hash || "";
      const m = hash.match(/^#block-([\w-]+)$/);
      if (m) return m[1];
      const sp = new URLSearchParams(window.location.search);
      return sp.get("focusBlock");
    };
    const tryFocus = () => {
      const id = pickFromUrl();
      if (!id) return;
      const idx = blocks.findIndex((b) => b.id === id);
      if (idx === -1) return;
      virtualizer.scrollToIndex(idx, { align: "start" });
      // After virtualizer mounts the row, flash it. Defer one frame so the
      // measureElement ref attaches.
      requestAnimationFrame(() => {
        setFlashId(id);
        setTimeout(() => setFlashId(null), FLASH_DURATION_MS);
      });
    };
    tryFocus();
    const onHash = () => tryFocus();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks.length]);

  // ── Mutations ──
  const refreshAfter = useCallback(() => {
    onAfterMutate?.();
  }, [onAfterMutate]);

  const onCopyLink = useCallback(
    async (blockId: string) => {
      // Build a deep link the FE router (or anyone) can use. We embed in
      // hash so the link doesn't trigger a full reload — the IdeaEditor's
      // own hashchange listener picks it up and scrolls.
      const url = `${window.location.origin}${window.location.pathname}${window.location.search}#block-${blockId}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success(t("blockMenu.copyLinkOk"));
      } catch {
        // Clipboard API can be blocked (e.g. in iframe without permission).
        // Fall back to a textarea + execCommand.
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
          toast.success(t("blockMenu.copyLinkOk"));
        } catch {
          toast.error(t("blockMenu.copyLinkFail"));
        } finally {
          document.body.removeChild(ta);
        }
      }
    },
    [toast, t],
  );

  const onDelete = useCallback(
    async (blockId: string) => {
      try {
        await deleteIdeaBlock(ideaId, blockId);
        refreshAfter();
      } catch (err) {
        toast.error(`${t("blockMenu.deleteFail")}: ${err instanceof Error ? err.message : err}`);
      }
    },
    [ideaId, refreshAfter, toast, t],
  );

  const onTransform = useCallback(
    async (blockId: string, to: BlockTransformTarget) => {
      try {
        await patchIdeaBlock(ideaId, blockId, { transformTo: to });
        refreshAfter();
      } catch (err) {
        toast.error(`${t("blockMenu.transformFail")}: ${err instanceof Error ? err.message : err}`);
      }
    },
    [ideaId, refreshAfter, toast, t],
  );

  // ── Drag handlers (HTML5 native, no extra deps) ──
  // Restored 2026-04-29: per user request. Now triggered ONLY from the ⋮
  // handle (the rest of the row is no longer a drop zone for the row itself
  // — only its children's elements receive native text selection events as
  // expected). Drop indicators stay above/below.
  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLElement>, blockId: string) => {
      if (readOnly) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", `block-${blockId}`);
      setDragId(blockId);
    },
    [readOnly],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, blockId: string) => {
      if (!dragId || dragId === blockId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const pos: "above" | "below" = e.clientY < midY ? "above" : "below";
      setDropIndicator({ blockId, pos });
    },
    [dragId],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setDropIndicator(null);
      }
    },
    [],
  );

  const onDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>, targetBlockId: string) => {
      e.preventDefault();
      const draggedId = dragId;
      const indicator = dropIndicator;
      setDragId(null);
      setDropIndicator(null);
      if (!draggedId || draggedId === targetBlockId) return;

      const fromIdx = blocks.findIndex((b) => b.id === draggedId);
      const targetIdx = blocks.findIndex((b) => b.id === targetBlockId);
      if (fromIdx === -1 || targetIdx === -1) return;
      let toIndex = targetIdx;
      if (indicator?.pos === "below") {
        toIndex = fromIdx < targetIdx ? targetIdx : targetIdx + 1;
      } else {
        toIndex = fromIdx < targetIdx ? targetIdx - 1 : targetIdx;
      }
      try {
        await moveIdeaBlock(ideaId, draggedId, toIndex);
        refreshAfter();
      } catch (err) {
        toast.error(`${t("blockMenu.moveFail") || "Move failed"}: ${err instanceof Error ? err.message : err}`);
      }
    },
    [blocks, dragId, dropIndicator, ideaId, refreshAfter, toast, t],
  );

  if (blocks.length === 0) {
    return <div className="idea-block-list-empty">{placeholder ?? ""}</div>;
  }

  return (
    <div
      ref={innerRef}
      className="idea-block-list"
      style={{
        height: virtualizer.getTotalSize(),
        position: "relative",
      }}
      onDragEnd={() => {
        setDragId(null);
        setDropIndicator(null);
      }}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const block = blocks[vi.index];
        const isHover = hoverBlockId === block.id;
        const isDragSource = dragId === block.id;
        const showIndicatorAbove =
          dropIndicator?.blockId === block.id && dropIndicator.pos === "above";
        const showIndicatorBelow =
          dropIndicator?.blockId === block.id && dropIndicator.pos === "below";
        // PR8.5 hotfix: per-block render content has trailing whitespace
        // collapsed to one `\n`. The block's BYTES in the source stay
        // unchanged (handleBlockEdit splices what the user actually edits),
        // but visually we hide the "phantom blank lines" that accumulate
        // when the parser absorbs blank-line separators into the previous
        // block's content. User-perceived doc → no extra empty space; on
        // any edit the splice naturally normalises trailing too (since
        // contentEditable round-trips innerText with at most one trailing
        // `\n`).
        const renderSource = block.content.replace(/\n+$/, "\n");
        return (
          <div
            key={vi.key}
            ref={(el) => {
              if (el) {
                virtualizer.measureElement(el);
                blockRefs.current.set(block.id, el);
              } else {
                blockRefs.current.delete(block.id);
              }
            }}
            data-index={vi.index}
            data-block-id={block.id}
            data-block-type={block.type}
            className={[
              "idea-block",
              `idea-block-${block.type}`,
              isHover ? "is-hover" : "",
              isDragSource ? "is-drag-source" : "",
              flashId === block.id ? "is-flash" : "",
              showIndicatorAbove ? "drop-indicator-above" : "",
              showIndicatorBelow ? "drop-indicator-below" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${vi.start}px)`,
            }}
            onMouseEnter={() => setHoverBlockId(block.id)}
            onMouseLeave={() => {
              setHoverBlockId((cur) => (cur === block.id ? null : cur));
            }}
            onDragOver={(e) => onDragOver(e, block.id)}
            onDragLeave={onDragLeave}
            onDrop={(e) => onDrop(e, block.id)}
          >
            {/* ⋮ handle — draggable + opens BlockMenu on click. Hidden when
             * not hovering (pointer-events suppressed via CSS) so it doesn't
             * disturb selection. */}
            {!readOnly && (
              <button
                className="idea-block-handle"
                draggable
                onDragStart={(e) => onDragStart(e, block.id)}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenuFor({ blockId: block.id, anchor: r });
                }}
                title={t("blockMenu.handleTooltip")}
                aria-label={t("blockMenu.handleTooltip")}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <circle cx="9" cy="6" r="1.5" fill="currentColor" />
                  <circle cx="9" cy="12" r="1.5" fill="currentColor" />
                  <circle cx="9" cy="18" r="1.5" fill="currentColor" />
                  <circle cx="15" cy="6" r="1.5" fill="currentColor" />
                  <circle cx="15" cy="12" r="1.5" fill="currentColor" />
                  <circle cx="15" cy="18" r="1.5" fill="currentColor" />
                </svg>
              </button>
            )}
            <MarkdownPreview
              source={renderSource}
              onMentionClick={onMentionClick}
              editable={editable && !readOnly}
              onEditableInput={
                editable && !readOnly
                  ? (next: string) => {
                      // Normalise trailing whitespace on every edit so
                      // the user can never accumulate phantom blank lines
                      // between blocks. Keep exactly one `\n` if the
                      // original block had one, else 0.
                      const normalised = next.replace(/\n+$/, block.content.endsWith("\n") ? "\n" : "");
                      handleBlockEdit(vi.index, normalised);
                    }
                  : undefined
              }
            />
          </div>
        );
      })}
      {menuFor && (
        <BlockMenu
          anchor={menuFor.anchor}
          blockType={blocks.find((b) => b.id === menuFor.blockId)?.type ?? "paragraph"}
          onClose={() => setMenuFor(null)}
          onCopyLink={() => onCopyLink(menuFor.blockId)}
          onDelete={() => onDelete(menuFor.blockId)}
          onTransform={(to) => onTransform(menuFor.blockId, to)}
        />
      )}
    </div>
  );
}
