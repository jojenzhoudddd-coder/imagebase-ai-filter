/**
 * ThinkingIndicator — model-thinking visual cue.
 *
 * Two modes driven by Figma:
 *
 *   - active (node 6:2990): single caption line "正在分析需求..." in
 *     14/22 #646A73 with an animated ellipsis. Rendered while the model is
 *     still streaming thinking tokens.
 *
 *   - collapsed (node 6:5302): "深度思考" pill with a 28×28 white tool card
 *     hosting the icon_ai-deepthink_outlined glyph (14×14) + the label in
 *     12/20 #646A73. Rendered once thinking is complete and the answer has
 *     begun to stream / has finished.
 *
 * The parent decides which mode to use (based on whether the assistant
 * message still has no content / is still streaming). The label text is
 * configurable so the active caption can surface dynamic progress copy.
 */

interface Props {
  /** 'active' → streaming caption; 'collapsed' → deepthink pill. */
  mode?: "active" | "collapsed";
  /** Caption text while active; defaults to 正在分析需求. */
  text?: string;
  /** Label for the collapsed pill; defaults to 深度思考. */
  label?: string;
}

export default function ThinkingIndicator({
  mode = "active",
  text = "正在分析需求",
  label = "深度思考",
}: Props) {
  if (mode === "collapsed") {
    return (
      <div className="chat-thinking">
        <div className="chat-thinking-pill">
          <span className="chat-thinking-tool" aria-hidden="true">
            <DeepThinkIcon size={14} />
          </span>
          <span className="chat-thinking-label">{label}</span>
        </div>
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
 * Five-row placeholder that mimics the Figma 骨架 (node
 * I6:2993;1688:46937) — a field / field-list preview that hints the
 * agent will soon produce schema output. Widths are staggered (80/65/
 * 90/55/72) so the bars don't look uniform, and the whole block gently
 * pulses via CSS keyframes (see .chat-thinking-skeleton in the stylesheet).
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

/**
 * `icon_ai-deepthink_outlined` — approximation of the Figma glyph.
 * A rounded square with a sparkle / brain-spark motif; 14×14 viewBox so the
 * parent .chat-thinking-tool (28×28) centres it with 7px padding.
 */
function DeepThinkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
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
