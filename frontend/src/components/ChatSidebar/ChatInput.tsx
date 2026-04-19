import { useCallback, useEffect, useRef } from "react";
import { AtIcon, MicIcon, SendIcon, StopIcon } from "./icons";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition";
import { useTranslation } from "../../i18n";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  disabled?: boolean;
  streaming: boolean;
  placeholder?: string;
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
}: Props) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    onChange(e.target.value);
  };

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
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            placeholder={placeholder ?? t("chat.input.placeholder")}
            disabled={disabled}
          />
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
