/**
 * Tooltip — Lark Base style tooltip.
 *
 * Dark background, small arrow, auto-positions above/below based on viewport.
 * Shows on hover with a short delay (200ms enter, 100ms leave).
 *
 * Usage:
 *   <Tooltip content="Full text here">
 *     <span className="truncated-text">Trun...</span>
 *   </Tooltip>
 *
 * Or with `title` shorthand for text-only:
 *   <Tooltip title="Full text">...</Tooltip>
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import "./Tooltip.css";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

interface Props {
  /** Tooltip content (string or JSX). */
  content?: ReactNode;
  /** Shorthand: plain text tooltip. If both `content` and `title` are set, `content` wins. */
  title?: string;
  /** Preferred placement. Flips if not enough space. Default "top". */
  placement?: TooltipPlacement;
  /** Delay before showing (ms). Default 200. */
  enterDelay?: number;
  /** Delay before hiding (ms). Default 100. */
  leaveDelay?: number;
  /** Disable tooltip entirely. */
  disabled?: boolean;
  /** Gap between trigger and tooltip (px). Default 6. */
  gap?: number;
  children: ReactNode;
}

function calcPosition(
  trigger: DOMRect,
  tipRect: DOMRect,
  placement: TooltipPlacement,
  gap: number,
): { top: number; left: number; actualPlacement: TooltipPlacement } {
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  let actualPlacement = placement;
  let top = 0;
  let left = 0;

  if (placement === "top" || placement === "bottom") {
    left = trigger.left + trigger.width / 2 - tipRect.width / 2;
    if (placement === "top") {
      top = trigger.top - tipRect.height - gap;
      if (top < 4) { actualPlacement = "bottom"; top = trigger.bottom + gap; }
    } else {
      top = trigger.bottom + gap;
      if (top + tipRect.height > viewH - 4) { actualPlacement = "top"; top = trigger.top - tipRect.height - gap; }
    }
  } else {
    top = trigger.top + trigger.height / 2 - tipRect.height / 2;
    if (placement === "left") {
      left = trigger.left - tipRect.width - gap;
      if (left < 4) { actualPlacement = "right"; left = trigger.right + gap; }
    } else {
      left = trigger.right + gap;
      if (left + tipRect.width > viewW - 4) { actualPlacement = "left"; left = trigger.left - tipRect.width - gap; }
    }
  }

  left = Math.max(4, Math.min(left, viewW - tipRect.width - 4));
  top = Math.max(4, Math.min(top, viewH - tipRect.height - 4));

  return { top, left, actualPlacement };
}

export default function Tooltip({
  content,
  title,
  placement = "top",
  enterDelay = 200,
  leaveDelay = 100,
  disabled,
  gap = 6,
  children,
}: Props) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; actualPlacement: TooltipPlacement } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const enterTimer = useRef<ReturnType<typeof setTimeout>>();
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();

  const tooltipContent = content ?? title;
  if (!tooltipContent || disabled) {
    return <>{children}</>;
  }

  const show = useCallback(() => {
    clearTimeout(leaveTimer.current);
    enterTimer.current = setTimeout(() => setVisible(true), enterDelay);
  }, [enterDelay]);

  const hide = useCallback(() => {
    clearTimeout(enterTimer.current);
    leaveTimer.current = setTimeout(() => setVisible(false), leaveDelay);
  }, [leaveDelay]);

  // Reposition after tooltip mounts / updates
  useLayoutEffect(() => {
    if (!visible) { setPos(null); return; }
    // Need a rAF because the portal may not be in the DOM yet during layoutEffect
    const raf = requestAnimationFrame(() => {
      if (!triggerRef.current || !tooltipRef.current) return;
      const trig = triggerRef.current.getBoundingClientRect();
      const tip = tooltipRef.current.getBoundingClientRect();
      setPos(calcPosition(trig, tip, placement, gap));
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, placement, gap]);

  // Also reposition on scroll/resize while visible
  useEffect(() => {
    if (!visible) return;
    const reposition = () => {
      if (!triggerRef.current || !tooltipRef.current) return;
      const trig = triggerRef.current.getBoundingClientRect();
      const tip = tooltipRef.current.getBoundingClientRect();
      setPos(calcPosition(trig, tip, placement, gap));
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [visible, placement, gap]);

  const style: CSSProperties = pos
    ? { top: pos.top, left: pos.left }
    : { visibility: "hidden" as const, top: -9999, left: -9999 };

  return (
    <>
      <span
        ref={triggerRef}
        className="tooltip-trigger"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {visible &&
        createPortal(
          <div
            ref={tooltipRef}
            className={`tooltip tooltip-${pos?.actualPlacement ?? placement}`}
            style={style}
            onMouseEnter={() => clearTimeout(leaveTimer.current)}
            onMouseLeave={hide}
          >
            <div className="tooltip-content">
              {tooltipContent}
            </div>
            <div className="tooltip-arrow" />
          </div>,
          document.body,
        )}
    </>
  );
}
