/**
 * BlockLayoutRenderer — renders a ColumnRow recursively.
 *
 * direction "h": CSS Grid side-by-side columns (fr widths + 12px resize handles)
 * direction "v": flex column with natural heights, no resize handles
 *
 * Anchor lines:
 *   "h" row: 4 edge lines on the whole row (6px gap) + insertion lines between columns
 *   "v" row: horizontal lines tight against blocks
 */
import React, { useCallback, useRef } from "react";
import type { ColumnRow, ColumnCell } from "../../types";
import type { IdeaBlockBrief, PatchBlockResponse } from "../../api";
import BlockItem from "./BlockItem";

export interface BlockLayoutRendererProps {
  row: ColumnRow;
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
  onResizeStart: (rowId: string, dividerIndex: number, e: React.PointerEvent) => void;
  resizingDivider: string | null;
  depth?: number;
}

export interface LayoutDropTarget {
  type: "layout-side";
  targetBlockId: string;
  side: "left" | "right" | "top" | "bottom";
}

const MAX_DEPTH = 6;

export default function BlockLayoutRenderer(props: BlockLayoutRendererProps) {
  const { row, depth = 0 } = props;
  const isH = row.direction === "h";

  if (isH) return <HorizontalRow {...props} depth={depth} />;
  return <VerticalStack {...props} depth={depth} />;
}

// ─── Horizontal row (CSS Grid, fr widths, resize handles) ──────────────

function HorizontalRow(props: BlockLayoutRendererProps & { depth: number }) {
  const { row, depth, resizingDivider } = props;
  const template = row.widths.map((w) => `${w}fr`).join(" 12px ");
  // Show percentage badges during resize of THIS row
  const isResizingThisRow = resizingDivider?.startsWith(row.id + ":") ?? false;
  const totalW = row.widths.reduce((s, w) => s + w, 0) || 1;

  return (
    <div
      data-layout-row={row.id}
      style={{
        display: "grid",
        gridTemplateColumns: template,
        gap: 0,
        minWidth: 0,
        alignItems: "start",
      }}
    >
      {row.columns.map((cell, colIdx) => (
        <React.Fragment key={cellKey(cell, colIdx)}>
          {colIdx > 0 && (
            <ResizeHandle
              rowId={row.id}
              dividerIndex={colIdx - 1}
              direction="h"
              onResizeStart={props.onResizeStart}
              isResizing={resizingDivider === `${row.id}:${colIdx - 1}`}
            />
          )}
          <div style={{ position: "relative", minWidth: 0 }}>
            {/* Percentage badge during resize */}
            {isResizingThisRow && (
              <div style={{
                position: "absolute", top: 8, right: 8, zIndex: 20,
                fontSize: 11, lineHeight: "18px", padding: "0 5px",
                borderRadius: 4, pointerEvents: "none",
                color: "var(--text-secondary)", background: "var(--surface-2)",
              }}>
                {Math.round((row.widths[colIdx] / totalW) * 100)}%
              </div>
            )}
            {cell.type === "block" ? (
              <BlockCell blockId={cell.blockId} parentDirection="h" {...props} />
            ) : depth < MAX_DEPTH ? (
              <BlockLayoutRenderer {...props} row={cell.row} depth={depth + 1} />
            ) : null}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Vertical stack (flex column, natural heights, no resize) ──────────

function VerticalStack(props: BlockLayoutRendererProps & { depth: number }) {
  const { row, depth, dropTarget, dragBlockId } = props;

  return (
    <div
      data-layout-row={row.id}
      style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}
    >
      {row.columns.map((cell, cellIdx) => (
        <React.Fragment key={cellKey(cell, cellIdx)}>
          {cell.type === "block" ? (
            <BlockCell blockId={cell.blockId} parentDirection="v" {...props} />
          ) : depth < MAX_DEPTH ? (
            <BlockLayoutRenderer {...props} row={cell.row} depth={depth + 1} />
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Block Cell (leaf) ─────────────────────────────────────────────────

function BlockCell({
  blockId,
  parentDirection,
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
}: BlockLayoutRendererProps & { blockId: string; parentDirection: "h" | "v" }) {
  const block = blocks.find((b) => b.id === blockId);
  if (!block) return null;

  const dt = dropTarget;
  const isTarget = dt?.type === "layout-side" && dt.targetBlockId === block.id;

  // "h" parent: top/bottom indicators (for nesting vertically into this column)
  // "v" parent: top/bottom indicators (for sibling insertion in vertical stack)
  //           + left/right indicators (for nesting horizontally)
  const showTop = isTarget && dt.side === "top";
  const showBottom = isTarget && dt.side === "bottom";
  const showLeft = isTarget && parentDirection === "v" && dt.side === "left";
  const showRight = isTarget && parentDirection === "v" && dt.side === "right";

  return (
    <div style={{ position: "relative", minWidth: 0, minHeight: 0 }}>
      {showTop && (
        <div style={{
          position: "absolute", left: 0, right: 0, top: -1, height: 2,
          background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none",
        }} />
      )}
      {showBottom && (
        <div style={{
          position: "absolute", left: 0, right: 0, bottom: -1, height: 2,
          background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none",
        }} />
      )}
      {showLeft && (
        <div style={{
          position: "absolute", top: 0, bottom: 0, left: -1, width: 2,
          background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none",
        }} />
      )}
      {showRight && (
        <div style={{
          position: "absolute", top: 0, bottom: 0, right: -1, width: 2,
          background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none",
        }} />
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

// ─── Resize Handle (horizontal only) ───────────────────────────────────

interface ResizeHandleProps {
  rowId: string;
  dividerIndex: number;
  direction: "h" | "v";
  onResizeStart: (rowId: string, dividerIndex: number, e: React.PointerEvent) => void;
  isResizing: boolean;
}

function ResizeHandle({ rowId, dividerIndex, direction, onResizeStart, isResizing }: ResizeHandleProps) {
  const barRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onResizeStart(rowId, dividerIndex, e);
    },
    [rowId, dividerIndex, onResizeStart],
  );

  return (
    <div
      data-resize-handle={`${rowId}:${dividerIndex}`}
      style={{
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
      }}
      onPointerDown={handlePointerDown}
      onPointerEnter={() => { if (barRef.current) barRef.current.style.opacity = "1"; }}
      onPointerLeave={() => { if (!isResizing && barRef.current) barRef.current.style.opacity = "0"; }}
    >
      <div
        ref={barRef}
        style={{
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
        }}
      />
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function cellKey(cell: ColumnCell, idx: number): string {
  return cell.type === "block" ? cell.blockId : `nested_${cell.row.id}_${idx}`;
}
