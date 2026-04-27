import { useEffect, useLayoutEffect, useRef, useState, ReactNode } from "react";
import { createPortal } from "react-dom";
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
}

export default function DropdownMenu({ items, onSelect, anchorEl, onClose, position = "auto", width, activeSubMenuKey, onMenuRef, onItemRef, extraContainers, className }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });

  useLayoutEffect(() => {
    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menuRef.current?.getBoundingClientRect();
    const menuH = menuRect?.height ?? 300;
    const menuW = menuRect?.width ?? (width ?? 220);
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    if (position === "right") {
      // Sub-menu: dock to the right of anchor (the parent menu item), top-
      // aligned with it. Flip to left of anchor if not enough horizontal
      // space. Clamp top so it stays within the viewport.
      let left = rect.right + 4;
      if (left + menuW > vw - 8) left = rect.left - menuW - 4;
      const top = Math.max(8, Math.min(rect.top, vh - menuH - 8));
      setPos({ top, left });
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

    if (position === "above") {
      setPos({ top: rect.top - menuH - 4, left: clampLeft(rect.left) });
      return;
    }
    if (position === "below") {
      setPos({ top: rect.bottom + 4, left: clampLeft(rect.left) });
      return;
    }
    // auto: prefer below; flip to above if not enough room below (and there IS
    // room above).
    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow >= menuH + 8 || spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + 4, left: clampLeft(rect.left) });
    } else {
      setPos({ top: Math.max(8, rect.top - menuH - 4), left: clampLeft(rect.left) });
    }
  }, [anchorEl, position, width]);

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
      style={{ top: pos.top, left: pos.left, width: width ?? undefined }}
    >
      {groups.map((group, gi) => (
        <div key={group.title || gi} className="dropdown-menu-group">
          {group.title && <div className="dropdown-menu-section">{group.title}</div>}
          <div className="dropdown-menu-items">
            {group.items.map((item) => (
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
            ))}
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
