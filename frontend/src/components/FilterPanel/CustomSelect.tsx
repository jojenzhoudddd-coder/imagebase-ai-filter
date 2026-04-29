import { useState, useRef, useEffect, useMemo } from "react";
import { pinyinMatch } from "../../utils/pinyinMatch";
import { useTranslation } from "../../i18n/index";
import "./CustomSelect.css";

interface Option {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  className?: string;
  /** Show a search input at the top of the dropdown with pinyin fuzzy match.
   *  Used by the Filter panel's field selector so users can type a few letters
   *  (incl. pinyin initials) to jump to a field when the table has many. */
  searchable?: boolean;
  /** Placeholder for the search input. Falls back to a translated default. */
  searchPlaceholder?: string;
}

export default function CustomSelect({
  value,
  options,
  onChange,
  className,
  searchable = false,
  searchPlaceholder,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Reset search query each time the dropdown reopens; auto-focus the input
  // so users can start typing immediately without an extra click.
  useEffect(() => {
    if (open && searchable) {
      setQuery("");
      // Defer focus to next frame so the dropdown DOM is mounted first.
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open, searchable]);

  const handleToggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left, minWidth: rect.width });
    }
    setOpen(!open);
  };

  const selected = options.find((o) => o.value === value);

  const filteredOptions = useMemo(() => {
    if (!searchable) return options;
    const q = query.trim();
    if (!q) return options;
    return options.filter((o) => pinyinMatch(o.label, q));
  }, [options, query, searchable]);

  return (
    <div className={`cs-dropdown ${className ?? ""}`} ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="cs-trigger"
        onClick={handleToggle}
      >
        <span className="cs-label">{selected?.label ?? value}</span>
        <svg className="cs-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {open && pos && (
        <div className="cs-list" style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.minWidth }}>
          {searchable && (
            <div className="cs-search">
              <svg className="cs-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                className="cs-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder ?? t("fieldConfig.searchPlaceholder")}
                // Keep dropdown open on Escape only when query is non-empty:
                // first Escape clears, second Escape closes (matches FieldConfigPanel UX).
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    if (query) {
                      e.preventDefault();
                      setQuery("");
                    } else {
                      setOpen(false);
                    }
                  } else if (e.key === "Enter" && filteredOptions.length === 1) {
                    // Enter with exactly one match → pick it.
                    e.preventDefault();
                    onChange(filteredOptions[0].value);
                    setOpen(false);
                  }
                }}
              />
            </div>
          )}
          <div className="cs-options">
            {filteredOptions.length === 0 ? (
              <div className="cs-empty">{t("fieldConfig.noFields")}</div>
            ) : (
              filteredOptions.map((opt) => {
                const isActive = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`cs-option ${isActive ? "active" : ""}`}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    <span>{opt.label}</span>
                    {isActive && (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="cs-check">
                        <path d="M2.5 7l3.5 3.5 5.5-5.5" stroke="#3370FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
