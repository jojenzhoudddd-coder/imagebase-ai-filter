import { useCallback, useEffect, useRef } from "react";
import { AtIcon, MicIcon, SendIcon, StopIcon } from "./icons";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition";

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
  placeholder = "输入你的问题",
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Voice input (reused from FilterPanel) ──
  // We preserve whatever the user had typed before starting voice so the
  // transcript appends rather than replaces. Long-press space also triggers
  // voice for parity with the AI filter input.
  const queryBeforeVoiceRef = useRef("");
  const spaceHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    // Long-press space (500ms) → enter voice input (mirrors FilterPanel).
    if (e.key === " " && speechSupported && !isListening && !streaming && !disabled) {
      if (!spaceHoldTimerRef.current && !e.repeat) {
        spaceHoldTimerRef.current = setTimeout(() => {
          spaceHoldTimerRef.current = null;
          queryBeforeVoiceRef.current = value;
          startSpeech();
        }, 500);
      }
    }
    // Enter sends; Shift+Enter = newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === " ") {
      if (spaceHoldTimerRef.current) {
        clearTimeout(spaceHoldTimerRef.current);
        spaceHoldTimerRef.current = null;
      } else if (isListening) {
        stopSpeech();
      }
    }
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
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            placeholder={placeholder}
            disabled={disabled}
          />
        </div>
        <div className="chat-input-toolbar">
          <div className="chat-input-tools-left">
            <button
              type="button"
              className="chat-input-mention-btn"
              title="提及"
              aria-label="提及"
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
                生成中
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
                    ? "正在结束录音…"
                    : isListening
                      ? "停止语音输入"
                      : "语音输入（长按空格）"
                }
                aria-label="语音输入"
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
                title="停止生成"
              >
                <StopIcon size={12} />
              </button>
            ) : (
              <button
                type="button"
                className="chat-input-send primary"
                onClick={onSend}
                disabled={!canSend}
                title="发送"
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
