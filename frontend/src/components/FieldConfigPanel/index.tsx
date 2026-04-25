import { useState, useRef, useEffect, useCallback, useMemo, RefObject } from "react";
import { Field } from "../../types";
import SearchInput from "../SearchInput/index";
import { pinyinMatch } from "../../utils/pinyinMatch";
import { useTranslation } from "../../i18n/index";
import "./FieldConfigPanel.css";

interface Props {
  fields: Field[];               // allOrderedFields (full list in order, including hidden)
  hiddenFields: string[];         // currently hidden field IDs
  onFieldOrderChange: (newOrder: string[]) => void;
  onToggleVisibility: (fieldId: string) => void;
  onSelectField?: (fieldId: string) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
}

interface DragState {
  fieldId: string;
  startY: number;
  currentY: number;
  itemRects: Map<string, DOMRect>;
}

export default function FieldConfigPanel({
  fields,
  hiddenFields,
  onFieldOrderChange,
  onToggleVisibility,
  onSelectField,
  onClose,
  anchorRef,
}: Props) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"above" | "below" | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragOverRef = useRef<{ id: string | null; pos: "above" | "below" | null }>({ id: null, pos: null });

  const [searchQuery, setSearchQuery] = useState("");

  const hiddenSet = new Set(hiddenFields);

  // Filter fields by search query (supports pinyin fuzzy match)
  const isSearching = searchQuery.trim().length > 0;
  const filteredFields = useMemo(() => {
    if (!isSearching) return fields;
    const q = searchQuery.trim();
    return fields.filter(f => pinyinMatch(f.name, q));
  }, [fields, searchQuery, isSearching]);

  // Position the panel below the anchor button —— 右对齐 trigger 的 hover 区域
  // panel.right === btn.right → left = btn.right - panelWidth (280)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      const PANEL_WIDTH = 280;
      const left = Math.max(8, rect.right - PANEL_WIDTH);
      setPos({ top: rect.bottom + 4, left });
    }
  }, [anchorRef]);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        panelRef.current && !panelRef.current.contains(target) &&
        anchorRef.current && !anchorRef.current.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose, anchorRef]);

  // ── Drag to reorder ──
  const handleDragStart = useCallback((e: React.MouseEvent, fieldId: string) => {
    // Don't allow dragging primary field
    const field = fields.find(f => f.id === fieldId);
    if (field?.isPrimary) return;

    e.preventDefault();
    e.stopPropagation();

    const rects = new Map<string, DOMRect>();
    itemRefs.current.forEach((el, id) => {
      rects.set(id, el.getBoundingClientRect());
    });

    const startY = e.clientY;
    const state: DragState = { fieldId, startY, currentY: startY, itemRects: rects };
    dragRef.current = state;
    setDragState(state);

    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      dragRef.current.currentY = ev.clientY;
      setDragState({ ...dragRef.current });

      // Find hover target
      let overId: string | null = null;
      let overPos: "above" | "below" | null = null;
      rects.forEach((r, id) => {
        if (id === fieldId) return;
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
          overId = id;
          overPos = ev.clientY < r.top + r.height / 2 ? "above" : "below";
        }
      });
      dragOverRef.current = { id: overId, pos: overPos };
      setDragOverId(overId);
      setDragOverPosition(overPos);
    };

    const onMouseUp = () => {
      const { id: finalOverId, pos: finalPos } = dragOverRef.current;

      if (finalOverId && finalOverId !== fieldId && finalPos) {
        const currentOrder = fields.map(f => f.id);
        const arr = [...currentOrder];
        const fromIdx = arr.indexOf(fieldId);
        if (fromIdx !== -1) {
          arr.splice(fromIdx, 1);
          let toIdx = arr.indexOf(finalOverId);
          if (toIdx !== -1) {
            if (finalPos === "below") toIdx += 1;
            arr.splice(toIdx, 0, fieldId);
            onFieldOrderChange(arr);
          }
        }
      }

      dragRef.current = null;
      dragOverRef.current = { id: null, pos: null };
      setDragState(null);
      setDragOverId(null);
      setDragOverPosition(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [fields, onFieldOrderChange]);

  const getDragTransform = (fieldId: string): React.CSSProperties => {
    if (!dragState || dragState.fieldId !== fieldId) return {};
    const delta = dragState.currentY - dragState.startY;
    return {
      transform: `translateY(${delta}px)`,
      position: "relative" as const,
      zIndex: 10,
    };
  };

  const getDragOverClass = (fieldId: string): string => {
    if (!dragState || dragOverId !== fieldId || dragState.fieldId === fieldId) return "";
    return dragOverPosition === "above" ? "drag-over-above" : "drag-over-below";
  };

  return (
    <div
      ref={panelRef}
      className="field-config-panel"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="field-config-header">
        {t("fieldConfig.title")}
      </div>
      <div className="field-config-search">
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t("fieldConfig.searchPlaceholder")}
          onEscape={() => { if (!searchQuery) onClose(); }}
        />
      </div>
      <div className="field-config-list">
        {filteredFields.length === 0 && isSearching ? (
          <div className="field-config-empty">{t("fieldConfig.noFields")}</div>
        ) : (
          filteredFields.map((field) => {
            const isHidden = hiddenSet.has(field.id);
            const isPrimary = field.isPrimary;
            const isDragging = dragState?.fieldId === field.id;
            const dragDisabled = isPrimary || isSearching;

            return (
              <div
                key={field.id}
                ref={(el) => { if (el) itemRefs.current.set(field.id, el); else itemRefs.current.delete(field.id); }}
                className={`field-config-item ${isDragging ? "is-dragging" : ""} ${getDragOverClass(field.id)}`}
                style={getDragTransform(field.id)}
              >
                {/* Drag handle */}
                <div
                  className={`field-config-drag ${dragDisabled ? "disabled" : ""}`}
                  onMouseDown={(e) => {
                    if (!dragDisabled) handleDragStart(e, field.id);
                  }}
                >
                  <DragIcon />
                </div>

                {/* Field icon */}
                <div className="field-config-icon">
                  <FieldTypeIcon type={field.type} />
                </div>

                {/* Field name — click to select & scroll to column */}
                <span
                  className={`field-config-name ${isHidden ? "is-hidden" : ""} ${!isHidden && onSelectField ? "clickable" : ""}`}
                  onClick={() => {
                    if (!isHidden && onSelectField) onSelectField(field.id);
                  }}
                >
                  {field.name}
                </span>

                {/* Lock icon for primary, eye toggle for others */}
                {isPrimary ? (
                  <div className="field-config-lock">
                    <LockIcon />
                  </div>
                ) : (
                  <button
                    className={`field-config-visibility ${isHidden ? "is-hidden" : ""}`}
                    onClick={() => onToggleVisibility(field.id)}
                    title={isHidden ? t("fieldConfig.showField") : t("fieldConfig.hideField")}
                  >
                    {isHidden ? <InvisibleIcon /> : <VisibleIcon />}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ── Icons from Figma (icon_drag_outlined, icon_visible_outlined, icon_invisible_outlined, icon_lock_outlined) ── */

function DragIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M8.75 6.5C9.7165 6.5 10.5 5.7165 10.5 4.75C10.5 3.7835 9.7165 3 8.75 3C7.7835 3 7 3.7835 7 4.75C7 5.7165 7.7835 6.5 8.75 6.5Z" fill="currentColor"/>
      <path d="M8.75 13.75C9.7165 13.75 10.5 12.9665 10.5 12C10.5 11.0335 9.7165 10.25 8.75 10.25C7.7835 10.25 7 11.0335 7 12C7 12.9665 7.7835 13.75 8.75 13.75Z" fill="currentColor"/>
      <path d="M10.5 19.25C10.5 20.2165 9.7165 21 8.75 21C7.7835 21 7 20.2165 7 19.25C7 18.2835 7.7835 17.5 8.75 17.5C9.7165 17.5 10.5 18.2835 10.5 19.25Z" fill="currentColor"/>
      <path d="M15.2534 6.5C16.2199 6.5 17.0034 5.7165 17.0034 4.75C17.0034 3.7835 16.2199 3 15.2534 3C14.2869 3 13.5034 3.7835 13.5034 4.75C13.5034 5.7165 14.2869 6.5 15.2534 6.5Z" fill="currentColor"/>
      <path d="M17 12C17 12.9665 16.2165 13.75 15.25 13.75C14.2835 13.75 13.5 12.9665 13.5 12C13.5 11.0335 14.2835 10.25 15.25 10.25C16.2165 10.25 17 11.0335 17 12Z" fill="currentColor"/>
      <path d="M15.2534 21C16.2199 21 17.0034 20.2165 17.0034 19.25C17.0034 18.2835 16.2199 17.5 15.2534 17.5C14.2869 17.5 13.5034 18.2835 13.5034 19.25C13.5034 20.2165 14.2869 21 15.2534 21Z" fill="currentColor"/>
    </svg>
  );
}

function VisibleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M11.9847 18.5C15.2226 18.5 18.2206 16.4404 20.9999 11.987C18.2921 7.54956 15.3009 5.5 11.9847 5.5C8.66951 5.5 5.6891 7.54864 2.99989 11.987C5.76055 16.4413 8.74785 18.5 11.9847 18.5ZM1.50233 12.89C1.18033 12.3419 1.17815 11.6605 1.49271 11.1081C1.50392 11.0884 1.51466 11.0697 1.52484 11.052C4.4279 6.01734 7.91416 3.5 11.9836 3.5C16.0696 3.5 19.5775 6.03792 22.507 11.1138C22.5158 11.129 22.525 11.145 22.5346 11.1618C22.831 11.6808 22.8287 12.3215 22.5256 12.8366C19.5187 17.9455 16.0047 20.5 11.9836 20.5C7.97652 20.5 4.48276 17.9633 1.50233 12.89ZM11.9999 16C9.79075 16 7.99989 14.2091 7.99989 12C7.99989 9.79086 9.79075 8 11.9999 8C14.209 8 15.9999 9.79086 15.9999 12C15.9999 14.2091 14.209 16 11.9999 16ZM11.9999 14C13.1045 14 13.9999 13.1046 13.9999 12C13.9999 10.8954 13.1045 10 11.9999 10C10.8953 10 9.99989 10.8954 9.99989 12C9.99989 13.1046 10.8953 14 11.9999 14Z" fill="currentColor"/>
    </svg>
  );
}

function InvisibleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M2.03133 8.17212C2.48854 7.86232 3.11033 7.98182 3.42013 8.43903C5.2629 11.1586 8.63638 13 11.9999 13C15.3634 13 18.7369 11.1586 20.5797 8.43903C20.8895 7.98182 21.5112 7.86232 21.9685 8.17212C22.4257 8.48193 22.5452 9.10371 22.2354 9.56092C21.6739 10.3896 20.9972 11.1486 20.2338 11.8197L22.2425 13.8284C22.633 14.2189 22.633 14.8521 22.2425 15.2426C21.852 15.6331 21.2188 15.6331 20.8283 15.2426L18.707 13.1213C18.6764 13.0907 18.6482 13.0586 18.6224 13.0252C17.8775 13.4967 17.0823 13.8942 16.2549 14.2062L16.967 16.8637C17.1099 17.3972 16.7933 17.9455 16.2599 18.0884C15.7264 18.2314 15.1781 17.9148 15.0351 17.3813L14.3332 14.7617C13.5658 14.9178 12.7838 15 11.9999 15C11.289 15 10.5796 14.9324 9.88128 14.8033L9.1905 17.3813C9.04756 17.9148 8.49922 18.2314 7.96576 18.0884C7.43229 17.9455 7.11571 17.3972 7.25865 16.8637L7.95049 14.2817C7.0364 13.9548 6.15936 13.5237 5.34339 13.0036C5.31329 13.0448 5.27966 13.0841 5.24249 13.1213L3.12117 15.2426C2.73064 15.6332 2.09748 15.6332 1.70696 15.2426C1.31643 14.8521 1.31643 14.219 1.70696 13.8284L3.73924 11.7961C2.98679 11.1308 2.31937 10.3799 1.76442 9.56092C1.45462 9.10371 1.57412 8.48193 2.03133 8.17212Z" fill="currentColor"/>
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M15 15C15 16.6569 13.6569 18 12 18C10.3431 18 9 16.6569 9 15C9 13.3431 10.3431 12 12 12C13.6569 12 15 13.3431 15 15ZM13 15C13 14.4477 12.5523 14 12 14C11.4477 14 11 14.4477 11 15C11 15.5523 11.4477 16 12 16C12.5523 16 13 15.5523 13 15Z" fill="currentColor"/>
      <path d="M6.5 7.5V8H4C2.89543 8 2 8.89543 2 10V20C2 21.1046 2.89543 22 4 22H20C21.1046 22 22 21.1046 22 20V10C22 8.89543 21.1046 8 20 8H17.5V7.5C17.5 4.46243 15.0376 2 12 2C8.96243 2 6.5 4.46243 6.5 7.5ZM15.5 8H8.5V7.5C8.5 5.567 10.067 4 12 4C13.933 4 15.5 5.567 15.5 7.5V8ZM4 10H20V20H4V10Z" fill="currentColor"/>
    </svg>
  );
}

/* ── Field type icons (same as TableView) ── */
function FieldTypeIcon({ type }: { type: string }) {
  switch (type) {
    case "DateTime":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "SingleSelect":
    case "MultiSelect":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path d="m9 12 2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "User":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
          <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "Number":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M7 20l3-16M14 20l3-16M4 8h18M3 16h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "Checkbox":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="2" />
          <path d="m8 12 3 3 5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "AutoNumber":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M4 7h7M4 12h16M4 17h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    default: // Text
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M4 7V4h16v3M9 20h6M12 4v16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}
