import { useEffect, useRef } from "react";
import { useTranslation } from "../../i18n/index";
import "./ConfirmDialog.css";

/**
 * Structured list entry for the optional "references" section under the main
 * message — used by the idea-delete flow to show which other docs point at
 * the target before the user commits. Each entry is displayed as one row:
 * bold source label + muted excerpt. Keeping the shape minimal so we can
 * feed it `IncomingMentionRef[]` from the API without re-mapping.
 */
export interface ConfirmReference {
  /** Where the reference lives — e.g. the parent idea's name. */
  sourceLabel: string;
  /** Context preview snippet around the mention. */
  contextExcerpt?: string | null;
}

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "danger" | "default";
  /**
   * When provided + non-empty, renders a scrollable list below the message
   * so the user can see who's currently pointing at the target before
   * confirming a destructive action. Caller owns the fetch — typically via
   * `fetchIncomingMentions` in api.ts. Pass `total` to show "+N more" when
   * the list was truncated server-side.
   */
  references?: ConfirmReference[];
  referencesTotal?: number;
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
  references,
  referencesTotal,
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

  // Cap inline rows to 6. Anything over shows a "+N 条更多" footer so the
  // dialog doesn't grow unboundedly. `referencesTotal` may be higher than
  // `references.length` when the API already truncated on the server side.
  const VISIBLE = 6;
  const visibleRefs = references?.slice(0, VISIBLE) ?? [];
  const totalRefs = referencesTotal ?? references?.length ?? 0;
  const moreCount = Math.max(0, totalRefs - visibleRefs.length);

  return (
    <div className="confirm-overlay" onMouseDown={onCancel}>
      <div
        className="confirm-card"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-title">{title}</div>
        <div className="confirm-message">{message}</div>
        {visibleRefs.length > 0 && (
          <div className="confirm-refs">
            <div className="confirm-refs-title">
              {t("confirm.refsTitle", { count: totalRefs })}
            </div>
            <ul className="confirm-refs-list">
              {visibleRefs.map((r, i) => (
                <li key={i} className="confirm-refs-item">
                  <span className="confirm-refs-source">{r.sourceLabel}</span>
                  {r.contextExcerpt && (
                    <span className="confirm-refs-excerpt">{r.contextExcerpt}</span>
                  )}
                </li>
              ))}
            </ul>
            {moreCount > 0 && (
              <div className="confirm-refs-more">
                {t("confirm.refsMore", { more: moreCount })}
              </div>
            )}
          </div>
        )}
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
