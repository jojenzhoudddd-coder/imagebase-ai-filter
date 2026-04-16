import { useState, useRef, useCallback, useEffect, forwardRef } from "react";
import CustomSelect from "./CustomSelect";
import { Field, FilterCondition, FilterLogic, FilterOperator, FilterValue, ViewFilter, AIGenerateStatus } from "../../types";
import { generateFilter } from "../../api";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition";
import { useToast } from "../Toast/index";
import { useTranslation } from "../../i18n/index";
import FilterRow from "./FilterRow";
import "./FilterPanel.css";
import { v4 as uuidv4 } from "./uuid";

interface Props {
  tableId: string;
  fields: Field[];
  filter: ViewFilter;
  onFilterChange: (filter: ViewFilter) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

const FilterPanel = forwardRef<HTMLDivElement, Props>(function FilterPanel({ tableId, fields, filter, onFilterChange, onClose, anchorRef }, ref) {
  const { t } = useTranslation();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [echoQuery, setEchoQuery] = useState("");
  const [aiStatus, setAiStatus] = useState<AIGenerateStatus>("idle");
  const [aiThinking, setAiThinking] = useState("");
  const [aiError, setAiError] = useState("");
  const [aiGenerated, setAiGenerated] = useState(false);
  const [panelLeft, setPanelLeft] = useState<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const conditionsRef = useRef<HTMLDivElement>(null);

  // ── Voice input ──
  const queryBeforeVoiceRef = useRef("");
  const { isSupported: speechSupported, isListening, isStopping, start: startSpeech, stop: stopSpeech } = useSpeechRecognition({
    lang: "zh-CN",
    onResult(text) {
      setQuery(queryBeforeVoiceRef.current + text);
    },
  });

  const toggleVoice = useCallback(() => {
    if (isListening) {
      stopSpeech();
    } else {
      queryBeforeVoiceRef.current = query;
      startSpeech();
    }
  }, [isListening, query, startSpeech, stopSpeech]);

  // Long-press spacebar to enter voice input
  const spaceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spaceTriggeredRef = useRef(false);

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    // Long-press spacebar detection
    if (e.key === " " && speechSupported && !isListening && !showGenerating) {
      if (!spaceTimerRef.current) {
        spaceTimerRef.current = setTimeout(() => {
          spaceTriggeredRef.current = true;
          e.preventDefault();
          queryBeforeVoiceRef.current = query;
          startSpeech();
        }, 500);
      }
      return; // Don't process Enter/Escape while space is held
    }

    if (e.key === "Enter") handleSubmit();
    if (e.key === "Escape") onClose();
  };

  const handleInputKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === " ") {
      if (spaceTimerRef.current) {
        clearTimeout(spaceTimerRef.current);
        spaceTimerRef.current = null;
      }
      if (spaceTriggeredRef.current) {
        spaceTriggeredRef.current = false;
        e.preventDefault();
        stopSpeech();
      }
    }
  };

  // Center panel horizontally relative to anchor button
  useEffect(() => {
    if (!anchorRef?.current) return;
    const btn = anchorRef.current;
    const panel = (ref as React.RefObject<HTMLDivElement>)?.current;
    const parent = panel?.offsetParent as HTMLElement | null;
    if (!parent) return;
    const btnRect = btn.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const btnCenterX = btnRect.left + btnRect.width / 2 - parentRect.left;
    const panelW = 520;
    const left = Math.max(0, Math.min(btnCenterX - panelW / 2, parentRect.width - panelW));
    setPanelLeft(left);
  }, [anchorRef, ref]);

  const handleSubmit = useCallback(() => {
    if (!query.trim() || aiStatus === "generating") return;

    const q = query.trim();
    setEchoQuery(q);
    setAiStatus("generating");
    setAiThinking("");
    setAiError("");

    abortRef.current = generateFilter({
      tableId,
      query: q,
      existingFilter: filter.conditions.length > 0 ? filter : undefined,
      onThinking(text) {
        setAiThinking(text);
      },
      onResult(newFilter) {
        setAiStatus("done");
        setEchoQuery(q);
        setAiGenerated(true);
        onFilterChange(newFilter);
        if (newFilter.conditions.length === 0) {
          toast.info(t("filter.conditionsGeneratedNoMatch"));
        } else {
          toast.success(t("filter.conditionsGenerated"));
        }
      },
      onError(_code, message) {
        setAiStatus("error");
        setAiError(message);
        setEchoQuery(q);
        toast.error(message || t("filter.failedToGenerate"));
      },
      onDone() {
        // Stream closed
      },
    });
  }, [query, aiStatus, tableId, filter, onFilterChange]);

  const handleConditionChange = (id: string, updated: Partial<FilterCondition>) => {
    const conditions = filter.conditions.map((c) =>
      c.id === id ? { ...c, ...updated } : c
    );
    onFilterChange({ ...filter, conditions });
  };

  const handleConditionDelete = (id: string) => {
    const conditions = filter.conditions.filter((c) => c.id !== id);
    onFilterChange({ ...filter, conditions });
  };

  const handleAddCondition = () => {
    const firstField = fields[0];
    if (!firstField) return;
    const newCond: FilterCondition = {
      id: uuidv4(),
      fieldId: firstField.id,
      operator: "eq",
      value: null,
    };
    onFilterChange({ ...filter, conditions: [...filter.conditions, newCond] });
  };

  const handleLogicChange = (logic: FilterLogic) => {
    onFilterChange({ ...filter, logic });
  };

  const handleClearAi = () => {
    setQuery("");
    setEchoQuery("");
    setAiStatus("idle");
    setAiError("");
    inputRef.current?.focus();
  };

  // Abort on unmount
  useEffect(() => () => abortRef.current?.(), []);

  // Dynamically cap conditions list so panel stays within viewport
  const [condMaxH, setCondMaxH] = useState<number | undefined>(undefined);
  useEffect(() => {
    const el = conditionsRef.current;
    if (!el) return;
    const compute = () => {
      const rect = el.getBoundingClientRect();
      // Leave 80px bottom margin for add-condition + footer + spacing
      const available = window.innerHeight - rect.top - 80;
      setCondMaxH(available > 60 ? available : 60);
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [filter.conditions.length]);

  const showGenerating = aiStatus === "generating";
  const placeholder = t("filter.aiPlaceholder");

  return (
    <div className="filter-panel" ref={ref} style={panelLeft !== undefined ? { left: panelLeft } : undefined}>
      <div className="fp-title">{t("filter.title")}</div>

      {/* AI Input: Figma h=32 with AI icon */}
      <div className={`fp-ai-row ${showGenerating ? "generating" : ""} ${aiStatus === "error" ? "error" : ""}`}>
        <span className="fp-ai-icon">
          <SparkleIcon animated={showGenerating} />
        </span>
        <div className="fp-ai-input-wrap">
          {showGenerating ? (
            <div className="fp-ai-loading">
              <span className="fp-ai-loading-text">
                <span className="fp-ai-loading-query">{t("filter.generatingBy")}&ldquo;{echoQuery}&rdquo;</span>
                <LoadingDots />
              </span>
            </div>
          ) : (
            <input
              ref={inputRef}
              className={`fp-ai-input ${echoQuery && !query ? "echo" : ""}`}
              type="text"
              value={query}
              readOnly={isListening || isStopping}
              onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setEchoQuery(""); }}
              onKeyDown={handleInputKeyDown}
              onKeyUp={handleInputKeyUp}
              placeholder={echoQuery || placeholder}
            />
          )}
        </div>
        {(query || echoQuery) && !showGenerating && (
          <button className="fp-ai-clear" onClick={() => { if (isListening) stopSpeech(); handleClearAi(); }} title={t("filter.clear")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {speechSupported && !showGenerating && (
          <button
            className={`fp-ai-mic ${isListening ? (isStopping ? "stopping" : "listening") : ""}`}
            onClick={toggleVoice}
            title={isStopping ? t("filter.voiceFinishing") : isListening ? t("filter.voiceStop") : t("filter.voiceInput")}
            disabled={isStopping}
          >
            <MicIcon />
            {isListening && !isStopping && <span className="fp-mic-pulse" />}
            {isStopping && <span className="fp-mic-stopping" />}
          </button>
        )}
        {query.trim() && !showGenerating && !isListening && !isStopping && (
          <button className="fp-ai-send" onClick={handleSubmit} title={t("filter.submit")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M12 20V4M5 11l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      {/* AI Error */}
      {aiStatus === "error" && aiError && (
        <div className="fp-ai-error">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {aiError}
        </div>
      )}

      {(aiGenerated || filter.conditions.length >= 2) && (
        <div className="fp-logic-row">
          {aiGenerated && <span className="fp-logic-left">{t("filter.conditionsGenerated")}</span>}
          {filter.conditions.length >= 2 && (
            <div className="fp-logic-right">
              <span className="fp-logic-label">{t("filter.match")}</span>
              <CustomSelect
                value={filter.logic}
                options={[
                  { value: "and", label: t("filter.all") },
                  { value: "or", label: t("filter.any") },
                ]}
                onChange={(v) => handleLogicChange(v as FilterLogic)}
                className="fp-logic-select"
              />
              <span className="fp-logic-label">{t("filter.conditions")}</span>
            </div>
          )}
        </div>
      )}

      {/* Filter Conditions: Figma gap=12 */}
      {filter.conditions.length > 0 && (
        <div className="fp-conditions" ref={conditionsRef} style={condMaxH ? { maxHeight: condMaxH } : undefined}>
          {filter.conditions.map((cond) => (
            <FilterRow
              key={cond.id}
              condition={cond}
              fields={fields}
              onChange={(updated) => handleConditionChange(cond.id, updated)}
              onDelete={() => handleConditionDelete(cond.id)}
            />
          ))}
        </div>
      )}

      <div className="fp-actions">
        <button className="fp-add-btn" onClick={handleAddCondition}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {t("filter.addCondition")}
        </button>
      </div>

      {filter.conditions.length > 0 && (
        <div className="fp-footer">
          <button className="fp-save-view">{t("filter.saveAsNewView")}</button>
        </div>
      )}
    </div>
  );
});

export default FilterPanel;

function SparkleIcon({ animated }: { animated: boolean }) {
  return (
    <svg
      className={`sparkle-icon ${animated ? "spinning" : ""}`}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2Z"
        fill={animated ? "url(#sparkle-grad)" : "var(--color-primary)"}
        stroke="none"
      />
      <defs>
        <linearGradient id="sparkle-grad" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0%" stopColor="#3370FF" />
          <stop offset="100%" stopColor="#A855F7" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function LoadingDots() {
  return (
    <span className="loading-dots">
      <span>.</span><span>.</span><span>.</span>
    </span>
  );
}

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 1a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4Z" />
      <path d="M19 11a7 7 0 0 1-14 0H3a9 9 0 0 0 8 8.94V22h2v-2.06A9 9 0 0 0 21 11h-2Z" />
    </svg>
  );
}
