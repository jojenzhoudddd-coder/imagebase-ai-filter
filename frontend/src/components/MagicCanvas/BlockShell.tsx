/**
 * BlockShell —— 每个 block 的外壳:
 *   - 邻接圆角(top/right/bottom/left = "page" → 直边 / "neighbor" → 圆角)
 *   - 关闭按钮(右上角,仅 >1 block 时显示)
 *   - 移动条(底部 hover 显现) —— 拖动触发 swap-on-midline-cross
 *   - hover 半透明边框,无负担
 */

import { useCallback, useRef } from "react";
import type { AdjacencyEdges } from "../../canvas/types";
import { useCanvas } from "../../contexts/canvasContext";
import { computeRects } from "../../canvas/layoutAlgorithms";

interface Props {
  blockId: string;
  edges: AdjacencyEdges;
  visibleCount: number;
  children: React.ReactNode;
  /** 容器 element ref(用于拖拽时计算其它 block 的 rect) */
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
}

export default function BlockShell({ blockId, edges, visibleCount, children, canvasContainerRef }: Props) {
  const { state, swapBlocks, removeBlock, scheduleSave } = useCanvas();
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const radius = "10px";
  const tl = edges.top === "neighbor" || edges.left === "neighbor" ? radius : "0";
  const tr = edges.top === "neighbor" || edges.right === "neighbor" ? radius : "0";
  const bl = edges.bottom === "neighbor" || edges.left === "neighbor" ? radius : "0";
  const br = edges.bottom === "neighbor" || edges.right === "neighbor" ? radius : "0";

  const onMoveBarPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (visibleCount <= 1) return;
      e.preventDefault();
      draggingRef.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      document.body.style.cursor = "grabbing";

      // 创建 ghost
      const ghost = document.createElement("div");
      ghost.className = "mc-drag-ghost";
      ghost.style.left = `${e.clientX - 60}px`;
      ghost.style.top = `${e.clientY - 20}px`;
      document.body.appendChild(ghost);
      dragGhostRef.current = ghost;
    },
    [visibleCount],
  );

  const onMoveBarPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      const ghost = dragGhostRef.current;
      if (ghost) {
        ghost.style.left = `${e.clientX - 60}px`;
        ghost.style.top = `${e.clientY - 20}px`;
      }
      // 实时检测落点 → 越过其他 block 中轴线就 swap
      const cont = canvasContainerRef.current;
      if (!cont || !state.layout) return;
      const rect = cont.getBoundingClientRect();
      const rects = computeRects(state.layout, rect.width, rect.height, rect.left, rect.top);
      const px = e.clientX;
      const py = e.clientY;
      for (const [id, r] of Object.entries(rects)) {
        if (id === blockId) continue;
        if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
          // 在中轴线哪一侧?对 h-split 看 X 轴中线;对 v-split 看 Y 轴中线
          // 简化:任何越过即触发(只 swap 一次,然后 dragging 期间忽略 — 通过
          // ref 标记防抖)
          swapBlocks(blockId, id);
          // 防止持续触发 swap loop:swap 后让光标已经在原 block 范围内
          break;
        }
      }
    },
    [blockId, state.layout, canvasContainerRef, swapBlocks],
  );

  const onMoveBarPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      document.body.style.cursor = "";
      const ghost = dragGhostRef.current;
      if (ghost) {
        ghost.remove();
        dragGhostRef.current = null;
      }
      scheduleSave();
    },
    [scheduleSave],
  );

  const onClose = useCallback(() => {
    removeBlock(blockId);
  }, [blockId, removeBlock]);

  const showClose = visibleCount > 1;

  return (
    <div
      className="mc-block-shell"
      style={{ borderTopLeftRadius: tl, borderTopRightRadius: tr, borderBottomLeftRadius: bl, borderBottomRightRadius: br }}
    >
      {showClose && (
        <button className="mc-block-close" onClick={onClose} title="关闭" aria-label="关闭">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
      <div className="mc-block-body">{children}</div>
      {visibleCount > 1 && (
        <div
          className="mc-block-movebar-zone"
          onPointerDown={onMoveBarPointerDown}
          onPointerMove={onMoveBarPointerMove}
          onPointerUp={onMoveBarPointerUp}
          onPointerCancel={onMoveBarPointerUp}
        >
          <div className="mc-block-movebar" />
        </div>
      )}
    </div>
  );
}
