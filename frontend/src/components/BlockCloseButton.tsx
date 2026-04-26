/**
 * BlockCloseButton —— 各 artifact / chat topbar 末尾渲染。BlockShell 没 mount 时
 * (例如非 magic canvas 的独立页面)自动 noop。BlockShell 内但 canClose=false
 * (只剩 1 个 block)也不渲染。
 *
 * 视觉对齐 artifact topbar 的图标按钮规格:28×28 hover 热区, 14×14 svg, radius-s,
 * hover bg = surface-3 + text-primary。与其他 topbar icon 一致。
 */

import { useBlockShell } from "../contexts/blockShellContext";

export default function BlockCloseButton() {
  const ctx = useBlockShell();
  if (!ctx || !ctx.canClose) return null;
  return (
    <button
      type="button"
      className="block-close-btn"
      onClick={ctx.onClose}
      title="关闭此 block"
      aria-label="关闭此 block"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  );
}
