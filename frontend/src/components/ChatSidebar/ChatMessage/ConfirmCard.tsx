import type { PendingConfirm } from "../../../api";
import { useTranslation } from "../../../i18n";

/**
 * ConfirmCard — the Agent asks the user to approve a destructive action
 * (delete_table, batch_delete_records, etc.) before executing it.
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ ⚠️  信息确认                                    │
 *   │    即将删除数据表「客户管理」                   │
 *   │    此操作不可撤销                                │
 *   │                       [  跳过  ]  [ 开始执行 ] │
 *   └────────────────────────────────────────────────┘
 *
 * The "跳过" button cancels this specific call (the Agent is told to skip
 * and continue). "开始执行" confirms. Both submit via the SSE confirm
 * channel, so the streaming response resumes from whichever path was taken.
 */
interface Props {
  pending: PendingConfirm;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
}

export default function ConfirmCard({ pending, onConfirm, onCancel, disabled }: Props) {
  const { t } = useTranslation();
  return (
    <div className="chat-confirm-card v2">
      <div className="chat-confirm-card-header">
        <span className="chat-confirm-card-icon" aria-hidden="true">
          <ConfirmIcon />
        </span>
        <span className="chat-confirm-card-title">{t("chat.confirm.title")}</span>
      </div>
      <div className="chat-confirm-card-body">
        {pending.prompt || t("chat.confirm.defaultPrompt", { tool: pending.tool })}
      </div>
      <div className="chat-confirm-actions">
        <button
          type="button"
          className="chat-confirm-btn secondary"
          onClick={onCancel}
          disabled={disabled}
        >
          {t("chat.confirm.skip")}
        </button>
        <button
          type="button"
          className="chat-confirm-btn primary"
          onClick={onConfirm}
          disabled={disabled}
        >
          {t("chat.confirm.start")}
        </button>
      </div>
    </div>
  );
}

/**
 * icon_warning_outlined — amber-style triangle-with-exclamation, drawn so
 * it pairs visually with the blue chat accent (same weight as Chevron et al).
 */
function ConfirmIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 1.8 12.8 11.5H1.2L7 1.8z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M7 5.5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="7" cy="10.2" r="0.7" fill="currentColor" />
    </svg>
  );
}
