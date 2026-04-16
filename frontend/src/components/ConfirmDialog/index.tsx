import { useEffect, useRef } from "react";
import { useTranslation } from "../../i18n/index";
import "./ConfirmDialog.css";

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "danger" | "default";
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  variant = "default",
}: Props) {
  const { t } = useTranslation();
  const resolvedConfirm = confirmLabel || t("confirm.confirm");
  const resolvedCancel = cancelLabel || t("confirm.cancel");
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="confirm-overlay" onMouseDown={onCancel}>
      <div
        className="confirm-card"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-title">{title}</div>
        <div className="confirm-message">{message}</div>
        <div className="confirm-actions">
          <button className="confirm-btn confirm-btn-cancel" onClick={onCancel}>
            {resolvedCancel}
          </button>
          <button
            className={`confirm-btn confirm-btn-ok ${variant === "danger" ? "confirm-btn-danger" : ""}`}
            onClick={onConfirm}
          >
            {resolvedConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
