import { useState, useRef, useEffect } from "react";
import { Field, FilterCondition, FilterOperator, FilterValue } from "../../types";
import CustomSelect from "./CustomSelect";
import DatePicker from "./DatePicker";
import "./FilterRow.css";

interface Props {
  condition: FilterCondition;
  fields: Field[];
  onChange: (updated: Partial<FilterCondition>) => void;
  onDelete: () => void;
}

const OPERATORS_BY_TYPE: Record<string, { value: FilterOperator; label: string }[]> = {
  Text: [
    { value: "contains", label: "Contains" },
    { value: "notContains", label: "Does not contain" },
    { value: "eq", label: "Equals" },
    { value: "neq", label: "Not equals" },
    { value: "isEmpty", label: "Is empty" },
    { value: "isNotEmpty", label: "Is not empty" },
  ],
  SingleSelect: [
    { value: "eq", label: "Equals" },
    { value: "neq", label: "Not equals" },
    { value: "contains", label: "Contains" },
    { value: "notContains", label: "Does not contain" },
    { value: "isEmpty", label: "Is empty" },
    { value: "isNotEmpty", label: "Is not empty" },
  ],
  MultiSelect: [
    { value: "contains", label: "Contains" },
    { value: "notContains", label: "Does not contain" },
    { value: "eq", label: "Has option" },
    { value: "neq", label: "Does not have option" },
    { value: "isEmpty", label: "Is empty" },
    { value: "isNotEmpty", label: "Is not empty" },
  ],
  DateTime: [
    { value: "eq", label: "Equals" },
    { value: "neq", label: "Not equals" },
    { value: "after", label: "After" },
    { value: "gte", label: "On or after" },
    { value: "before", label: "Before" },
    { value: "lte", label: "On or before" },
    { value: "isEmpty", label: "Is empty" },
    { value: "isNotEmpty", label: "Is not empty" },
  ],
  Number: [
    { value: "eq", label: "is" },
    { value: "neq", label: "is not" },
    { value: "gt", label: "greater than" },
    { value: "gte", label: "greater than or equal to" },
    { value: "lt", label: "less than" },
    { value: "lte", label: "less than or equal to" },
    { value: "isEmpty", label: "is empty" },
    { value: "isNotEmpty", label: "is not empty" },
  ],
  User: [
    { value: "eq", label: "Is" },
    { value: "neq", label: "Is not" },
    { value: "contains", label: "Contains" },
    { value: "notContains", label: "Does not contain" },
    { value: "isEmpty", label: "Is empty" },
    { value: "isNotEmpty", label: "Is not empty" },
  ],
  Checkbox: [
    { value: "eq", label: "Is" },
  ],
};
// Field type aliases: map types that share the same operators
OPERATORS_BY_TYPE.AutoNumber = OPERATORS_BY_TYPE.Number;
OPERATORS_BY_TYPE.CreatedUser = OPERATORS_BY_TYPE.User;
OPERATORS_BY_TYPE.ModifiedUser = OPERATORS_BY_TYPE.User;
OPERATORS_BY_TYPE.CreatedTime = OPERATORS_BY_TYPE.DateTime;
OPERATORS_BY_TYPE.ModifiedTime = OPERATORS_BY_TYPE.DateTime;

const DATE_VALUE_OPTIONS = [
  { value: "exactDate", label: "Exact date" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "last7Days", label: "Last 7 days" },
  { value: "last30Days", label: "Last 30 days" },
  { value: "next7Days", label: "Next 7 days" },
  { value: "next30Days", label: "Next 30 days" },
  { value: "thisWeek", label: "This week" },
  { value: "lastWeek", label: "Last week" },
  { value: "thisMonth", label: "This month" },
  { value: "lastMonth", label: "Last month" },
];

function isExactDateMode(value: FilterValue): boolean {
  return value === "exactDate" || (typeof value === "string" && /^\d{4}\/\d{2}\/\d{2}$/.test(value));
}

const NO_VALUE_OPERATORS: FilterOperator[] = [
  "isEmpty", "isNotEmpty",
];

// ─── Custom dropdown for operator ───
function OperatorDropdown({
  value,
  operators,
  onChange,
}: {
  value: FilterOperator;
  operators: { value: FilterOperator; label: string }[];
  onChange: (op: FilterOperator) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleToggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen(!open);
  };

  const selected = operators.find((o) => o.value === value);

  return (
    <div className="fr-operator-dropdown" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="fr-operator-trigger"
        onClick={handleToggle}
      >
        <span className="fr-operator-label">{selected?.label ?? value}</span>
        <svg className="fr-operator-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {open && pos && (
        <div className="fr-operator-list" style={{ position: "fixed", top: pos.top, left: pos.left }}>
          {operators.map((op) => {
            const isActive = op.value === value;
            return (
              <button
                key={op.value}
                type="button"
                className={`fr-operator-option ${isActive ? "active" : ""}`}
                onClick={() => {
                  onChange(op.value);
                  setOpen(false);
                }}
              >
                <span>{op.label}</span>
                {isActive && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="fr-operator-check">
                    <path d="M2.5 7l3.5 3.5 5.5-5.5" stroke="#3370FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function FilterRow({ condition, fields, onChange, onDelete }: Props) {
  const field = fields.find((f) => f.id === condition.fieldId);
  const fieldType = field?.type ?? "Text";
  const operators = OPERATORS_BY_TYPE[fieldType] ?? OPERATORS_BY_TYPE.Text;
  const noValue = NO_VALUE_OPERATORS.includes(condition.operator);

  const handleFieldChange = (fieldId: string) => {
    const newField = fields.find((f) => f.id === fieldId);
    const newType = newField?.type ?? "Text";
    const defaultOps = OPERATORS_BY_TYPE[newType] ?? OPERATORS_BY_TYPE.Text;
    const defaultOp = defaultOps[0].value;
    let defaultValue: FilterValue = null;
    if (newType === "Checkbox") defaultValue = true;
    else if (newType === "DateTime") defaultValue = "last30Days";
    else if ((newType === "SingleSelect" || newType === "MultiSelect") && newField?.config.options?.length) {
      defaultValue = newField.config.options[0].name;
    }
    onChange({ fieldId, operator: defaultOp, value: defaultValue });
  };

  const handleOperatorChange = (operator: FilterOperator) => {
    onChange({ operator, value: NO_VALUE_OPERATORS.includes(operator) ? null : condition.value });
  };

  return (
    <div className="filter-row">
      <CustomSelect
        value={condition.fieldId}
        options={fields.map((f) => ({ value: f.id, label: f.name }))}
        onChange={(v) => handleFieldChange(v)}
        className="fr-select fr-field"
      />

      <OperatorDropdown
        value={condition.operator}
        operators={operators}
        onChange={handleOperatorChange}
      />

      {!noValue && (
        <ValueInput
          field={field ?? null}
          operator={condition.operator}
          value={condition.value}
          onChange={(value) => onChange({ value })}
        />
      )}

      <button className="fr-delete" onClick={onDelete} title="Delete condition">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

interface ValueInputProps {
  field: Field | null;
  operator: FilterOperator;
  value: FilterValue;
  onChange: (value: FilterValue) => void;
}

function ValueInput({ field, operator, value, onChange }: ValueInputProps) {
  const type = field?.type ?? "Text";

  if (type === "DateTime" || type === "CreatedTime" || type === "ModifiedTime") {
    const exact = isExactDateMode(value);
    const modeValue = exact ? "exactDate" : String(value ?? "today");
    const dateStr = typeof value === "string" && /^\d{4}\/\d{2}\/\d{2}$/.test(value) ? value : "";

    const handleModeChange = (v: string) => {
      if (v === "exactDate") onChange("exactDate");
      else onChange(v);
    };

    if (exact) {
      return (
        <div className="fr-date-exact">
          <CustomSelect
            value="exactDate"
            options={DATE_VALUE_OPTIONS}
            onChange={handleModeChange}
            className="fr-select fr-date-mode"
          />
          <DatePicker
            value={dateStr}
            onChange={(v) => onChange(v)}
            className="fr-date-picker"
          />
        </div>
      );
    }

    return (
      <CustomSelect
        value={modeValue}
        options={DATE_VALUE_OPTIONS}
        onChange={handleModeChange}
        className="fr-select fr-value"
      />
    );
  }

  if ((type === "SingleSelect" || type === "MultiSelect") && field?.config.options?.length) {
    return (
      <CustomSelect
        value={String(value ?? "")}
        options={[
          { value: "", label: "Select..." },
          ...field.config.options.map((opt) => ({ value: opt.name, label: opt.name })),
        ]}
        onChange={(v) => onChange(v)}
        className="fr-select fr-value"
      />
    );
  }

  if (type === "User" && field?.config.users?.length) {
    const currentId = Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && "id" in value[0]
      ? (value[0] as { id: string }).id
      : "";
    return (
      <CustomSelect
        value={currentId}
        options={[
          { value: "", label: "Select..." },
          ...field.config.users.map((u) => ({ value: u.id, label: u.name })),
        ]}
        onChange={(v) => onChange(v ? [{ id: v }] as unknown as FilterValue : null)}
        className="fr-select fr-value"
      />
    );
  }

  if (type === "Checkbox") {
    return (
      <CustomSelect
        value={value === true ? "true" : "false"}
        options={[
          { value: "true", label: "Checked" },
          { value: "false", label: "Unchecked" },
        ]}
        onChange={(v) => onChange(v === "true")}
        className="fr-select fr-value"
      />
    );
  }

  if (type === "Number" || type === "AutoNumber") {
    return (
      <input
        type="number"
        className="fr-input fr-value"
        value={value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        placeholder="Enter number..."
      />
    );
  }

  return (
    <input
      type="text"
      className="fr-input fr-value"
      value={value === null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Enter here"
    />
  );
}
