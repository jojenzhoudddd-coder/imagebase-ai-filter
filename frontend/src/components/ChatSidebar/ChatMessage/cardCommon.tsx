/**
 * Shared chat-expand-card primitives (V2.3 D2).
 *
 * ToolCallCard / SubagentBlock / WorkflowBlock all use the same expand-card
 * shell:
 *   ┌────────────────────────────────────────────┐
 *   │ <icon>  <title>          <status>  <▾>    │  ← header (button)
 *   ├────────────────────────────────────────────┤
 *   │   ... body (per-card-type content) ...     │
 *   └────────────────────────────────────────────┘
 *
 * StatusDot + Chevron + formatElapsed live here so any future card type
 * inherits identical visuals without copy-paste drift.
 */

import { useTranslation } from "../../../i18n";

export type CardStatus =
  | "running"
  | "success"
  | "error"
  | "awaiting_confirmation"
  | "aborted";

/** 16×16 status indicator on the right of an expand-card header. */
export function StatusDot({ status, title }: { status: CardStatus; title?: string }) {
  if (status === "running") {
    return <span className="chat-tool-row-spinner" title={title} aria-label={title} />;
  }
  if (status === "success") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
        className="chat-tool-row-status-icon success" aria-label={title}>
        <path d="m4.5 8.2 2.4 2.3L11.5 5.7" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "error" || status === "aborted") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
        className="chat-tool-row-status-icon error" aria-label={title}>
        <path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "awaiting_confirmation") {
    return (
      <span className="chat-tool-row-status-icon awaiting" title={title} aria-label={title}>•</span>
    );
  }
  return null;
}

export function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
      className={`chat-expand-card-chevron${expanded ? " expanded" : ""}`} aria-hidden="true">
      <path d="m5 6 3 3 3-3" stroke="currentColor"
        strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function formatElapsed(ms?: number): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) * 100)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m${String(sec).padStart(2, "0")}s`;
}

/** V2.9 #12: Subagent + Workflow 卡片统一改用四芒星 (gradient) icon,
 *  与 chat 入口按钮 / mention chip 视觉系统保持一致。 */
export function SubagentGlyph() {
  return <FourPointStarGlyph />;
}
export function WorkflowGlyph() {
  return <FourPointStarGlyph />;
}

function FourPointStarGlyph() {
  // 每个 instance 有独立 gradient id,避免同 SVGDoc 内多个实例 mask 冲突
  const id = "card_star_" + Math.random().toString(36).slice(2, 8);
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="2" y1="2" x2="14" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4D83F5" />
          <stop offset="0.5" stopColor="#B463F2" />
          <stop offset="1" stopColor="#F5406B" />
        </linearGradient>
      </defs>
      <path
        d="M8 1c.2 0 .4.15.45.35l.9 3.16c.2.7.75 1.25 1.45 1.45l3.16.9c.35.1.35.6 0 .7l-3.16.9c-.7.2-1.25.75-1.45 1.45l-.9 3.16c-.1.35-.6.35-.7 0l-.9-3.16c-.2-.7-.75-1.25-1.45-1.45l-3.16-.9c-.35-.1-.35-.6 0-.7l3.16-.9c.7-.2 1.25-.75 1.45-1.45l.9-3.16c.05-.2.25-.35.45-.35z"
        fill={`url(#${id})`}
      />
    </svg>
  );
}

/** Header title fragment used by both subagent + workflow cards.
 * Format: <bold>{primary}</bold> · <secondary> */
export function CardTitleParts({ primary, secondary }: { primary: string; secondary?: string }) {
  return (
    <>
      <span className="chat-expand-card-title-primary">{primary}</span>
      {secondary && <span className="chat-expand-card-title-secondary"> · {secondary}</span>}
    </>
  );
}

export function useCardTranslation() {
  return useTranslation();
}
