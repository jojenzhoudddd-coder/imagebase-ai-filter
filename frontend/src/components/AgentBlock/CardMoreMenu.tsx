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
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M6.5 9C5.94772 9 5.5 9.44772 5.5 10V11C5.5 11.5523 5.94772 12 6.5 12H7.5C8.05228 12 8.5 11.5523 8.5 11V10C8.5 9.44772 8.05228 9 7.5 9H6.5Z" fill="currentColor"/><path d="M11.5 9C10.9477 9 10.5 9.44772 10.5 10V11C10.5 11.5523 10.9477 12 11.5 12H12.5C13.0523 12 13.5 11.5523 13.5 11V10C13.5 9.44772 13.0523 9 12.5 9H11.5Z" fill="currentColor"/><path d="M15.5 10C15.5 9.44772 15.9477 9 16.5 9H17.5C18.0523 9 18.5 9.44772 18.5 10V11C18.5 11.5523 18.0523 12 17.5 12H16.5C15.9477 12 15.5 11.5523 15.5 11V10Z" fill="currentColor"/><path d="M23 4C23 2.9 22.1 2 21 2H3C1.9 2 1 2.9 1 4V17.0111C1 18.0211 1.9 19.0111 3 19.0111H7.7586L10.4774 22C10.9822 22.5017 11.3166 22.6311 12 22.7009C12.414 22.707 13.0502 22.5093 13.5 22L16.2414 19.0111H21C22.1 19.0111 23 18.1111 23 17.0111V4ZM3 4H21V17.0111H15.5L12 20.6714L8.5 17.0111H3V4Z" fill="currentColor"/>
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
