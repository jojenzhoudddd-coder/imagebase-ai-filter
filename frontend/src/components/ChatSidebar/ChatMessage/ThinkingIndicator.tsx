import { useState } from "react";
import { useTranslation } from "../../../i18n";
import { DeepThinkingIcon } from "./toolCategoryIcons";

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
  /** Controlled expanded state for turn-level details toggles. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export default function ThinkingIndicator({
  mode = "active",
  text = "正在分析需求",
  label,
  thinking,
  expanded: controlledExpanded,
  onExpandedChange,
}: Props) {
  const { t } = useTranslation();
  // Default collapsed — the thinking transcript is supplementary context,
  // not the primary answer. Users opt in by clicking.
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(false);
  const expanded = controlledExpanded ?? uncontrolledExpanded;
  const toggleExpanded = () => {
    const next = !expanded;
    if (onExpandedChange) onExpandedChange(next);
    else setUncontrolledExpanded(next);
  };
  const headerLabel = label ?? t("chat.thinking.collapsed");

  if (mode === "collapsed") {
    const hasBody = Boolean(thinking && thinking.trim().length > 0);
    return (
      <div className={`chat-expand-card chat-thinking-card${expanded ? " expanded" : ""}`}>
        <button
          type="button"
          className="chat-expand-card-header"
          onClick={() => hasBody && toggleExpanded()}
          aria-expanded={expanded}
          disabled={!hasBody}
        >
          <span className="chat-expand-card-icon" aria-hidden="true">
            <DeepThinkingIcon />
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

/* DeepThinkIcon moved to toolCategoryIcons.tsx */

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
