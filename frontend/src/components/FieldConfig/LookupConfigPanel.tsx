import { useEffect, useMemo, useState } from "react";
import {
  CellValue,
  Field,
  FieldType,
  FilterOperator,
  LookupCalcMethod,
  LookupCondition,
  LookupConfig,
  LookupOutputFormat,
} from "../../types";
import { fetchFields, TableBrief } from "../../api";
import { getAllowedOperators, OPERATOR_LABELS, isUnary } from "./operatorWhitelist";

interface Props {
  currentTable: { id: string; name: string; fields: Field[] };
  allTables: TableBrief[];
  config: LookupConfig;
  onChange: (cfg: LookupConfig) => void;
}

const CALC_OPTIONS: { value: LookupCalcMethod; label: string }[] = [
  { value: "original", label: "Value (原值)" },
  { value: "deduplicate", label: "Unique values (去重)" },
  { value: "count", label: "Count (计数)" },
  { value: "deduplicateCount", label: "Count unique (去重计数)" },
  { value: "sum", label: "Sum (求和)" },
  { value: "average", label: "Average (平均)" },
  { value: "max", label: "Max (最大)" },
  { value: "min", label: "Min (最小)" },
];

const FORMAT_OPTIONS: { value: LookupOutputFormat; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "currency", label: "Currency" },
  { value: "autoNumber", label: "Auto Number" },
];

function allowedFormatsFor(calc: LookupCalcMethod): LookupOutputFormat[] {
  if (calc === "original" || calc === "deduplicate") {
    return ["default", "text", "number", "date", "currency", "autoNumber"];
  }
  return ["number", "date", "currency"];
}

function allowedCalcsFor(refFieldType: FieldType | undefined): LookupCalcMethod[] {
  if (!refFieldType) return CALC_OPTIONS.map(o => o.value);
  const NUMERIC: FieldType[] = ["Number", "AutoNumber"];
  const DATE: FieldType[] = ["DateTime"];
  const all = CALC_OPTIONS.map(o => o.value);
  return all.filter(c => {
    if (c === "sum" || c === "average") return NUMERIC.includes(refFieldType);
    if (c === "max" || c === "min") return NUMERIC.includes(refFieldType) || DATE.includes(refFieldType);
    return true;
  });
}

export function LookupConfigPanel({ currentTable, allTables, config, onChange }: Props) {
  // Candidate ref tables = all tables except current
  const refTables = useMemo(() => allTables.filter(t => t.id !== currentTable.id), [allTables, currentTable.id]);

  // Fields of the selected ref table (lazy-loaded on demand)
  const [refFields, setRefFields] = useState<Field[]>([]);
  const [loadingRefFields, setLoadingRefFields] = useState(false);

  useEffect(() => {
    if (!config.refTableId) { setRefFields([]); return; }
    setLoadingRefFields(true);
    fetchFields(config.refTableId)
      .then(fs => setRefFields(fs))
      .finally(() => setLoadingRefFields(false));
  }, [config.refTableId]);

  const refField = refFields.find(f => f.id === config.refFieldId);

  const patch = (delta: Partial<LookupConfig>) => onChange({ ...config, ...delta });

  const handleRefTableChange = (v: string) => {
    patch({ refTableId: v, refFieldId: "", conditions: [{ refFieldId: "", operator: "eq", valueType: "field", currentFieldId: "" }] });
  };

  const handleRefFieldChange = (v: string) => {
    // Reset calcMethod/format if not allowed for new ref field type
    const f = refFields.find(x => x.id === v);
    const allowedCalcs = allowedCalcsFor(f?.type);
    const newCalc = allowedCalcs.includes(config.calcMethod) ? config.calcMethod : "original";
    const allowedFmts = allowedFormatsFor(newCalc);
    const newFmt = allowedFmts.includes(config.lookupOutputFormat) ? config.lookupOutputFormat : allowedFmts[0];
    patch({ refFieldId: v, calcMethod: newCalc, lookupOutputFormat: newFmt });
  };

  const addCondition = () => {
    if (config.conditions.length >= 5) return;
    patch({
      conditions: [
        ...config.conditions,
        { refFieldId: "", operator: "eq", valueType: "field", currentFieldId: "" },
      ],
    });
  };

  const updateCondition = (idx: number, delta: Partial<LookupCondition>) => {
    const conds = config.conditions.map((c, i) => (i === idx ? { ...c, ...delta } : c));
    patch({ conditions: conds });
  };

  const removeCondition = (idx: number) => {
    if (config.conditions.length <= 1) return;
    patch({ conditions: config.conditions.filter((_, i) => i !== idx) });
  };

  return (
    <>
      <div className="field-popover-divider" />

      {/* Look up data in this field */}
      <div className="form-row">
        <label>Look up data in this field</label>
        <div className="form-row-pair">
          <div className="form-row">
            <select
              className="fc-select"
              value={config.refTableId}
              onChange={(e) => handleRefTableChange(e.target.value)}
            >
              <option value="">Select target table</option>
              {refTables.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <select
              className="fc-select"
              value={config.refFieldId}
              disabled={!config.refTableId || loadingRefFields}
              onChange={(e) => handleRefFieldChange(e.target.value)}
            >
              <option value="">Select a field</option>
              {refFields.map(f => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Reference data if */}
      <div className="form-row">
        <div className="conditions-header">
          <label>Reference data if</label>
          {config.conditions.length > 1 && (
            <div className="logic-wrap">
              <select
                className="fc-select"
                value={config.conditionLogic}
                onChange={(e) => patch({ conditionLogic: e.target.value as "and" | "or" })}
              >
                <option value="and">all</option>
                <option value="or">any</option>
              </select>
              conditions are met
            </div>
          )}
        </div>

        <div className="cond-list">
          {config.conditions.map((c, i) => (
            <ConditionRow
              key={i}
              idx={i}
              condition={c}
              refFields={refFields}
              currentFields={currentTable.fields}
              canDelete={config.conditions.length > 1}
              disabled={!config.refFieldId}
              onChange={(delta) => updateCondition(i, delta)}
              onRemove={() => removeCondition(i)}
            />
          ))}
        </div>

        <button
          className="add-condition-btn"
          onClick={addCondition}
          disabled={config.conditions.length >= 5 || !config.refFieldId}
          type="button"
        >
          + Add Condition{config.conditions.length >= 5 ? " (max 5)" : ""}
        </button>
      </div>

      {/* Display data as + Field format */}
      <div className="form-row-pair">
        <div className="form-row">
          <label>Display data as</label>
          <select
            className="fc-select"
            value={config.calcMethod}
            onChange={(e) => {
              const newCalc = e.target.value as LookupCalcMethod;
              const allowedFmts = allowedFormatsFor(newCalc);
              const newFmt = allowedFmts.includes(config.lookupOutputFormat) ? config.lookupOutputFormat : allowedFmts[0];
              patch({ calcMethod: newCalc, lookupOutputFormat: newFmt });
            }}
          >
            {allowedCalcsFor(refField?.type).map(c => {
              const opt = CALC_OPTIONS.find(o => o.value === c)!;
              return <option key={c} value={c}>{opt.label}</option>;
            })}
          </select>
        </div>
        <div className="form-row">
          <label>Field format</label>
          <select
            className="fc-select"
            value={config.lookupOutputFormat}
            onChange={(e) => patch({ lookupOutputFormat: e.target.value as LookupOutputFormat })}
          >
            {allowedFormatsFor(config.calcMethod).map(fmt => {
              const opt = FORMAT_OPTIONS.find(o => o.value === fmt)!;
              return <option key={fmt} value={fmt}>{opt.label}</option>;
            })}
          </select>
        </div>
      </div>
    </>
  );
}

// ─── Condition row ───

interface CondRowProps {
  idx: number;
  condition: LookupCondition;
  refFields: Field[];
  currentFields: Field[];
  canDelete: boolean;
  disabled: boolean;
  onChange: (delta: Partial<LookupCondition>) => void;
  onRemove: () => void;
}

function ConditionRow({ idx, condition, refFields, currentFields, canDelete, disabled, onChange, onRemove }: CondRowProps) {
  const lhsField = refFields.find(f => f.id === condition.refFieldId);
  const allowedOps = lhsField ? getAllowedOperators(lhsField.type) : [];
  const unary = isUnary(condition.operator);
  const isDateField = lhsField?.type === "DateTime";

  return (
    <div className="cond-row">
      <select
        className="fc-select"
        value={condition.refFieldId}
        disabled={disabled}
        onChange={(e) => {
          const newLhsField = refFields.find(f => f.id === e.target.value);
          const newOps = newLhsField ? getAllowedOperators(newLhsField.type) : [];
          const newOp = newOps.includes(condition.operator) ? condition.operator : (newOps[2] ?? "eq");
          onChange({ refFieldId: e.target.value, operator: newOp as FilterOperator });
        }}
      >
        <option value="">Select field</option>
        {refFields.map(f => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>

      <select
        className="fc-select narrow"
        value={condition.operator}
        disabled={disabled || !lhsField}
        onChange={(e) => onChange({ operator: e.target.value as FilterOperator })}
      >
        {allowedOps.map(op => (
          <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>
        ))}
      </select>

      {!unary && (
        isDateField ? (
          <DateConstantInput
            value={condition.value}
            onChange={(v) => onChange({ valueType: "constant", value: v })}
          />
        ) : condition.valueType === "field" ? (
          <select
            className="fc-select"
            value={(condition.currentFieldId as string) || ""}
            disabled={disabled}
            onChange={(e) => onChange({ valueType: "field", currentFieldId: e.target.value })}
          >
            <option value="">Field in current table</option>
            {currentFields.map(f => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        ) : (
          <input
            className="fc-input"
            placeholder="Value"
            value={(condition.value as string) ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ valueType: "constant", value: e.target.value })}
          />
        )
      )}

      {!unary && !isDateField && (
        <button
          type="button"
          className="cond-delete"
          title={condition.valueType === "field" ? "Switch to constant" : "Switch to field"}
          onClick={() => onChange({ valueType: condition.valueType === "field" ? "constant" : "field", value: undefined, currentFieldId: undefined })}
          style={{ color: "#1456f0" }}
        >
          ⇄
        </button>
      )}

      <button
        type="button"
        className="cond-delete"
        onClick={onRemove}
        disabled={!canDelete}
        title="Remove condition"
      >
        ✕
      </button>
    </div>
  );
}

// ─── Date constant input (select for relative, input for absolute) ───

function DateConstantInput({ value, onChange }: { value: CellValue | undefined | any; onChange: (v: any) => void }) {
  const isRelative = typeof value === "string" && ["yesterday", "today", "tomorrow"].includes(value);
  const [mode, setMode] = useState<"relative" | "absolute">(isRelative ? "relative" : "absolute");

  return (
    <div style={{ display: "flex", gap: 6, flex: 1, minWidth: 0 }}>
      <select
        className="fc-select"
        style={{ flex: "0 0 96px" }}
        value={mode}
        onChange={(e) => {
          const m = e.target.value as "relative" | "absolute";
          setMode(m);
          onChange(m === "relative" ? "today" : { type: "absolute", value: "" });
        }}
      >
        <option value="relative">Relative</option>
        <option value="absolute">Absolute</option>
      </select>
      {mode === "relative" ? (
        <select
          className="fc-select"
          value={(typeof value === "string" ? value : "today")}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="yesterday">Yesterday</option>
          <option value="today">Today</option>
          <option value="tomorrow">Tomorrow</option>
        </select>
      ) : (
        <input
          className="fc-input"
          placeholder="yyyy/MM/dd"
          value={(typeof value === "object" && value?.value) || ""}
          onChange={(e) => onChange({ type: "absolute", value: e.target.value })}
        />
      )}
    </div>
  );
}
