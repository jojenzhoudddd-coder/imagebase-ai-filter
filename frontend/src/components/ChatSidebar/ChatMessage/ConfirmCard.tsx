import type { PendingConfirm } from "../../../api";
import { useTranslation } from "../../../i18n";

interface Props {
  pending: PendingConfirm;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
}

export default function ConfirmCard({ pending, onConfirm, onCancel, disabled }: Props) {
  const { t } = useTranslation();
  return (
    <div className="chat-confirm-card">
      <div className="chat-confirm-text">
        {pending.prompt || t("chat.confirm.defaultPrompt", { tool: pending.tool })}
      </div>
      <div className="chat-confirm-actions">
        <button
          type="button"
          className="chat-confirm-btn secondary"
          onClick={onCancel}
          disabled={disabled}
        >
          {t("chat.confirm.cancel")}
        </button>
        <button
          type="button"
          className="chat-confirm-btn primary"
          onClick={onConfirm}
          disabled={disabled}
        >
          {t("chat.confirm.confirm")}
        </button>
      </div>
    </div>
  );
}
