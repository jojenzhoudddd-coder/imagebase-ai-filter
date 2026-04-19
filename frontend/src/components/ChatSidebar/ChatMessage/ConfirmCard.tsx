import type { PendingConfirm } from "../../../api";

interface Props {
  pending: PendingConfirm;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
}

export default function ConfirmCard({ pending, onConfirm, onCancel, disabled }: Props) {
  return (
    <div className="chat-confirm-card">
      <div className="chat-confirm-text">{pending.prompt || `即将执行 ${pending.tool}`}</div>
      <div className="chat-confirm-actions">
        <button
          type="button"
          className="chat-confirm-btn secondary"
          onClick={onCancel}
          disabled={disabled}
        >
          取消
        </button>
        <button
          type="button"
          className="chat-confirm-btn primary"
          onClick={onConfirm}
          disabled={disabled}
        >
          确认
        </button>
      </div>
    </div>
  );
}
