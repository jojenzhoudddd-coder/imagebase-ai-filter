/**
 * Virtualized block-list renderer (PR7).
 *
 * Replaces the single full-document `<MarkdownPreview source={content}>`
 * with one `MarkdownPreview` per block, virtualized via @tanstack/react-virtual.
 *
 * Goals:
 *   - Big documents (1MB+) don't drop frames on scroll / re-render
 *   - Mention chips still render inside each block (each block is its own
 *     react-markdown island, so all the existing rehype/remark plugins apply
 *     on the block's bytes)
 *   - Click-to-navigate on mention chips still works
 *   - Block-level click handlers plumbed for PR8 (hover ⋮ / drag handle)
 *   - **Read-only**: full-document contentEditable is dropped in favor of
 *     the textarea (source mode). Per-block contentEditable returns in PR8
 *     with proper hover affordances + transformations.
 *
 * Source-of-truth invariant from PR6: `blocks.map(b=>b.content).join("") ===
 * idea.content`. This lets us use each block's `content` slice as the input
 * to its own MarkdownPreview without losing fidelity.
 *
 * 详见 docs/roadmap-post-skill-v1.md PR7.
 */

import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import MarkdownPreview from "../MarkdownPreview";
import type { ParsedMention } from "../../Mention/mentionSyntax";
import type { IdeaBlockBrief } from "../../../api";
import "./BlockList.css";

interface Props {
  blocks: IdeaBlockBrief[];
  /** External scroll container — typically the IdeaEditor `bodyRef`. */
  scrollRef: React.RefObject<HTMLElement | null>;
  onMentionClick: (m: ParsedMention) => void;
  /** Fired when a block's wrapper is clicked (anywhere outside an inline link).
   *  Reserved for PR8 (focus / select / hover). For now we just plumb the
   *  hook — caller may ignore. */
  onBlockClick?: (blockId: string) => void;
  /** When the document is empty (content === "") show this as a read-only
   *  hint, mirroring textarea placeholder behaviour. */
  placeholder?: string;
}

const ESTIMATED_BLOCK_HEIGHT = 64; // p1 estimate; virtualizer will measure each
const OVERSCAN = 6;

export default function BlockList({
  blocks,
  scrollRef,
  onMentionClick,
  onBlockClick,
  placeholder,
}: Props) {
  // We attach an inner sentinel div to actually measure positions —
  // virtualizer needs a stable element ref. The OUTER scroll element is
  // owned by IdeaEditor (`bodyRef`); we don't take ownership of that.
  const innerRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_BLOCK_HEIGHT,
    overscan: OVERSCAN,
    // Stable getItemKey — block id stays the same across re-renders so
    // virtualizer can preserve measurements + DOM mapping.
    getItemKey: (i) => blocks[i].id,
  });

  // Reflow when block count changes drastically (e.g. doc switched).
  useEffect(() => {
    virtualizer.measure();
  }, [blocks.length, virtualizer]);

  // Empty-doc placeholder
  if (blocks.length === 0) {
    return (
      <div className="idea-block-list-empty">
        {placeholder ?? ""}
      </div>
    );
  }

  return (
    <div
      ref={innerRef}
      className="idea-block-list"
      style={{
        // Full virtual height — ensures the scrollbar is correct.
        height: virtualizer.getTotalSize(),
        position: "relative",
      }}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const block = blocks[vi.index];
        return (
          <div
            key={vi.key}
            ref={virtualizer.measureElement}
            data-index={vi.index}
            data-block-id={block.id}
            data-block-type={block.type}
            className={`idea-block idea-block-${block.type}`}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${vi.start}px)`,
            }}
            onClick={() => onBlockClick?.(block.id)}
          >
            {/* Each block is its own MarkdownPreview instance — its
             * `source` is the block's raw bytes. Read-only in V1; PR8
             * adds block-level edit affordances. */}
            <MarkdownPreview
              source={block.content}
              onMentionClick={onMentionClick}
            />
          </div>
        );
      })}
    </div>
  );
}
