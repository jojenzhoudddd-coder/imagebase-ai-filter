import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "../../i18n/index";
import "./SearchInput.css";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onEscape?: () => void;
  className?: string;
}

export default function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus = false,
  onEscape,
  className = "",
}: Props) {
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder || t("search.placeholder");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocus]);

  const handleClear = useCallback(() => {
    onChange("");
    inputRef.current?.focus();
  }, [onChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        if (value) {
          onChange("");
        } else {
          onEscape?.();
        }
      }
    },
    [value, onChange, onEscape]
  );

  return (
    <div className={`search-input ${value ? "has-value" : ""} ${className}`}>
      <SearchIcon />
      <input
        ref={inputRef}
        type="text"
        className="search-input-field"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={resolvedPlaceholder}
      />
      {value && (
        <button
          className="search-input-clear"
          onClick={handleClear}
          type="button"
          tabIndex={-1}
        >
          <ClearIcon />
        </button>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg className="search-input-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10ZM14 14l-3.25-3.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M18 6 6 18M6 6l12 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
