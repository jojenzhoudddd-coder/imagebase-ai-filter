/**
 * DropIndicator —— 拖拽期间的"落位预览"高亮。
 * 根据 dropTarget.side 渲染:
 *   - top/bottom/left/right: 在目标 block 该侧画一条 50% 半区的高亮覆盖,
 *     提示"松手后 source block 会出现在这一侧"
 *   - center: 整块高亮(swap 语义)
 * 容器是 .mc-canvas(position: relative),所以坐标用相对 canvas 的 (x,y)。
 */

import type { DropSide } from "../../canvas/layoutAlgorithms";

interface Props {
  rect: { x: number; y: number; w: number; h: number }; // canvas 内坐标
  side: DropSide;
}

export default function DropIndicator({ rect, side }: Props) {
  let style: React.CSSProperties;
  switch (side) {
    case "top":
      style = { left: rect.x, top: rect.y, width: rect.w, height: rect.h / 2 };
      break;
    case "bottom":
      style = { left: rect.x, top: rect.y + rect.h / 2, width: rect.w, height: rect.h / 2 };
      break;
    case "left":
      style = { left: rect.x, top: rect.y, width: rect.w / 2, height: rect.h };
      break;
    case "right":
      style = { left: rect.x + rect.w / 2, top: rect.y, width: rect.w / 2, height: rect.h };
      break;
    case "center":
    default:
      style = { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
      break;
  }
  return <div className={`mc-drop-indicator mc-drop-indicator-${side}`} style={style} />;
}
