import { useRef, useState, useCallback, useEffect, ReactNode } from "react";
import "./SwipeDelete.css";

interface SwipeDeleteProps {
  label: string;
  onDelete: () => void;
  icon?: ReactNode;
  disabled?: boolean;
}

const TRASH_ICON = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path
      d="M3 4h8M5.5 4V3a1 1 0 011-1h1a1 1 0 011 1v1M4.5 4v7a1 1 0 001 1h3a1 1 0 001-1V4"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
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

  const getMaxOffset = useCallback(() => {
    if (!trackRef.current) return 0;
    // max offset = track width - thumb width (28px) - 2px padding each side
    return trackRef.current.clientWidth - 28 - 4;
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
        style={{ left: offset + 2 }}
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
