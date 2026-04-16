import { useState, useRef, useEffect } from "react";
import "./InlineEdit.css";

interface Props {
  value: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onSave: (newValue: string) => void;
  onCancelEdit: () => void;
  className?: string;
  maxLength?: number;
}

export default function InlineEdit({
  value,
  isEditing,
  onStartEdit,
  onSave,
  onCancelEdit,
  className,
  maxLength = 100,
}: Props) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setDraft(value);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing, value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      onSave(trimmed);
    } else {
      onCancelEdit();
    }
  };

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        className={`inline-edit-input ${className ?? ""}`}
        value={draft}
        maxLength={maxLength}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            inputRef.current?.blur();
          } else if (e.key === "Escape") {
            setDraft(value);
            onCancelEdit();
          }
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <span
      className={`inline-edit-text ${className ?? ""}`}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartEdit();
      }}
    >
      {value}
    </span>
  );
}
