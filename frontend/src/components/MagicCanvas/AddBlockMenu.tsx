/**
 * AddBlockMenu —— TopBar `+` 按钮点击后的下拉菜单。
 * 选项:Chat / Artifact / System(disabled)。
 */

import { useEffect, useRef, useState } from "react";
import { useCanvas, MAX_BLOCKS } from "../../contexts/canvasContext";

export default function AddBlockMenu({ anchorRef }: { anchorRef: React.RefObject<HTMLElement | null> }) {
  const { addBlock, visibleBlockIds } = useCanvas();
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, anchorRef]);

  const reachedMax = visibleBlockIds.length >= MAX_BLOCKS;

  // 暴露 toggle 给父组件 —— 通过 imperative handle 太重,改成 anchor 上挂事件
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const onClick = () => setOpen((v) => !v);
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [anchorRef]);

  if (!open) return null;

  const anchor = anchorRef.current;
  const rect = anchor?.getBoundingClientRect();
  const top = rect ? rect.bottom + 4 : 60;
  const left = rect ? Math.max(8, rect.right - 180) : 60;

  return (
    <div
      ref={popRef}
      className="mc-add-block-menu"
      style={{ position: "fixed", top, left }}
    >
      <button
        className="mc-add-block-item"
        disabled={reachedMax}
        onClick={() => {
          addBlock("chat");
          setOpen(false);
        }}
      >
        <SparkleIcon />
        <span>Chat</span>
      </button>
      <button
        className="mc-add-block-item"
        disabled={reachedMax}
        onClick={() => {
          addBlock("artifact");
          setOpen(false);
        }}
      >
        <ArtifactIcon />
        <span>Artifact</span>
      </button>
      <button className="mc-add-block-item mc-add-block-item-disabled" disabled title="敬请期待">
        <SystemIcon />
        <span>System</span>
        <span className="mc-add-block-item-soon">soon</span>
      </button>
      {reachedMax && (
        <div className="mc-add-block-foot">已达上限 {MAX_BLOCKS} 个 block</div>
      )}
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5l1.5 4.5h4.5l-3.6 2.7 1.4 4.4-3.8-2.8-3.8 2.8 1.4-4.4-3.6-2.7h4.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
function ArtifactIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 6h12M6 2v12" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M13 8a5 5 0 01-.1 1l1.3 1-1 1.7-1.5-.4a5 5 0 01-1.8 1L9.5 14h-3l-.4-1.7a5 5 0 01-1.8-1L2.8 11.7 1.8 10l1.3-1a5 5 0 01-.1-1 5 5 0 01.1-1L1.8 6 2.8 4.3l1.5.4a5 5 0 011.8-1L6.5 2h3l.4 1.7a5 5 0 011.8 1l1.5-.4 1 1.7-1.3 1a5 5 0 01.1 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
