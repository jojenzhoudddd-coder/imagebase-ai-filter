/**
 * FilterPanel — V4 redesign per Figma node 259:110958
 *
 * 视觉:单一面板,两段式布局
 *   ┌──────────────────────────────────────────────┐
 *   │ [告诉 AI 你想看到什么 ......]   🎙  ▶        │ ← Input (pl-16 pr-12 py-12)
 *   ├──────────────────────────────────────────────┤
 *   │ 设置筛选条件 ?                                │ ← Title (gap 12)
 *   │ [filter row 1 ...]                           │
 *   │ [filter row 2 ...]                           │
 *   │ + 添加条件                                    │ ← Action
 *   └──────────────────────────────────────────────┘
 *
 * 关键变化(对比 V3):
 *   - 输入和条件设置合并到一个 floating panel,中间一条 0.5px divider 区隔
 *   - Title 改回显示 ("设置筛选条件 ?"),含 help 图标
 *   - Send 按钮从矩形改为圆形 (28×28),input 空时灰底禁用、有内容时蓝色激活
 *   - "已生成筛选条件" 提示行去掉,取消重复
 */

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
// V4.1 复用 chat 同款 icon (mic/send/stop) 保证视觉一致
import { MicIcon as ChatMicIcon, SendIcon as ChatSendIcon, StopIcon as ChatStopIcon } from "../ChatSidebar/icons";

interface Props {
  tableId: string;
  fields: Field[];
  filter: ViewFilter;
  onFilterChange: (filter: ViewFilter) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

const FilterPanel = forwardRef<HTMLDivElement, Props>(function FilterPanel(
  { tableId, fields, filter, onFilterChange, onClose, anchorRef },
  ref,
) {
  const { t } = useTranslation();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [echoQuery, setEchoQuery] = useState("");
  const [aiStatus, setAiStatus] = useState<AIGenerateStatus>("idle");
  const [aiThinking, setAiThinking] = useState("");
  const [aiError, setAiError] = useState("");
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | undefined>(undefined);
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

  const showGenerating = aiStatus === "generating";

  // Long-press spacebar to enter voice input
  const spaceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spaceTriggeredRef = useRef(false);

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === " " && speechSupported && !isListening && !showGenerating) {
      if (!spaceTimerRef.current) {
        spaceTimerRef.current = setTimeout(() => {
          spaceTriggeredRef.current = true;
          e.preventDefault();
          queryBeforeVoiceRef.current = query;
          startSpeech();
        }, 500);
      }
      return;
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

  // V4.1 对齐 FieldConfigPanel:position fixed,top = btn.bottom + 4,
  // right-align (panel 右边对齐 btn 右边)。viewport-clamp 防溢出。
  useEffect(() => {
    if (!anchorRef?.current) return;
    const btn = anchorRef.current;
    const compute = () => {
      const r = btn.getBoundingClientRect();
      const panelW = 480;
      const top = r.bottom + 4;
      // 默认 panel 右边 = btn 右边
      let left = r.right - panelW;
      // 视口 clamp:右侧距右窗 ≥ 8px,左侧 ≥ 8px
      const vw = window.innerWidth;
      const maxLeft = vw - panelW - 8;
      const minLeft = 8;
      if (left > maxLeft) left = maxLeft;
      if (left < minLeft) left = minLeft;
      setPanelPos({ top, left });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorRef]);

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
  }, [query, aiStatus, tableId, filter, onFilterChange, t, toast]);

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
      const available = window.innerHeight - rect.top - 80;
      setCondMaxH(available > 60 ? available : 60);
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [filter.conditions.length]);

  const placeholder = t("filter.aiPlaceholder");
  const canSend = !!query.trim() && !showGenerating && !isListening && !isStopping;

  // V4.1 对齐 chat input:streaming 时 send 按钮变 stop 样式,点击 abort 当前生成
  const handleStop = useCallback(() => {
    if (abortRef.current) abortRef.current();
    abortRef.current = null;
    setAiStatus("idle");
  }, []);

  return (
    <div className="filter-panel" ref={ref} style={panelPos ? { top: panelPos.top, left: panelPos.left } : undefined}>
      {/* ── Section 1: AI Input ── */}
      <div className={`fp-input-section ${showGenerating ? "generating" : ""} ${aiStatus === "error" ? "error" : ""}`}>
        <div className="fp-input-row">
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
              className={`fp-input ${echoQuery && !query ? "echo" : ""}`}
              type="text"
              value={query}
              readOnly={isListening || isStopping}
              onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setEchoQuery(""); }}
              onKeyDown={handleInputKeyDown}
              onKeyUp={handleInputKeyUp}
              placeholder={echoQuery || placeholder}
            />
          )}

          <div className="fp-input-actions">
            {/* Clear (隐藏在 generating) */}
            {(query || echoQuery) && !showGenerating && (
              <button
                className="fp-action-btn fp-action-clear"
                onClick={() => { if (isListening) stopSpeech(); handleClearAi(); }}
                title={t("filter.clear")}
                aria-label={t("filter.clear")}
              >
                <ClearIcon />
              </button>
            )}
            {/* Mic (隐藏在 generating) — V4.1 对齐 chat MicIcon */}
            {speechSupported && !showGenerating && (
              <button
                className={`fp-action-btn fp-action-mic ${isListening ? (isStopping ? "stopping" : "listening") : ""}`}
                onClick={toggleVoice}
                title={isStopping ? t("filter.voiceFinishing") : isListening ? t("filter.voiceStop") : t("filter.voiceInput")}
                disabled={isStopping}
                aria-label={t("filter.voiceInput")}
              >
                <ChatMicIcon size={14} />
                {isListening && !isStopping && <span className="fp-mic-pulse" />}
                {isStopping && <span className="fp-mic-stopping" />}
              </button>
            )}
            {/* Send / Stop — V4.1 对齐 chat input:generating 时显示 stop 样式 */}
            {showGenerating ? (
              <button
                className="fp-action-btn fp-action-send stop"
                onClick={handleStop}
                title={t("filter.stop")}
                aria-label={t("filter.stop")}
              >
                <ChatStopIcon size={12} />
              </button>
            ) : (
              <button
                className={`fp-action-btn fp-action-send ${canSend ? "active" : ""}`}
                onClick={handleSubmit}
                disabled={!canSend}
                title={t("filter.submit")}
                aria-label={t("filter.submit")}
              >
                <ChatSendIcon size={14} />
              </button>
            )}
          </div>
        </div>
        {/* AI error inline below input */}
        {aiStatus === "error" && aiError && (
          <div className="fp-error">
            <ErrorIcon /> <span>{aiError}</span>
          </div>
        )}
      </div>

      {/* ── Section 2: Filter conditions ── */}
      <div className="fp-conditions-section">
        <div className="fp-section-title">
          <span className="fp-section-title-text">
            <span>{t("filter.title")}</span>
            <button
              type="button"
              className="fp-help-btn"
              title={t("filter.helpHint")}
              aria-label={t("filter.helpHint")}
            >
              <HelpIcon />
            </button>
          </span>
          <span className="fp-section-title-spacer" />
          {/* V4.1 match logic 与 title 同行,右对齐 */}
          {filter.conditions.length >= 2 && (
            <div className="fp-logic-row">
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

        <button className="fp-add-btn" onClick={handleAddCondition}>
          <PlusIcon />
          <span>{t("filter.addCondition")}</span>
        </button>
      </div>
    </div>
  );
});

export default FilterPanel;

// ─── Icons ───────────────────────────────────────────────────────────

function ClearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M5.4 5.4a1.6 1.6 0 0 1 3.2 0c0 .8-.6 1.2-1.1 1.5-.4.2-.5.4-.5.7v.3M7 9.7v.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 1.75v10.5M1.75 7h10.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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
