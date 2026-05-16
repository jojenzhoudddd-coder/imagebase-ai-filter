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

export { SubagentIcon as SubagentGlyph, WorkflowIcon as WorkflowGlyph } from "./toolCategoryIcons";

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
