import { useState } from "react";
import type { ChatToolCall } from "../../../api";
import { useTranslation } from "../../../i18n";

/**
 * ToolCallGroup — consecutive tool calls of the same MCP tool are grouped
 * under a single expandable card header. Prevents batch jobs (e.g. creating
 * 10 fields in one breath) from drowning the transcript in near-identical
 * rows.
 *
 * Header: same card chrome as ThinkingIndicator/ToolCallCard, plus a count
 * badge. Body (when expanded): a sub-step list — one row per child call,
 * each with its own target tag and status indicator.
 */
export default function ToolCallGroup({
  tool,
  items,
}: {
  tool: string;
  items: ChatToolCall[];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const translated = t(`chat.tool.${tool}`);
  const label = translated === `chat.tool.${tool}` ? tool : translated;
  const status = deriveGroupStatus(items);

  return (
    <div className={`chat-expand-card chat-tool-card ${status}${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        className="chat-expand-card-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="chat-expand-card-icon" aria-hidden="true">
          <GroupGlyph />
        </span>
        <span className="chat-expand-card-title">
          {label}
          <span className="chat-tool-row-count">
            · {t("chat.tool.groupCount", { count: items.length })}
          </span>
        </span>
        <Chevron expanded={expanded} />
      </button>
      {expanded && (
        <div className="chat-expand-card-body chat-tool-body">
          <div className="chat-tool-body-step">
            <span className="chat-tool-body-step-marker">{t("chat.tool.stepStart")}</span>
            <span className="chat-tool-body-step-text">{label}</span>
          </div>
          <ol className="chat-tool-substeps">
            {items.map((it) => (
              <li
                key={it.callId}
                className={`chat-tool-substep ${it.status || "running"}`}
              >
                <span className="chat-tool-substep-marker" aria-hidden="true">
                  <SubstepMarker status={it.status || "running"} />
                </span>
                <span className="chat-tool-substep-text">
                  {extractTargetTag(it.args) || it.callId.slice(-6)}
                </span>
              </li>
            ))}
          </ol>
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

function deriveGroupStatus(items: ChatToolCall[]): string {
  let hasRunning = false;
  let hasAwaiting = false;
  let hasError = false;
  for (const it of items) {
    const s = it.status || "running";
    if (s === "error") hasError = true;
    else if (s === "running") hasRunning = true;
    else if (s === "awaiting_confirmation") hasAwaiting = true;
  }
  if (hasError) return "error";
  if (hasRunning) return "running";
  if (hasAwaiting) return "awaiting_confirmation";
  return "success";
}

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

/** Per-substep marker: mirrors the header status glyph but in a smaller, inline form. */
function SubstepMarker({ status }: { status: string }) {
  if (status === "running") {
    return <span className="chat-tool-substep-spinner" />;
  }
  if (status === "success") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path
          d="m3 6.2 2 2 4-4.2"
          stroke="#17B26A"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "error") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="#F54A45" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "awaiting_confirmation") {
    return <span className="chat-tool-substep-awaiting" />;
  }
  return <span className="chat-tool-substep-idle" />;
}

function GroupGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="10" height="2.2" rx="0.6" stroke="currentColor" strokeWidth="1.1" />
      <rect x="2" y="6" width="10" height="2.2" rx="0.6" stroke="currentColor" strokeWidth="1.1" />
      <rect x="2" y="9.5" width="10" height="2.2" rx="0.6" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
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
