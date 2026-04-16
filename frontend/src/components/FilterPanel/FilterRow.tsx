import { useState, useRef, useEffect } from "react";
import { Field, FilterCondition, FilterOperator, FilterValue } from "../../types";
import CustomSelect from "./CustomSelect";
import DatePicker from "./DatePicker";
import { useTranslation } from "../../i18n/index";
import "./FilterRow.css";

interface Props {
  condition: FilterCondition;
  fields: Field[];
  onChange: (updated: Partial<FilterCondition>) => void;
  onDelete: () => void;
}

const OPERATORS_BY_TYPE: Record<string, { value: FilterOperator; label: string }[]> = {
  Text: [
    { value: "contains", label: "op.contains" },
    { value: "notContains", label: "op.notContains" },
    { value: "eq", label: "op.eq" },
    { value: "neq", label: "op.neq" },
    { value: "isEmpty", label: "op.isEmpty" },
    { value: "isNotEmpty", label: "op.isNotEmpty" },
  ],
  SingleSelect: [
    { value: "eq", label: "op.eq" },
    { value: "neq", label: "op.neq" },
    { value: "contains", label: "op.contains" },
    { value: "notContains", label: "op.notContains" },
    { value: "isEmpty", label: "op.isEmpty" },
    { value: "isNotEmpty", label: "op.isNotEmpty" },
  ],
  MultiSelect: [
    { value: "contains", label: "op.contains" },
    { value: "notContains", label: "op.notContains" },
    { value: "eq", label: "op.hasOption" },
    { value: "neq", label: "op.notHasOption" },
    { value: "isEmpty", label: "op.isEmpty" },
    { value: "isNotEmpty", label: "op.isNotEmpty" },
  ],
  DateTime: [
    { value: "eq", label: "op.eq" },
    { value: "neq", label: "op.neq" },
    { value: "after", label: "op.after" },
    { value: "gte", label: "op.onOrAfter" },
    { value: "before", label: "op.before" },
    { value: "lte", label: "op.onOrBefore" },
    { value: "isEmpty", label: "op.isEmpty" },
    { value: "isNotEmpty", label: "op.isNotEmpty" },
  ],
  Number: [
    { value: "eq", label: "op.is" },
    { value: "neq", label: "op.isNot" },
    { value: "gt", label: "op.gt" },
    { value: "gte", label: "op.gte" },
    { value: "lt", label: "op.lt" },
    { value: "lte", label: "op.lte" },
    { value: "isEmpty", label: "op.numIsEmpty" },
    { value: "isNotEmpty", label: "op.numIsNotEmpty" },
  ],
  User: [
    { value: "eq", label: "op.is" },
    { value: "neq", label: "op.isNot" },
    { value: "contains", label: "op.contains" },
    { value: "notContains", label: "op.notContains" },
    { value: "isEmpty", label: "op.isEmpty" },
    { value: "isNotEmpty", label: "op.isNotEmpty" },
  ],
  Checkbox: [
    { value: "eq", label: "op.is" },
  ],
};
// Field type aliases: map types that share the same operators
OPERATORS_BY_TYPE.AutoNumber = OPERATORS_BY_TYPE.Number;
OPERATORS_BY_TYPE.CreatedUser = OPERATORS_BY_TYPE.User;
OPERATORS_BY_TYPE.ModifiedUser = OPERATORS_BY_TYPE.User;
OPERATORS_BY_TYPE.CreatedTime = OPERATORS_BY_TYPE.DateTime;
OPERATORS_BY_TYPE.ModifiedTime = OPERATORS_BY_TYPE.DateTime;

const DATE_VALUE_OPTIONS = [
  { value: "exactDate", label: "date.exactDate" },
  { value: "today", label: "date.today" },
  { value: "yesterday", label: "date.yesterday" },
  { value: "tomorrow", label: "date.tomorrow" },
  { value: "last7Days", label: "date.last7Days" },
  { value: "last30Days", label: "date.last30Days" },
  { value: "next7Days", label: "date.next7Days" },
  { value: "next30Days", label: "date.next30Days" },
  { value: "thisWeek", label: "date.thisWeek" },
  { value: "lastWeek", label: "date.lastWeek" },
  { value: "thisMonth", label: "date.thisMonth" },
  { value: "lastMonth", label: "date.lastMonth" },
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
  const { t } = useTranslation();
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
        <span className="fr-operator-label">{selected ? t(selected.label) : value}</span>
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
                <span>{t(op.label)}</span>
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
  const { t } = useTranslation();
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

      <button className="fr-delete" onClick={onDelete} title={t("filter.deleteCondition")}>
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
  const { t } = useTranslation();
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
            options={DATE_VALUE_OPTIONS.map(o => ({ ...o, label: t(o.label) }))}
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
        options={DATE_VALUE_OPTIONS.map(o => ({ ...o, label: t(o.label) }))}
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
          { value: "", label: t("value.select") },
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
          { value: "", label: t("value.select") },
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
          { value: "true", label: t("value.checked") },
          { value: "false", label: t("value.unchecked") },
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
        placeholder={t("value.enterNumber")}
      />
    );
  }

  return (
    <input
      type="text"
      className="fr-input fr-value"
      value={value === null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={t("value.enterHere")}
    />
  );
}
