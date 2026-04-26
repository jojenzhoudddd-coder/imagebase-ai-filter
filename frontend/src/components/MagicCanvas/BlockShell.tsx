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
  const { state, swapBlocks, removeBlock, scheduleSave } = useCanvas();
  const shellRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const dragStartRef = useRef<{ pointerX: number; pointerY: number; ghostX: number; ghostY: number } | null>(null);

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

  // ─── Drag 系统 (用 document 级监听,避免 pointer 离开 movebar 后丢事件) ───
  const tearDownDrag = useCallback(() => {
    draggingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (ghostRef.current) {
      ghostRef.current.remove();
      ghostRef.current = null;
    }
    dragStartRef.current = null;
  }, []);

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

      // 创建 ghost —— 大小等于当前 block,半透明 + 虚线边
      const ghost = document.createElement("div");
      ghost.className = "mc-drag-ghost";
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      // 初始位置 = block 当前位置(translate 体系)
      const initX = rect.left;
      const initY = rect.top;
      ghost.style.transform = `translate(${initX}px, ${initY}px)`;
      document.body.appendChild(ghost);
      ghostRef.current = ghost;

      dragStartRef.current = { pointerX: e.clientX, pointerY: e.clientY, ghostX: initX, ghostY: initY };
      draggingRef.current = true;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        const start = dragStartRef.current;
        if (!start || !ghostRef.current) return;
        const dx = ev.clientX - start.pointerX;
        const dy = ev.clientY - start.pointerY;
        ghostRef.current.style.transform = `translate(${start.ghostX + dx}px, ${start.ghostY + dy}px)`;
      };

      const onUp = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        // 落点判定:用 pointer 当前位置查 layout rects,落在哪个 leaf 就 swap 那一个
        const cont = canvasContainerRef.current;
        if (cont && state.layout) {
          const cr = cont.getBoundingClientRect();
          const rects = computeRects(state.layout, cr.width, cr.height, cr.left, cr.top);
          for (const [id, r] of Object.entries(rects)) {
            if (id === blockId) continue;
            if (ev.clientX >= r.x && ev.clientX <= r.x + r.w && ev.clientY >= r.y && ev.clientY <= r.y + r.h) {
              swapBlocks(blockId, id);
              break;
            }
          }
        }
        tearDownDrag();
        scheduleSave();
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [visibleCount, canvasContainerRef, state.layout, swapBlocks, scheduleSave, blockId, tearDownDrag],
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
