import { useState, useRef, useEffect, useCallback } from "react";
import { Field, TableRecord, UserOption } from "../../types";
import "./TableView.css";

type CellValue = string | number | boolean | string[] | null;

interface Props {
  fields: Field[];
  records: TableRecord[];
  onCellChange: (recordId: string, fieldId: string, value: CellValue) => void;
  onDeleteField?: (fieldId: string) => void;
}

interface EditingState {
  recordId: string;
  fieldId: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  fieldId: string;
}

interface DragState {
  fieldId: string;
  startX: number;
  currentX: number;
  headerRects: Map<string, DOMRect>;
}

// Lark option color palette: maps option.color → { bg, text, dot }
const OPTION_PALETTE: Record<string, { bg: string; text: string; dot: string }> = {
  "#D83931": { bg: "#FEE2E2", text: "#D83931", dot: "#F54A45" },   // Red
  "#F77234": { bg: "#FEE7CD", text: "#F77234", dot: "#FF7D00" },   // Orange
  "#02312A": { bg: "#CAEFFC", text: "#02312A", dot: "#14C9C9" },   // Teal
  "#002270": { bg: "#E0E9FF", text: "#002270", dot: "#3370FF" },   // Blue
  "#3B1A02": { bg: "#FEF0E1", text: "#3B1A02", dot: "#FFB900" },   // Amber
  "#2B2F36": { bg: "#F0F1F3", text: "#2B2F36", dot: "#646A73" },   // Dark
  "#8F959E": { bg: "#F0F1F3", text: "#8F959E", dot: "#8F959E" },   // Gray
};
const DEFAULT_OPTION_STYLE = { bg: "#F0F1F3", text: "#646A73", dot: "#8F959E" };

function getOptionStyle(optionColor?: string) {
  if (optionColor && OPTION_PALETTE[optionColor]) return OPTION_PALETTE[optionColor];
  return DEFAULT_OPTION_STYLE;
}

function findOptionColor(field: Field | undefined, optionName: string): string | undefined {
  return field?.config.options?.find((o) => o.name === optionName)?.color;
}

function StatusTag({ name, optColor }: { name: string; optColor?: string }) {
  const style = getOptionStyle(optColor);
  return (
    <span className="status-tag" style={{ background: style.bg, color: style.text }}>
      {name}
    </span>
  );
}

function formatDate(ts: number | string | null): string {
  if (!ts) return "";
  const d = new Date(typeof ts === "number" ? ts : String(ts));
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function UserAvatar({ userId, users, showName = true }: { userId: string; users: UserOption[]; showName?: boolean }) {
  const user = users.find((u) => u.id === userId);
  if (!user) return <span className="cell-empty" />;
  return (
    <div className="cell-user">
      <img
        className="user-avatar-img"
        src={user.avatar}
        alt={user.name}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
          (e.currentTarget.nextElementSibling as HTMLElement | null)?.style.setProperty("display", "flex");
        }}
      />
      <span className="user-avatar-fallback">{user.name.charAt(0)}</span>
      {showName && <span className="user-name">{user.name}</span>}
    </div>
  );
}

// ─────────── Cell display (read-only) ───────────
function CellDisplay({ field, value }: { field: Field; value: CellValue }) {
  if (value === null || value === undefined || value === "") {
    return <span className="cell-empty" />;
  }

  switch (field.type) {
    case "SingleSelect":
      return <StatusTag name={String(value)} optColor={findOptionColor(field, String(value))} />;

    case "MultiSelect":
      return (
        <div className="cell-tags">
          {(Array.isArray(value) ? value : [String(value)]).map((v) => (
            <StatusTag key={v} name={v} optColor={findOptionColor(field, v)} />
          ))}
        </div>
      );

    case "DateTime":
      return <span className="cell-text">{formatDate(value as number | string)}</span>;

    case "User": {
      const users = field.config.users ?? [];
      return <UserAvatar userId={String(value)} users={users} />;
    }

    case "Checkbox":
      return (
        <span className="cell-checkbox">
          {value ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="0.5" y="0.5" width="13" height="13" rx="2.5" fill="#1456F0" stroke="#1456F0"/>
              <path d="M3 7l3 3 5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="0.5" y="0.5" width="13" height="13" rx="2.5" stroke="#DEE0E3"/>
            </svg>
          )}
        </span>
      );

    default:
      return <span className="cell-text">{String(value)}</span>;
  }
}

// ─────────── Text / Number inline editor ───────────
function TextEditor({
  field,
  value,
  onCommit,
  onCancel,
}: {
  field: Field;
  value: CellValue;
  onCommit: (v: CellValue) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const commit = () => {
    const v = draft.trim();
    if (field.type === "Number") {
      onCommit(v === "" ? null : Number(v));
    } else {
      onCommit(v === "" ? null : v);
    }
  };

  return (
    <input
      ref={inputRef}
      className="cell-input"
      type={field.type === "Number" ? "number" : "text"}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
    />
  );
}

// ─────────── Select dropdown editor ───────────
function SelectEditor({
  field,
  value,
  onCommit,
  onCancel,
}: {
  field: Field;
  value: CellValue;
  onCommit: (v: CellValue) => void;
  onCancel: () => void;
}) {
  const options = field.config.options ?? [];
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onCancel]);

  return (
    <div ref={ref} className="cell-dropdown">
      {options.map((opt) => {
        const optStyle = getOptionStyle(opt.color);
        const isSelected = String(value) === opt.name;
        return (
          <button
            key={opt.id}
            className={`cell-dropdown-item ${isSelected ? "selected" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); onCommit(opt.name); }}
          >
            <span className="option-dot-indicator">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M5 9L1 1H9L5 9Z" fill={optStyle.dot} />
              </svg>
            </span>
            <span className="option-label">{opt.name}</span>
            {isSelected && (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="check-icon">
                <path d="M2 6l3 3 5-5" stroke="#1456F0" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─────────── User picker dropdown ───────────
function UserEditor({
  field,
  value,
  onCommit,
  onCancel,
}: {
  field: Field;
  value: CellValue;
  onCommit: (v: CellValue) => void;
  onCancel: () => void;
}) {
  const users = field.config.users ?? [];
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onCancel]);

  return (
    <div ref={ref} className="cell-dropdown">
      {users.map((user) => {
        const isSelected = String(value) === user.id;
        return (
          <button
            key={user.id}
            className={`cell-dropdown-item ${isSelected ? "selected" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); onCommit(user.id); }}
          >
            <div className="cell-user">
              <img className="user-avatar-img" src={user.avatar} alt={user.name}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                  (e.currentTarget.nextElementSibling as HTMLElement | null)?.style.setProperty("display", "flex");
                }}
              />
              <span className="user-avatar-fallback">{user.name.charAt(0)}</span>
              <span className="user-name">{user.name}</span>
            </div>
            {isSelected && (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="check-icon">
                <path d="M2 6l3 3 5-5" stroke="#1456F0" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─────────── Date picker editor ───────────
function DateEditor({
  value,
  onCommit,
  onCancel,
}: {
  value: CellValue;
  onCommit: (v: CellValue) => void;
  onCancel: () => void;
}) {
  const parsed = value ? new Date(typeof value === "number" ? value : String(value)) : new Date();
  const validDate = isNaN(parsed.getTime()) ? new Date() : parsed;

  const [viewYear, setViewYear] = useState(validDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(validDate.getMonth());
  const ref = useRef<HTMLDivElement>(null);

  const selectedYear = validDate.getFullYear();
  const selectedMonth = validDate.getMonth();
  const selectedDay = validDate.getDate();

  const today = new Date();
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth();
  const todayDay = today.getDate();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onCancel]);

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  // Build calendar grid
  const firstDayOfMonth = new Date(viewYear, viewMonth, 1).getDay();
  // Convert Sunday=0 to Monday-first: Mon=0 .. Sun=6
  const startOffset = (firstDayOfMonth + 6) % 7;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

  const calendarDays: { day: number; month: number; year: number; otherMonth: boolean }[] = [];

  // Previous month trailing days
  for (let i = startOffset - 1; i >= 0; i--) {
    const prevM = viewMonth === 0 ? 11 : viewMonth - 1;
    const prevY = viewMonth === 0 ? viewYear - 1 : viewYear;
    calendarDays.push({ day: daysInPrevMonth - i, month: prevM, year: prevY, otherMonth: true });
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    calendarDays.push({ day: d, month: viewMonth, year: viewYear, otherMonth: false });
  }

  // Next month leading days to fill 6 rows (42 cells) or at least complete the last row
  const remaining = 42 - calendarDays.length;
  for (let d = 1; d <= remaining; d++) {
    const nextM = viewMonth === 11 ? 0 : viewMonth + 1;
    const nextY = viewMonth === 11 ? viewYear + 1 : viewYear;
    calendarDays.push({ day: d, month: nextM, year: nextY, otherMonth: true });
  }

  const handleDayClick = (entry: { day: number; month: number; year: number }) => {
    const picked = new Date(entry.year, entry.month, entry.day);
    onCommit(picked.getTime());
  };

  return (
    <div ref={ref} className="date-picker">
      <div className="date-picker-header">
        <button className="date-picker-nav" onMouseDown={(e) => { e.preventDefault(); prevMonth(); }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M8 2L4 6l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <span className="date-picker-title">{monthNames[viewMonth]} {viewYear}</span>
        <button className="date-picker-nav" onMouseDown={(e) => { e.preventDefault(); nextMonth(); }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
      <div className="date-picker-weekdays">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="date-picker-days">
        {calendarDays.map((entry, i) => {
          const isSelected =
            !entry.otherMonth &&
            entry.year === selectedYear &&
            entry.month === selectedMonth &&
            entry.day === selectedDay;
          const isToday =
            entry.year === todayYear &&
            entry.month === todayMonth &&
            entry.day === todayDay;
          const classes = [
            "date-picker-day",
            entry.otherMonth ? "other-month" : "",
            isSelected ? "selected" : "",
            isToday && !isSelected ? "today" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={i}
              className={classes}
              onMouseDown={(e) => { e.preventDefault(); handleDayClick(entry); }}
            >
              {entry.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─────────── Editable cell wrapper ───────────
function EditableCell({
  field,
  record,
  editing,
  onStartEdit,
  onCommit,
  onCancel,
}: {
  field: Field;
  record: TableRecord;
  editing: boolean;
  onStartEdit: () => void;
  onCommit: (v: CellValue) => void;
  onCancel: () => void;
}) {
  const value = record.cells[field.id] ?? null;
  const isEditable = field.type !== "AutoNumber";

  const handleClick = () => {
    if (isEditable && !editing) onStartEdit();
  };

  const renderEditor = () => {
    switch (field.type) {
      case "Text":
        return <TextEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
      case "Number":
        return <TextEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
      case "SingleSelect":
        return (
          <div className="cell-editor-wrap">
            <CellDisplay field={field} value={value} />
            <SelectEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />
          </div>
        );
      case "MultiSelect":
        return (
          <div className="cell-editor-wrap">
            <CellDisplay field={field} value={value} />
            <SelectEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />
          </div>
        );
      case "User":
        return (
          <div className="cell-editor-wrap">
            <CellDisplay field={field} value={value} />
            <UserEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />
          </div>
        );
      case "DateTime":
        return (
          <div className="cell-editor-wrap">
            <CellDisplay field={field} value={value} />
            <DateEditor value={value} onCommit={onCommit} onCancel={onCancel} />
          </div>
        );
      default:
        return <CellDisplay field={field} value={value} />;
    }
  };

  return (
    <div
      className={`cell-wrap ${isEditable ? "editable" : ""} ${editing ? "editing" : ""}`}
      onClick={handleClick}
    >
      {editing ? renderEditor() : <CellDisplay field={field} value={value} />}
    </div>
  );
}

// ─────────── Default column widths ───────────
const DEFAULT_COL_WIDTHS: Record<string, number> = {
  fld_name: 220,
  fld_status: 130,
  fld_created: 120,
  fld_assignee: 100,
  fld_module: 100,
  fld_desc: 240,
  fld_priority: 80,
  fld_type: 100,
  fld_progress: 90,
  fld_tags: 160,
  fld_deadline: 120,
  fld_reviewer: 100,
  fld_estimated_hours: 90,
  fld_actual_hours: 90,
  fld_is_urgent: 80,
  fld_sprint: 100,
  fld_source: 100,
  fld_version: 90,
  fld_test_status: 100,
  fld_remark: 160,
};
const MIN_COL_WIDTH = 60;

// ─────────── Main TableView ───────────
const DEFAULT_FIELD_IDS = [
  "fld_name", "fld_status", "fld_priority", "fld_type", "fld_created",
  "fld_deadline", "fld_assignee", "fld_reviewer", "fld_module", "fld_source",
  "fld_tags", "fld_progress", "fld_estimated_hours", "fld_actual_hours",
  "fld_is_urgent", "fld_sprint", "fld_version", "fld_test_status", "fld_desc", "fld_remark",
  "fld_pd_estimate",
];

const FIELD_ORDER_KEY = "field_order_v1";
const COL_WIDTHS_KEY = "col_widths_v1";

function loadFieldOrder(): string[] {
  try {
    const stored = localStorage.getItem(FIELD_ORDER_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_FIELD_IDS;
}

function loadColWidths(): Record<string, number> {
  try {
    const stored = localStorage.getItem(COL_WIDTHS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === "object") {
        return { ...DEFAULT_COL_WIDTHS, ...parsed };
      }
    }
  } catch {}
  return { ...DEFAULT_COL_WIDTHS };
}

export default function TableView({ fields, records, onCellChange, onDeleteField }: Props) {
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const [selectedColId, setSelectedColId] = useState<string | null>(null);
  const [colWidths, setColWidths] = useState<Record<string, number>>(loadColWidths);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [fieldOrder, setFieldOrder] = useState<string[]>(loadFieldOrder);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dragOverFieldId, setDragOverFieldId] = useState<string | null>(null);

  // Resize state
  const resizeRef = useRef<{
    fieldId: string;
    startX: number;
    startWidth: number;
  } | null>(null);

  const headerRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const dragRef = useRef<DragState | null>(null);
  const justDraggedRef = useRef(false);

  // Sync fieldOrder with actual fields: remove stale/duplicate, append new
  useEffect(() => {
    if (fields.length === 0) return; // wait for fields to load
    const validIds = new Set(fields.map((f) => f.id));
    const seen = new Set<string>();
    // Keep only valid, unique entries
    const cleaned = fieldOrder.filter((id) => {
      if (!validIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    // Append any new fields not yet in the order
    const newIds = fields.filter((f) => !seen.has(f.id)).map((f) => f.id);
    const updated = [...cleaned, ...newIds];
    if (JSON.stringify(updated) !== JSON.stringify(fieldOrder)) {
      setFieldOrder(updated);
    }
  }, [fields]);

  // Persist field order to localStorage
  useEffect(() => {
    localStorage.setItem(FIELD_ORDER_KEY, JSON.stringify(fieldOrder));
  }, [fieldOrder]);

  // Persist column widths to localStorage
  useEffect(() => {
    localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(colWidths));
  }, [colWidths]);

  const visibleFields = fieldOrder
    .map((id) => fields.find((f) => f.id === id))
    .filter(Boolean) as Field[];

  const startEdit = useCallback((recordId: string, fieldId: string) => {
    setEditing({ recordId, fieldId });
  }, []);

  const commitEdit = useCallback((recordId: string, fieldId: string, value: CellValue) => {
    onCellChange(recordId, fieldId, value);
    setEditing(null);
  }, [onCellChange]);

  const cancelEdit = useCallback(() => {
    setEditing(null);
  }, []);

  // Click outside table = cancel edit & deselect column & close context menu
  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tableRef.current && !tableRef.current.contains(e.target as Node)) {
        if (editing) setEditing(null);
        if (selectedColId) setSelectedColId(null);
      }
      // Close context menu on any click
      setContextMenu(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editing, selectedColId]);

  // ── Column resize handlers ──
  const handleResizeStart = useCallback((e: React.MouseEvent, fieldId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[fieldId] ?? DEFAULT_COL_WIDTHS[fieldId] ?? 120;
    resizeRef.current = { fieldId, startX, startWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = ev.clientX - resizeRef.current.startX;
      const newWidth = Math.max(MIN_COL_WIDTH, resizeRef.current.startWidth + delta);
      setColWidths((prev) => ({ ...prev, [resizeRef.current!.fieldId]: newWidth }));
    };

    const onMouseUp = () => {
      resizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [colWidths]);

  // ── Header click → select column ──
  const handleHeaderClick = useCallback((fieldId: string) => {
    setSelectedColId((prev) => (prev === fieldId ? null : fieldId));
  }, []);

  // ── Context menu (right-click on header) ──
  const handleHeaderContextMenu = useCallback((e: React.MouseEvent, fieldId: string) => {
    e.preventDefault();
    // Don't allow deleting the primary field (fld_name)
    if (fieldId === "fld_name") return;
    setContextMenu({ x: e.clientX, y: e.clientY, fieldId });
  }, []);

  const handleDeleteFieldClick = useCallback(() => {
    if (!contextMenu) return;
    const fieldId = contextMenu.fieldId;
    setContextMenu(null);
    onDeleteField?.(fieldId);
    // Remove from field order
    setFieldOrder((prev) => prev.filter((id) => id !== fieldId));
    // If this column was selected, deselect
    setSelectedColId((prev) => (prev === fieldId ? null : prev));
  }, [contextMenu, onDeleteField]);

  // ── Drag-to-reorder columns ──
  const dragOverRef = useRef<string | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent, fieldId: string) => {
    // Don't start drag from resize handle area (rightmost 8px)
    const th = headerRefs.current.get(fieldId);
    if (!th) return;
    const rect = th.getBoundingClientRect();
    if (e.clientX > rect.right - 8) return;

    // Only allow drag if the column is already selected
    if (selectedColId !== fieldId) return;

    e.preventDefault();
    e.stopPropagation();

    // Gather all header rects at drag start
    const rects = new Map<string, DOMRect>();
    headerRefs.current.forEach((el, id) => {
      rects.set(id, el.getBoundingClientRect());
    });

    const startX = e.clientX;
    dragRef.current = { fieldId, startX, currentX: startX, headerRects: rects };
    justDraggedRef.current = false;
    setDragState({ fieldId, startX, currentX: startX, headerRects: rects });
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      dragRef.current.currentX = ev.clientX;
      setDragState({ ...dragRef.current });

      // Find which column we're hovering over
      let overId: string | null = null;
      rects.forEach((r, id) => {
        if (id === fieldId) return;
        if (ev.clientX >= r.left && ev.clientX <= r.right) {
          overId = id;
        }
      });
      dragOverRef.current = overId;
      setDragOverFieldId(overId);
    };

    const onMouseUp = () => {
      const finalOverId = dragOverRef.current;
      const finalCurrentX = dragRef.current?.currentX ?? startX;

      if (finalOverId && finalOverId !== fieldId) {
        setFieldOrder((prev) => {
          const arr = [...prev];
          const fromIdx = arr.indexOf(fieldId);
          if (fromIdx === -1) return prev;
          arr.splice(fromIdx, 1);

          let toIdx = arr.indexOf(finalOverId);
          if (toIdx === -1) return prev;

          // If dragging past the target's center, insert after
          const targetRect = rects.get(finalOverId);
          if (targetRect && finalCurrentX > targetRect.left + targetRect.width / 2) {
            toIdx += 1;
          }

          arr.splice(toIdx, 0, fieldId);
          return arr;
        });
      }

      dragRef.current = null;
      dragOverRef.current = null;
      justDraggedRef.current = true;
      // Clear the flag after a tick so subsequent clicks work
      requestAnimationFrame(() => { justDraggedRef.current = false; });
      setDragState(null);
      setDragOverFieldId(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [selectedColId]);

  // Compute drag offset for the dragged column header
  const getDragTransform = (fieldId: string): React.CSSProperties => {
    if (!dragState || dragState.fieldId !== fieldId) return {};
    const delta = dragState.currentX - dragState.startX;
    return {
      transform: `translateX(${delta}px)`,
      zIndex: 10,
      opacity: 0.85,
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      position: "relative" as const,
    };
  };

  // Visual indicator styles for the drop target
  const getDropIndicatorStyle = (fieldId: string): string => {
    if (!dragState || !dragOverFieldId || dragOverFieldId !== fieldId || dragState.fieldId === fieldId) return "";
    return "col-drag-over";
  };

  return (
    <div className="table-wrap" ref={tableRef}>
      <div className="table-container">
        <table className="data-table">
          <colgroup>
            <col style={{ width: 44 }} />
            {visibleFields.map((f) => (
              <col key={f.id} style={{ width: colWidths[f.id] ?? DEFAULT_COL_WIDTHS[f.id] ?? 120 }} />
            ))}
            <col style={{ width: 136 }} />
          </colgroup>
          <thead>
            <tr>
              <th className="col-index">
                <input type="checkbox" className="row-checkbox" />
              </th>
              {visibleFields.map((f) => (
                <th
                  key={f.id}
                  ref={(el) => { if (el) headerRefs.current.set(f.id, el); else headerRefs.current.delete(f.id); }}
                  data-field-id={f.id}
                  className={`col-${f.id} ${selectedColId === f.id ? "col-selected" : ""} ${getDropIndicatorStyle(f.id)}`}
                  style={{
                    ...(getDragTransform(f.id)),
                    cursor: selectedColId === f.id && !resizeRef.current ? "grab" : undefined,
                  }}
                  onClick={() => {
                    // Don't toggle selection if we just finished a drag
                    if (!dragRef.current && !justDraggedRef.current) handleHeaderClick(f.id);
                  }}
                  onContextMenu={(e) => handleHeaderContextMenu(e, f.id)}
                  onMouseDown={(e) => {
                    if (e.button === 0 && selectedColId === f.id) {
                      handleDragStart(e, f.id);
                    }
                  }}
                >
                  <div className="th-inner">
                    <FieldIcon type={f.type} />
                    {f.name}
                  </div>
                  {/* Resize handle */}
                  <div
                    className="col-resize-handle"
                    onMouseDown={(e) => handleResizeStart(e, f.id)}
                  />
                </th>
              ))}
              <th className="col-add">
                <button className="col-add-btn" title="Add field">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {records.map((record, idx) => {
              const isHovered = hoveredRowId === record.id;
              return (
                <tr
                  key={record.id}
                  className={`data-row ${isHovered ? "row-hovered" : ""}`}
                  onMouseEnter={() => setHoveredRowId(record.id)}
                  onMouseLeave={() => setHoveredRowId(null)}
                >
                  <td className="col-index">
                    {isHovered ? (
                      <input type="checkbox" className="row-checkbox" />
                    ) : (
                      <span className="row-number">{idx + 1}</span>
                    )}
                  </td>
                  {visibleFields.map((f) => {
                    const isEditing = editing?.recordId === record.id && editing?.fieldId === f.id;
                    const isColSelected = selectedColId === f.id;
                    return (
                      <td
                        key={f.id}
                        className={`col-${f.id} ${isEditing ? "td-editing" : ""} ${isColSelected ? "col-selected" : ""}`}
                      >
                        <EditableCell
                          field={f}
                          record={record}
                          editing={isEditing}
                          onStartEdit={() => startEdit(record.id, f.id)}
                          onCommit={(v) => commitEdit(record.id, f.id, v)}
                          onCancel={cancelEdit}
                        />
                      </td>
                    );
                  })}
                  <td className="col-add" />
                </tr>
              );
            })}
            <tr className="add-row">
              <td colSpan={visibleFields.length + 2}>
                <button className="add-record-btn">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  Add record
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="table-footer">
        {records.length} records
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ marginLeft: 2 }}>
          <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* Context menu for field headers */}
      {contextMenu && (
        <div
          className="field-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button className="field-context-menu-item" onClick={handleDeleteFieldClick}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4.5 3V2.5C4.5 1.67 5.17 1 6 1h4c.83 0 1.5.67 1.5 1.5V3M2 3.5h12M3.5 3.5v10c0 .83.67 1.5 1.5 1.5h6c.83 0 1.5-.67 1.5-1.5v-10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M6.5 6.5v4.5M9.5 6.5v4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            Delete field
          </button>
        </div>
      )}
    </div>
  );
}

function FieldIcon({ type }: { type: string }) {
  switch (type) {
    case "DateTime":
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="field-icon">
          <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "SingleSelect":
    case "MultiSelect":
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="field-icon">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path d="m9 12 2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "User":
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="field-icon">
          <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
          <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "Number":
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="field-icon">
          <path d="M7 20l3-16M14 20l3-16M4 8h18M3 16h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "Checkbox":
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="field-icon">
          <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="2" />
          <path d="m7 12 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="field-icon">
          <path d="M4 6h16M4 10h16M4 14h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
  }
}
