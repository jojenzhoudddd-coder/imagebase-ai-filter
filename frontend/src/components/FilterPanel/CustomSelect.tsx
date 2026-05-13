import { useState, useRef, useEffect, useMemo, useCallback } from "react";
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
  // Keyboard-highlighted option index in `filteredOptions` order.
  // Order in the visible list === navigation order. Reset on open / query change.
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [open]);

  // Reset search query each time the dropdown reopens; auto-focus the input
  // so users can start typing immediately without an extra click.
  useEffect(() => {
    if (open) {
      // Reset highlight whenever the dropdown opens (whether or not it's searchable
      // — non-searchable dropdowns don't show the highlight visually but using
      // the same hook keeps state predictable).
      setHighlightedIndex(0);
      if (searchable) {
        setQuery("");
        // Defer focus to next frame so the dropdown DOM is mounted first.
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    }
  }, [open, searchable]);

  // Reset highlight to top whenever the query changes — same UX as
  // FieldConfigPanel: typing always lands cursor on the first match.
  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

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

  // Clamp highlight if the visible list shrinks (e.g. user types a very
  // narrow query). Without this, the highlight could hover off the end.
  useEffect(() => {
    if (highlightedIndex >= filteredOptions.length) {
      setHighlightedIndex(filteredOptions.length > 0 ? filteredOptions.length - 1 : 0);
    }
  }, [filteredOptions.length, highlightedIndex]);

  // Scroll the highlighted option into view as the user keys up / down.
  useEffect(() => {
    if (!open) return;
    const target = filteredOptions[highlightedIndex];
    if (!target) return;
    optionRefs.current.get(target.value)?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, filteredOptions, open]);

  // ↑/↓/Enter handler shared by the search input AND the dropdown when there
  // is no search input (e.g. when `searchable=false` we still wire it on the
  // option list container so non-searchable dropdowns also get keyboard nav).
  //
  // IME guard: while a Chinese / Japanese IME composition is active, Enter
  // confirms the candidate and ↑/↓ traverses the candidate list — those
  // events MUST flow to the IME, not us. `e.nativeEvent.isComposing` covers
  // modern browsers; `keyCode === 229` is the legacy placeholder some IMEs
  // still emit on the very first composition keydown.
  const handleNavKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      const len = filteredOptions.length;
      if (len === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((i) => (i + 1) % len);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((i) => (i - 1 + len) % len);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const opt = filteredOptions[highlightedIndex];
        if (opt) {
          onChange(opt.value);
          setOpen(false);
        }
      }
    },
    [filteredOptions, highlightedIndex, onChange],
  );

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
                onKeyDown={(e) => {
                  // While an IME composition is active, every key belongs to
                  // the IME (Enter confirms candidate, Esc cancels, etc.).
                  // Bail out so we don't steal those events.
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  // Escape: first clears query, second closes (autocomplete UX).
                  if (e.key === "Escape") {
                    if (query) {
                      e.preventDefault();
                      setQuery("");
                    } else {
                      setOpen(false);
                    }
                    return;
                  }
                  // Delegate ↑/↓/Enter to the shared nav handler so behavior
                  // stays in sync with the option list itself.
                  handleNavKey(e);
                }}
              />
            </div>
          )}
          <div
            className="cs-options"
            // Non-searchable dropdowns can still receive ↑/↓/Enter via the
            // option container if the user tabs to it — searchable variants
            // have the search input handle keys instead.
            tabIndex={searchable ? -1 : 0}
            onKeyDown={searchable ? undefined : handleNavKey}
          >
            {filteredOptions.length === 0 ? (
              <div className="cs-empty">{t("fieldConfig.noFields")}</div>
            ) : (
              filteredOptions.map((opt, idx) => {
                const isActive = opt.value === value;
                const isHighlighted = idx === highlightedIndex;
                return (
                  <button
                    key={opt.value}
                    ref={(el) => {
                      if (el) optionRefs.current.set(opt.value, el);
                      else optionRefs.current.delete(opt.value);
                    }}
                    type="button"
                    className={`cs-option ${isActive ? "active" : ""} ${isHighlighted ? "is-highlighted" : ""}`}
                    // Sync keyboard cursor to mouse so the two never disagree.
                    onMouseEnter={() => setHighlightedIndex(idx)}
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
