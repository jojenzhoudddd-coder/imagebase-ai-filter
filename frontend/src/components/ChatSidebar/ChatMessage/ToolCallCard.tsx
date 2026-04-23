import { useState, useMemo } from "react";
import type { ChatToolCall } from "../../../api";
import { useTranslation } from "../../../i18n";
import ChatTableBlock from "./ChatTableBlock";

/**
 * ToolCallCard — a single tool invocation rendered as an expandable card.
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ 🔧  <tool label> · <target>          ⚪  ▾   │  <- header (clickable)
 *   ├────────────────────────────────────────────────┤
 *   │ ┃  开始执行 create_table                       │
 *   │ ┃  参数：name="CRM 线索", workspaceId=…       │  <- body (left accent)
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

  // Analyst preview: if this tool returned {preview:{columns, rows, rowCount, truncated}}
  // we render a compact ChatTableBlock right under the card header when the
  // card isn't yet expanded. Keeps the result visible without forcing users
  // to expand every analyst tool call.
  const analystPreview = useMemo(() => extractAnalystPreview(call.result), [call.result]);

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
      {/* Progress strip is outside the collapsible body on purpose: users
          need to see live activity even when the card header is collapsed. */}
      {status === "running" && (call.progress || call.heartbeat) && (
        <ProgressStrip progress={call.progress} heartbeat={call.heartbeat} />
      )}
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
          {/* Analyst result preview lives inside the expanded body so it
              hides when the card is collapsed. Collapse-by-default keeps
              long conversations readable; user clicks header to reveal. */}
          {status === "success" && analystPreview && (
            <div className="chat-tool-analyst-preview">
              <ChatTableBlock
                columns={analystPreview.columns}
                rows={analystPreview.rows}
                totalRows={analystPreview.rowCount}
                footerNote={analystPreview.handle ? `handle=${analystPreview.handle}` : undefined}
              />
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

/** Progress strip shown below the header while a tool is executing.
 * Shows progress bar + message when tool reports progress, elapsed timer
 * when only heartbeat (silent long-running) signals are arriving. */
function ProgressStrip({
  progress,
  heartbeat,
}: {
  progress?: ChatToolCall["progress"];
  heartbeat?: ChatToolCall["heartbeat"];
}) {
  const elapsedMs = progress?.elapsedMs ?? heartbeat?.elapsedMs ?? 0;
  const elapsedLabel = formatElapsed(elapsedMs);
  const message =
    progress?.message ||
    (heartbeat ? `计算中 · ${elapsedLabel}` : `计算中`);
  const pct =
    typeof progress?.progress === "number"
      ? Math.max(0, Math.min(1, progress.progress))
      : progress?.current && progress?.total
      ? Math.max(0, Math.min(1, progress.current / progress.total))
      : undefined;
  return (
    <div className="chat-tool-progress">
      <div className="chat-tool-progress-row">
        <span className="chat-tool-progress-message">{message}</span>
        <span className="chat-tool-progress-elapsed">{elapsedLabel}</span>
      </div>
      <div className="chat-tool-progress-bar">
        <div
          className={`chat-tool-progress-bar-fill${pct === undefined ? " indeterminate" : ""}`}
          style={pct !== undefined ? { width: `${(pct * 100).toFixed(1)}%` } : undefined}
        />
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) * 100)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m${String(sec).padStart(2, "0")}s`;
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

/** If a tool returned an analyst-shaped preview, surface it for inline
 * rendering. Expected shape (via dataStoreClient toolResult wrapper):
 *   { _resultHandle?, data: { meta: {...}, preview: { columns, rows, rowCount, truncated } } }
 * Also handles the unwrapped form some tools emit directly. */
function extractAnalystPreview(result: unknown): null | {
  columns: Array<{ name: string; type?: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  handle?: string;
} {
  if (!result) return null;
  let parsed: any = result;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (typeof parsed !== "object") return null;
  const handle = parsed._resultHandle;
  const data = parsed.data ?? parsed;
  const preview = data?.preview;
  if (!preview || !Array.isArray(preview.columns) || !Array.isArray(preview.rows)) {
    return null;
  }
  return {
    columns: preview.columns,
    rows: preview.rows,
    rowCount:
      typeof preview.rowCount === "number"
        ? preview.rowCount
        : preview.rows.length,
    handle: typeof handle === "string" ? handle : undefined,
  };
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
