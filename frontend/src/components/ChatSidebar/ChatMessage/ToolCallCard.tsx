import { useState } from "react";
import type { ChatToolCall } from "../../../api";
import { useTranslation } from "../../../i18n";

/**
 * ToolCallCard — a single tool invocation rendered as an expandable card.
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ 🔧  <tool label> · <target>          ⚪  ▾   │  <- header (clickable)
 *   ├────────────────────────────────────────────────┤
 *   │ ┃  开始执行 create_table                       │
 *   │ ┃  参数：name="CRM 线索", documentId=…        │  <- body (left accent)
 *   │ ┃  ✓ 执行成功                                  │
 *   └────────────────────────────────────────────────┘
 *
 * The header always shows status on the right. Clicking toggles the body,
 * which lines up with the thinking/confirm cards for visual consistency.
 */
export default function ToolCallCard({ call }: { call: ChatToolCall }) {
  const { t } = useTranslation();
  const status = call.status || "running";
  const [expanded, setExpanded] = useState(false);

  const translated = t(`chat.tool.${call.tool}`);
  const label = translated === `chat.tool.${call.tool}` ? call.tool : translated;
  const targetTag = extractTargetTag(call.args);
  const statusTitle = t(
    `chat.tool.status.${status === "awaiting_confirmation" ? "awaiting" : status}`
  );

  return (
    <div className={`chat-expand-card chat-tool-card ${status}${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        className="chat-expand-card-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={label}
      >
        <span className="chat-expand-card-icon" aria-hidden="true">
          <ToolGlyph />
        </span>
        <span className="chat-expand-card-title">
          {label}
          {targetTag && <span className="chat-tool-row-target">「{targetTag}」</span>}
        </span>
        <StatusDot status={status} title={statusTitle} />
        <Chevron expanded={expanded} />
      </button>
      {expanded && (
        <div className="chat-expand-card-body chat-tool-body">
          <div className="chat-tool-body-step">
            <span className="chat-tool-body-step-marker">{t("chat.tool.stepStart")}</span>
            <span className="chat-tool-body-step-text">{label}</span>
          </div>
          {Object.keys(call.args || {}).length > 0 && (
            <div className="chat-tool-body-args">
              {Object.entries(call.args).map(([k, v]) => (
                <div key={k} className="chat-tool-body-arg">
                  <span className="chat-tool-body-arg-key">{k}</span>
                  <span className="chat-tool-body-arg-val">{formatArgValue(v)}</span>
                </div>
              ))}
            </div>
          )}
          <div className={`chat-tool-body-step result ${status}`}>
            <span className="chat-tool-body-step-marker">
              {t(
                `chat.tool.step.${status === "awaiting_confirmation" ? "awaiting" : status}`
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function formatArgValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 78) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 78) + "…" : s;
  } catch {
    return String(v);
  }
}

/** Derive a short human-readable target label from common tool args. */
function extractTargetTag(args: Record<string, unknown>): string | null {
  if (!args) return null;
  if (typeof args.name === "string" && args.name) return args.name;
  if (typeof args.tableId === "string") {
    return args.tableId.length > 16 ? args.tableId.slice(0, 14) + "…" : args.tableId;
  }
  if (typeof args.viewId === "string") return args.viewId.slice(0, 14);
  if (typeof args.recordId === "string") return args.recordId.slice(0, 14);
  if (typeof args.fieldId === "string") return args.fieldId.slice(0, 14);
  return null;
}

/** Bracket+grid glyph hinting "a tracked table action". 14×14. */
function ToolGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M9 1.5h2.5A1 1 0 0 1 12.5 2.5V5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 12.5H2.5A1 1 0 0 1 1.5 11.5V9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="4" y="4" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** 16×16 status indicator on the right of the header. */
function StatusDot({ status, title }: { status: string; title: string }) {
  if (status === "running") {
    return <span className="chat-tool-row-spinner" title={title} aria-label={title} />;
  }
  if (status === "success") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        className="chat-tool-row-status-icon success"
        aria-label={title}
      >
        <path
          d="m4.5 8.2 2.4 2.3L11.5 5.7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "error") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        className="chat-tool-row-status-icon error"
        aria-label={title}
      >
        <path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "awaiting_confirmation") {
    return (
      <span className="chat-tool-row-status-icon awaiting" title={title} aria-label={title}>
        •
      </span>
    );
  }
  return null;
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className={`chat-expand-card-chevron${expanded ? " expanded" : ""}`}
      aria-hidden="true"
    >
      <path
        d="m5 6 3 3 3-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
