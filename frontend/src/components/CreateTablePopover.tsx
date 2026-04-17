import { useState, useRef, useEffect, useLayoutEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/index";
import { generateTableStructure, GeneratedField } from "../api";
import "./CreateTablePopover.css";

interface Props {
  /** The dropdown menu item element to align with (right side) */
  anchorItemEl: HTMLElement;
  /** The dropdown menu container (for positioning to its right) */
  menuEl: HTMLElement;
  onClose: () => void;
  onCreateWithAI: (tableName: string, fields: GeneratedField[]) => Promise<string>;
  onResetToDefault: (tableId: string, tableName: string) => Promise<void>;
  onCreateBlank: () => Promise<void>;
}

export type PopoverState = "input" | "generating" | "creating" | "complete" | "error";

export interface CreateTablePopoverHandle {
  getState: () => PopoverState;
}

const AI_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M8 .335c.234 0 .427.183.456.418.074.585.21 1.15.401 1.688l.268.657c.781 1.698 2.136 3.07 3.813 3.861l.648.272.212.073c.497.166 1.016.282 1.552.345.177.02.315.17.315.35l-.007.067a.344.344 0 01-.309.284l-.083.01a7.98 7.98 0 00-1.681.418l-.648.272c-1.676.791-3.031 2.163-3.813 3.861l-.267.657a7.98 7.98 0 00-.401 1.688l-.018.085a.354.354 0 01-.438.333l-.085-.009a.344.344 0 01-.353-.173l-.018-.085a7.98 7.98 0 00-.401-1.688l-.268-.657c-.781-1.698-2.136-3.07-3.813-3.861l-.648-.272a7.98 7.98 0 00-1.535-.388l-.229-.03a.354.354 0 01-.315-.35c0-.181.138-.331.315-.351a7.98 7.98 0 001.552-.345l.212-.073.648-.272c1.676-.791 3.031-2.163 3.813-3.861l.267-.657A7.98 7.98 0 007.544.753C7.573.518 7.766.335 8 .335z" fill="url(#ai_popover_g)"/>
    <defs><linearGradient id="ai_popover_g" x1=".335" y1="15.665" x2="15.665" y2="15.665" gradientUnits="userSpaceOnUse"><stop stopColor="#4752E6"/><stop offset="1" stopColor="#CF5ECF"/></linearGradient></defs>
  </svg>
);

/* Large success checkmark icon for complete state */
const SUCCESS_ICON_LARGE = (
  <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
    <circle cx="24" cy="24" r="22" fill="#34A853"/>
    <path d="M15 24l7 7 12-12" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const CreateTablePopover = forwardRef<CreateTablePopoverHandle, Props>(
  function CreateTablePopover({ anchorItemEl, menuEl, onClose, onCreateWithAI, onResetToDefault, onCreateBlank }, ref) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  const [state, setState] = useState<PopoverState>("input");
  const [tableName, setTableName] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [createdTableId, setCreatedTableId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });

  // Expose state to parent
  useImperativeHandle(ref, () => ({
    getState: () => state,
  }), [state]);

  // Position to the right of menu, Y-aligned with anchorItemEl
  useLayoutEffect(() => {
    const menuRect = menuEl.getBoundingClientRect();
    const itemRect = anchorItemEl.getBoundingClientRect();
    setPos({
      top: itemRect.top,
      left: menuRect.right + 4,
    });
  }, [anchorItemEl, menuEl, state]);

  // Focus input on mount
  useEffect(() => {
    if (state === "input") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [state]);

  // Cleanup abort on unmount
  useEffect(() => {
    return () => { abortRef.current?.(); };
  }, []);

  const handleGenerate = useCallback(() => {
    if (!tableName.trim()) return;
    setState("generating");
    setErrorMsg("");
    setCreatedTableId(null);

    const abort = generateTableStructure({
      tableName: tableName.trim(),
      onFields: async (generatedFields) => {
        setState("creating");
        try {
          const tableId = await onCreateWithAI(tableName.trim(), generatedFields);
          setCreatedTableId(tableId);
          setState("complete");
        } catch {
          setErrorMsg("Failed to create table");
          setState("error");
        }
      },
      onError: (_code, message) => {
        setErrorMsg(message);
        setState("error");
      },
      onDone: () => {
        setState(prev => prev === "generating" ? "error" : prev);
      },
    });
    abortRef.current = abort;
  }, [tableName, onCreateWithAI]);

  // Adopt: close everything
  const handleAdopt = useCallback(() => {
    onClose();
  }, [onClose]);

  // Reset: replace AI fields with default schema
  const handleReset = useCallback(async () => {
    if (!createdTableId) return;
    setState("creating");
    try {
      await onResetToDefault(createdTableId, tableName.trim());
      onClose();
    } catch {
      onClose();
    }
  }, [createdTableId, tableName, onResetToDefault, onClose]);

  const handleRetry = useCallback(() => {
    setState("input");
    setErrorMsg("");
    setCreatedTableId(null);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && tableName.trim()) {
      handleGenerate();
    }
    if (e.key === "Escape" && state === "input") {
      onClose();
    }
  }, [handleGenerate, onClose, tableName, state]);

  const handleCreateBlank = useCallback(async () => {
    setState("creating");
    try {
      await onCreateBlank();
      onClose();
    } catch {
      onClose();
    }
  }, [onCreateBlank, onClose]);

  return createPortal(
    <div ref={popoverRef} className="create-table-popover" style={{ top: pos.top, left: pos.left }}>
      {/* Close button — always visible */}
      <button
        className="create-table-popover-close"
        onClick={onClose}
        title="Close"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>

      {/* Title — hidden during generating/creating/complete */}
      {state !== "generating" && state !== "creating" && state !== "complete" && (
        <div className="create-table-popover-title">
          {AI_ICON}
          {t("aiTable.title")}
        </div>
      )}

      {/* Input state */}
      {state === "input" && (
        <>
          <input
            ref={inputRef}
            className="create-table-popover-input"
            placeholder={t("aiTable.placeholder")}
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            onKeyDown={handleKeyDown}
            maxLength={100}
          />
          <div className="create-table-popover-actions">
            <button
              className="create-table-popover-btn secondary"
              onClick={handleCreateBlank}
            >
              {t("aiTable.blankCreate")}
            </button>
            <button
              className="create-table-popover-btn primary"
              disabled={!tableName.trim()}
              onClick={handleGenerate}
            >
              {t("aiTable.create")}
            </button>
          </div>
        </>
      )}

      {/* Generating / Creating state */}
      {(state === "generating" || state === "creating") && (
        <div className="create-table-popover-generating">
          <div className="create-table-popover-ai-anim">
            {AI_ICON}
          </div>
          <div className="create-table-popover-progress-bar">
            <div className="create-table-popover-progress-fill" />
          </div>
          <div className="create-table-popover-status-text">
            {state === "creating" ? t("aiTable.creating") : t("aiTable.generating")}
          </div>
        </div>
      )}

      {/* Complete state — centered icon, text, full-width stacked buttons */}
      {state === "complete" && (
        <div className="create-table-popover-complete">
          <div className="create-table-popover-complete-icon">
            {SUCCESS_ICON_LARGE}
          </div>
          <div className="create-table-popover-complete-text">
            {t("aiTable.complete", { name: tableName.trim() })}
          </div>
          <div className="create-table-popover-complete-actions">
            <button className="create-table-popover-btn primary full" onClick={handleAdopt}>
              {t("aiTable.adopt")}
            </button>
            <button className="create-table-popover-btn secondary full" onClick={handleReset}>
              {t("aiTable.blank")}
            </button>
          </div>
        </div>
      )}

      {/* Error state */}
      {state === "error" && (
        <>
          <div className="create-table-popover-error">
            {errorMsg || t("aiTable.failed")}
          </div>
          <div className="create-table-popover-actions">
            <button className="create-table-popover-btn secondary" onClick={onClose}>
              {t("confirm.cancel")}
            </button>
            <button className="create-table-popover-btn primary" onClick={handleRetry}>
              {t("aiTable.create")}
            </button>
          </div>
        </>
      )}
    </div>,
    document.body,
  );
});

export default CreateTablePopover;
