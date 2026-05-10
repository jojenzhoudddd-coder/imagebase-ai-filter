/**
 * CardMoreMenu — "..." button with DropdownMenu for card actions.
 * Reuses the same DropdownMenu component as chat block's profile menu.
 */

import { useRef, useState } from "react";
import DropdownMenu, { type MenuItem } from "../DropdownMenu";
import { useTranslation } from "../../i18n";

interface Props {
  onViewActivities: () => void;
  label: string;
  /** If provided, shows a "Delete" option with swipe-to-delete */
  onDelete?: () => void;
  deleteLabel?: string;
}

export default function CardMoreMenu({ onViewActivities, label, onDelete, deleteLabel }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const items: MenuItem[] = [
    {
      key: "view-activities",
      label,
      icon: (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M2 3.5h10M2 7h10M2 10.5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      ),
    },
  ];

  if (onDelete) {
    items.push({
      key: "delete",
      label: deleteLabel || t("agent.card.delete"),
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M8 4C8 2.89543 8.89543 2 10 2H14C15.1046 2 16 2.89543 16 4H21C21.5523 4 22 4.44772 22 5C22 5.55228 21.5523 6 21 6H20C20 10.6667 20 15.3333 20 20C20 21.1046 19.1046 22 18 22H6C4.89543 22 4 21.1046 4 20C4 15.3333 4 10.6667 4 6H3C2.44772 6 2 5.55228 2 5C2 4.44772 2.44772 4 3 4H8ZM6 6V20H18V6H6ZM10 9C10.5523 9 11 9.44772 11 10V16C11 16.5523 10.5523 17 10 17C9.44772 17 9 16.5523 9 16V10C9 9.44772 9.44772 9 10 9ZM14 9C14.5523 9 15 9.44772 15 10V16C15 16.5523 14.5523 17 14 17C13.4477 17 13 16.5523 13 16V10C13 9.44772 13.4477 9 14 9Z" fill="currentColor"/>
        </svg>
      ),
      swipeDelete: true,
      onSwipeDelete: () => onDelete(),
    });
  }

  return (
    <>
      <button
        ref={btnRef}
        className="ab-card-more"
        title="More"
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
          <circle cx="8" cy="8" r="1.2" fill="currentColor" />
          <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
        </svg>
      </button>
      {open && btnRef.current && (
        <DropdownMenu
          anchorEl={btnRef.current}
          items={items}
          onSelect={(key) => {
            setOpen(false);
            if (key === "view-activities") onViewActivities();
          }}
          onClose={() => setOpen(false)}
          width={160}
        />
      )}
    </>
  );
}
