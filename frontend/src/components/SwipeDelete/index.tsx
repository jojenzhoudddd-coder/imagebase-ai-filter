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

// icon_delete-trash_filled — shown when swipe completes
const DONE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M10 2C8.89543 2 8 2.89543 8 4H3C2.44772 4 2 4.44772 2 5C2 5.55228 2.44772 6 3 6H4V20C4 21.1046 4.89543 22 6 22H18C19.1046 22 20 21.1046 20 20V6H21C21.5523 6 22 5.55228 22 5C22 4.44772 21.5523 4 21 4H16C16 2.89543 15.1046 2 14 2H10ZM9.5 9C10.0523 9 10.5 9.44772 10.5 10V16C10.5 16.5523 10.0523 17 9.5 17C8.94772 17 8.5 16.5523 8.5 16V10C8.5 9.44772 8.94772 9 9.5 9ZM14.5 9C15.0523 9 15.5 9.44772 15.5 10V16C15.5 16.5523 15.0523 17 14.5 17C13.9477 17 13.5 16.5523 13.5 16V10C13.5 9.44772 13.9477 9 14.5 9Z" fill="currentColor"/>
  </svg>
);

const THUMB_START = 1;
const THUMB_WIDTH = 36;
const CLICK_STEP = 20;

export default function SwipeDelete({ label, onDelete, icon, disabled }: SwipeDeleteProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [done, setDone] = useState(false);
  const startXRef = useRef(0);
  const startOffsetRef = useRef(0);
  const maxOffsetRef = useRef(0);
  const movedRef = useRef(false);

  const getMaxOffset = useCallback(() => {
    if (!trackRef.current) return 0;
    return trackRef.current.clientWidth - THUMB_WIDTH - THUMB_START - 1;
  }, []);

  // Complete deletion
  const triggerDelete = useCallback((max: number) => {
    setOffset(max);
    setDone(true);
    setTimeout(() => onDelete(), 300);
  }, [onDelete]);

  // Click to advance 20px
  const handleClick = useCallback(() => {
    if (disabled || done || dragging) return;
    const max = getMaxOffset();
    if (max <= 0) return;
    const next = offset + CLICK_STEP;
    if (next >= max * 0.9) {
      setAnimating(true);
      triggerDelete(max);
    } else {
      setAnimating(true);
      setOffset(next);
      setTimeout(() => setAnimating(false), 250);
    }
  }, [disabled, done, dragging, offset, getMaxOffset, triggerDelete]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (disabled || done) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    startXRef.current = e.clientX;
    startOffsetRef.current = offset;
    maxOffsetRef.current = getMaxOffset();
    movedRef.current = false;
    setDragging(true);
    setAnimating(false);
  }, [disabled, done, getMaxOffset, offset]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    e.stopPropagation();
    const dx = e.clientX - startXRef.current;
    if (Math.abs(dx) > 3) movedRef.current = true;
    const clamped = Math.max(0, Math.min(startOffsetRef.current + dx, maxOffsetRef.current));
    setOffset(clamped);
  }, [dragging]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    e.stopPropagation();
    setDragging(false);

    // Click on thumb (no drag) → advance by step
    if (!movedRef.current) {
      handleClick();
      return;
    }

    const threshold = maxOffsetRef.current * 0.9;
    if (offset >= threshold) {
      triggerDelete(maxOffsetRef.current);
    } else {
      // Spring back to last click-step position
      setAnimating(true);
      const snapped = Math.round(offset / CLICK_STEP) * CLICK_STEP;
      setOffset(Math.max(0, snapped));
      setTimeout(() => setAnimating(false), 250);
    }
  }, [dragging, offset, handleClick, triggerDelete]);

  useEffect(() => {
    if (disabled) {
      setOffset(0);
      setDone(false);
    }
  }, [disabled]);

  const max = getMaxOffset();
  const progress = max > 0 ? offset / max : 0;

  return (
    <div
      ref={trackRef}
      className={`swipe-del-root${animating ? " swipe-del-spring" : ""}${disabled ? " swipe-del-disabled" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        handleClick();
      }}
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
        className={`swipe-del-thumb${done ? " swipe-del-done" : ""}${offset > 0 && !dragging ? " swipe-del-active" : ""}`}
        style={{ left: offset + THUMB_START }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {done ? DONE_ICON : (icon || TRASH_ICON)}
      </div>
    </div>
  );
}

export type { SwipeDeleteProps };
