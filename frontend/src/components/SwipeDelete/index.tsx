import { useRef, useState, useCallback, useEffect, ReactNode } from "react";
import "./SwipeDelete.css";

interface SwipeDeleteProps {
  label: string;
  onDelete: () => void;
  icon?: ReactNode;
  disabled?: boolean;
}

// icon_delete-trash_outlined
const TRASH_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M8 4C8 2.89543 8.89543 2 10 2H14C15.1046 2 16 2.89543 16 4H21C21.5523 4 22 4.44772 22 5C22 5.55228 21.5523 6 21 6H20C20 10.6667 20 15.3333 20 20C20 21.1046 19.1046 22 18 22H6C4.89543 22 4 21.1046 4 20C4 15.3333 4 10.6667 4 6H3C2.44772 6 2 5.55228 2 5C2 4.44772 2.44772 4 3 4H8ZM6 6V20H18V6H6ZM10 9C10.5523 9 11 9.44772 11 10V16C11 16.5523 10.5523 17 10 17C9.44772 17 9 16.5523 9 16V10C9 9.44772 9.44772 9 10 9ZM14 9C14.5523 9 15 9.44772 15 10V16C15 16.5523 14.5523 17 14 17C13.4477 17 13 16.5523 13 16V10C13 9.44772 13.4477 9 14 9Z" fill="currentColor"/>
  </svg>
);

const CHECK_ICON = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path
      d="M3 7.5l3 3 5-6"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default function SwipeDelete({ label, onDelete, icon, disabled }: SwipeDeleteProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [spring, setSpring] = useState(false);
  const [done, setDone] = useState(false);
  const startXRef = useRef(0);
  const maxOffsetRef = useRef(0);

  const THUMB_START = 5; // px from left edge, aligns icon with menu item icons
  const getMaxOffset = useCallback(() => {
    if (!trackRef.current) return 0;
    return trackRef.current.clientWidth - 28 - THUMB_START - 5;
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (disabled || done) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    startXRef.current = e.clientX;
    maxOffsetRef.current = getMaxOffset();
    setDragging(true);
    setSpring(false);
  }, [disabled, done, getMaxOffset]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    e.stopPropagation();
    const dx = e.clientX - startXRef.current;
    const clamped = Math.max(0, Math.min(dx, maxOffsetRef.current));
    setOffset(clamped);
  }, [dragging]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    e.stopPropagation();
    setDragging(false);

    const threshold = maxOffsetRef.current * 0.9;
    if (offset >= threshold) {
      // Snap to end and fire
      setOffset(maxOffsetRef.current);
      setDone(true);
      setTimeout(() => {
        onDelete();
      }, 300);
    } else {
      // Spring back
      setSpring(true);
      setOffset(0);
      setTimeout(() => setSpring(false), 260);
    }
  }, [dragging, offset, onDelete]);

  // Reset when disabled changes
  useEffect(() => {
    if (disabled) {
      setOffset(0);
      setDone(false);
    }
  }, [disabled]);

  const progress = maxOffsetRef.current > 0 ? offset / maxOffsetRef.current : 0;

  return (
    <div
      ref={trackRef}
      className={`swipe-del-root${spring ? " swipe-del-spring" : ""}${disabled ? " swipe-del-disabled" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Fill gradient */}
      <div
        className="swipe-del-fill"
        style={{ width: `${progress * 100}%` }}
      />
      {/* Label */}
      <span className="swipe-del-label">{label}</span>
      {/* Draggable thumb */}
      <div
        className={`swipe-del-thumb${done ? " swipe-del-done" : ""}`}
        style={{ left: offset + THUMB_START }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {done ? CHECK_ICON : (icon || TRASH_ICON)}
      </div>
    </div>
  );
}

export type { SwipeDeleteProps };
