import { useEffect, useRef, useState, ReactNode } from "react";
import { createPortal } from "react-dom";
import "./DropdownMenu.css";

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
}

interface Props {
  items: MenuItem[];
  onSelect: (key: string) => void;
  anchorEl: HTMLElement;
  onClose: () => void;
}

export default function DropdownMenu({ items, onSelect, anchorEl, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    const rect = anchorEl.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
  }, [anchorEl]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          !anchorEl.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [anchorEl, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="dropdown-menu"
      style={{ top: pos.top, left: pos.left }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          className="dropdown-menu-item"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(item.key);
            onClose();
          }}
        >
          {item.icon && <span className="dropdown-menu-item-icon">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
