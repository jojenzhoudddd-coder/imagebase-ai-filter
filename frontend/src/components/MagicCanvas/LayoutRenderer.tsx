/**
 * LayoutRenderer —— 递归把 LayoutNode 渲染成嵌套 flex 布局。
 * 中间节点 = split,带可拖拽分隔线;叶子 = 委托给 renderLeaf 渲染具体 block。
 *
 * Resize 实现:鼠标按下分隔线 → mousemove 时按容器 width/height 反算 ratio →
 * Context.setRatioByPath 更新树。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { LayoutNode } from "../../canvas/types";
import { useCanvas } from "../../contexts/canvasContext";

interface Props {
  node: LayoutNode;
  path?: ("L" | "R")[];
  renderLeaf: (blockId: string) => React.ReactNode;
}

export default function LayoutRenderer({ node, path = [], renderLeaf }: Props) {
  if (node.kind === "leaf") {
    return <>{renderLeaf(node.blockId)}</>;
  }

  return <SplitNode node={node} path={path} renderLeaf={renderLeaf} />;
}

function SplitNode({
  node,
  path,
  renderLeaf,
}: {
  node: Extract<LayoutNode, { kind: "split" }>;
  path: ("L" | "R")[];
  renderLeaf: (blockId: string) => React.ReactNode;
}) {
  const { setRatioByPath } = useCanvas();
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const orientation = node.orientation;
  const dirStyle = orientation === "h" ? { flexDirection: "row" as const } : { flexDirection: "column" as const };
  const dividerCls = orientation === "h" ? "mc-divider mc-divider-h" : "mc-divider mc-divider-v";

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ratio =
        orientation === "h"
          ? (e.clientX - rect.left) / rect.width
          : (e.clientY - rect.top) / rect.height;
      setRatioByPath(path, Math.max(0.15, Math.min(0.85, ratio)));
    },
    [dragging, orientation, path, setRatioByPath],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    setDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  }, []);

  // 用 CSS grid 而非 flex 做精确分配。grid-template 用 fr 单位 + 显式 6px
  // divider 槽位,父级 100% 空间 = ratio*fr + 6px + (1-ratio)*fr,数学上无溢出。
  // 之前用 flex `${ratio*100}% 0 0` 会让 2 块 50% 总和 + 6px divider = 106% 溢出,
  // 容器 overflow:hidden 把右下角 block 切掉 ~6-12px。
  const gridStyle: React.CSSProperties = orientation === "h"
    ? { display: "grid", gridTemplateColumns: `${node.ratio}fr 6px ${1 - node.ratio}fr`, gridTemplateRows: "100%" }
    : { display: "grid", gridTemplateRows: `${node.ratio}fr 6px ${1 - node.ratio}fr`, gridTemplateColumns: "100%" };

  return (
    <div ref={containerRef} className="mc-split" style={gridStyle}>
      <div className="mc-pane" style={{ minWidth: 0, minHeight: 0 }}>
        <LayoutRenderer node={node.first} path={[...path, "L"]} renderLeaf={renderLeaf} />
      </div>
      <div
        className={dividerCls + (dragging ? " mc-divider-dragging" : "")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="mc-pane" style={{ minWidth: 0, minHeight: 0 }}>
        <LayoutRenderer node={node.second} path={[...path, "R"]} renderLeaf={renderLeaf} />
      </div>
    </div>
  );
}
