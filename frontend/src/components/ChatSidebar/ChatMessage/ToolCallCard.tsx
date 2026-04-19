import type { ChatToolCall } from "../../../api";
import { useTranslation } from "../../../i18n";

/**
 * ToolCallCard — single tool-call row, pixel-aligned to Figma node
 * 6905:40884 "AI_ActionItem":
 *
 *   ┌───────────────────────────────────────────────┐
 *   │  ▢ icon  label (ellipsis, 12/20 #646A73)  ● │
 *   └───────────────────────────────────────────────┘
 *
 *   • Outer row: 36px height, 11px radius, #F5F6F7 background,
 *     4px horizontal padding, 8px gap.
 *   • Icon container: 28×28, 8px radius, rgba(255,255,255,0.8),
 *     0.5px #DEE0E3 border, 14×14 tool icon centred (#2B2F36).
 *   • Label: PingFang SC 12/20, #646A73, flex:1 with ellipsis.
 *   • Right side: 16×16 status indicator (spinner / check / x /
 *     awaiting-dot).
 */
export default function ToolCallCard({ call }: { call: ChatToolCall }) {
  const { t } = useTranslation();
  const status = call.status || "running";
  // Localized tool label — falls back to the raw MCP name if there's no
  // dedicated translation key.
  const translated = t(`chat.tool.${call.tool}`);
  const label = translated === `chat.tool.${call.tool}` ? call.tool : translated;
  const targetTag = extractTargetTag(call.args);
  const statusTitle = t(`chat.tool.status.${status === "awaiting_confirmation" ? "awaiting" : status}`);

  return (
    <div className={`chat-tool-row ${status}`} role="group" aria-label={label}>
      <span className="chat-tool-row-icon" aria-hidden="true">
        <ToolGlyph />
      </span>
      <span className="chat-tool-row-label">
        {label}
        {targetTag && <span className="chat-tool-row-target">「{targetTag}」</span>}
      </span>
      <StatusDot status={status} title={statusTitle} />
    </div>
  );
}

/** Try to extract a short, human-readable target label from common tool args. */
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

/** `icon_base-agent-table_outlined` — Figma node 6905:25839.
 * Approximated as a bracket-style "richtext / table agent" mark (two opposing
 * L-corners) that reads as "a tracked table action". 14×14 viewBox. */
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
      <rect
        x="4"
        y="4"
        width="6"
        height="6"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

/** Right-edge status indicator: 16×16. Variants per status. */
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
        <path
          d="M5 5l6 6M11 5l-6 6"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
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
