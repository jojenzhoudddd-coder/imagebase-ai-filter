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

function ConfirmIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14.4357 21.4309C14.4357 21.1547 14.6596 20.9309 14.9357 20.9309H21.9357C22.2119 20.9309 22.4357 21.1547 22.4357 21.4309V22.0309C22.4357 22.307 22.2119 22.5309 21.9357 22.5309H14.9357C14.6596 22.5309 14.4357 22.307 14.4357 22.0309V21.4309Z" fill="currentColor" />
      <path d="M3.96521 17.825C3.33166 18.7298 3.55156 19.9769 4.45637 20.6104L5.88402 21.6101C6.78883 22.2436 8.03592 22.0237 8.66947 21.1189L12.232 16.0312L7.5277 12.7372L3.96521 17.825ZM6.80174 20.2994L5.37409 19.2998C5.19312 19.1731 5.14915 18.9236 5.27586 18.7427L8.83669 13.6573L10.9197 15.1158L7.35883 20.2012C7.23212 20.3822 6.9827 20.4261 6.80174 20.2994Z" fill="currentColor" />
      <path d="M13.148 14.7229L8.44377 11.4289L7.5277 12.7372L12.232 16.0312L13.148 14.7229Z" fill="currentColor" />
      <path d="M10.7385 3.84016L5.50192 11.3187L6.31183 11.8858C6.78949 11.7842 7.23128 11.5085 7.53348 11.0769L11.205 5.83342C11.5077 5.40109 11.6156 4.89063 11.547 4.40628L10.7385 3.84016Z" fill="currentColor" />
      <path d="M14.1264 17.3577L19.363 9.87908L18.5494 9.30941C18.0708 9.41061 17.628 9.68657 17.3252 10.1189L13.6537 15.3624C13.3516 15.7939 13.2435 16.3034 13.3114 16.787L14.1264 17.3577Z" fill="currentColor" />
      <path d="M19.363 9.87908L14.1264 17.3577L13.3114 16.787C13.3858 17.3173 13.6717 17.8164 14.1449 18.1478L15.1805 18.873C16.0853 19.5065 17.3324 19.2866 17.966 18.3818L21.6375 13.1384C22.271 12.2336 22.0511 10.9865 21.1463 10.3529L20.1107 9.62775C19.6382 9.29692 19.0724 9.1988 18.5494 9.30941L19.363 9.87908ZM16.0982 17.5623L15.0626 16.8372C14.8817 16.7105 14.8377 16.461 14.9644 16.2801L18.6359 11.0366C18.7626 10.8557 19.012 10.8117 19.193 10.9384L20.2286 11.6636C20.4096 11.7903 20.4536 12.0397 20.3268 12.2206L16.6553 17.4641C16.5286 17.6451 16.2792 17.689 16.0982 17.5623Z" fill="currentColor" />
      <path d="M5.50192 11.3187L10.7385 3.84016L11.547 4.40628C11.472 3.87694 11.1863 3.3788 10.7138 3.04796L9.6782 2.3228C8.77339 1.68925 7.5263 1.90915 6.89274 2.81396L3.22124 8.0574C2.58769 8.96221 2.80758 10.2093 3.71239 10.8429L4.74802 11.568C5.22125 11.8994 5.7881 11.9973 6.31183 11.8858L5.50192 11.3187ZM8.76048 3.63345L9.79611 4.3586C9.97707 4.48531 10.021 4.73473 9.89434 4.91569L6.22284 10.1591C6.09613 10.3401 5.84671 10.3841 5.66574 10.2574L4.63012 9.53222C4.44915 9.40551 4.40517 9.15609 4.53189 8.97512L8.20339 3.73168C8.3301 3.55072 8.57952 3.50674 8.76048 3.63345Z" fill="currentColor" />
      <path d="M11.205 5.83342L7.53348 11.0769C7.23128 11.5085 6.78949 11.7842 6.31183 11.8858L7.5277 12.7372L8.44377 11.4289L13.148 14.7229L12.232 16.0312L13.3114 16.787C13.2435 16.3034 13.3516 15.7939 13.6537 15.3624L17.3252 10.1189C17.628 9.68657 18.0708 9.41061 18.5494 9.30941L11.547 4.40628C11.6156 4.89063 11.5077 5.40109 11.205 5.83342ZM17.1346 10.272L13.7335 15.1293L7.73029 10.9258L11.1314 6.06852L17.1346 10.272Z" fill="currentColor" />
    </svg>
  );
}
