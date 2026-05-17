import { useEffect, useState } from "react";
import { useTranslation } from "../../../i18n";

/**
 * GeneratingMeta — replaces the old "正在分析需求 · skeleton" placeholder.
 *
 * Two visual states tied to the assistant message lifecycle:
 *
 *   - phase="generating": shown while the turn is in flight. Renders
 *     `Generating · Xs · Y tokens`. The timer ticks client-side every
 *     250ms so the seconds reading stays alive even when no new server
 *     events arrive (e.g. mid-tool-call). The token count is the
 *     cumulative server-reported value from the most recent `turn_usage`
 *     event (server emits after every provider round). If usage hasn't
 *     arrived yet (first 1-2s before any provider response), the count
 *     reads `0 tokens` rather than hiding — keeps the strip's width
 *     stable so the layout doesn't reflow when the first event lands.
 *
 *   - phase="generated": frozen snapshot at the moment `done` arrived,
 *     using the server's authoritative durationMs + totalTokens from the
 *     done payload. Color shifts to muted grey to distinguish "live
 *     metric" from "completed metric".
 *
 * `startedAt` is captured by the parent ChatSidebar at handleSend time
 * (Date.now()) so the timer is consistent across remounts within the
 * same turn. After done, the parent passes `frozenDurationMs` and we
 * stop the timer.
 *
 * Why a separate component (vs. folding into ThinkingIndicator):
 *   - ThinkingIndicator is now ONLY the collapsed thinking-card surface
 *     (post-thinking transcript); the active mode is unused.
 *   - The skeleton-row preview was decorative; the meta strip carries
 *     real signal (time + tokens) which is more useful while waiting.
 *   - Keeping them separate lets us A/B the placeholder UI without
 *     touching the thinking-card (which has different lifecycle).
 */

interface Props {
  /** "generating" while turn is in flight; "generated" after `done`. */
  phase: "generating" | "generated";
  /** UNIX ms when the turn started. Used for the live timer. */
  startedAt: number;
  /** **Completion** tokens for this turn (model output only, not counting
   *  prompt/context which gets re-counted across multi-round tool calls).
   *  Updated live by `turn_usage` events; finalized on `done` payload.
   *  与 timer 类似 —— 是"本次对话轮次的纯增量",不是跨轮的累加和。 */
  completionTokens: number;
  /** Server-reported final duration. ONLY used in "generated" phase. In
   *  "generating" phase the timer is client-side from `startedAt`. */
  frozenDurationMs?: number;
  /** Final assistant message timestamp. Used instead of the word "Generated". */
  generatedAt?: number;
  /** Number of detail/feed cards attached to this turn. */
  detailsCount?: number;
  /** Whether all detail cards for this turn are currently visible/expanded. */
  detailsExpanded?: boolean;
  /** Toggle all detail cards for this turn. */
  onToggleDetails?: () => void;
}

export default function GeneratingMeta({
  phase,
  startedAt,
  completionTokens = 0,
  frozenDurationMs,
  generatedAt,
  detailsCount = 0,
  detailsExpanded = false,
  onToggleDetails,
}: Props) {
  const { t } = useTranslation();
  const [tickMs, setTickMs] = useState<number>(() => Date.now() - startedAt);

  // Client-side timer — ticks while in "generating" phase. We use 250ms
  // resolution: rendering whole seconds, the user sees a smooth update
  // without React rerender storm. requestAnimationFrame would be even
  // smoother but burns more CPU than the visible benefit.
  useEffect(() => {
    if (phase !== "generating") return;
    const id = window.setInterval(() => {
      setTickMs(Date.now() - startedAt);
    }, 250);
    return () => window.clearInterval(id);
  }, [phase, startedAt]);

  const displayMs = phase === "generated" && frozenDurationMs != null
    ? frozenDurationMs
    : tickMs;
  const seconds = Math.max(0, Math.round(displayMs / 1000));

  const label = phase === "generating"
    ? t("chat.meta.generating")
    : formatGeneratedAt(generatedAt ?? (startedAt + (frozenDurationMs ?? 0)));

  // Number formatting: tokens use `,` thousand separators (1,234) so
  // the strip reads naturally even at 100k+ tokens. seconds stays raw.
  // Defensive ?? 0 fallback covers stale localStorage cache from before
  // the totalTokens → completionTokens rename — old shapes deserialize with
  // completionTokens undefined; without this guard `.toLocaleString()` on
  // undefined throws a TypeError that crashes the whole message tree.
  const tokensStr = (completionTokens ?? 0).toLocaleString();

  return (
    <div className={`chat-generating-meta phase-${phase}`}>
      <span className="chat-generating-meta-logo" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <mask id="gm-mask" style={{ maskType: "alpha" }} maskUnits="userSpaceOnUse" x="0" y="0" width="14" height="14">
            <path d="M14 14H0V0H14V14ZM7 3.5C6.89336 3.5 6.8057 3.58335 6.79199 3.69043C6.75844 3.95746 6.69592 4.21622 6.6084 4.46191L6.48633 4.76172C6.1296 5.537 5.51051 6.16407 4.74512 6.52539L4.44922 6.64844L4.35254 6.68262C4.12548 6.75818 3.88808 6.81145 3.64355 6.83984C3.56276 6.8494 3.5 6.91757 3.5 7C3.5 7.08243 3.56276 7.1506 3.64355 7.16016L3.74805 7.17383C3.99038 7.20929 4.22507 7.2697 4.44922 7.35156L4.74512 7.47461C5.51051 7.83593 6.1296 8.463 6.48633 9.23828L6.6084 9.53809C6.69592 9.78378 6.75844 10.0425 6.79199 10.3096L6.7998 10.3477C6.82324 10.423 6.88498 10.4811 6.96094 10.4961L7 10.5C7.09348 10.5 7.17286 10.4356 7.2002 10.3477L7.20801 10.3096C7.24156 10.0425 7.30408 9.78378 7.3916 9.53809L7.51367 9.23828C7.8704 8.463 8.48949 7.83593 9.25488 7.47461L9.55078 7.35156C9.79539 7.26223 10.0524 7.19883 10.3184 7.16504L10.3564 7.16016C10.4271 7.15181 10.4839 7.09858 10.4971 7.03027L10.5 7C10.5 6.91757 10.4372 6.8494 10.3564 6.83984C10.1119 6.81145 9.87452 6.75818 9.64746 6.68262L9.55078 6.64844L9.25488 6.52539C8.48949 6.16407 7.8704 5.537 7.51367 4.76172L7.3916 4.46191C7.30408 4.21622 7.24156 3.95746 7.20801 3.69043C7.1943 3.58335 7.10664 3.5 7 3.5Z" fill="#D9D9D9"/>
          </mask>
          <g mask="url(#gm-mask)">
            <path d="M7.4375 6.5625V1.75C7.4375 0.783502 8.221 4.93259e-08 9.1875 0H14L7.4375 6.5625Z" fill="#0E42D2" fillOpacity="0.9"/>
            <path d="M7.875 6.56172C7.875 6.56172 12.8021 6.51841 12.986 6.52544C13.17 6.53248 13.4435 6.56171 13.4435 6.56171L13.1924 6.32626L10.6436 3.79309L7.875 6.56172Z" fill="#C9CDD4" fillOpacity="0.9"/>
            <path d="M7.4375 7.4375L12.25 7.4375C13.2165 7.4375 14 8.221 14 9.1875L14 14L7.4375 7.4375Z" fill="#E8F3FF" fillOpacity="0.9"/>
            <path d="M7.43816 7.875C7.43816 7.875 7.48147 12.8021 7.47444 12.986C7.4674 13.17 7.43817 13.4435 7.43817 13.4435L7.67362 13.1924L10.2068 10.6436L7.43816 7.875Z" fill="#BEDAFF" fillOpacity="0.9"/>
            <path d="M6.5625 7.4375L6.5625 12.25C6.5625 13.2165 5.779 14 4.8125 14H0L6.5625 7.4375Z" fill="#94BFFF" fillOpacity="0.9"/>
            <path d="M6.125 7.43828C6.125 7.43828 1.19793 7.48159 1.01396 7.47456C0.829979 7.46752 0.55654 7.43829 0.55654 7.43829L0.807629 7.67374L3.35639 10.2069L6.125 7.43828Z" fill="#6AA1FF" fillOpacity="0.9"/>
            <path d="M6.5625 6.5625H1.75C0.783502 6.5625 4.93259e-08 5.779 0 4.8125L0 0L6.5625 6.5625Z" fill="#4080FF" fillOpacity="0.9"/>
            <path d="M6.56184 6.125C6.56184 6.125 6.51853 1.19793 6.52556 1.01396C6.5326 0.829979 6.56183 0.55654 6.56183 0.55654L6.32638 0.807629L3.79321 3.35639L6.56184 6.125Z" fill="#165DFF" fillOpacity="0.9"/>
          </g>
        </svg>
      </span>
      <span className="chat-generating-meta-label">{label}</span>
      <span className="chat-generating-meta-sep">·</span>
      <span className="chat-generating-meta-time">
        {seconds}
        <span className="chat-generating-meta-unit">{t("chat.meta.seconds")}</span>
      </span>
      <span className="chat-generating-meta-sep">·</span>
      <span className="chat-generating-meta-tokens">
        {tokensStr}
        <span className="chat-generating-meta-unit"> {t("chat.meta.tokens")}</span>
      </span>
      <span className="chat-generating-meta-sep">·</span>
      <button
        type="button"
        className={`chat-generating-meta-details${detailsExpanded ? " expanded" : ""}`}
        onClick={onToggleDetails}
        disabled={!onToggleDetails}
        aria-pressed={detailsExpanded}
      >
        {detailsCount.toLocaleString()} details
      </button>
    </div>
  );
}

function formatGeneratedAt(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}
