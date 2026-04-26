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

/** V2.9.1 #3: Subagent + Workflow 卡片用与 TopBar AI 入口按钮一致的 sparkle
 *  outline,纯色蓝(active 态)。原 path 出自 Figma node 1332,22 20×20 viewBox;
 *  此处压缩为 14×14 与 ToolCallCard 的 ToolGlyph 视觉对齐。 */
export function SubagentGlyph() {
  return <SparkleGlyph />;
}
export function WorkflowGlyph() {
  return <SparkleGlyph />;
}

function SparkleGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="1332 22 20 20"
      fill="none"
      aria-hidden="true"
      style={{ color: "var(--primary, #1456f0)" }}
    >
      <path
        d="M1342 27.3108C1341.02 29.321 1339.43 30.97 1337.46 31.9998C1339.43 33.0294 1341.02 34.678 1342 36.688C1342.98 34.678 1344.57 33.0294 1346.54 31.9998C1344.57 30.97 1342.98 29.321 1342 27.3108ZM1350.62 31.9998C1350.62 32.2031 1350.47 32.3714 1350.27 32.3945L1350.18 32.4062C1349.52 32.4895 1348.89 32.6447 1348.28 32.8647L1347.55 33.1702C1345.67 34.0603 1344.14 35.6041 1343.27 37.5142L1342.96 38.2532C1342.75 38.8585 1342.6 39.4945 1342.51 40.1523L1342.49 40.2483C1342.43 40.4649 1342.23 40.6226 1342 40.6226L1341.9 40.613C1341.72 40.5762 1341.56 40.4341 1341.51 40.2483L1341.49 40.1523C1341.4 39.4945 1341.25 38.8585 1341.04 38.2532L1340.73 37.5142C1339.86 35.6041 1338.33 34.0603 1336.45 33.1702L1335.72 32.8647C1335.16 32.6631 1334.59 32.5156 1333.99 32.4282L1333.73 32.3945C1333.53 32.3714 1333.38 32.2031 1333.38 31.9998C1333.38 31.7964 1333.53 31.6281 1333.73 31.605C1334.33 31.535 1334.92 31.4037 1335.48 31.2175L1335.72 31.1348L1336.45 30.8293C1338.33 29.9392 1339.86 28.3954 1340.73 26.4854L1341.04 25.7463C1341.25 25.141 1341.4 24.505 1341.49 23.8472C1341.52 23.5828 1341.74 23.377 1342 23.377C1342.26 23.377 1342.48 23.5828 1342.51 23.8472C1342.6 24.505 1342.75 25.141 1342.96 25.7463L1343.27 26.4854C1344.14 28.3954 1345.67 29.9392 1347.55 30.8293L1348.28 31.1348L1348.52 31.2175C1349.08 31.4037 1349.67 31.535 1350.27 31.605C1350.47 31.6281 1350.62 31.7964 1350.62 31.9998Z"
        fill="currentColor"
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
