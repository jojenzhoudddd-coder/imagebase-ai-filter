import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Field,
  FieldType,
  LookupConfig,
  SelectOption,
} from "../../types";
import { createField, updateField, fetchTables, suggestFields, withClientId, TableBrief, ApiError, FieldSuggestion } from "../../api";
import { LookupConfigPanel } from "./LookupConfigPanel";
import { FieldIcon } from "./FieldIcons";
import CustomSelect from "../FilterPanel/CustomSelect";
import { useTranslation } from "../../i18n";
import "./FieldConfig.css";

interface Props {
  currentTableId: string;
  currentFields: Field[];
  anchorRect: DOMRect | null;
  onCancel: () => void;
  onConfirm: (newField: Field) => void;
  fieldSuggestions: FieldSuggestionsState;
  editingField?: Field;
  /**
   * 可选:覆盖 mutation 携带的 X-Client-Id。
   * Magic Canvas 多 block 场景下,每个 TableArtifactSurface 实例传入自己的
   * instanceClientId,使 SSE 自身回声过滤逐 block 独立——同 table 双开时
   * 一边编辑另一边能立即同步。
   */
  clientId?: string;
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

const PAGE_SIZE = 8;

// ─── AI Suggestions hook ───
// 默认 lazy:不自动 fetch,等 AddFieldPopover 实际打开时再调一次 LLM
// (旧行为是每次 tableId 变化都立刻打 LLM,Magic Canvas 多 block + StrictMode
// 双挂载会放大 N 倍;且 LLM 503 时还会拖慢整个 table 渲染)。
// 用 `{autoFetch:true}` 可以恢复旧行为(目前没有调用方需要)。

export function useFieldSuggestions(tableId: string, opts?: { autoFetch?: boolean }) {
  const autoFetch = opts?.autoFetch ?? false;
  const [cache, setCache] = useState<FieldSuggestion[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const shownNamesRef = useRef<Set<string>>(new Set());

  const fetchSuggestions = useCallback(async (innerOpts?: { excludeNames?: string[]; forceRefresh?: boolean }) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    try {
      const res = await suggestFields(
        tableId,
        {
          excludeNames: innerOpts?.excludeNames ?? [...shownNamesRef.current],
          forceRefresh: innerOpts?.forceRefresh,
        },
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

  // Reset state when tableId changes; only auto-fetch if explicitly opted-in
  useEffect(() => {
    setCache([]);
    setPageIndex(0);
    shownNamesRef.current = new Set();
    if (autoFetch) fetchSuggestions({ excludeNames: [] });
    return () => { abortRef.current?.abort(); };
  }, [tableId, autoFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Paginated view
  const currentPage = useMemo(() => {
    const start = pageIndex * PAGE_SIZE;
    return cache.slice(start, start + PAGE_SIZE);
  }, [cache, pageIndex]);

  const totalPages = Math.max(1, Math.ceil(cache.length / PAGE_SIZE));

  const refresh = useCallback(() => {
    const nextPage = pageIndex + 1;
    if (nextPage < totalPages) {
      // Still have cached pages — instant switch
      setPageIndex(nextPage);
    } else {
      // Exhausted cache — force new LLM call, show loading
      setCache([]);
      setPageIndex(0);
      shownNamesRef.current = new Set();
      fetchSuggestions({ forceRefresh: true });
    }
  }, [pageIndex, totalPages, fetchSuggestions]);

  return { suggestions: currentPage, loading, refresh, fetchSuggestions, hasFetched: cache.length > 0 || loading };
}

export interface FieldSuggestionsState {
  suggestions: FieldSuggestion[];
  loading: boolean;
  refresh: () => void;
  /** 触发首次 fetch —— AddFieldPopover 打开时会调一次,实现 lazy 加载 */
  fetchSuggestions: (opts?: { excludeNames?: string[]; forceRefresh?: boolean }) => Promise<void>;
  /** 是否已经至少 fetch 过一次(包含 loading 中)—— 用于决定是否需要 lazy 触发 */
  hasFetched: boolean;
}

// ─── Main component ───

export function AddFieldPopover({ currentTableId, currentFields, anchorRect, onCancel, onConfirm, fieldSuggestions, editingField, clientId }: Props) {
  const isEdit = !!editingField;
  const { t } = useTranslation();
  const [title, setTitle] = useState(editingField?.name ?? "");
  const [fieldType, setFieldType] = useState<FieldType>(editingField?.type ?? "Text");
  const [typePickerAnchor, setTypePickerAnchor] = useState<{ card: DOMRect; popover: DOMRect } | null>(null);
  const [lookupConfig, setLookupConfig] = useState<LookupConfig>(EMPTY_LOOKUP);
  const [dateFormat, setDateFormat] = useState(editingField?.config?.format ?? "yyyy-MM-dd");
  const [numberFormat, setNumberFormat] = useState(editingField?.config?.format ?? "decimal_1");
  const [selectOptions, setSelectOptions] = useState<SelectOption[]>(editingField?.config?.options ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; path?: string } | null>(null);
  const [allTables, setAllTables] = useState<TableBrief[]>([]);
  const fieldTypeCardRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { suggestions, loading: sugLoading, refresh: sugRefresh, fetchSuggestions, hasFetched } = fieldSuggestions;

  useEffect(() => {
    fetchTables().then(setAllTables);
  }, []);

  // Lazy 触发 AI suggestions —— 仅在 popover 打开 (此组件 mount) 且尚未 fetch 时调一次。
  // 这样 TableArtifactSurface 普通渲染不会产生 LLM 调用,直到用户真正点 "+ 加字段"。
  // 编辑模式不需要 suggestions(只是改字段名/类型)。
  useEffect(() => {
    if (isEdit) return;
    if (hasFetched) return;
    fetchSuggestions({ excludeNames: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelHideTimer = () => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  };

  const showTypePicker = () => {
    cancelHideTimer();
    if (typePickerAnchor) return;
    const card = fieldTypeCardRef.current?.getBoundingClientRect();
    const popover = popoverRef.current?.getBoundingClientRect();
    if (card && popover) setTypePickerAnchor({ card, popover });
  };

  const scheduleHide = () => {
    cancelHideTimer();
    hideTimerRef.current = setTimeout(() => setTypePickerAnchor(null), 150);
  };

  const width = fieldType === "Lookup" ? 484 : 320;
  const style = useMemo(() => {
    if (!anchorRect) return { left: 100, top: 100, width } as React.CSSProperties;
    // Default: left-align with anchor; shift left if overflows right edge (16px margin)
    const maxLeft = window.innerWidth - width - 16;
    const left = Math.max(16, Math.min(anchorRect.left, maxLeft));
    const top = anchorRect.bottom + 6;
    return { left, top, width };
  }, [anchorRect, width]);

  const canSubmit = title.trim().length > 0 && !submitting;

  const handleConfirm = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      if (isEdit) {
        // Edit mode: update existing field
        const dto: Record<string, any> = {};
        if (title.trim() !== editingField.name) dto.name = title.trim();
        if (fieldType !== editingField.type) dto.type = fieldType;
        // Persist format config changes
        const isDateType = fieldType === "DateTime" || fieldType === "CreatedTime" || fieldType === "ModifiedTime";
        const isSelectType = fieldType === "SingleSelect" || fieldType === "MultiSelect";
        if (isDateType && dateFormat !== (editingField.config?.format ?? "yyyy-MM-dd")) {
          dto.config = { format: dateFormat };
        }
        if (fieldType === "Number" && numberFormat !== (editingField.config?.format ?? "decimal_1")) {
          dto.config = { format: numberFormat };
        }
        if (isSelectType) {
          dto.config = { ...dto.config, options: selectOptions };
        }
        const updated = clientId
          ? await withClientId(clientId, () => updateField(currentTableId, editingField.id, dto))
          : await updateField(currentTableId, editingField.id, dto);
        onConfirm(updated);
      } else {
        // Create mode
        const isDateType = fieldType === "DateTime" || fieldType === "CreatedTime" || fieldType === "ModifiedTime";
        const isSelectType = fieldType === "SingleSelect" || fieldType === "MultiSelect";
        const config =
          fieldType === "Lookup"
            ? { lookup: lookupConfig }
            : isDateType
            ? { format: dateFormat }
            : fieldType === "Number"
            ? { format: numberFormat }
            : isSelectType
            ? { options: selectOptions }
            : {};
        const dto = { name: title.trim(), type: fieldType, config };
        const newField = clientId
          ? await withClientId(clientId, () => createField(currentTableId, dto))
          : await createField(currentTableId, dto);
        onConfirm(newField);
      }
    } catch (e: unknown) {
      const err = e as ApiError;
      setError({ message: err.message || t(isEdit ? "addField.saveFailed" : "addField.createFailed"), path: err.path });
      setSubmitting(false);
    }
  };

  const handleTitleChange = (val: string) => {
    setTitle(val);
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
        ref={popoverRef}
        style={style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="field-popover-body">
          {/* AI Suggestions (above title) — hidden in edit mode */}
          {!isEdit && <div className="form-row">
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
                    <span className="suggest-chip-icon"><FieldIcon type={s.type} size={14} /></span>
                    {s.name}
                    {s.type.startsWith("ai_") && <span className="suggest-ai-badge">AI</span>}
                  </button>
                ))
              ) : (
                <span className="suggest-empty">{t("addField.aiLoading")}</span>
              )}
            </div>
          </div>}

          {/* Title */}
          <div className="form-row">
            <label>{t("addField.fieldTitle")}</label>
            <input
              className="fc-input"
              autoFocus
              placeholder={t("addField.fieldTitlePlaceholder")}
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConfirm();
                if (e.key === "Escape") onCancel();
              }}
            />
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
                  <span style={{ width: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)" }}><FieldIcon type={fieldType} size={16} /></span>
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

          {(fieldType === "DateTime" || fieldType === "CreatedTime" || fieldType === "ModifiedTime") && (
            <div className="form-row">
              <label>{t("addField.dateFormat")}</label>
              <CustomSelect
                value={dateFormat}
                options={[
                  { value: "yyyy-MM-dd", label: "yyyy-MM-dd" },
                  { value: "yyyy-MM-dd HH:mm", label: "yyyy-MM-dd HH:mm" },
                  { value: "yyyy-MM-dd HH:mm:ss", label: "yyyy-MM-dd HH:mm:ss" },
                ]}
                onChange={setDateFormat}
              />
            </div>
          )}

          {fieldType === "Number" && (
            <div className="form-row">
              <label>{t("addField.numberFormat")}</label>
              <CustomSelect
                value={numberFormat}
                options={[
                  { value: "integer", label: t("addField.numFmt.integer") },
                  { value: "thousands", label: t("addField.numFmt.thousands") },
                  { value: "thousands_decimal", label: t("addField.numFmt.thousandsDecimal") },
                  { value: "percent", label: t("addField.numFmt.percent") },
                  { value: "percent_decimal", label: t("addField.numFmt.percentDecimal") },
                  { value: "decimal_1", label: t("addField.numFmt.decimal1") },
                  { value: "decimal_2", label: t("addField.numFmt.decimal2") },
                  { value: "decimal_3", label: t("addField.numFmt.decimal3") },
                  { value: "decimal_4", label: t("addField.numFmt.decimal4") },
                  { value: "decimal_5", label: t("addField.numFmt.decimal5") },
                ]}
                onChange={setNumberFormat}
              />
            </div>
          )}

          {(fieldType === "SingleSelect" || fieldType === "MultiSelect") && (
            <div className="form-row">
              <label>{t("addField.optionContent")}</label>
              <div className="so-list">
                {selectOptions.map((opt, idx) => (
                  <div
                    key={opt.id}
                    className="so-item"
                    draggable
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(idx)); }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = parseInt(e.dataTransfer.getData("text/plain"));
                      if (isNaN(from) || from === idx) return;
                      const next = [...selectOptions];
                      const [moved] = next.splice(from, 1);
                      next.splice(idx, 0, moved);
                      setSelectOptions(next);
                    }}
                  >
                    <span className="so-drag" title="Drag to reorder">
                      <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
                        <circle cx="3" cy="3" r="1.2" fill="currentColor"/><circle cx="7" cy="3" r="1.2" fill="currentColor"/>
                        <circle cx="3" cy="7" r="1.2" fill="currentColor"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/>
                        <circle cx="3" cy="11" r="1.2" fill="currentColor"/><circle cx="7" cy="11" r="1.2" fill="currentColor"/>
                      </svg>
                    </span>
                    <span className="so-dot" style={{ background: opt.color || "#4080FF" }} />
                    <input
                      className="so-input"
                      value={opt.name}
                      onChange={(e) => {
                        const next = [...selectOptions];
                        next[idx] = { ...opt, name: e.target.value };
                        setSelectOptions(next);
                      }}
                      placeholder={t("addField.optionPlaceholder")}
                    />
                    <button
                      type="button"
                      className="so-remove"
                      onClick={() => setSelectOptions(selectOptions.filter((_, i) => i !== idx))}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="so-add"
                  onClick={() => {
                    const colors = ["#4080FF", "#F54A45", "#FF7D00", "#00B365", "#7B61FF", "#F77234", "#14C0C0"];
                    const color = colors[selectOptions.length % colors.length];
                    setSelectOptions([...selectOptions, { id: `opt_${Date.now()}`, name: "", color }]);
                  }}
                >
                  + {t("addField.addOption")}
                </button>
              </div>
            </div>
          )}

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
            {submitting ? t(isEdit ? "addField.saving" : "addField.creating") : t(isEdit ? "addField.save" : "addField.confirm")}
          </button>
        </div>
      </div>

      {typePickerAnchor && (
        <TypePicker
          cardRect={typePickerAnchor.card}
          popoverRect={typePickerAnchor.popover}
          current={fieldType}
          onSelect={(ft) => { cancelHideTimer(); setFieldType(ft); setTypePickerAnchor(null); }}
          onMouseEnter={cancelHideTimer}
          onMouseLeave={scheduleHide}
        />
      )}
    </div>
  );
}

// ─── Type picker menu ───

interface TypePickerProps {
  cardRect: DOMRect;
  popoverRect: DOMRect;
  current: FieldType;
  onSelect: (t: FieldType) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function TypePicker({ cardRect, popoverRect, current, onSelect, onMouseEnter, onMouseLeave }: TypePickerProps) {
  const { t } = useTranslation();
  const MENU_W = 220;

  // 1. Y: align with the field-type-card (the first row of the "一级菜单")
  const top = cardRect.top;

  // 2. Height: fill to bottom, leaving 10px margin
  const maxHeight = window.innerHeight - top - 10;

  // 3. X: flush against the popover panel (0px gap)
  const spaceRight = window.innerWidth - popoverRect.right;
  const openRight = spaceRight >= MENU_W;
  const menuLeft = openRight
    ? popoverRect.right
    : popoverRect.left - MENU_W;

  // Bridge covers the gap between card edge and popover edge
  const bridgeStyle: React.CSSProperties = openRight
    ? { position: "fixed", left: cardRect.right, top, width: Math.max(0, popoverRect.right - cardRect.right), height: cardRect.height }
    : { position: "fixed", left: popoverRect.left - (cardRect.left - popoverRect.left), top, width: Math.max(0, cardRect.left - popoverRect.left), height: cardRect.height };

  return (
    <>
      <div style={bridgeStyle} onMouseEnter={onMouseEnter} />
      <div
        className="type-picker-menu floating"
        style={{ position: "fixed", left: menuLeft, top, width: MENU_W, maxHeight }}
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
                  <span className="icon"><FieldIcon type={item.type} size={16} /></span>
                  {t(item.labelKey)}
                </span>
                {current === item.type && <span style={{ color: "var(--primary)" }}>✓</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
