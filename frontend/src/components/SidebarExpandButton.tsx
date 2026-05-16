/**
 * SidebarExpandButton —— 仅当 sidebar 当前处于"收起"状态时才渲染的展开按钮,
 * 由各个 artifact 的 topbar（table / idea / design / demo）放在自己 title 的
 * 左边作为前缀。展开时按钮节点不存在,title 自然归位。
 *
 * Hover 时显示一个 sidebar popover，可以快速切换 artifact。
 * 支持上下键导航 + 回车选中。
 */

import { useState, useRef, useCallback, useLayoutEffect, useEffect } from "react";
import { createPortal } from "react-dom";
import { useSidebarToggle } from "../contexts/sidebarToggleContext";

const HOVER_DELAY = 200;
const LEAVE_DELAY = 300;

const ITEM_SELECTOR = ".sidebar-item, .tree-node-row";

export default function SidebarExpandButton({ className }: { className?: string }) {
  const ctx = useSidebarToggle();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const enterTimer = useRef<ReturnType<typeof setTimeout>>();
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);

  const clearTimers = () => {
    clearTimeout(enterTimer.current);
    clearTimeout(leaveTimer.current);
  };

  // Recompute position whenever popover opens
  useLayoutEffect(() => {
    if (!open) return;
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left });
    setActiveIdx(-1);
  }, [open]);

  // Focus the popover when it opens so it can receive keyboard events
  useEffect(() => {
    if (open && popoverRef.current) {
      popoverRef.current.focus();
    }
  }, [open]);

  const handleEnter = useCallback(() => {
    clearTimers();
    enterTimer.current = setTimeout(() => setOpen(true), HOVER_DELAY);
  }, []);

  const handleLeave = useCallback(() => {
    clearTimers();
    leaveTimer.current = setTimeout(() => setOpen(false), LEAVE_DELAY);
  }, []);

  const handlePopoverEnter = useCallback(() => {
    clearTimers();
  }, []);

  const handlePopoverLeave = useCallback(() => {
    clearTimers();
    leaveTimer.current = setTimeout(() => setOpen(false), LEAVE_DELAY);
  }, []);

  // Close popover when a sidebar item is clicked (bubbles up from tree items)
  const handlePopoverClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(".sidebar-item, .tree-node-label, .tree-node-row")) {
      setTimeout(() => setOpen(false), 100);
    }
  }, []);

  const getItems = useCallback((): HTMLElement[] => {
    if (!popoverRef.current) return [];
    return Array.from(popoverRef.current.querySelectorAll(ITEM_SELECTOR)) as HTMLElement[];
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      btnRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = getItems();
      if (items.length === 0) return;
      setActiveIdx((prev) => {
        let next: number;
        if (e.key === "ArrowDown") {
          next = prev < items.length - 1 ? prev + 1 : 0;
        } else {
          next = prev > 0 ? prev - 1 : items.length - 1;
        }
        items[next]?.scrollIntoView({ block: "nearest" });
        return next;
      });
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const items = getItems();
      if (activeIdx >= 0 && activeIdx < items.length) {
        items[activeIdx].click();
        setTimeout(() => setOpen(false), 100);
      }
    }
  }, [activeIdx, getItems]);

  // Sync highlight class on items when activeIdx changes
  useEffect(() => {
    if (!popoverRef.current) return;
    const items = popoverRef.current.querySelectorAll(ITEM_SELECTOR);
    items.forEach((el, i) => {
      el.classList.toggle("keyboard-active", i === activeIdx);
    });
  }, [activeIdx, open]);

  if (!ctx || !ctx.collapsed) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`artifact-sidebar-expand-btn${className ? " " + className : ""}`}
        onClick={() => { clearTimers(); setOpen(false); ctx.onToggle(); }}
        title={ctx.expandTitle}
        aria-label={ctx.expandTitle}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ transform: "scaleX(-1)" }}>
          <path d="M11.2126 15.2884L7.92466 12.0005L11.3915 8.53368C11.4481 8.47708 11.6699 8.25401 11.8788 8.04388C12.1054 7.81597 12.1048 7.44773 11.8776 7.2205C11.6492 6.99219 11.2789 6.99284 11.0513 7.22187C10.883 7.39125 10.7158 7.55943 10.6645 7.61073L6.68721 11.588C6.45941 11.8158 6.45941 12.1852 6.68721 12.413L10.4628 16.1885C10.5235 16.2492 10.804 16.5304 11.0528 16.7799C11.2803 17.008 11.6498 17.0083 11.8776 16.7804C12.1048 16.5532 12.1053 16.1851 11.8787 15.9574C11.6019 15.6793 11.276 15.3518 11.2126 15.2884Z" fill="currentColor"/>
          <path d="M16.4088 15.2884L13.1208 12.0005L16.5876 8.53368C16.6442 8.47708 16.8661 8.25401 17.075 8.04388C17.3016 7.81597 17.301 7.44773 17.0737 7.2205C16.8454 6.99219 16.4751 6.99284 16.2475 7.22187C16.0792 7.39125 15.912 7.55943 15.8607 7.61073L11.8834 11.588C11.6556 11.8158 11.6556 12.1852 11.8834 12.413L15.659 16.1885C15.7197 16.2492 16.0001 16.5304 16.249 16.7799C16.4765 17.008 16.8459 17.0083 17.0738 16.7804C17.3009 16.5532 17.3015 16.1851 17.0749 15.9574C16.7981 15.6793 16.4721 15.3518 16.4088 15.2884Z" fill="currentColor"/>
        </svg>
      </button>
      {open && pos && ctx.sidebarElement && createPortal(
        <div
          ref={popoverRef}
          className="sidebar-expand-popover"
          style={{ top: pos.top, left: pos.left }}
          onMouseEnter={handlePopoverEnter}
          onMouseLeave={handlePopoverLeave}
          onClick={handlePopoverClick}
          onKeyDown={handleKeyDown}
          tabIndex={-1}
        >
          {ctx.sidebarElement}
        </div>,
        document.body,
      )}
    </>
  );
}
