/**
 * BlockOverlays — absolute-positioned ⋮ handles + drag affordances overlaid
 * on top of a live (whole-document) MarkdownPreview surface.
 *
 * Why this exists (2026-04-29 rewrite):
 * The previous PR7+PR8 architecture rendered each block in its own
 * MarkdownPreview instance under a virtualizer, and made each one its own
 * contentEditable. That fought the browser hard:
 *   • Enter intercepted-and-spliced into the BLOCK'S source, then forced a
 *     remount with the same `source` prop — visually nothing changed because
 *     the parent's state update is async and `useIdeaBlocks` was preferring
 *     stale serverBlocks over live `localContent`.
 *   • Up/Down arrow at block boundaries had no way to cross between separate
 *     contentEditables.
 *   • Drag in preview-edit mode mutated the server but the FE didn't refetch
 *     in time, so the block visually didn't move until the next SSE.
 *   • Image rendering was per-block which masked schema bugs.
 *
 * The fix: revert to ONE big MarkdownPreview for editing (native Enter, native
 * arrow nav, native image rendering, single-pass sanitisation). For the per-
 * block widgets the user explicitly asked for (drag handle + ⋮ menu), this
 * component overlays them by:
 *   1. Reading the preview root's *direct top-level* children (these map 1:1
 *      to top-level Markdown blocks: <h1..6>, <p>, <ul>, <ol>, <pre>, <hr>,
 *      <blockquote>, <table>).
 *   2. Pairing the i-th DOM child with `blocks[i]` from `useIdeaBlocks`
 *      (which carries the stable server id).
 *   3. Rendering an absolute-positioned ⋮ handle at each block's top-left,
 *      inside a wrapper that sits at `position: relative` over the preview.
 *
 * Drag+menu behavior is identical to the old BlockList — same API endpoints,
 * same drop-indicator semantics — but now they coexist with native editing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import BlockMenu, { type BlockTransformTarget } from "./BlockMenu";
import { patchIdeaBlock, deleteIdeaBlock, moveIdeaBlock } from "../../../api";
import type { IdeaBlockBrief } from "../../../api";
import { useToast } from "../../Toast/index";
import { useTranslation } from "../../../i18n/index";
import "./BlockList.css";

interface OverlayItem {
  blockId: string;
  blockType: string;
  /** y-offset relative to the overlay container (matches the preview root). */
  top: number;
  /** Block height in pixels (used to make the drop indicator span correctly
   *  and to size the entire-block hover hit-target). */
  height: number;
}

interface Props {
  ideaId: string;
  blocks: IdeaBlockBrief[];
  /** Imperative-handle accessor for the live MarkdownPreview's contenteditable
   *  root. We measure top-level children of THIS element to compute overlay
   *  positions. */
  getPreviewRoot: () => HTMLElement | null;
  /** Hide overlays while the doc is read-only (streaming write in flight,
   *  external user). The handle is the only mutation surface, so removing
   *  it is sufficient. */
  readOnly?: boolean;
  /** Called after any structural mutation succeeds with the server's new
   *  full-document content + version. The parent (IdeaEditor) MUST update
   *  its local `content` state from this — `useIdeaSync` deliberately
   *  filters out same-client SSE echoes (so user keystrokes don't bounce
   *  back), which means the block-level mutation's content broadcast is
   *  also filtered. Without this callback the move endpoint succeeds
   *  server-side but the rendered preview stays stale because its
   *  `source` prop comes from the parent's `content`. (2026-04-29: this
   *  was the second half of the "drag in preview不生效" bug — the first
   *  half was useIdeaBlocks's missing `?clientId=…` on its SSE; the
   *  second half is that `useIdeaSync`'s clientId filter swallows the
   *  matching content-change event.) */
  onAfterMutate?: (next: { content: string; version: number }) => void;
}

const HANDLE_GAP = 8; // visual gap between handle right-edge and content edge
const HANDLE_SIZE = 28;

export default function BlockOverlays({
  ideaId,
  blocks,
  getPreviewRoot,
  readOnly = false,
  onAfterMutate,
}: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<OverlayItem[]>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<{ blockId: string; anchor: DOMRect } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ blockId: string; pos: "above" | "below" } | null>(null);

  /** Recompute overlay item positions by walking the preview root's
   *  direct children. This is the stitching point between server-side
   *  block IDs (from `blocks`) and DOM rects (from the live preview).
   *
   *  We rely on the invariant that the markdown parser emits exactly one
   *  top-level DOM element per top-level block: heading → h1..h6, paragraph
   *  → p, list → ul/ol, blockquote → blockquote, code → pre, divider → hr,
   *  table → table, html → whatever tag the user wrote. ideaBlocks[i]
   *  matches the i-th child in document order.
   *
   *  If the counts disagree (parser emitted extra wrapper, sanitiser ate a
   *  block, …), we degrade gracefully: emit overlays for as many as both
   *  agree on. The extras simply don't get widgets — better than crashing
   *  or pinning widgets to wrong blocks. */
  const measure = useCallback(() => {
    const root = getPreviewRoot();
    if (!root) {
      setItems([]);
      return;
    }
    const children = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );
    const rootRect = root.getBoundingClientRect();
    const count = Math.min(children.length, blocks.length);
    const next: OverlayItem[] = [];
    for (let i = 0; i < count; i++) {
      const el = children[i];
      const block = blocks[i];
      if (!block) continue;
      const r = el.getBoundingClientRect();
      next.push({
        blockId: block.id,
        blockType: block.type,
        // y-offset relative to root. Note: r.top is viewport-y, rootRect.top
        // is viewport-y too; their difference is root-relative-y (and stable
        // under page scroll, which is what we want — the overlay container
        // sits inside the same scroll context as the preview).
        top: r.top - rootRect.top,
        height: r.height,
      });
    }
    setItems(next);
  }, [getPreviewRoot, blocks]);

  // Watch for layout changes: ResizeObserver on the root catches font / image
  // load reflows; MutationObserver on subtree catches React-driven content
  // changes. Both feed `measure`. We also re-measure when `blocks` changes
  // (the dependency above) — important because a structural edit (Enter to
  // create a new block) updates `blocks` BEFORE the DOM has reflowed; rAF in
  // a useEffect catches the post-paint layout.
  useEffect(() => {
    const root = getPreviewRoot();
    if (!root) return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    Array.from(root.children).forEach((c) => {
      if (c instanceof Element) ro.observe(c);
    });
    const mo = new MutationObserver(schedule);
    mo.observe(root, {
      childList: true, subtree: true, characterData: true, attributes: true,
    });
    // Also watch the page scroll — if the user scrolls a containing element,
    // our root-relative offsets stay stable but layout might still need a
    // re-measure on certain browsers.
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [getPreviewRoot, measure]);

  // ── Mutations ──
  // Each block-level endpoint returns the server-authoritative
  // `{content, version}` after the splice; we forward both up so the
  // parent can `setContent` AND advance its `versionRef` for optimistic
  // concurrency. Skipping the version handoff would let the parent's
  // next autosave race the server with a stale baseVersion and 423.
  const refreshAfter = useCallback(
    (resp: { content: string; version: number }) => {
      onAfterMutate?.(resp);
    },
    [onAfterMutate],
  );

  const onCopyLink = useCallback(
    async (blockId: string) => {
      const url = `${window.location.origin}${window.location.pathname}${window.location.search}#block-${blockId}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success(t("blockMenu.copyLinkOk"));
      } catch {
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
        const resp = await deleteIdeaBlock(ideaId, blockId);
        refreshAfter(resp);
      } catch (err) {
        toast.error(`${t("blockMenu.deleteFail")}: ${err instanceof Error ? err.message : err}`);
      }
    },
    [ideaId, refreshAfter, toast, t],
  );

  const onTransform = useCallback(
    async (blockId: string, to: BlockTransformTarget) => {
      try {
        const resp = await patchIdeaBlock(ideaId, blockId, { transformTo: to });
        refreshAfter(resp);
      } catch (err) {
        toast.error(`${t("blockMenu.transformFail")}: ${err instanceof Error ? err.message : err}`);
      }
    },
    [ideaId, refreshAfter, toast, t],
  );

  // ── Drag handlers ──
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

  const onDragOverItem = useCallback(
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

  const onDropItem = useCallback(
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
        const resp = await moveIdeaBlock(ideaId, draggedId, toIndex);
        refreshAfter(resp);
      } catch (err) {
        toast.error(`${t("blockMenu.moveFail") || "Move failed"}: ${err instanceof Error ? err.message : err}`);
      }
    },
    [blocks, dragId, dropIndicator, ideaId, refreshAfter, toast, t],
  );

  if (readOnly) return null;

  return (
    <div
      ref={containerRef}
      className="idea-block-overlays"
      onDragEnd={() => {
        setDragId(null);
        setDropIndicator(null);
      }}
    >
      {items.map((it) => {
        const isHover = hoverId === it.blockId;
        const isDragSource = dragId === it.blockId;
        const showAbove = dropIndicator?.blockId === it.blockId && dropIndicator.pos === "above";
        const showBelow = dropIndicator?.blockId === it.blockId && dropIndicator.pos === "below";
        return (
          <div
            key={it.blockId}
            data-block-id={it.blockId}
            data-block-type={it.blockType}
            className={[
              "idea-block-overlay",
              isHover ? "is-hover" : "",
              isDragSource ? "is-drag-source" : "",
              showAbove ? "drop-indicator-above" : "",
              showBelow ? "drop-indicator-below" : "",
            ].filter(Boolean).join(" ")}
            style={{
              position: "absolute",
              top: it.top,
              left: 0,
              width: "100%",
              height: it.height,
              pointerEvents: "none", // wrapper transparent — only the handle catches events
            }}
            onMouseEnter={() => setHoverId(it.blockId)}
            onMouseLeave={() => setHoverId((cur) => (cur === it.blockId ? null : cur))}
            onDragOver={(e) => onDragOverItem(e, it.blockId)}
            onDrop={(e) => onDropItem(e, it.blockId)}
          >
            <button
              className="idea-block-handle idea-block-handle-overlay"
              draggable
              onDragStart={(e) => onDragStart(e, it.blockId)}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenuFor({ blockId: it.blockId, anchor: r });
              }}
              title={t("blockMenu.handleTooltip")}
              aria-label={t("blockMenu.handleTooltip")}
              style={{
                position: "absolute",
                left: -(HANDLE_SIZE + HANDLE_GAP),
                top: 2,
                width: HANDLE_SIZE,
                height: HANDLE_SIZE,
                pointerEvents: "auto",
              }}
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
            {/* Hit-target band that covers the block's left margin so hovering
             * the block (or an empty area to its left) still surfaces the
             * handle. The wrapper itself is pointer-events:none so block
             * text below stays clickable / editable. */}
            <div
              className="idea-block-overlay-hit"
              style={{
                position: "absolute",
                left: -(HANDLE_SIZE + HANDLE_GAP),
                top: 0,
                width: HANDLE_SIZE + HANDLE_GAP,
                height: it.height,
                pointerEvents: "auto",
              }}
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
