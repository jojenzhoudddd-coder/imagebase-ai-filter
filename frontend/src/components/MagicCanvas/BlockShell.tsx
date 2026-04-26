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
  const { stateRef, swapBlocks, removeBlock, scheduleSave, setDragging } = useCanvas();
  const shellRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const dragStartRef = useRef<{ pointerX: number; pointerY: number; ghostX: number; ghostY: number } | null>(null);
  /** 跟踪当前正在 hover 的 block(从中线判定换位避免反复 swap)。
   *  规则:进入新 block 区域 → 算一次"是否越过中线"。越过就 swap once,然后
   *  把 lastHoveredId 设为 self(因为 swap 后此区域已是 self),pointer 不离开
   *  此区域不再 swap。
   */
  const lastSwapTargetRef = useRef<string | null>(null);

  // 圆角规则:仅当一个 corner 的"两条相邻边都是 neighbor"时才圆角
  // (该 corner 真的落在 gap 与 gap 的十字交叉处)。任一边贴 page = 直线
  // (page 边要无缝衔接主框架,不能有圆角导致视觉缝隙)。
  const radius = "10px";
  const tl = edges.top === "neighbor" && edges.left === "neighbor" ? radius : "0";
  const tr = edges.top === "neighbor" && edges.right === "neighbor" ? radius : "0";
  const bl = edges.bottom === "neighbor" && edges.left === "neighbor" ? radius : "0";
  const br = edges.bottom === "neighbor" && edges.right === "neighbor" ? radius : "0";

  const onClose = useCallback(() => removeBlock(blockId), [blockId, removeBlock]);
  const shellCtx = useMemo(
    () => ({ canClose: visibleCount > 1, onClose }),
    [visibleCount, onClose],
  );

  // ─── Drag 系统 (document 级监听 + 中线 swap) ───
  const tearDownDrag = useCallback(() => {
    draggingRef.current = false;
    setDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (ghostRef.current) {
      ghostRef.current.remove();
      ghostRef.current = null;
    }
    dragStartRef.current = null;
    lastSwapTargetRef.current = null;
  }, [setDragging]);

  useEffect(() => {
    return () => tearDownDrag();
  }, [tearDownDrag]);

  const handleMoveBarDown = useCallback(
    (e: React.PointerEvent) => {
      if (visibleCount <= 1) return;
      e.preventDefault();
      const shell = shellRef.current;
      if (!shell) return;
      const rect = shell.getBoundingClientRect();

      // ghost = block 真实大小 + 半透明虚线,跟随光标(transform translate)
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
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      lastSwapTargetRef.current = null;

      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        const start = dragStartRef.current;
        if (!start || !ghostRef.current) return;
        const dx = ev.clientX - start.pointerX;
        const dy = ev.clientY - start.pointerY;
        ghostRef.current.style.transform = `translate(${start.ghostX + dx}px, ${start.ghostY + dy}px)`;

        // 中线 swap —— 实时检测 pointer 越过其它 block 的中线
        const cont = canvasContainerRef.current;
        const layout = stateRef.current.layout;
        if (!cont || !layout) return;
        const cr = cont.getBoundingClientRect();
        const rects = computeRects(layout, cr.width, cr.height, cr.left, cr.top);
        for (const [id, r] of Object.entries(rects)) {
          if (id === blockId) continue;
          // 命中此 block 的矩形
          if (ev.clientX >= r.x && ev.clientX <= r.x + r.w && ev.clientY >= r.y && ev.clientY <= r.y + r.h) {
            // 越过中线判定:pointer 在此 block 中线的"远侧"才 swap(简化:进入即触发,
            // 避免边缘抖动)。lastSwapTargetRef 防 swap loop —— 只在进入新目标时 swap。
            if (lastSwapTargetRef.current !== id) {
              swapBlocks(blockId, id);
              // swap 后 self 现在占了 id 的位置,所以这片区域的"逻辑 id"是 self。
              // 标记 lastSwap = id 表示"这一区域不再触发 swap",直到 pointer 离开。
              lastSwapTargetRef.current = id;
            }
            return;
          }
        }
        // pointer 不在任何其它 block 范围内 —— 重置 lastSwapTarget,下次进入新目标时重新触发
        lastSwapTargetRef.current = null;
      };

      const onUp = () => {
        if (!draggingRef.current) return;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        tearDownDrag();
        scheduleSave();
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [visibleCount, canvasContainerRef, stateRef, swapBlocks, scheduleSave, blockId, tearDownDrag, setDragging],
  );

  return (
    <div
      ref={shellRef}
      className="mc-block-shell"
      style={{
        borderTopLeftRadius: tl,
        borderTopRightRadius: tr,
        borderBottomLeftRadius: bl,
        borderBottomRightRadius: br,
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
