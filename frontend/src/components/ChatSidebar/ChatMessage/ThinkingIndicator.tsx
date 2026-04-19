import { useState } from "react";
import { useTranslation } from "../../../i18n";

/**
 * ThinkingIndicator — model "deep thinking" surface.
 *
 * Two visual modes:
 *
 *   - active: the agent is still streaming thinking tokens and no answer
 *     has begun yet. Shows an animated caption line + skeleton preview.
 *
 *   - collapsed: thinking finished (or the full message is settled). Renders
 *     an expandable card with a header ("深度思考" + deepthink icon +
 *     chevron). Click the header to reveal the raw thinking transcript
 *     inside, anchored to a left accent bar so it reads like a quoted aside.
 *
 * The parent picks the mode based on whether the assistant message has
 * started producing answer tokens; we show whichever surface fits.
 */

interface Props {
  mode?: "active" | "collapsed";
  /** Caption text while active; defaults to 正在分析需求. */
  text?: string;
  /** Label for the collapsed card header; defaults to 深度思考. */
  label?: string;
  /** Full thinking transcript rendered inside the expanded card body. */
  thinking?: string;
}

export default function ThinkingIndicator({
  mode = "active",
  text = "正在分析需求",
  label,
  thinking,
}: Props) {
  const { t } = useTranslation();
  // Default collapsed — the thinking transcript is supplementary context,
  // not the primary answer. Users opt in by clicking.
  const [expanded, setExpanded] = useState(false);
  const headerLabel = label ?? t("chat.thinking.collapsed");

  if (mode === "collapsed") {
    const hasBody = Boolean(thinking && thinking.trim().length > 0);
    return (
      <div className={`chat-expand-card chat-thinking-card${expanded ? " expanded" : ""}`}>
        <button
          type="button"
          className="chat-expand-card-header"
          onClick={() => hasBody && setExpanded((v) => !v)}
          aria-expanded={expanded}
          disabled={!hasBody}
        >
          <span className="chat-expand-card-icon" aria-hidden="true">
            <DeepThinkIcon size={14} />
          </span>
          <span className="chat-expand-card-title">{headerLabel}</span>
          {hasBody && <Chevron expanded={expanded} />}
        </button>
        {expanded && hasBody && (
          <div className="chat-expand-card-body chat-thinking-body">
            {/* Trim — ARK often prefixes thinking with "\n" and trails with
             * whitespace; rendering those verbatim shows as empty rows at
             * the top/bottom of the body since we use pre-wrap. */}
            <p className="chat-thinking-body-text">{thinking?.trim()}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="chat-thinking active">
      <span className="chat-thinking-caption">{text}</span>
      <SkeletonPreview />
    </div>
  );
}

/**
 * Five-row placeholder mimicking a schema preview. Gentle opacity pulse
 * hints the model is still working. See .chat-thinking-skeleton in the
 * stylesheet for keyframes.
 */
function SkeletonPreview() {
  const rows: Array<"w-80" | "w-65" | "w-90" | "w-55" | "w-72"> = [
    "w-80",
    "w-65",
    "w-90",
    "w-55",
    "w-72",
  ];
  return (
    <div className="chat-thinking-skeleton" aria-hidden="true">
      {rows.map((w, i) => (
        <div key={i} className={`chat-thinking-skeleton-row ${w}`}>
          <span className="chat-thinking-skeleton-icon" />
          <span className="chat-thinking-skeleton-bar" />
        </div>
      ))}
    </div>
  );
}

/** icon_ai-deepthink — approximation of the Figma glyph. Sparkle + dot. */
function DeepThinkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 2.2c.18 0 .34.12.4.29l.62 1.96c.13.4.45.72.86.86l1.96.62c.35.12.35.6 0 .72l-1.96.62c-.4.13-.72.45-.86.86l-.62 1.96c-.06.17-.22.29-.4.29s-.34-.12-.4-.29l-.62-1.96c-.13-.4-.45-.72-.86-.86l-1.96-.62c-.35-.12-.35-.6 0-.72l1.96-.62c.4-.13.72-.45.86-.86l.62-1.96c.06-.17.22-.29.4-.29z"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <circle cx="11" cy="11" r="1.3" stroke="currentColor" strokeWidth="1" />
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
