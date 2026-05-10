import { useEffect, useLayoutEffect, useRef, useState, ReactNode } from "react";
import { createPortal } from "react-dom";
import SwipeDelete from "./SwipeDelete";
import "./DropdownMenu.css";

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  suffix?: ReactNode;
  disabled?: boolean;
  noop?: boolean;
  section?: string;
  /** V3.0 PR1: 危险操作(如删除),CSS 标红 */
  danger?: boolean;
  /** V3.0 PR1: 当前选中态(如对话列表中高亮当前对话) */
  active?: boolean;
  /** Swipe-to-delete: replaces the regular click handler with a drag interaction */
  swipeDelete?: boolean;
  /** Callback when swipe-delete completes (only used when swipeDelete=true) */
  onSwipeDelete?: () => void;
}

interface Props {
  items: MenuItem[];
  onSelect: (key: string) => void;
  anchorEl: HTMLElement;
  onClose: () => void;
  /** "auto" (default) chooses below if space allows, else above. "right"
   * docks the menu to the right of anchorEl, vertically top-aligned —
   * used for cascading sub-menus. */
  position?: "below" | "above" | "auto" | "right";
  width?: number;
  /** Key of item that currently has a sub-menu open — prevents click-outside close */
  activeSubMenuKey?: string | null;
  /** Ref callback: receives menu DOM element once mounted (for sub-menu positioning) */
  onMenuRef?: (el: HTMLDivElement | null) => void;
  /** Ref callback: receives a specific item's DOM element (for sub-menu anchor) */
  onItemRef?: (key: string, el: HTMLButtonElement | null) => void;
  /** Extra DOM elements that should NOT trigger click-outside close */
  extraContainers?: React.RefObject<HTMLElement | null>[];
  /** Additional CSS class for the menu container */
  className?: string;
  /** Optional boundary element. When set, the menu's max-height is clamped
   *  so its bottom edge stays within boundary's bottom minus 20px,使弹窗
   *  在 chat block / artifact block 这种内嵌容器里不会探出底边。超出则
   *  内部纵向滚动。 */
  boundaryEl?: HTMLElement | null;
}

export default function DropdownMenu({ items, onSelect, anchorEl, onClose, position = "auto", width, activeSubMenuKey, onMenuRef, onItemRef, extraContainers, className, boundaryEl }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number | null }>({
    top: -9999, left: -9999, maxHeight: null,
  });

  useLayoutEffect(() => {
    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menuRef.current?.getBoundingClientRect();
    const menuH = menuRect?.height ?? 300;
    const menuW = menuRect?.width ?? (width ?? 220);
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // Boundary clamp: 弹窗底部至少距 boundary 底边 20px。viewport 底边
    // 也作 fallback,无 boundaryEl 时仍走 viewport 行为。
    const BOUNDARY_BOTTOM_GAP = 20;
    const boundaryRect = boundaryEl?.getBoundingClientRect();
    const effectiveBottom = boundaryRect
      ? Math.min(vh, boundaryRect.bottom) - BOUNDARY_BOTTOM_GAP
      : vh;
    const effectiveTop = boundaryRect
      ? Math.max(0, boundaryRect.top)
      : 0;

    if (position === "right") {
      // Sub-menu: dock to the right of anchor (the parent menu item), top-
      // aligned with it. Flip to left of anchor if not enough horizontal
      // space. Clamp top so it stays within the viewport.
      let left = rect.right + 4;
      if (left + menuW > vw - 8) left = rect.left - menuW - 4;
      const top = Math.max(8, Math.min(rect.top, vh - menuH - 8));
      setPos({ top, left, maxHeight: null });
      return;
    }

    // V3.0.3:水平 clamp helper —— 默认左对齐 anchor (rect.left),
    // 但 menu 右边超出 viewport 时距右窗 12px,左边也保留 ≥ 8px 兜底。
    const clampLeft = (preferred: number) => {
      const RIGHT_GAP = 12;
      const LEFT_MIN = 8;
      const maxLeft = vw - menuW - RIGHT_GAP;
      let left = preferred;
      if (left > maxLeft) left = maxLeft;
      if (left < LEFT_MIN) left = LEFT_MIN;
      return left;
    };

    /** Helper: 给定 top, 算 maxHeight = effectiveBottom - top。如果 menu
     *  自然高度小于这个值, maxHeight 为 null(不限制)。否则给上限 + 触发滚动。 */
    const computeMaxHeight = (top: number): number | null => {
      const available = effectiveBottom - top;
      if (available <= 0) return 80; // 兜底,容器太窄给 80px 至少能看到一行
      return menuH > available ? available : null;
    };

    if (position === "above") {
      // 上弹:bottom 固定 = anchor.top - 4,top 由 maxHeight 反推
      let top = rect.top - menuH - 4;
      if (top < effectiveTop) top = effectiveTop;
      setPos({ top, left: clampLeft(rect.left), maxHeight: rect.top - 4 - top });
      return;
    }
    if (position === "below") {
      const top = rect.bottom + 4;
      setPos({ top, left: clampLeft(rect.left), maxHeight: computeMaxHeight(top) });
      return;
    }
    // auto: prefer below if there's room (with boundary), else flip above.
    const spaceBelow = effectiveBottom - rect.bottom;
    const spaceAbove = rect.top - effectiveTop;
    if (spaceBelow >= menuH + 8 || spaceBelow >= spaceAbove) {
      const top = rect.bottom + 4;
      setPos({ top, left: clampLeft(rect.left), maxHeight: computeMaxHeight(top) });
    } else {
      // Above mode: 锚点上方空间塞不下时给 maxHeight 让其滚动
      const desiredTop = rect.top - menuH - 4;
      const top = Math.max(effectiveTop + 8, desiredTop);
      const maxH = rect.top - 4 - top;
      setPos({ top, left: clampLeft(rect.left), maxHeight: menuH > maxH ? maxH : null });
    }
  }, [anchorEl, position, width, boundaryEl]);

  // Expose menu ref on mount only
  useEffect(() => {
    onMenuRef?.(menuRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // Don't close if click is inside menu or anchor
      if (menuRef.current && menuRef.current.contains(target)) return;
      if (anchorEl.contains(target)) return;
      // Don't close if click is inside any extra containers (e.g. sub-menu popover)
      if (extraContainers?.some(ref => ref.current?.contains(target))) return;
      // Don't close if a sub-menu is active (generating/creating)
      if (activeSubMenuKey) return;
      onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [anchorEl, onClose, activeSubMenuKey, extraContainers]);

  // Group items by section
  const groups: Array<{ title?: string; items: MenuItem[] }> = [];
  let currentGroup: { title?: string; items: MenuItem[] } | null = null;
  for (const item of items) {
    if (item.section) {
      currentGroup = { title: item.section, items: [item] };
      groups.push(currentGroup);
    } else if (currentGroup) {
      currentGroup.items.push(item);
    } else {
      currentGroup = { title: undefined, items: [item] };
      groups.push(currentGroup);
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      className={`dropdown-menu${className ? ` ${className}` : ""}`}
      style={{
        top: pos.top,
        left: pos.left,
        width: width ?? undefined,
        // boundaryEl 限高时溢出滚动。CSS 兜底 padding 4px(.dropdown-menu)
        // 跟 max-height 一起作用,内容超出会出现纵向滚动条。
        maxHeight: pos.maxHeight ?? undefined,
        overflowY: pos.maxHeight != null ? "auto" : undefined,
      }}
    >
      {groups.map((group, gi) => (
        <div key={group.title || gi} className="dropdown-menu-group">
          {group.title && <div className="dropdown-menu-section">{group.title}</div>}
          <div className="dropdown-menu-items">
            {group.items.map((item) => (
              item.swipeDelete ? (
                <div key={item.key} className="dropdown-menu-item swipe-delete-wrapper">
                  <SwipeDelete
                    label={item.label}
                    icon={item.icon}
                    onDelete={() => {
                      item.onSwipeDelete?.();
                      onClose();
                    }}
                    disabled={item.disabled}
                  />
                </div>
              ) : (
              <button
                key={item.key}
                ref={(el) => onItemRef?.(item.key, el)}
                className={`dropdown-menu-item${item.disabled ? " disabled" : ""}${item.suffix ? " has-suffix" : ""}${activeSubMenuKey === item.key ? " active-submenu" : ""}${item.danger ? " danger" : ""}${item.active ? " active" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (item.disabled || item.noop) return;
                  onSelect(item.key);
                }}
              >
                {item.icon && <span className="dropdown-menu-item-icon">{item.icon}</span>}
                <span className="dropdown-menu-item-label">{item.label}</span>
                {item.suffix && <span className="dropdown-menu-item-suffix">{item.suffix}</span>}
              </button>
              )
            ))}
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
