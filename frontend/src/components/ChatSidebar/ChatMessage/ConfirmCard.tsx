import type { PendingConfirm } from "../../../api";
import { useTranslation } from "../../../i18n";

/**
 * ConfirmCard — the Agent asks the user to approve a destructive action
 * (delete_table, batch_delete_records, delete_idea, etc.) before executing.
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ ⚠️  信息确认                                    │
 *   │    即将删除灵感文档「2026 路线图」              │
 *   │    此操作不可撤销                                │
 *   │  ┌───────────────────────────────────────────┐ │
 *   │  │ 当前 2 处引用（将变成死链）：             │ │
 *   │  │ • 📝 产品需求 — "参考 @2026 路线图 …"    │ │
 *   │  │ • 📝 周报 Q2   — "详见 @2026 路线图 …"   │ │
 *   │  └───────────────────────────────────────────┘ │
 *   │                       [  跳过  ]  [ 开始执行 ] │
 *   └────────────────────────────────────────────────┘
 *
 * The "跳过" button cancels this specific call (the Agent is told to skip
 * and continue). "开始执行" confirms. Both submit via the SSE confirm
 * channel, so the streaming response resumes from whichever path was taken.
 *
 * When the backend supplies `pending.incomingRefs` (e.g. delete_idea), the
 * card renders a collapsible list of the incoming references so the user
 * sees the blast radius before approving. Without it we render nothing —
 * the prompt string alone is enough for tools that don't have
 * reverse-indexed targets.
 */
interface Props {
  pending: PendingConfirm;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
}

export default function ConfirmCard({ pending, onConfirm, onCancel, disabled }: Props) {
  const { t } = useTranslation();
  const refs = pending.incomingRefs;
  const hasRefs = refs && refs.refs.length > 0;
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
      {hasRefs && (
        <div className="chat-confirm-refs">
          <div className="chat-confirm-refs-title">
            {t("chat.confirm.refsTitle", { count: refs!.total })}
          </div>
          <ul className="chat-confirm-refs-list">
            {refs!.refs.slice(0, 6).map((r, i) => (
              <li key={`${r.sourceType}:${r.sourceId}:${i}`} className="chat-confirm-refs-item">
                <span className="chat-confirm-refs-source">{r.sourceLabel}</span>
                {r.contextExcerpt && (
                  <span className="chat-confirm-refs-excerpt">{r.contextExcerpt}</span>
                )}
              </li>
            ))}
          </ul>
          {refs!.refs.length > 6 && (
            <div className="chat-confirm-refs-more">
              {t("chat.confirm.refsMore", { more: refs!.refs.length - 6 })}
            </div>
          )}
        </div>
      )}
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
