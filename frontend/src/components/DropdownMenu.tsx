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
}

interface Props {
  items: MenuItem[];
  onSelect: (key: string) => void;
  anchorEl: HTMLElement;
  onClose: () => void;
  position?: "below" | "above";
  width?: number;
  /** Key of item that currently has a sub-menu open — prevents click-outside close */
  activeSubMenuKey?: string | null;
  /** Ref callback: receives menu DOM element once mounted (for sub-menu positioning) */
  onMenuRef?: (el: HTMLDivElement | null) => void;
  /** Ref callback: receives a specific item's DOM element (for sub-menu anchor) */
  onItemRef?: (key: string, el: HTMLButtonElement | null) => void;
  /** Extra DOM elements that should NOT trigger click-outside close */
  extraContainers?: React.RefObject<HTMLElement | null>[];
}

export default function DropdownMenu({ items, onSelect, anchorEl, onClose, position = "below", width, activeSubMenuKey, onMenuRef, onItemRef, extraContainers }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });

  useLayoutEffect(() => {
    const rect = anchorEl.getBoundingClientRect();
    if (position === "above") {
      if (menuRef.current) {
        const menuRect = menuRef.current.getBoundingClientRect();
        setPos({ top: rect.top - menuRect.height - 4, left: rect.left });
      } else {
        // Fallback: estimate
        setPos({ top: rect.top - 300, left: rect.left });
      }
    } else {
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
  }, [anchorEl, position]);

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
      className="dropdown-menu"
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
                className={`dropdown-menu-item${item.disabled ? " disabled" : ""}${item.suffix ? " has-suffix" : ""}${activeSubMenuKey === item.key ? " active-submenu" : ""}`}
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
