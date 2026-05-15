/**
 * BlockLayoutRenderer — recursively renders a BlockLayoutNode tree.
 *
 * - leaf nodes render a <BlockItem> for the referenced blockId
 * - split nodes render CSS Grid with two children + a resize handle
 *
 * All styling is inline (no CSS file changes).
 */
import React, { useCallback, useRef } from "react";
import type { BlockLayoutNode } from "../../types";
import type { IdeaBlockBrief, PatchBlockResponse } from "../../api";
import BlockItem from "./BlockItem";

export interface BlockLayoutRendererProps {
  node: BlockLayoutNode;
  blocks: IdeaBlockBrief[];
  ideaId: string;
  streaming: boolean;
  autoEditBlockId: string | null;
  focusBlockId: string | null;
  focusTrigger: number;
  focusCursorPos: number | null;
  pendingRemoteBlocks: Set<string>;
  dragBlockId: string | null;
  dropTarget: LayoutDropTarget | null;
  onSaved: (res: PatchBlockResponse) => void;
  onDeleted: (blockId: string) => void;
  onCreatedAfter: (newBlock: { id: string; order: number; type: string; content: string; props: Record<string, unknown>; version: number }) => void;
  onConflict: () => void;
  onFocusChange: (blockId: string, focused: boolean) => void;
  onEditBlocked: () => void;
  onSplit: (blockId: string, contentBefore: string, contentAfter: string) => void;
  onMergeIntoPrev: (blockId: string, contentToAppend: string) => void;
  onDragStart: (blockId: string) => void;
  onFocusPrev: (blockId: string) => void;
  onFocusNext: (blockId: string) => void;
  /** Callback when a resize handle is dragged. path identifies which split. */
  onResizeStart: (path: ("first" | "second")[], e: React.PointerEvent) => void;
  /** Current path being resized (for visual feedback). null if not resizing. */
  resizingPath: string | null;
  /** Current depth for enforcing max nesting. */
  depth?: number;
}

export interface LayoutDropTarget {
  type: "layout-side";
  targetBlockId: string;
  side: "top" | "right" | "bottom" | "left";
}

/** Serialize path for comparison */
function pathKey(path: ("first" | "second")[]): string {
  return path.join(".");
}

export default function BlockLayoutRenderer({
  node,
  blocks,
  ideaId,
  streaming,
  autoEditBlockId,
  focusBlockId,
  focusTrigger,
  focusCursorPos,
  pendingRemoteBlocks,
  dragBlockId,
  dropTarget,
  onSaved,
  onDeleted,
  onCreatedAfter,
  onConflict,
  onFocusChange,
  onEditBlocked,
  onSplit,
  onMergeIntoPrev,
  onDragStart,
  onFocusPrev,
  onFocusNext,
  onResizeStart,
  resizingPath,
  depth = 0,
}: BlockLayoutRendererProps) {
  if (node.kind === "leaf") {
    const block = blocks.find((b) => b.id === node.blockId);
    if (!block) return null;

    const showDropTop = dropTarget?.type === "layout-side" && dropTarget.targetBlockId === block.id && dropTarget.side === "top";
    const showDropBottom = dropTarget?.type === "layout-side" && dropTarget.targetBlockId === block.id && dropTarget.side === "bottom";
    const showDropLeft = dropTarget?.type === "layout-side" && dropTarget.targetBlockId === block.id && dropTarget.side === "left";
    const showDropRight = dropTarget?.type === "layout-side" && dropTarget.targetBlockId === block.id && dropTarget.side === "right";

    return (
      <div style={{ position: "relative", minWidth: 0, minHeight: 0 }}>
        {showDropTop && (
          <div style={{ position: "absolute", top: -1, left: 0, right: 0, height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none" }} />
        )}
        {showDropBottom && (
          <div style={{ position: "absolute", bottom: -1, left: 0, right: 0, height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none" }} />
        )}
        {showDropLeft && (
          <div style={{ position: "absolute", left: -1, top: 0, bottom: 0, width: 2, background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none" }} />
        )}
        {showDropRight && (
          <div style={{ position: "absolute", right: -1, top: 0, bottom: 0, width: 2, background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none" }} />
        )}
        <BlockItem
          block={block}
          ideaId={ideaId}
          readOnly={streaming}
          sourceMode={false}
          autoFocus={autoEditBlockId === block.id}
          focusTrigger={focusBlockId === block.id ? focusTrigger : 0}
          focusCursorPos={focusBlockId === block.id ? focusCursorPos : null}
          remoteUpdatePending={pendingRemoteBlocks.has(block.id)}
          onSaved={onSaved}
          onDeleted={onDeleted}
          onCreatedAfter={onCreatedAfter}
          onConflict={onConflict}
          onFocusChange={onFocusChange}
          editLocked={!!focusBlockId && focusBlockId !== block.id}
          onEditBlocked={onEditBlocked}
          onSplit={onSplit}
          onMergeIntoPrev={onMergeIntoPrev}
          onDragStart={onDragStart}
          isDragging={dragBlockId === block.id}
          dragInProgress={!!dragBlockId}
          onFocusPrev={() => onFocusPrev(block.id)}
          onFocusNext={() => onFocusNext(block.id)}
        />
      </div>
    );
  }

  // Split node — render as CSS Grid
  const isH = node.orientation === "h";
  const currentPath: ("first" | "second")[] = [];
  const currentPathKey = pathKey(currentPath);
  const handleSize = 12;

  const gridStyle: React.CSSProperties = isH
    ? {
        display: "grid",
        gridTemplateColumns: `${node.ratio}fr ${handleSize}px ${1 - node.ratio}fr`,
        gap: 0,
        minHeight: 0,
        minWidth: 0,
        alignItems: "stretch",
      }
    : {
        display: "grid",
        gridTemplateRows: `${node.ratio}fr ${handleSize}px ${1 - node.ratio}fr`,
        gap: 0,
        minHeight: 0,
        minWidth: 0,
      };

  return (
    <div style={gridStyle}>
      <div style={{ minWidth: 0, minHeight: 0, overflow: "hidden" }}>
        <BlockLayoutRenderer
          {...{
            node: node.first,
            blocks,
            ideaId,
            streaming,
            autoEditBlockId,
            focusBlockId,
            focusTrigger,
            focusCursorPos,
            pendingRemoteBlocks,
            dragBlockId,
            dropTarget,
            onSaved,
            onDeleted,
            onCreatedAfter,
            onConflict,
            onFocusChange,
            onEditBlocked,
            onSplit,
            onMergeIntoPrev,
            onDragStart,
            onFocusPrev,
            onFocusNext,
            onResizeStart,
            resizingPath,
            depth: depth + 1,
          }}
        />
      </div>
      <ResizeHandle
        orientation={node.orientation}
        path={currentPath}
        onResizeStart={onResizeStart}
        isResizing={resizingPath === currentPathKey}
      />
      <div style={{ minWidth: 0, minHeight: 0, overflow: "hidden" }}>
        <BlockLayoutRenderer
          {...{
            node: node.second,
            blocks,
            ideaId,
            streaming,
            autoEditBlockId,
            focusBlockId,
            focusTrigger,
            focusCursorPos,
            pendingRemoteBlocks,
            dragBlockId,
            dropTarget,
            onSaved,
            onDeleted,
            onCreatedAfter,
            onConflict,
            onFocusChange,
            onEditBlocked,
            onSplit,
            onMergeIntoPrev,
            onDragStart,
            onFocusPrev,
            onFocusNext,
            onResizeStart,
            resizingPath,
            depth: depth + 1,
          }}
        />
      </div>
    </div>
  );
}

// ─── Resize Handle ──────────────────────────────────────────────────────

interface ResizeHandleProps {
  orientation: "h" | "v";
  path: ("first" | "second")[];
  onResizeStart: (path: ("first" | "second")[], e: React.PointerEvent) => void;
  isResizing: boolean;
}

function ResizeHandle({ orientation, path, onResizeStart, isResizing }: ResizeHandleProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const isH = orientation === "h";

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onResizeStart(path, e);
    },
    [path, onResizeStart],
  );

  const containerStyle: React.CSSProperties = isH
    ? {
        width: 24,
        marginLeft: -6,
        marginRight: -6,
        cursor: "col-resize",
        alignSelf: "stretch",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        zIndex: 5,
        background: "transparent",
      }
    : {
        height: 24,
        marginTop: -6,
        marginBottom: -6,
        cursor: "row-resize",
        justifySelf: "stretch",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        zIndex: 5,
        background: "transparent",
      };

  const barStyle: React.CSSProperties = isH
    ? {
        width: 2,
        borderRadius: 2,
        position: "absolute",
        top: 0,
        bottom: 0,
        left: 11,
        opacity: isResizing ? 1 : 0,
        background: "var(--primary, #1456F0)",
        transition: "opacity 0.15s",
        pointerEvents: "none",
      }
    : {
        height: 2,
        borderRadius: 2,
        position: "absolute",
        left: 0,
        right: 0,
        top: 11,
        opacity: isResizing ? 1 : 0,
        background: "var(--primary, #1456F0)",
        transition: "opacity 0.15s",
        pointerEvents: "none",
      };

  return (
    <div
      style={containerStyle}
      onPointerDown={handlePointerDown}
      onPointerEnter={() => {
        if (barRef.current) barRef.current.style.opacity = "1";
      }}
      onPointerLeave={() => {
        if (!isResizing && barRef.current) barRef.current.style.opacity = "0";
      }}
    >
      <div ref={barRef} style={barStyle} />
    </div>
  );
}
