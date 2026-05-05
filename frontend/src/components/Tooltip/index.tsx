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
  children: ReactNode;
}

export default function Tooltip({
  content,
  title,
  placement = "top",
  enterDelay = 200,
  leaveDelay = 100,
  disabled,
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

  // Position calculation
  useEffect(() => {
    if (!visible || !triggerRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const tooltip = tooltipRef.current;
    if (!tooltip) return;

    const tipRect = tooltip.getBoundingClientRect();
    const GAP = 6;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;

    let actualPlacement = placement;
    let top = 0;
    let left = 0;

    // Try preferred placement, flip if needed
    if (placement === "top" || placement === "bottom") {
      left = trigger.left + trigger.width / 2 - tipRect.width / 2;
      if (placement === "top") {
        top = trigger.top - tipRect.height - GAP;
        if (top < 4) { actualPlacement = "bottom"; top = trigger.bottom + GAP; }
      } else {
        top = trigger.bottom + GAP;
        if (top + tipRect.height > viewH - 4) { actualPlacement = "top"; top = trigger.top - tipRect.height - GAP; }
      }
    } else {
      top = trigger.top + trigger.height / 2 - tipRect.height / 2;
      if (placement === "left") {
        left = trigger.left - tipRect.width - GAP;
        if (left < 4) { actualPlacement = "right"; left = trigger.right + GAP; }
      } else {
        left = trigger.right + GAP;
        if (left + tipRect.width > viewW - 4) { actualPlacement = "left"; left = trigger.left - tipRect.width - GAP; }
      }
    }

    // Clamp horizontal
    left = Math.max(4, Math.min(left, viewW - tipRect.width - 4));
    // Clamp vertical
    top = Math.max(4, Math.min(top, viewH - tipRect.height - 4));

    setPos({ top, left, actualPlacement });
  }, [visible, placement]);

  const style: CSSProperties | undefined = pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 };

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
              {typeof tooltipContent === "string" ? tooltipContent : tooltipContent}
            </div>
            <div className="tooltip-arrow" />
          </div>,
          document.body,
        )}
    </>
  );
}
