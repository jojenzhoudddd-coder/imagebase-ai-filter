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
  /** Cumulative tokens from the latest server `turn_usage` (live mode)
   *  or the final `done` payload (completed mode). */
  totalTokens: number;
  /** Server-reported final duration. ONLY used in "generated" phase. In
   *  "generating" phase the timer is client-side from `startedAt`. */
  frozenDurationMs?: number;
}

export default function GeneratingMeta({
  phase,
  startedAt,
  totalTokens,
  frozenDurationMs,
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
    : t("chat.meta.generated");

  // Number formatting: tokens use `,` thousand separators (1,234) so
  // the strip reads naturally even at 100k+ tokens. seconds stays raw.
  const tokensStr = totalTokens.toLocaleString();

  return (
    <div className={`chat-generating-meta phase-${phase}`}>
      <span className="chat-generating-meta-pulse" aria-hidden="true" />
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
    </div>
  );
}
