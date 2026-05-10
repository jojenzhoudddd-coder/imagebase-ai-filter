/**
 * SortPanel — sort conditions popover matching FilterPanel V4 style.
 * Two-section layout: AI input + sort rules.
 * Supports drag-to-reorder of sort rules.
 */

import { useState, useRef, useEffect, forwardRef, useCallback } from "react";
import CustomSelect from "../FilterPanel/CustomSelect";
import { useTranslation } from "../../i18n/index";
import { getSortLabelType } from "../../services/sortEngine";
import { generateSort } from "../../api";
import { useToast } from "../Toast/index";
import { MicIcon as ChatMicIcon, SendIcon as ChatSendIcon, StopIcon as ChatStopIcon } from "../ChatSidebar/icons";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition";
import type { Field, ViewSort, ViewSortRule, AIGenerateStatus } from "../../types";
import "./SortPanel.css";

interface Props {
  tableId: string;
  fields: Field[];
  sort: ViewSort;
  onSortChange: (sort: ViewSort) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

const DRAG_THRESHOLD = 4;

const SortPanel = forwardRef<HTMLDivElement, Props>(function SortPanel(
  { tableId, fields, sort, onSortChange, onClose, anchorRef },
  ref,
) {
  const { t } = useTranslation();
  const toast = useToast();
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | undefined>(undefined);
  const conditionsRef = useRef<HTMLDivElement>(null);

  // ── AI input state ──
  const [query, setQuery] = useState("");
  const [echoQuery, setEchoQuery] = useState("");
  const [aiStatus, setAiStatus] = useState<AIGenerateStatus>("idle");
  const [aiError, setAiError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  // ── Voice input ──
  const queryBeforeVoiceRef = useRef("");
  const { isSupported: speechSupported, isListening, isStopping, start: startSpeech, stop: stopSpeech } = useSpeechRecognition({
    lang: "zh-CN",
    onResult(text) { setQuery(queryBeforeVoiceRef.current + text); },
  });

  const toggleVoice = useCallback(() => {
    if (isListening) stopSpeech();
    else { queryBeforeVoiceRef.current = query; startSpeech(); }
  }, [isListening, query, startSpeech, stopSpeech]);

  const showGenerating = aiStatus === "generating";

  // ── Drag state ──
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [dragOverPos, setDragOverPos] = useState<"above" | "below" | null>(null);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const dragRef = useRef<{ idx: number; startY: number; isDragging: boolean } | null>(null);
  const dragOverIdxRef = useRef<number | null>(null);
  const dragOverPosRef = useRef<"above" | "below" | null>(null);

  // Position panel
  useEffect(() => {
    if (!anchorRef?.current) return;
    const btn = anchorRef.current;
    const compute = () => {
      const r = btn.getBoundingClientRect();
      const panelW = 480;
      const top = r.bottom + 4;
      let left = r.right - panelW;
      const vw = window.innerWidth;
      if (left > vw - panelW - 8) left = vw - panelW - 8;
      if (left < 8) left = 8;
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

  // ── AI submit ──
  const handleSubmit = useCallback(() => {
    if (!query.trim() || aiStatus === "generating") return;
    const q = query.trim();
    setEchoQuery(q);
    setAiStatus("generating");
    setAiError("");

    abortRef.current = generateSort({
      tableId,
      query: q,
      existingSort: sort.rules.length > 0 ? sort : undefined,
      onThinking() { /* thinking state handled by aiStatus */ },
      onResult(newSort) {
        setAiStatus("done");
        setEchoQuery(q);
        onSortChange(newSort);
        if (newSort.rules.length === 0) {
          toast.info(t("sort.conditionsGeneratedEmpty"));
        } else {
          toast.success(t("sort.conditionsGenerated"));
        }
      },
      onError(_code, message) {
        setAiStatus("error");
        setAiError(message);
        setEchoQuery(q);
        toast.error(message || t("sort.failedToGenerate"));
      },
      onDone() {},
    });
  }, [query, aiStatus, tableId, sort, onSortChange, t, toast]);

  const handleStop = useCallback(() => {
    if (abortRef.current) abortRef.current();
    abortRef.current = null;
    setAiStatus("idle");
  }, []);

  const handleClearAi = () => {
    setQuery("");
    setEchoQuery("");
    setAiStatus("idle");
    setAiError("");
    inputRef.current?.focus();
  };

  useEffect(() => () => abortRef.current?.(), []);

  const canSend = !!query.trim() && !showGenerating && !isListening && !isStopping;

  // ── Sort rule handlers ──
  const handleRuleChange = useCallback((idx: number, updated: Partial<ViewSortRule>) => {
    const rules = sort.rules.map((r, i) => (i === idx ? { ...r, ...updated } : r));
    onSortChange({ ...sort, rules });
  }, [sort, onSortChange]);

  const handleRuleDelete = useCallback((idx: number) => {
    const rules = sort.rules.filter((_, i) => i !== idx);
    onSortChange({ ...sort, rules });
  }, [sort, onSortChange]);

  const handleAddRule = useCallback(() => {
    const usedIds = new Set(sort.rules.map(r => r.fieldId));
    const available = fields.find(f => !usedIds.has(f.id)) ?? fields[0];
    if (!available) return;
    onSortChange({ ...sort, rules: [...sort.rules, { fieldId: available.id, order: "asc" }] });
  }, [sort, fields, onSortChange]);

  // ── Drag handlers ──
  const handleDragMouseDown = useCallback((e: React.MouseEvent, idx: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = { idx, startY: e.clientY, isDragging: false };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      if (!dragRef.current.isDragging && Math.abs(ev.clientY - dragRef.current.startY) < DRAG_THRESHOLD) return;
      if (!dragRef.current.isDragging) {
        dragRef.current.isDragging = true;
        setDragIdx(idx);
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      const GAP_HALF = 6;
      let overIdx: number | null = null;
      let overPos: "above" | "below" | null = null;
      rowRefs.current.forEach((el, i) => {
        if (i === idx) return;
        const rect = el.getBoundingClientRect();
        if (ev.clientY >= rect.top - GAP_HALF && ev.clientY <= rect.bottom + GAP_HALF) {
          overIdx = i;
          overPos = ev.clientY < rect.top + rect.height / 2 ? "above" : "below";
        }
      });
      setDragOverIdx(overIdx);
      setDragOverPos(overPos);
      dragOverIdxRef.current = overIdx;
      dragOverPosRef.current = overPos;
    };

    const onMouseUp = () => {
      if (dragRef.current?.isDragging && dragOverIdxRef.current != null && dragOverPosRef.current) {
        const fromIdx = dragRef.current.idx;
        const rules = [...sort.rules];
        const [moved] = rules.splice(fromIdx, 1);
        let toIdx = dragOverIdxRef.current;
        if (fromIdx < toIdx) toIdx--;
        if (dragOverPosRef.current === "below") toIdx++;
        rules.splice(toIdx, 0, moved);
        onSortChange({ ...sort, rules });
      }
      dragRef.current = null;
      setDragIdx(null);
      setDragOverIdx(null);
      setDragOverPos(null);
      dragOverIdxRef.current = null;
      dragOverPosRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [sort, onSortChange]);

  // Cap conditions height
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
  }, [sort.rules.length]);

  const fieldOptions = fields.map(f => ({ value: f.id, label: f.name }));

  // Long-press spacebar for voice
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
      if (spaceTimerRef.current) { clearTimeout(spaceTimerRef.current); spaceTimerRef.current = null; }
      if (spaceTriggeredRef.current) { spaceTriggeredRef.current = false; e.preventDefault(); stopSpeech(); }
    }
  };

  return (
    <div className="sort-panel" ref={ref} style={panelPos ? { top: panelPos.top, left: panelPos.left } : undefined}>
      {/* ── Section 1: AI Input ── */}
      <div className={`fp-input-section ${showGenerating ? "generating" : ""} ${aiStatus === "error" ? "error" : ""}`}>
        <div className="fp-input-row">
          {showGenerating ? (
            <div className="fp-ai-loading">
              <span className="fp-ai-loading-text">
                <span className="fp-ai-loading-query">{t("sort.generatingBy")}&ldquo;{echoQuery}&rdquo;</span>
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
              placeholder={echoQuery || t("sort.aiPlaceholder")}
            />
          )}
          <div className="fp-input-actions">
            {(query || echoQuery) && !showGenerating && (
              <button
                className="fp-action-btn fp-action-clear"
                onClick={() => { if (isListening) stopSpeech(); handleClearAi(); }}
                title={t("filter.clear")}
              >
                <ClearIcon />
              </button>
            )}
            {speechSupported && !showGenerating && (
              <button
                className={`fp-action-btn fp-action-mic ${isListening ? (isStopping ? "stopping" : "listening") : ""}`}
                onClick={toggleVoice}
                disabled={isStopping}
              >
                <ChatMicIcon size={14} />
                {isListening && !isStopping && <span className="fp-mic-pulse" />}
                {isStopping && <span className="fp-mic-stopping" />}
              </button>
            )}
            {showGenerating ? (
              <button className="fp-action-btn fp-action-send stop" onClick={handleStop}>
                <ChatStopIcon size={12} />
              </button>
            ) : (
              <button
                className={`fp-action-btn fp-action-send ${canSend ? "active" : ""}`}
                onClick={handleSubmit}
                disabled={!canSend}
              >
                <ChatSendIcon size={14} />
              </button>
            )}
          </div>
        </div>
        {aiStatus === "error" && aiError && (
          <div className="fp-error">
            <ErrorIcon /> <span>{aiError}</span>
          </div>
        )}
      </div>

      {/* ── Section 2: Sort conditions ── */}
      <div className="sp-conditions-section">
        {sort.rules.length > 0 && (
          <div className="sp-conditions" ref={conditionsRef} style={condMaxH ? { maxHeight: condMaxH } : undefined}>
            {sort.rules.map((rule, idx) => {
              const isDragging = dragIdx === idx;
              const isOver = dragOverIdx === idx;
              let rowClass = "sort-row";
              if (isDragging) rowClass += " is-dragging";
              if (isOver && dragOverPos === "above") rowClass += " drag-over-above";
              if (isOver && dragOverPos === "below") rowClass += " drag-over-below";

              return (
                <div
                  key={`${rule.fieldId}-${idx}`}
                  ref={el => { if (el) rowRefs.current.set(idx, el); else rowRefs.current.delete(idx); }}
                  className={rowClass}
                >
                  <span className="sr-drag" onMouseDown={(e) => handleDragMouseDown(e, idx)}>
                    <DragIcon />
                  </span>
                  <SortRowContent
                    rule={rule}
                    fields={fields}
                    fieldOptions={fieldOptions}
                    onChange={(updated) => handleRuleChange(idx, updated)}
                    onDelete={() => handleRuleDelete(idx)}
                  />
                </div>
              );
            })}
          </div>
        )}

        <button className="sp-add-btn" onClick={handleAddRule}>
          <PlusIcon />
          <span>{t("sort.addRule")}</span>
        </button>
      </div>
    </div>
  );
});

export default SortPanel;

// ─── SortRowContent ─────────────────────────────────────────────

interface SortRowContentProps {
  rule: ViewSortRule;
  fields: Field[];
  fieldOptions: Array<{ value: string; label: string }>;
  onChange: (updated: Partial<ViewSortRule>) => void;
  onDelete: () => void;
}

function SortRowContent({ rule, fields, fieldOptions, onChange, onDelete }: SortRowContentProps) {
  const { t } = useTranslation();
  const field = fields.find(f => f.id === rule.fieldId);
  const labelType = field ? getSortLabelType(field.type) : "text";
  const ascLabel = t(`sort.asc.${labelType}`);
  const descLabel = t(`sort.desc.${labelType}`);

  return (
    <>
      <CustomSelect
        value={rule.fieldId}
        options={fieldOptions}
        onChange={(v) => onChange({ fieldId: v })}
        className="sr-field"
        searchable
      />
      <div className="sr-order-group">
        <button
          className={`sr-order-btn${rule.order === "asc" ? " active" : ""}`}
          onClick={() => onChange({ order: "asc" })}
        >
          {ascLabel}
        </button>
        <button
          className={`sr-order-btn${rule.order === "desc" ? " active" : ""}`}
          onClick={() => onChange({ order: "desc" })}
        >
          {descLabel}
        </button>
      </div>
      <button className="sr-delete" onClick={onDelete} type="button">
        <DeleteIcon />
      </button>
    </>
  );
}

// ─── Icons ─────────────────────────────────────────────────────

function DragIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="4" cy="2.5" r="1" fill="currentColor"/>
      <circle cx="8" cy="2.5" r="1" fill="currentColor"/>
      <circle cx="4" cy="6" r="1" fill="currentColor"/>
      <circle cx="8" cy="6" r="1" fill="currentColor"/>
      <circle cx="4" cy="9.5" r="1" fill="currentColor"/>
      <circle cx="8" cy="9.5" r="1" fill="currentColor"/>
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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

function HelpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.4 5.4a1.6 1.6 0 0 1 3.2 0c0 .8-.6 1.2-1.1 1.5-.4.2-.5.4-.5.7v.3M7 9.7v.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 1.75v10.5M1.75 7h10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
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
