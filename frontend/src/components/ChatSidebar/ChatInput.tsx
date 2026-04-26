import { useCallback, useEffect, useRef, useState } from "react";
import { AtIcon, MicIcon, SendIcon, StopIcon } from "./icons";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition";
import { useTranslation } from "../../i18n";
import MentionPicker from "../Mention/MentionPicker";
import { buildMentionLink } from "../Mention/mentionSyntax";
import type { MentionHit } from "../../types";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  disabled?: boolean;
  streaming: boolean;
  placeholder?: string;
  /** Workspace id powering the @-mention picker. PR2: chat input gains the
   *  same picker as IdeaEditor + adds `model` type for "force-use" hints. */
  workspaceId: string;
}

/**
 * Mention query state — open when user typed `@` and is editing the query
 * suffix (until they hit space / Esc / pick). `triggerOffset` is the position
 * of the `@` glyph in the textarea value;`anchorRect` is the textarea's
 * bottom-left in viewport pixels (we anchor the picker to the textarea, not
 * to the caret — caret-tracking in a `<textarea>` requires a mirror div and
 * is overkill for chat input).
 */
interface MentionQueryState {
  triggerOffset: number;
  query: string;
  anchorRect: { left: number; right: number; top: number; bottom: number };
}

/**
 * ChatInput — pixel-aligned to Figma node 1:19143 "AI_Input_Area".
 *
 * Layout:
 *   wrap  ─ pb-14 px-14, hosts an 11px white→transparent fade on its top edge
 *           (CSS ::before) so the input blends into the scrollable messages
 *           area above.
 *   box   ─ white, 0.5px #DEE0E3 border, 16px radius, 3-layer drop shadow,
 *           pt-12. Two rows:
 *             1. content row (px-14) with the textarea
 *             2. action row (h-52, p-12, gap-16, items-end justify-end)
 *                - left pill: 28×28 rounded-100 @ mention button
 *                - right:     28×28 rounded-16 send button (grey idle → blue
 *                             primary when canSend, red when streaming=stop)
 */
export default function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  disabled,
  streaming,
  placeholder,
  workspaceId,
}: Props) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // ── Mention picker state (PR2) ──
  const [mentionState, setMentionState] = useState<MentionQueryState | null>(null);

  // Picker is anchored to the textarea's bounding rect (not the caret) —
  // chat input has limited width so a textarea-anchored picker is plenty
  // findable without the cost of a mirror-div caret tracker.
  const computeAnchorRect = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return { left: 0, right: 0, top: 0, bottom: 0 };
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }, []);

  /**
   * Re-detect mention state from a new (value, caret) pair. Walks left from
   * the caret looking for a recent `@`. Bails out when:
   *   - caret is at start (no `@` to find)
   *   - we hit whitespace before finding `@` (the `@` is not the active one)
   *   - we hit a `]` (the `@` is part of a mention markdown link `[@x](…)`)
   *   - we hit another `@` (the previous one is the active query, not this)
   */
  const recomputeMentionState = useCallback((newValue: string, caret: number) => {
    if (caret === 0) {
      setMentionState(null);
      return;
    }
    let i = caret - 1;
    while (i >= 0) {
      const ch = newValue[i];
      if (ch === "@") {
        // Found candidate. Validate it's not the `@` inside a mention chip
        // markdown (i.e. the char before isn't `[`).
        const prev = i > 0 ? newValue[i - 1] : "";
        if (prev === "[") {
          setMentionState(null);
          return;
        }
        const query = newValue.slice(i + 1, caret);
        // Reject if the query contains whitespace (means user has moved past
        // the @ context and is just typing prose).
        if (/\s/.test(query)) {
          setMentionState(null);
          return;
        }
        setMentionState({
          triggerOffset: i,
          query,
          anchorRect: computeAnchorRect(),
        });
        return;
      }
      // Bail-out characters
      if (ch === "\n" || ch === " " || ch === "\t" || ch === "]") {
        setMentionState(null);
        return;
      }
      i--;
    }
    setMentionState(null);
  }, [computeAnchorRect]);

  // ── Voice input (reused from FilterPanel) ──
  // We preserve whatever the user had typed before starting voice so the
  // transcript appends rather than replaces. Long-press space also triggers
  // voice for parity with the AI filter input.
  //
  // Space-key strategy: we ALWAYS preventDefault on a space keydown while
  // the input is focused, then re-inject a literal " " only on a short-tap
  // release (<500ms). A long-press (≥500ms) starts voice recognition and
  // the space character is silently dropped so it doesn't leak into the
  // textarea / recorded transcript.
  const queryBeforeVoiceRef = useRef("");
  const spaceHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once the long-press timer has fired (so keyup must NOT re-inject
  // a space character — the keystroke has been "consumed" by voice).
  const spaceConsumedRef = useRef(false);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const {
    isSupported: speechSupported,
    isListening,
    isStopping,
    start: startSpeech,
    stop: stopSpeech,
  } = useSpeechRecognition({
    lang: "zh-CN",
    onResult: (text) => {
      onChange(queryBeforeVoiceRef.current + text);
    },
  });

  const toggleVoice = useCallback(() => {
    if (isListening) {
      stopSpeech();
    } else {
      queryBeforeVoiceRef.current = value;
      startSpeech();
    }
  }, [isListening, value, startSpeech, stopSpeech]);

  // Auto-resize textarea up to max-height
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }, [value]);

  const canSend = !disabled && !streaming && value.trim().length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Space handling — only intercept when voice is a plausible action.
    // We preventDefault to hold back the character; keyup decides whether
    // to re-inject it (short-tap) or drop it (long-press → voice started).
    if (e.key === " " && speechSupported && !streaming && !disabled) {
      e.preventDefault();
      // Suppress browser key repeat — we only care about the first down.
      if (e.repeat) return;
      if (isListening) {
        // Already recording — swallow repeated spacebar presses.
        spaceConsumedRef.current = true;
        return;
      }
      if (!spaceHoldTimerRef.current) {
        spaceHoldTimerRef.current = setTimeout(() => {
          spaceHoldTimerRef.current = null;
          spaceConsumedRef.current = true;
          queryBeforeVoiceRef.current = valueRef.current;
          startSpeech();
        }, 500);
      }
      return;
    }
    // Enter sends; Shift+Enter = newline.
    // Skip when the IME is still composing (e.g. Chinese pinyin): the first
    // Enter should commit the candidate, not submit the message. Browsers
    // expose this via `isComposing` on the native event; legacy fallback is
    // keyCode 229 (set while composition is active in older engines).
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      e.keyCode !== 229
    ) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== " ") return;
    if (spaceHoldTimerRef.current) {
      // Short-tap (<500ms) — cancel the voice timer and insert a literal
      // space at the current caret position (simulating the character we
      // swallowed on keydown).
      clearTimeout(spaceHoldTimerRef.current);
      spaceHoldTimerRef.current = null;
      const el = textareaRef.current;
      if (el) {
        const start = el.selectionStart ?? value.length;
        const end = el.selectionEnd ?? value.length;
        const next = value.slice(0, start) + " " + value.slice(end);
        onChange(next);
        // Restore caret after the inserted space on the next tick (React
        // re-render resets selection otherwise).
        const caret = start + 1;
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.selectionStart = caret;
            textareaRef.current.selectionEnd = caret;
          }
        });
      }
      spaceConsumedRef.current = false;
    } else if (isListening || spaceConsumedRef.current) {
      // Long-press release → stop recording. The space keyup default is
      // harmless (no character inserted) but we still flag this keystroke
      // as consumed so no trailing " " slips through.
      e.preventDefault();
      if (isListening) stopSpeech();
      spaceConsumedRef.current = false;
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value;
    onChange(newVal);
    const caret = e.target.selectionStart ?? newVal.length;
    recomputeMentionState(newVal, caret);
  };

  // Caret movement (arrow keys / click) without value change still affects
  // mention state — re-evaluate after these too.
  const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    recomputeMentionState(el.value, el.selectionStart ?? el.value.length);
  };

  const handleMentionSelect = useCallback((hit: MentionHit) => {
    const ms = mentionState;
    if (!ms) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    // Replace the `@<query>` segment with the markdown mention link.
    const before = value.slice(0, ms.triggerOffset);
    const after = value.slice(caret);
    const link = buildMentionLink(hit);
    const next = `${before}${link} ${after}`;
    onChange(next);
    setMentionState(null);
    // Restore caret AFTER the inserted link + trailing space.
    const newCaret = before.length + link.length + 1;
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      try {
        ta.setSelectionRange(newCaret, newCaret);
      } catch { /* */ }
    });
  }, [mentionState, value, onChange]);

  const handleMentionClose = useCallback(() => setMentionState(null), []);

  return (
    <div className="chat-input-wrap">
      <div className="chat-input-box">
        <div className="chat-input-content">
          <textarea
            ref={textareaRef}
            className="chat-input-textarea"
            rows={1}
            value={value}
            onChange={handleChange}
            onSelect={handleSelect}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            placeholder={placeholder ?? t("chat.input.placeholder")}
            disabled={disabled}
          />
          {mentionState && (
            <MentionPicker
              workspaceId={workspaceId}
              query={mentionState.query}
              atRect={mentionState.anchorRect}
              types={["model", "table", "design", "taste", "idea", "idea-section"]}
              onSelect={handleMentionSelect}
              onClose={handleMentionClose}
            />
          )}
        </div>
        <div className="chat-input-toolbar">
          <div className="chat-input-tools-left">
            <button
              type="button"
              className="chat-input-mention-btn"
              title={t("chat.input.mention")}
              aria-label={t("chat.input.mention")}
            >
              <AtIcon size={14} />
            </button>
          </div>
          <div className="chat-input-tools-right">
            {streaming && (
              <span className="chat-generating-hint">
                <span className="chat-thinking-dots">
                  <span />
                  <span />
                  <span />
                </span>
                {t("chat.input.generating")}
              </span>
            )}
            {/* Voice button sits immediately to the LEFT of send, inside the
             * right-aligned cluster. Hidden while streaming (the stop button
             * takes the slot). */}
            {speechSupported && !streaming && (
              <button
                type="button"
                className={`chat-input-voice-btn${
                  isListening ? (isStopping ? " stopping" : " listening") : ""
                }`}
                onClick={toggleVoice}
                disabled={isStopping || disabled}
                title={
                  isStopping
                    ? t("chat.input.voice.stopping")
                    : isListening
                      ? t("chat.input.voice.listening")
                      : t("chat.input.voice.idle")
                }
                aria-label={t("chat.input.voice.idle")}
              >
                <MicIcon size={14} />
                {isListening && !isStopping && <span className="chat-input-voice-pulse" />}
                {isStopping && <span className="chat-input-voice-stopping" />}
              </button>
            )}
            {streaming ? (
              <button
                type="button"
                className="chat-input-send stop"
                onClick={onStop}
                title={t("chat.input.stop")}
                aria-label={t("chat.input.stop")}
              >
                <StopIcon size={12} />
              </button>
            ) : (
              <button
                type="button"
                className="chat-input-send primary"
                onClick={onSend}
                disabled={!canSend}
                title={t("chat.input.send")}
                aria-label={t("chat.input.send")}
              >
                <SendIcon size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
