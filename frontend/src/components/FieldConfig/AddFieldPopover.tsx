import { useEffect, useMemo, useRef, useState } from "react";
import {
  Field,
  FieldType,
  LookupConfig,
} from "../../types";
import { createField, fetchTables, TableBrief, ApiError } from "../../api";
import { LookupConfigPanel } from "./LookupConfigPanel";
import "./FieldConfig.css";

interface Props {
  currentTableId: string;
  currentFields: Field[];
  anchorRect: DOMRect | null;
  onCancel: () => void;
  onConfirm: (newField: Field) => void;
}

const FIELD_TYPE_GROUPS: { group: string; items: { type: FieldType; icon: string; label: string }[] }[] = [
  {
    group: "Basic",
    items: [
      { type: "Text",         icon: "AΞ", label: "Text" },
      { type: "Number",       icon: "#",  label: "Number" },
      { type: "SingleSelect", icon: "◉", label: "Single Option" },
      { type: "MultiSelect",  icon: "☲", label: "Multi Options" },
      { type: "User",         icon: "☻", label: "Person" },
      { type: "DateTime",     icon: "▥", label: "Date" },
      { type: "Checkbox",     icon: "☑", label: "Checkbox" },
      { type: "Lookup",       icon: "▦", label: "Lookup" },
    ],
  },
];

function findTypeLabel(t: FieldType): string {
  for (const g of FIELD_TYPE_GROUPS) {
    const hit = g.items.find(i => i.type === t);
    if (hit) return hit.label;
  }
  return t;
}

function findTypeIcon(t: FieldType): string {
  for (const g of FIELD_TYPE_GROUPS) {
    const hit = g.items.find(i => i.type === t);
    if (hit) return hit.icon;
  }
  return "∎";
}

const EMPTY_LOOKUP: LookupConfig = {
  refTableId: "",
  refFieldId: "",
  conditions: [{ refFieldId: "", operator: "eq", valueType: "field", currentFieldId: "" }],
  conditionLogic: "and",
  calcMethod: "original",
  lookupOutputFormat: "default",
};

export function AddFieldPopover({ currentTableId, currentFields, anchorRect, onCancel, onConfirm }: Props) {
  const [title, setTitle] = useState("");
  const [fieldType, setFieldType] = useState<FieldType>("Text");
  const [typePickerRect, setTypePickerRect] = useState<DOMRect | null>(null);
  const [lookupConfig, setLookupConfig] = useState<LookupConfig>(EMPTY_LOOKUP);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; path?: string } | null>(null);
  const [allTables, setAllTables] = useState<TableBrief[]>([]);
  const fieldTypeCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchTables().then(setAllTables);
  }, []);

  const toggleTypePicker = () => {
    if (typePickerRect) { setTypePickerRect(null); return; }
    const r = fieldTypeCardRef.current?.getBoundingClientRect();
    if (r) setTypePickerRect(r);
  };

  // Popover geometry: anchor right edge to anchor button's right edge, below it
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
      setError({ message: err.message || "创建字段失败", path: err.path });
      setSubmitting(false);
    }
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
          <div className="form-row">
            <label>Field title</label>
            <input
              className="fc-input"
              autoFocus
              placeholder="Enter a field title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConfirm();
                if (e.key === "Escape") onCancel();
              }}
            />
          </div>

          <div className="form-row">
            <label>Field type</label>
            <div
              className="field-type-card"
              ref={fieldTypeCardRef}
              onClick={toggleTypePicker}
            >
              <div className="field-type-row">
                <span className="label">
                  <span style={{ width: 18, fontFamily: "monospace", color: "#51565d" }}>{findTypeIcon(fieldType)}</span>
                  {findTypeLabel(fieldType)}
                </span>
                <span className="chevron">›</span>
              </div>
              <div className="field-type-row sub">
                <span>Explore Field Shortcuts ⓘ</span>
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
          <button className="btn btn-secondary" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" onClick={handleConfirm} disabled={!canSubmit}>
            {submitting ? "..." : "Confirm"}
          </button>
        </div>
      </div>

      {typePickerRect && (
        <TypePicker
          anchorRect={typePickerRect}
          current={fieldType}
          onSelect={(t) => { setFieldType(t); setTypePickerRect(null); }}
          onClose={() => setTypePickerRect(null)}
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
  onClose: () => void;
}

function TypePicker({ anchorRect, current, onSelect, onClose }: TypePickerProps) {
  // Position to the right of the field-type card; align top edges
  const MENU_W = 204;
  const GAP = 8;
  const left = Math.min(window.innerWidth - MENU_W - 16, anchorRect.right + GAP);
  const top = Math.max(16, Math.min(window.innerHeight - 480, anchorRect.top));

  // Close on outside click
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="type-picker-menu floating"
      style={{ position: "fixed", left, top, width: MENU_W }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {FIELD_TYPE_GROUPS.map(g => (
        <div key={g.group}>
          <div className="type-picker-section">{g.group}</div>
          {g.items.map(item => (
            <div
              key={item.type}
              className={`type-picker-item ${current === item.type ? "active" : ""}`}
              onClick={() => onSelect(item.type)}
            >
              <span className="left">
                <span className="icon">{item.icon}</span>
                {item.label}
              </span>
              {current === item.type && <span style={{ color: "#1456f0" }}>✓</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
