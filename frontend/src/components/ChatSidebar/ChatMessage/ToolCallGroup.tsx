import { useState } from "react";
import type { ChatToolCall } from "../../../api";
import { useTranslation } from "../../../i18n";
import ToolCallCard from "./ToolCallCard";

/**
 * ToolCallGroup — collapses consecutive tool calls of the same type into a
 * single expandable header row. Defaults to COLLAPSED because long action
 * sessions (e.g. creating 10 fields in a row) would otherwise swamp the
 * transcript with near-identical rows.
 *
 * Visual: same row skin as ToolCallCard (Figma 6905:40884). The right edge
 * shows a count badge + chevron indicator instead of a status dot. Clicking
 * anywhere on the header toggles the group.
 */
export default function ToolCallGroup({
  tool,
  items,
}: {
  tool: string;
  items: ChatToolCall[];
}) {
  const { t } = useTranslation();
  // Default collapsed — per user requirement ("当有多个同类动作时，默认收起").
  const [expanded, setExpanded] = useState(false);

  const translated = t(`chat.tool.${tool}`);
  const label = translated === `chat.tool.${tool}` ? tool : translated;

  // Overall status: error > running > awaiting > success
  const status = deriveGroupStatus(items);

  return (
    <div className="chat-tool-group" data-tool={tool}>
      <button
        type="button"
        className={`chat-tool-row chat-tool-group-header ${status}${expanded ? " expanded" : ""}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="chat-tool-row-icon" aria-hidden="true">
          <GroupGlyph />
        </span>
        <span className="chat-tool-row-label">
          {label}
          <span className="chat-tool-row-count">· {t("chat.tool.groupCount", { count: items.length })}</span>
        </span>
        <ChevronIcon expanded={expanded} title={expanded ? t("chat.tool.collapse") : t("chat.tool.expand")} />
      </button>
      {expanded && (
        <div className="chat-tool-group-children">
          {items.map((it) => (
            <ToolCallCard key={it.callId} call={it} />
          ))}
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

/** Group icon — stacked-rows glyph hinting "multiple items". 14×14. */
function GroupGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="10" height="2.2" rx="0.6" stroke="currentColor" strokeWidth="1.1" />
      <rect x="2" y="6" width="10" height="2.2" rx="0.6" stroke="currentColor" strokeWidth="1.1" />
      <rect x="2" y="9.5" width="10" height="2.2" rx="0.6" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

/** Expand/collapse chevron. Flips 180° via CSS transform when expanded. */
function ChevronIcon({ expanded, title }: { expanded: boolean; title?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className={`chat-tool-row-chevron${expanded ? " expanded" : ""}`}
      aria-label={title}
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
