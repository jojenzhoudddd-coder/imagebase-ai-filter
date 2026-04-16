import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Field,
  FieldType,
  LookupConfig,
} from "../../types";
import { createField, fetchTables, suggestFields, TableBrief, ApiError, FieldSuggestion } from "../../api";
import { LookupConfigPanel } from "./LookupConfigPanel";
import { useTranslation } from "../../i18n";
import "./FieldConfig.css";

interface Props {
  currentTableId: string;
  currentFields: Field[];
  anchorRect: DOMRect | null;
  onCancel: () => void;
  onConfirm: (newField: Field) => void;
}

interface FieldTypeItem { type: FieldType; icon: string; labelKey: string }
interface FieldTypeGroup { groupKey: string; items: FieldTypeItem[] }

const FIELD_TYPE_GROUPS: FieldTypeGroup[] = [
  {
    groupKey: "fieldType.groupBasic",
    items: [
      { type: "Text",         icon: "AΞ", labelKey: "fieldType.text" },
      { type: "Number",       icon: "#",  labelKey: "fieldType.number" },
      { type: "SingleSelect", icon: "◉", labelKey: "fieldType.singleSelect" },
      { type: "MultiSelect",  icon: "☲", labelKey: "fieldType.multiSelect" },
      { type: "User",         icon: "☻", labelKey: "fieldType.user" },
      { type: "DateTime",     icon: "▥", labelKey: "fieldType.dateTime" },
      { type: "Attachment",   icon: "📎", labelKey: "fieldType.attachment" },
      { type: "Checkbox",     icon: "☑", labelKey: "fieldType.checkbox" },
      { type: "Stage",        icon: "▷", labelKey: "fieldType.stage" },
      { type: "AutoNumber",   icon: "⊕", labelKey: "fieldType.autoNumber" },
      { type: "Url",          icon: "🔗", labelKey: "fieldType.url" },
      { type: "Phone",        icon: "☏", labelKey: "fieldType.phone" },
      { type: "Email",        icon: "✉", labelKey: "fieldType.email" },
      { type: "Location",     icon: "◎", labelKey: "fieldType.location" },
      { type: "Barcode",      icon: "⊞", labelKey: "fieldType.barcode" },
      { type: "Progress",     icon: "▰", labelKey: "fieldType.progress" },
      { type: "Currency",     icon: "¤", labelKey: "fieldType.currency" },
      { type: "Rating",       icon: "★", labelKey: "fieldType.rating" },
    ],
  },
  {
    groupKey: "fieldType.groupSystem",
    items: [
      { type: "CreatedUser",  icon: "◈", labelKey: "fieldType.createdUser" },
      { type: "ModifiedUser", icon: "◇", labelKey: "fieldType.modifiedUser" },
      { type: "CreatedTime",  icon: "◴", labelKey: "fieldType.createdTime" },
      { type: "ModifiedTime", icon: "◵", labelKey: "fieldType.modifiedTime" },
    ],
  },
  {
    groupKey: "fieldType.groupExtended",
    items: [
      { type: "Formula",      icon: "ƒx", labelKey: "fieldType.formula" },
      { type: "SingleLink",   icon: "↗", labelKey: "fieldType.singleLink" },
      { type: "DuplexLink",   icon: "⇄", labelKey: "fieldType.duplexLink" },
      { type: "Lookup",       icon: "▦", labelKey: "fieldType.lookup" },
    ],
  },
  {
    groupKey: "fieldType.groupAI",
    items: [
      { type: "ai_summary",    icon: "⊜", labelKey: "fieldType.aiSummary" },
      { type: "ai_transition", icon: "⊡", labelKey: "fieldType.aiTransition" },
      { type: "ai_extract",    icon: "⊟", labelKey: "fieldType.aiExtract" },
      { type: "ai_classify",   icon: "⊠", labelKey: "fieldType.aiClassify" },
      { type: "ai_tag",        icon: "⊞", labelKey: "fieldType.aiTag" },
      { type: "ai_custom",     icon: "✦", labelKey: "fieldType.aiCustom" },
    ],
  },
];

const ALL_FIELD_ITEMS = FIELD_TYPE_GROUPS.flatMap(g => g.items);

function findTypeIcon(ft: FieldType | string): string {
  return ALL_FIELD_ITEMS.find(i => i.type === ft)?.icon ?? "∎";
}

function findTypeLabelKey(ft: FieldType): string {
  return ALL_FIELD_ITEMS.find(i => i.type === ft)?.labelKey ?? ft;
}

const EMPTY_LOOKUP: LookupConfig = {
  refTableId: "",
  refFieldId: "",
  conditions: [{ refFieldId: "", operator: "eq", valueType: "field", currentFieldId: "" }],
  conditionLogic: "and",
  calcMethod: "original",
  lookupOutputFormat: "default",
};

const PAGE_SIZE = 4;

// ─── AI Suggestions hook ───

function useFieldSuggestions(tableId: string, currentFields: Field[]) {
  const [cache, setCache] = useState<FieldSuggestion[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [titleQuery, setTitleQuery] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const shownNamesRef = useRef<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSuggestions = useCallback(async (title?: string) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    try {
      const res = await suggestFields(
        tableId,
        { title: title || undefined, excludeNames: [...shownNamesRef.current] },
        ac.signal,
      );
      if (!ac.signal.aborted) {
        setCache(res.suggestions);
        setPageIndex(0);
        res.suggestions.forEach(s => shownNamesRef.current.add(s.name));
      }
    } catch {
      // aborted or network error — ignore
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [tableId]);

  // Cold start: fetch on mount
  useEffect(() => {
    fetchSuggestions();
    return () => { abortRef.current?.abort(); };
  }, [fetchSuggestions]);

  // Debounced title change
  const onTitleChange = useCallback((title: string) => {
    setTitleQuery(title);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchSuggestions(title);
    }, 500);
  }, [fetchSuggestions]);

  // Title blur — immediate fetch
  const onTitleBlur = useCallback((title: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (title.trim() && title !== titleQuery) {
      setTitleQuery(title);
      fetchSuggestions(title);
    }
  }, [fetchSuggestions, titleQuery]);

  // Paginated view
  const currentPage = useMemo(() => {
    const start = pageIndex * PAGE_SIZE;
    return cache.slice(start, start + PAGE_SIZE);
  }, [cache, pageIndex]);

  const totalPages = Math.max(1, Math.ceil(cache.length / PAGE_SIZE));

  const refresh = useCallback(() => {
    const nextPage = pageIndex + 1;
    if (nextPage < totalPages) {
      // Still have cached pages
      setPageIndex(nextPage);
    } else {
      // Exhausted cache — re-fetch with excludeNames
      fetchSuggestions(titleQuery || undefined);
    }
  }, [pageIndex, totalPages, fetchSuggestions, titleQuery]);

  return { suggestions: currentPage, loading, refresh, onTitleChange, onTitleBlur };
}

// ─── Main component ───

export function AddFieldPopover({ currentTableId, currentFields, anchorRect, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [fieldType, setFieldType] = useState<FieldType>("Text");
  const [typePickerRect, setTypePickerRect] = useState<DOMRect | null>(null);
  const [lookupConfig, setLookupConfig] = useState<LookupConfig>(EMPTY_LOOKUP);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; path?: string } | null>(null);
  const [allTables, setAllTables] = useState<TableBrief[]>([]);
  const fieldTypeCardRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { suggestions, loading: sugLoading, refresh: sugRefresh, onTitleChange, onTitleBlur } =
    useFieldSuggestions(currentTableId, currentFields);

  useEffect(() => {
    fetchTables().then(setAllTables);
  }, []);

  const cancelHideTimer = () => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  };

  const showTypePicker = () => {
    cancelHideTimer();
    if (typePickerRect) return;
    const r = fieldTypeCardRef.current?.getBoundingClientRect();
    if (r) setTypePickerRect(r);
  };

  const scheduleHide = () => {
    cancelHideTimer();
    hideTimerRef.current = setTimeout(() => setTypePickerRect(null), 150);
  };

  const width = fieldType === "Lookup" ? 484 : 340;
  const style = useMemo(() => {
    if (!anchorRect) return { left: 100, top: 100, width } as React.CSSProperties;
    const rightEdge = anchorRect.right + 12;
    const left = Math.max(16, rightEdge - width);
    const top = anchorRect.bottom + 6;
    return { left, top, width };
  }, [anchorRect, width]);

  const canSubmit = title.trim().length > 0 && !submitting;

  const handleConfirm = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const config =
        fieldType === "Lookup"
          ? { lookup: lookupConfig }
          : fieldType === "DateTime"
          ? { format: "yyyy-MM-dd", includeTime: false }
          : {};
      const newField = await createField(currentTableId, { name: title.trim(), type: fieldType, config });
      onConfirm(newField);
    } catch (e: unknown) {
      const err = e as ApiError;
      setError({ message: err.message || t("addField.createFailed"), path: err.path });
      setSubmitting(false);
    }
  };

  const handleTitleChange = (val: string) => {
    setTitle(val);
    onTitleChange(val);
  };

  const handleSuggestionClick = (s: FieldSuggestion) => {
    setTitle(s.name);
    const ft = ALL_FIELD_ITEMS.find(i => i.type === s.type) ? (s.type as FieldType) : "Text";
    setFieldType(ft);
  };

  const currentTableDesc = useMemo(
    () => ({ id: currentTableId, name: "当前表", fields: currentFields }),
    [currentTableId, currentFields]
  );

  return (
    <div className="field-popover-backdrop" onMouseDown={onCancel}>
      <div
        className="field-popover"
        style={style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="field-popover-body">
          {/* Title */}
          <div className="form-row">
            <label>{t("addField.fieldTitle")}</label>
            <input
              className="fc-input"
              autoFocus
              placeholder={t("addField.fieldTitlePlaceholder")}
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              onBlur={() => onTitleBlur(title)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConfirm();
                if (e.key === "Escape") onCancel();
              }}
            />
          </div>

          {/* AI Suggestions */}
          <div className="form-row">
            <div className="suggest-header">
              <label>{t("addField.aiSuggestions")}</label>
              <button
                type="button"
                className="suggest-refresh"
                onClick={sugRefresh}
                disabled={sugLoading}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className={sugLoading ? "spin" : ""}>
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <path d="M21 3v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {t("addField.refresh")}
              </button>
            </div>
            <div className="suggest-chips">
              {sugLoading && suggestions.length === 0 ? (
                <>
                  <span className="suggest-chip skeleton" />
                  <span className="suggest-chip skeleton" />
                  <span className="suggest-chip skeleton" />
                </>
              ) : suggestions.length > 0 ? (
                suggestions.map((s, i) => (
                  <button
                    key={`${s.name}-${i}`}
                    type="button"
                    className="suggest-chip"
                    onClick={() => handleSuggestionClick(s)}
                  >
                    <span className="suggest-chip-icon">{findTypeIcon(s.type)}</span>
                    {s.name}
                    {s.type.startsWith("ai_") && <span className="suggest-ai-badge">AI</span>}
                  </button>
                ))
              ) : (
                <span className="suggest-empty">{t("addField.aiLoading")}</span>
              )}
            </div>
          </div>

          {/* Field type */}
          <div className="form-row">
            <label>{t("addField.fieldType")}</label>
            <div
              className="field-type-card"
              ref={fieldTypeCardRef}
              onMouseEnter={showTypePicker}
              onMouseLeave={scheduleHide}
            >
              <div className="field-type-row">
                <span className="label">
                  <span style={{ width: 18, fontFamily: "monospace", color: "#51565d" }}>{findTypeIcon(fieldType)}</span>
                  {t(findTypeLabelKey(fieldType))}
                </span>
                <span className="chevron">›</span>
              </div>
              <div className="field-type-row sub">
                <span>{t("addField.exploreShortcuts")} ⓘ</span>
                <span className="chevron">›</span>
              </div>
            </div>
          </div>

          {fieldType === "Lookup" && (
            <LookupConfigPanel
              currentTable={currentTableDesc}
              allTables={allTables}
              config={lookupConfig}
              onChange={setLookupConfig}
            />
          )}
        </div>

        {error && (
          <div className="field-popover-error">
            {error.message}{error.path ? `  (${error.path})` : ""}
          </div>
        )}

        <div className="field-popover-footer">
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>{t("addField.cancel")}</button>
          <button className="btn btn-primary" onClick={handleConfirm} disabled={!canSubmit}>
            {submitting ? t("addField.creating") : t("addField.confirm")}
          </button>
        </div>
      </div>

      {typePickerRect && (
        <TypePicker
          anchorRect={typePickerRect}
          current={fieldType}
          onSelect={(ft) => { cancelHideTimer(); setFieldType(ft); setTypePickerRect(null); }}
          onMouseEnter={cancelHideTimer}
          onMouseLeave={scheduleHide}
        />
      )}
    </div>
  );
}

// ─── Type picker menu ───

interface TypePickerProps {
  anchorRect: DOMRect;
  current: FieldType;
  onSelect: (t: FieldType) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function TypePicker({ anchorRect, current, onSelect, onMouseEnter, onMouseLeave }: TypePickerProps) {
  const { t } = useTranslation();
  const MENU_W = 220;
  const GAP = 4;
  const spaceRight = window.innerWidth - anchorRect.right - GAP - 16;
  const openRight = spaceRight >= MENU_W;
  const menuLeft = openRight
    ? anchorRect.right + GAP
    : anchorRect.left - GAP - MENU_W;
  const top = Math.max(16, Math.min(window.innerHeight - 560, anchorRect.top));

  const bridgeStyle: React.CSSProperties = openRight
    ? { position: "fixed", left: anchorRect.right, top, width: GAP, height: anchorRect.height }
    : { position: "fixed", left: anchorRect.left - GAP, top, width: GAP, height: anchorRect.height };

  return (
    <>
      <div style={bridgeStyle} onMouseEnter={onMouseEnter} />
      <div
        className="type-picker-menu floating"
        style={{ position: "fixed", left: menuLeft, top, width: MENU_W }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {FIELD_TYPE_GROUPS.map(g => (
          <div key={g.groupKey}>
            <div className="type-picker-section">{t(g.groupKey)}</div>
            {g.items.map(item => (
              <div
                key={item.type}
                className={`type-picker-item ${current === item.type ? "active" : ""}`}
                onClick={() => onSelect(item.type)}
              >
                <span className="left">
                  <span className="icon">{item.icon}</span>
                  {t(item.labelKey)}
                </span>
                {current === item.type && <span style={{ color: "#1456f0" }}>✓</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
