/**
 * BlockShell —— 每个 block 的外壳:
 *   - 邻接圆角(top/right/bottom/left = "page" → 直边 / "neighbor" → 圆角)
 *   - close 按钮通过 BlockShellProvider 暴露给内部 artifact/chat 的 topbar 渲染,
 *     视觉与其他 topbar 按钮一致(不再外挂 absolute 按钮)
 *   - 移动条(底部 hover 显现)—— 拖动时:
 *       · 在 document.body 创建 ghost,大小 = 当前 block bounding rect
 *       · 用 transform translate 跟随鼠标(不是 left/top,避免布局抖动)
 *       · 仅在 pointerup 时确定落点 → 一次性 swap(避免拖动中反复 swap "颠簸")
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AdjacencyEdges } from "../../canvas/types";
import { useCanvas } from "../../contexts/canvasContext";
import { computeRects } from "../../canvas/layoutAlgorithms";
import { BlockShellProvider } from "../../contexts/blockShellContext";

interface Props {
  blockId: string;
  edges: AdjacencyEdges;
  visibleCount: number;
  children: React.ReactNode;
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
}

export default function BlockShell({
  blockId,
  edges,
  visibleCount,
  children,
  canvasContainerRef,
}: Props) {
  const {
    stateRef,
    removeBlock,
    moveBlock,
    moveBlockToEdge,
    scheduleSave,
    setDragging,
    setDragSourceId,
    setDropTarget,
  } = useCanvas();
  const shellRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const dragStartRef = useRef<{ pointerX: number; pointerY: number; ghostX: number; ghostY: number } | null>(null);

  // 圆角规则:"若 corner 的另外三个 90 度方向都有其它内容(block 或 topbar),
  //              则圆角;若任一方向是真窗口外缘,则直角"
  // 关键:topbar 不是窗口外缘,所以 top edge=page 在我们布局里总是贴 topbar,
  //        视为"有内容"(soft edge)。仅 right/bottom/left 的 page 才是真 viewport
  //        外缘(true outer)→ 此方向无内容。
  // 简化推导:
  //   - 顶部 corner(tl/tr):top edge 永远 soft(topbar 或 block),
  //                          仅看 left/right 是不是 neighbor。
  //   - 底部 corner(bl/br):bottom 必须是 neighbor(否则贴 viewport),
  //                          且 left/right 是 neighbor。
  // 对角方向那一格在两边都"有内容"时也必有内容(canvas 完全被 leaf 平铺)。
  const radius = "10px";
  const tl = edges.left === "neighbor" ? radius : "0";
  const tr = edges.right === "neighbor" ? radius : "0";
  const bl = edges.bottom === "neighbor" && edges.left === "neighbor" ? radius : "0";
  const br = edges.bottom === "neighbor" && edges.right === "neighbor" ? radius : "0";

  const onClose = useCallback(() => removeBlock(blockId), [blockId, removeBlock]);
  const shellCtx = useMemo(
    () => ({ canClose: visibleCount > 1, onClose }),
    [visibleCount, onClose],
  );

  // ─── Drag 系统(参考 Linear / Figma / Mosaic 的拖拽 UX) ───
  // 1. mousedown 起 ghost,布局 unchanged
  // 2. pointermove 仅更新 ghost 位置 + 计算落位目标(target block + side),
  //    通过 setDropTarget 推到 context,由 MagicCanvas 渲染高亮 indicator
  // 3. pointerup release 才执行 moveBlock(source → target side),否则取消
  const tearDownDrag = useCallback(() => {
    draggingRef.current = false;
    setDragging(false);
    setDragSourceId(null);
    setDropTarget(null);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (ghostRef.current) {
      ghostRef.current.remove();
      ghostRef.current = null;
    }
    dragStartRef.current = null;
  }, [setDragging, setDragSourceId, setDropTarget]);

  useEffect(() => {
    return () => tearDownDrag();
  }, [tearDownDrag]);

  /** 计算 pointer 落点
   *   - 如果靠近 canvas 外缘(< EDGE_BAND px),返回 edge target
   *   - 否则在哪个 block 内部,按 4 边距离决定 side / center
   */
  const computeDropTarget = useCallback(
    (px: number, py: number):
      | { kind: "block"; blockId: string; side: "top" | "right" | "bottom" | "left" | "center" }
      | { kind: "edge"; edge: "top" | "right" | "bottom" | "left" }
      | null => {
      const cont = canvasContainerRef.current;
      const layout = stateRef.current.layout;
      if (!cont || !layout) return null;
      const cr = cont.getBoundingClientRect();

      // 1) Canvas 外缘 drop band (顶/右/底/左 各 ~36px)
      const EDGE_BAND = 36;
      // 必须 pointer 落在 canvas 内才考虑 edge(防止漂在 topbar 上误触发)
      if (px >= cr.left && px <= cr.right && py >= cr.top && py <= cr.bottom) {
        const dTopCanvas = py - cr.top;
        const dBottomCanvas = cr.bottom - py;
        const dLeftCanvas = px - cr.left;
        const dRightCanvas = cr.right - px;
        const minEdge = Math.min(dTopCanvas, dBottomCanvas, dLeftCanvas, dRightCanvas);
        if (minEdge < EDGE_BAND) {
          if (minEdge === dTopCanvas) return { kind: "edge", edge: "top" };
          if (minEdge === dBottomCanvas) return { kind: "edge", edge: "bottom" };
          if (minEdge === dLeftCanvas) return { kind: "edge", edge: "left" };
          return { kind: "edge", edge: "right" };
        }
      }

      // 2) 落在某个 block 的内部 —— 算到该 block 4 边的距离
      const rects = computeRects(layout, cr.width, cr.height, cr.left, cr.top);
      for (const [id, r] of Object.entries(rects)) {
        if (id === blockId) continue;
        if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) continue;
        const dTop = py - r.y;
        const dBottom = r.y + r.h - py;
        const dLeft = px - r.x;
        const dRight = r.x + r.w - px;
        const minDist = Math.min(dTop, dBottom, dLeft, dRight);
        const centerThreshold = Math.min(r.w, r.h) * 0.25;
        if (minDist > centerThreshold) return { kind: "block", blockId: id, side: "center" };
        if (minDist === dTop) return { kind: "block", blockId: id, side: "top" };
        if (minDist === dBottom) return { kind: "block", blockId: id, side: "bottom" };
        if (minDist === dLeft) return { kind: "block", blockId: id, side: "left" };
        return { kind: "block", blockId: id, side: "right" };
      }
      return null;
    },
    [canvasContainerRef, stateRef, blockId],
  );

  const handleMoveBarDown = useCallback(
    (e: React.PointerEvent) => {
      if (visibleCount <= 1) return;
      e.preventDefault();
      const shell = shellRef.current;
      if (!shell) return;
      const rect = shell.getBoundingClientRect();

      const ghost = document.createElement("div");
      ghost.className = "mc-drag-ghost";
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      const initX = rect.left;
      const initY = rect.top;
      ghost.style.transform = `translate(${initX}px, ${initY}px)`;
      document.body.appendChild(ghost);
      ghostRef.current = ghost;

      dragStartRef.current = { pointerX: e.clientX, pointerY: e.clientY, ghostX: initX, ghostY: initY };
      draggingRef.current = true;
      setDragging(true);
      setDragSourceId(blockId);
      setDropTarget(null);
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        const start = dragStartRef.current;
        if (!start || !ghostRef.current) return;
        const dx = ev.clientX - start.pointerX;
        const dy = ev.clientY - start.pointerY;
        ghostRef.current.style.transform = `translate(${start.ghostX + dx}px, ${start.ghostY + dy}px)`;

        // 仅更新 dropTarget,布局不变
        const t = computeDropTarget(ev.clientX, ev.clientY);
        setDropTarget(t);
      };

      const onUp = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        // 落位 —— 仅在 release 时改 layout
        const t = computeDropTarget(ev.clientX, ev.clientY);
        if (t) {
          if (t.kind === "edge") {
            // 拖到 canvas 外缘:全宽/全高 block 贴边
            moveBlockToEdge(blockId, t.edge);
          } else {
            // 落在某 block 的某边:保持 source 原 size
            const cont = canvasContainerRef.current;
            const layout = stateRef.current.layout;
            let preserveRatio: { sourceW: number; sourceH: number; targetW: number; targetH: number } | undefined;
            if (cont && layout) {
              const cr = cont.getBoundingClientRect();
              const rects = computeRects(layout, cr.width, cr.height, cr.left, cr.top);
              const sr = rects[blockId];
              const tr = rects[t.blockId];
              if (sr && tr) {
                preserveRatio = { sourceW: sr.w, sourceH: sr.h, targetW: tr.w, targetH: tr.h };
              }
            }
            moveBlock(blockId, t.blockId, t.side, preserveRatio);
          }
          scheduleSave();
        }
        tearDownDrag();
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [visibleCount, blockId, computeDropTarget, moveBlock, scheduleSave, tearDownDrag, setDragging, setDragSourceId, setDropTarget],
  );

  // 边框规则:仅当边贴"窗口外缘"(viewport 真外缘)时才隐藏 border。
  // 关键技巧:不用 border:none(会让该侧 width=0 → 与 1px 邻边在圆角处不连续,
  // 视觉上"模糊"),而是用 1px solid transparent 占位 —— 4 条边宽度一致,
  // 圆角弧线连续平滑。
  const borderTopWanted = true;            // top 永远显示(topbar 不是窗口边)
  const borderRightWanted = edges.right !== "page";
  const borderBottomWanted = edges.bottom !== "page";
  const borderLeftWanted = edges.left !== "page";
  const borderTop = borderTopWanted ? "1px solid var(--border-default)" : "1px solid transparent";
  const borderRight = borderRightWanted ? "1px solid var(--border-default)" : "1px solid transparent";
  const borderBottom = borderBottomWanted ? "1px solid var(--border-default)" : "1px solid transparent";
  const borderLeft = borderLeftWanted ? "1px solid var(--border-default)" : "1px solid transparent";

  return (
    <div
      ref={shellRef}
      className="mc-block-shell"
      style={{
        borderTopLeftRadius: tl,
        borderTopRightRadius: tr,
        borderBottomLeftRadius: bl,
        borderBottomRightRadius: br,
        borderTop,
        borderRight,
        borderBottom,
        borderLeft,
      }}
    >
      <BlockShellProvider value={shellCtx}>
        <div className="mc-block-body">{children}</div>
      </BlockShellProvider>
      {visibleCount > 1 && (
        <div className="mc-block-movebar-zone" onPointerDown={handleMoveBarDown}>
          <div className="mc-block-movebar" />
        </div>
      )}
    </div>
  );
}
