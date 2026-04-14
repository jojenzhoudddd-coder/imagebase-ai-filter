import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import { Field, TableRecord, UserOption } from "../../types";
import "./TableView.css";

type CellValue = string | number | boolean | string[] | null;

interface Props {
  fields: Field[];              // Already ordered & filtered visible fields from App.tsx
  records: TableRecord[];
  onCellChange: (recordId: string, fieldId: string, value: CellValue) => void;
  onDeleteField?: (fieldId: string) => void;
  onDeleteFields?: (fieldIds: string[]) => void;
  onFieldOrderChange?: (newOrder: string[]) => void;   // Full fieldOrder (including hidden)
  onHideField?: (fieldId: string) => void;
  onHideFields?: (fieldIds: string[]) => void;
  fieldOrder?: string[];         // Full fieldOrder from App.tsx (including hidden fields)
  onDeleteRecords?: (recordIds: string[]) => void;
  onClearCells?: (cells: Array<{ recordId: string; fieldId: string }>) => void;
}

interface CellRange {
  startRowIdx: number;
  startColIdx: number;
  endRowIdx: number;
  endColIdx: number;
}

interface RowContextMenuState {
  x: number;
  y: number;
  recordIds: string[];
}

interface EditingState {
  recordId: string;
  fieldId: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  fieldIds: string[];
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

  const handleDoubleClick = () => {
    if (isEditable && !editing && field.type !== "Checkbox") onStartEdit();
  };

  const handleClick = () => {
    // Checkbox: toggle on single click
    if (field.type === "Checkbox" && !editing) {
      onCommit(!value);
    }
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
      onDoubleClick={handleDoubleClick}
    >
      {editing ? renderEditor() : <CellDisplay field={field} value={value} />}
    </div>
  );
}

// ─────────── Default column widths ───────────
const DEFAULT_COL_WIDTHS: Record<string, number> = {
  fld_name: 220,
  fld_created: 120,
  fld_assignee: 100,
  fld_desc: 240,
  fld_priority: 80,
  fld_deadline: 120,
  fld_source: 100,
  fld_remark: 160,
  fld_pd_estimate: 90,
};
const MIN_COL_WIDTH = 60;

// ─────────── Main TableView ───────────
export interface TableViewHandle {
  selectAndScrollToField: (fieldId: string) => void;
}

const COL_WIDTHS_KEY = "col_widths_v1";

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

const CELL_DRAG_THRESHOLD = 4;

const TableView = forwardRef<TableViewHandle, Props>(function TableView({ fields, records, onCellChange, onDeleteField, onDeleteFields, onFieldOrderChange, onHideField, onHideFields, fieldOrder, onDeleteRecords, onClearCells }, ref) {
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const [selectedColIds, setSelectedColIds] = useState<Set<string>>(new Set());
  const [colWidths, setColWidths] = useState<Record<string, number>>(loadColWidths);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [rowContextMenu, setRowContextMenu] = useState<RowContextMenuState | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dragOverFieldId, setDragOverFieldId] = useState<string | null>(null);

  // ── Cell range selection (drag to select) ──
  const [cellRange, setCellRange] = useState<CellRange | null>(null);
  const cellDragRef = useRef<{
    startRowIdx: number;
    startColIdx: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const justCellDraggedRef = useRef(false);

  // Track last-clicked row for Shift+Click range selection
  const lastClickedRowRef = useRef<string | null>(null);

  // Header checkbox ref for indeterminate state
  const headerCheckRef = useRef<HTMLInputElement>(null);

  // Resize state
  const resizeRef = useRef<{
    fieldId: string;
    startX: number;
    startWidth: number;
  } | null>(null);

  const headerRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const dragRef = useRef<DragState | null>(null);
  const justDraggedRef = useRef(false);

  // Expose imperative methods to parent
  useImperativeHandle(ref, () => ({
    selectAndScrollToField(fieldId: string) {
      setSelectedColIds(new Set([fieldId]));
      // Scroll the column header into view
      const th = headerRefs.current.get(fieldId);
      if (th) {
        th.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }
    },
  }), []);

  // Header checkbox: indeterminate state
  const allSelected = records.length > 0 && selectedRowIds.size === records.length;
  const someSelected = selectedRowIds.size > 0 && !allSelected;
  useEffect(() => {
    if (headerCheckRef.current) headerCheckRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const handleHeaderCheckChange = useCallback(() => {
    setCellRange(null);
    if (allSelected) setSelectedRowIds(new Set());
    else setSelectedRowIds(new Set(records.map(r => r.id)));
  }, [allSelected, records]);

  const handleRowCheckChange = useCallback((recordId: string, shiftKey = false) => {
    setCellRange(null); // Clear cell selection when selecting rows
    setSelectedRowIds(prev => {
      // Shift+Click: select range from last-clicked row to this row
      if (shiftKey && lastClickedRowRef.current && lastClickedRowRef.current !== recordId) {
        const ids = records.map(r => r.id);
        const anchorIdx = ids.indexOf(lastClickedRowRef.current);
        const targetIdx = ids.indexOf(recordId);
        if (anchorIdx !== -1 && targetIdx !== -1) {
          const from = Math.min(anchorIdx, targetIdx);
          const to = Math.max(anchorIdx, targetIdx);
          const rangeIds = ids.slice(from, to + 1);
          const next = new Set(prev);
          for (const id of rangeIds) next.add(id);
          return next;
        }
      }
      // Normal click: toggle single row
      const next = new Set(prev);
      if (next.has(recordId)) next.delete(recordId);
      else next.add(recordId);
      lastClickedRowRef.current = recordId;
      return next;
    });
  }, [records]);

  // Clear selection when records change (e.g. after delete)
  useEffect(() => {
    setSelectedRowIds(prev => {
      const validIds = new Set(records.map(r => r.id));
      const cleaned = new Set([...prev].filter(id => validIds.has(id)));
      if (cleaned.size !== prev.size) return cleaned;
      return prev;
    });
  }, [records]);

  // Row context menu handler
  const handleRowContextMenu = useCallback((e: React.MouseEvent, recordId: string) => {
    e.preventDefault();
    let ids: string[];
    if (selectedRowIds.has(recordId)) {
      // Row checkbox selection: use all checked rows
      ids = [...selectedRowIds];
    } else if (cellRange) {
      // Cell range selection: collect all rows covered by the range
      const minRow = Math.min(cellRange.startRowIdx, cellRange.endRowIdx);
      const maxRow = Math.max(cellRange.startRowIdx, cellRange.endRowIdx);
      ids = [];
      for (let r = minRow; r <= maxRow; r++) {
        if (r < records.length) ids.push(records[r].id);
      }
    } else {
      ids = [recordId];
    }
    setRowContextMenu({ x: e.clientX, y: e.clientY, recordIds: ids });
  }, [selectedRowIds, cellRange, records]);

  const handleDeleteRowsClick = useCallback(() => {
    if (!rowContextMenu) return;
    const ids = rowContextMenu.recordIds;
    setRowContextMenu(null);
    setSelectedRowIds(new Set());
    onDeleteRecords?.(ids);
  }, [rowContextMenu, onDeleteRecords]);

  // Persist column widths to localStorage
  useEffect(() => {
    localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(colWidths));
  }, [colWidths]);

  // fields is already ordered and filtered by App.tsx
  const visibleFields = fields;

  const startEdit = useCallback((recordId: string, fieldId: string) => {
    if (justCellDraggedRef.current) return;
    setEditing({ recordId, fieldId });
    setCellRange(null);
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
        if (selectedColIds.size > 0) setSelectedColIds(new Set());
        if (cellRange) setCellRange(null);
      }
      // Close context menus on any click
      setContextMenu(null);
      setRowContextMenu(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editing, selectedColIds]);

  // ── Cell range selection: drag to select ──
  const isCellInRange = useCallback((rowIdx: number, colIdx: number) => {
    if (!cellRange) return false;
    const minRow = Math.min(cellRange.startRowIdx, cellRange.endRowIdx);
    const maxRow = Math.max(cellRange.startRowIdx, cellRange.endRowIdx);
    const minCol = Math.min(cellRange.startColIdx, cellRange.endColIdx);
    const maxCol = Math.max(cellRange.startColIdx, cellRange.endColIdx);
    return rowIdx >= minRow && rowIdx <= maxRow && colIdx >= minCol && colIdx <= maxCol;
  }, [cellRange]);

  const handleCellMouseDown = useCallback((e: React.MouseEvent, rowIdx: number, colIdx: number) => {
    if (e.button !== 0) return;
    // If currently editing, exit edit mode first, then proceed to select the new cell
    if (editing) setEditing(null);

    // Check if clicking on an already-selected single cell (for "click again to edit")
    const wasAlreadySelected = cellRange &&
      cellRange.startRowIdx === cellRange.endRowIdx &&
      cellRange.startColIdx === cellRange.endColIdx &&
      cellRange.startRowIdx === rowIdx &&
      cellRange.startColIdx === colIdx;

    const startX = e.clientX;
    const startY = e.clientY;
    cellDragRef.current = { startRowIdx: rowIdx, startColIdx: colIdx, startX, startY, dragging: false };
    justCellDraggedRef.current = false;

    // Set initial selection to this single cell; clear column selection
    setCellRange({ startRowIdx: rowIdx, startColIdx: colIdx, endRowIdx: rowIdx, endColIdx: colIdx });
    setSelectedColIds(new Set());

    const onMouseMove = (ev: MouseEvent) => {
      if (!cellDragRef.current) return;
      const dx = ev.clientX - cellDragRef.current.startX;
      const dy = ev.clientY - cellDragRef.current.startY;

      if (!cellDragRef.current.dragging && (Math.abs(dx) > CELL_DRAG_THRESHOLD || Math.abs(dy) > CELL_DRAG_THRESHOLD)) {
        cellDragRef.current.dragging = true;
        justCellDraggedRef.current = true;
        setEditing(null); // cancel any pending edit
        document.body.style.userSelect = "none";
      }

      if (cellDragRef.current.dragging) {
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const td = el?.closest("td[data-row-idx][data-col-idx]") as HTMLElement | null;
        if (td) {
          const endRowIdx = parseInt(td.getAttribute("data-row-idx")!, 10);
          const endColIdx = parseInt(td.getAttribute("data-col-idx")!, 10);
          if (!isNaN(endRowIdx) && !isNaN(endColIdx)) {
            setCellRange(prev => prev ? { ...prev, endRowIdx, endColIdx } : null);
          }
        }
      }
    };

    const onMouseUp = () => {
      if (cellDragRef.current?.dragging) {
        // Suppress clicks that might follow the drag (e.g. checkbox toggle)
        requestAnimationFrame(() => { justCellDraggedRef.current = false; });
      } else {
        justCellDraggedRef.current = false;
        // Click (no drag) on an already-selected single cell → enter edit
        if (wasAlreadySelected) {
          const field = visibleFields[colIdx];
          if (field && field.type !== "AutoNumber" && field.type !== "Checkbox") {
            startEdit(records[rowIdx]?.id, field.id);
          }
        }
      }
      cellDragRef.current = null;
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [editing, cellRange, records, visibleFields, startEdit]);

  // ── Keyboard: Delete/Backspace on selected rows or cells, Escape clears selection ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in a text input/textarea (but allow checkbox)
      const target = e.target as HTMLInputElement;
      if (target.tagName === "TEXTAREA") return;
      if (target.tagName === "INPUT" && target.type !== "checkbox") return;

      if ((e.key === "Delete" || e.key === "Backspace") && !editing) {
        // Priority 1: rows selected via checkbox → delete rows (goes through safety delete)
        if (selectedRowIds.size > 0) {
          e.preventDefault();
          onDeleteRecords?.([...selectedRowIds]);
          return;
        }
        // Priority 2: cell range selected → clear cells directly (no confirmation)
        if (cellRange) {
          e.preventDefault();
          const minRow = Math.min(cellRange.startRowIdx, cellRange.endRowIdx);
          const maxRow = Math.max(cellRange.startRowIdx, cellRange.endRowIdx);
          const minCol = Math.min(cellRange.startColIdx, cellRange.endColIdx);
          const maxCol = Math.max(cellRange.startColIdx, cellRange.endColIdx);

          const cells: Array<{ recordId: string; fieldId: string }> = [];
          const readOnlyTypes = new Set(["AutoNumber", "CreatedTime", "ModifiedTime"]);
          for (let r = minRow; r <= maxRow; r++) {
            for (let c = minCol; c <= maxCol; c++) {
              if (r < records.length && c < visibleFields.length) {
                const field = visibleFields[c];
                if (readOnlyTypes.has(field.type)) continue;
                cells.push({ recordId: records[r].id, fieldId: field.id });
              }
            }
          }
          if (cells.length > 0) onClearCells?.(cells);
        }
      }

      if (e.key === "Escape" && cellRange && !editing) {
        setCellRange(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [cellRange, editing, records, visibleFields, onClearCells, selectedRowIds, onDeleteRecords]);

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

  // ── Header click → select column (Shift+Click = add to selection) ──
  const handleHeaderClick = useCallback((fieldId: string, shiftKey = false) => {
    setCellRange(null); // Clear cell selection when selecting columns
    setSelectedColIds(prev => {
      if (shiftKey) {
        // Shift+Click: toggle this column in the multi-selection
        const next = new Set(prev);
        if (next.has(fieldId)) next.delete(fieldId);
        else next.add(fieldId);
        return next;
      }
      // Normal click: single-select toggle
      if (prev.size === 1 && prev.has(fieldId)) return new Set();
      return new Set([fieldId]);
    });
  }, []);

  // ── Context menu (right-click on header) ──
  const handleHeaderContextMenu = useCallback((e: React.MouseEvent, fieldId: string) => {
    e.preventDefault();
    let ids: string[];
    if (selectedColIds.has(fieldId) && selectedColIds.size > 0) {
      // Use entire selection, but exclude primary field (fld_name)
      ids = [...selectedColIds].filter(id => id !== "fld_name");
    } else {
      if (fieldId === "fld_name") return;
      ids = [fieldId];
    }
    if (ids.length === 0) return;
    setContextMenu({ x: e.clientX, y: e.clientY, fieldIds: ids });
  }, [selectedColIds]);

  const handleDeleteFieldClick = useCallback(() => {
    if (!contextMenu) return;
    const ids = contextMenu.fieldIds;
    setContextMenu(null);
    if (ids.length === 1) {
      onDeleteField?.(ids[0]);
    } else {
      onDeleteFields?.(ids);
    }
    // Remove deleted columns from selection
    setSelectedColIds(prev => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, [contextMenu, onDeleteField, onDeleteFields]);

  const handleHideFieldClick = useCallback(() => {
    if (!contextMenu) return;
    const ids = contextMenu.fieldIds;
    setContextMenu(null);
    if (ids.length === 1) {
      onHideField?.(ids[0]);
    } else {
      onHideFields?.(ids);
    }
    setSelectedColIds(prev => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, [contextMenu, onHideField, onHideFields]);

  // ── Drag-to-reorder columns ──
  const dragOverRef = useRef<string | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent, fieldId: string) => {
    // Don't start drag from resize handle area (rightmost 8px)
    const th = headerRefs.current.get(fieldId);
    if (!th) return;
    const rect = th.getBoundingClientRect();
    if (e.clientX > rect.right - 8) return;

    // Only allow drag if the column is already selected (and it's the only selected one)
    if (!selectedColIds.has(fieldId) || selectedColIds.size !== 1) return;

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

      if (finalOverId && finalOverId !== fieldId && fieldOrder) {
        // Reorder using the full fieldOrder (including hidden fields)
        const arr = [...fieldOrder];
        const fromIdx = arr.indexOf(fieldId);
        if (fromIdx !== -1) {
          arr.splice(fromIdx, 1);
          let toIdx = arr.indexOf(finalOverId);
          if (toIdx !== -1) {
            // If dragging past the target's center, insert after
            const targetRect = rects.get(finalOverId);
            if (targetRect && finalCurrentX > targetRect.left + targetRect.width / 2) {
              toIdx += 1;
            }
            arr.splice(toIdx, 0, fieldId);
            onFieldOrderChange?.(arr);
          }
        }
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
  }, [selectedColIds]);

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
                <input
                  type="checkbox"
                  className="row-checkbox"
                  ref={headerCheckRef}
                  checked={allSelected}
                  onChange={handleHeaderCheckChange}
                />
              </th>
              {visibleFields.map((f) => (
                <th
                  key={f.id}
                  ref={(el) => { if (el) headerRefs.current.set(f.id, el); else headerRefs.current.delete(f.id); }}
                  data-field-id={f.id}
                  className={`col-${f.id} ${selectedColIds.has(f.id) ? "col-selected" : ""} ${getDropIndicatorStyle(f.id)}`}
                  style={{
                    ...(getDragTransform(f.id)),
                    cursor: selectedColIds.has(f.id) && selectedColIds.size === 1 && !resizeRef.current ? "grab" : undefined,
                  }}
                  onClick={(e) => {
                    // Don't toggle selection if we just finished a drag
                    if (!dragRef.current && !justDraggedRef.current) handleHeaderClick(f.id, e.shiftKey);
                  }}
                  onContextMenu={(e) => handleHeaderContextMenu(e, f.id)}
                  onMouseDown={(e) => {
                    if (e.button === 0 && selectedColIds.has(f.id) && selectedColIds.size === 1) {
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
              const isRowSelected = selectedRowIds.has(record.id);
              const showCheckbox = selectedRowIds.size > 0 || isHovered;
              return (
                <tr
                  key={record.id}
                  className={`data-row ${isHovered ? "row-hovered" : ""} ${isRowSelected ? "row-selected" : ""}`}
                  onMouseEnter={() => setHoveredRowId(record.id)}
                  onMouseLeave={() => setHoveredRowId(null)}
                  onContextMenu={(e) => handleRowContextMenu(e, record.id)}
                  onClick={(e) => {
                    // Shift+Click on a row selects range (skip if click originated from checkbox)
                    if (e.shiftKey && !(e.target instanceof HTMLInputElement)) {
                      e.preventDefault();
                      handleRowCheckChange(record.id, true);
                    }
                  }}
                >
                  <td className="col-index">
                    {showCheckbox ? (
                      <input
                        type="checkbox"
                        className="row-checkbox"
                        checked={isRowSelected}
                        onChange={(e) => handleRowCheckChange(record.id, (e.nativeEvent as MouseEvent).shiftKey)}
                      />
                    ) : (
                      <span
                        className="row-number"
                        onClick={(e) => { e.stopPropagation(); handleRowCheckChange(record.id, e.shiftKey); }}
                      >{idx + 1}</span>
                    )}
                  </td>
                  {visibleFields.map((f, fIdx) => {
                    const isEditing = editing?.recordId === record.id && editing?.fieldId === f.id;
                    const isColSelected = selectedColIds.has(f.id);
                    const isCellSel = isCellInRange(idx, fIdx);
                    return (
                      <td
                        key={f.id}
                        data-row-idx={idx}
                        data-col-idx={fIdx}
                        className={`col-${f.id} ${isEditing ? "td-editing" : ""} ${isColSelected ? "col-selected" : ""} ${isCellSel ? "cell-range-selected" : ""}`}
                        onMouseDown={(e) => handleCellMouseDown(e, idx, fIdx)}
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
          <button className="field-context-menu-item" onClick={handleHideFieldClick}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M2.03133 8.17212C2.48854 7.86232 3.11033 7.98182 3.42013 8.43903C5.2629 11.1586 8.63638 13 11.9999 13C15.3634 13 18.7369 11.1586 20.5797 8.43903C20.8895 7.98182 21.5112 7.86232 21.9685 8.17212C22.4257 8.48193 22.5452 9.10371 22.2354 9.56092C21.6739 10.3896 20.9972 11.1486 20.2338 11.8197L22.2425 13.8284C22.633 14.2189 22.633 14.8521 22.2425 15.2426C21.852 15.6331 21.2188 15.6331 20.8283 15.2426L18.707 13.1213C18.6764 13.0907 18.6482 13.0586 18.6224 13.0252C17.8775 13.4967 17.0823 13.8942 16.2549 14.2062L16.967 16.8637C17.1099 17.3972 16.7933 17.9455 16.2599 18.0884C15.7264 18.2314 15.1781 17.9148 15.0351 17.3813L14.3332 14.7617C13.5658 14.9178 12.7838 15 11.9999 15C11.289 15 10.5796 14.9324 9.88128 14.8033L9.1905 17.3813C9.04756 17.9148 8.49922 18.2314 7.96576 18.0884C7.43229 17.9455 7.11571 17.3972 7.25865 16.8637L7.95049 14.2817C7.0364 13.9548 6.15936 13.5237 5.34339 13.0036C5.31329 13.0448 5.27966 13.0841 5.24249 13.1213L3.12117 15.2426C2.73064 15.6332 2.09748 15.6332 1.70696 15.2426C1.31643 14.8521 1.31643 14.219 1.70696 13.8284L3.73924 11.7961C2.98679 11.1308 2.31937 10.3799 1.76442 9.56092C1.45462 9.10371 1.57412 8.48193 2.03133 8.17212Z" fill="currentColor"/>
            </svg>
            {contextMenu.fieldIds.length > 1 ? `Hide ${contextMenu.fieldIds.length} fields` : "Hide field"}
          </button>
          <div className="field-context-menu-divider" />
          <button className="field-context-menu-item" onClick={handleDeleteFieldClick}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4.5 3V2.5C4.5 1.67 5.17 1 6 1h4c.83 0 1.5.67 1.5 1.5V3M2 3.5h12M3.5 3.5v10c0 .83.67 1.5 1.5 1.5h6c.83 0 1.5-.67 1.5-1.5v-10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M6.5 6.5v4.5M9.5 6.5v4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            {contextMenu.fieldIds.length > 1 ? `Delete ${contextMenu.fieldIds.length} fields` : "Delete field"}
          </button>
        </div>
      )}

      {/* Context menu for rows (right-click) */}
      {rowContextMenu && (
        <div
          className="field-context-menu"
          style={{ left: rowContextMenu.x, top: rowContextMenu.y, minWidth: 200 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button className="field-context-menu-item" onClick={handleDeleteRowsClick}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4.5 3V2.5C4.5 1.67 5.17 1 6 1h4c.83 0 1.5.67 1.5 1.5V3M2 3.5h12M3.5 3.5v10c0 .83.67 1.5 1.5 1.5h6c.83 0 1.5-.67 1.5-1.5v-10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M6.5 6.5v4.5M9.5 6.5v4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            {rowContextMenu.recordIds.length === 1 ? "Delete record" : `Delete ${rowContextMenu.recordIds.length} records`}
          </button>
        </div>
      )}
    </div>
  );
});

export default TableView;

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
