import { useEffect, useRef } from "react";
import { SendIcon, StopIcon } from "./icons";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  disabled?: boolean;
  streaming: boolean;
  placeholder?: string;
}

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

  // Auto-resize textarea up to max-height
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }, [value]);

  const canSend = !disabled && !streaming && value.trim().length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter = newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div className="chat-input-wrap">
      <div className="chat-input-box">
        <textarea
          ref={textareaRef}
          className="chat-input-textarea"
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
        />
        <div className="chat-input-toolbar">
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
          {streaming ? (
            <button
              type="button"
              className="chat-input-send stop"
              onClick={onStop}
              title="停止生成"
            >
              <StopIcon size={10} />
            </button>
          ) : (
            <button
              type="button"
              className="chat-input-send"
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
  );
}
