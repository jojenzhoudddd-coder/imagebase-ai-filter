/**
 * CardMoreMenu — "..." button with DropdownMenu for card actions.
 * Reuses the same DropdownMenu component as chat block's profile menu.
 */

import { useRef, useState } from "react";
import DropdownMenu, { type MenuItem } from "../DropdownMenu";
import ConfirmDialog from "../ConfirmDialog/index";
import { useTranslation } from "../../i18n";

interface Props {
  onViewActivities: () => void;
  label: string;
  /** If provided, shows a "Delete" option with confirmation */
  onDelete?: () => void;
  deleteLabel?: string;
}

export default function CardMoreMenu({ onViewActivities, label, onDelete, deleteLabel }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3 4h8M5.5 4V3a1 1 0 011-1h1a1 1 0 011 1v1M4.5 4v7a1 1 0 001 1h3a1 1 0 001-1V4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
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
            if (key === "delete") setConfirmDelete(true);
          }}
          onClose={() => setOpen(false)}
          width={160}
        />
      )}
      <ConfirmDialog
        open={confirmDelete}
        title={t("agent.card.deleteConfirmTitle")}
        message={t("agent.card.deleteConfirmMessage")}
        confirmLabel={t("agent.card.deleteConfirmOk")}
        cancelLabel={t("agent.card.deleteConfirmCancel")}
        onConfirm={() => { setConfirmDelete(false); onDelete?.(); }}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
