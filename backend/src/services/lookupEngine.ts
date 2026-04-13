// Lookup computation engine.
// For a given record on a "current" table, walk the ref table, match records by the
// LookupConfig's conditions, extract values from refField, and aggregate per calcMethod.
//
// Phase 1 scope: refField is assumed NOT to be itself a Lookup. Nested Lookups are a
// future concern; the validator already prevents cycles, so the worst case here is that
// a nested ref yields a stale value. A follow-up can add topological materialization.

import {
  CellValue,
  Field,
  FieldType,
  FilterOperator,
  LookupCalcMethod,
  LookupCondition,
  LookupConfig,
  LookupDateConstant,
  Table,
  TableRecord,
} from "../types.js";

const NUMERIC_TYPES: FieldType[] = ["Number", "AutoNumber", "Progress", "Currency", "Rating"];
const DATE_TYPES: FieldType[] = ["DateTime", "CreatedTime", "ModifiedTime"];

// ─── Utilities ───

function toEpoch(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const ts = new Date(value.replace(/\//g, "-")).getTime();
    return isNaN(ts) ? null : ts;
  }
  return null;
}

function resolveLookupDateConstant(value: LookupDateConstant, now: Date = new Date()): { start: number; end: number } | null {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
  const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  if (value === "today") return { start: startOfDay(now), end: endOfDay(now) };
  if (value === "yesterday") { const d = addDays(now, -1); return { start: startOfDay(d), end: endOfDay(d) }; }
  if (value === "tomorrow") { const d = addDays(now, 1); return { start: startOfDay(d), end: endOfDay(d) }; }
  if (typeof value === "object" && value !== null && value.type === "absolute") {
    const ts = toEpoch(value.value);
    if (ts == null) return null;
    const d = new Date(ts);
    return { start: startOfDay(d), end: endOfDay(d) };
  }
  return null;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// ─── Condition evaluation ───
// Evaluate one LookupCondition against one ref-table record, using currentRecord for field-valued RHS.

function evaluateLookupCondition(
  cond: LookupCondition,
  refRecord: TableRecord,
  currentRecord: TableRecord,
  refTable: Table,
): boolean {
  // The condition's LHS is a field on the ref table; look up its type to route correctly.
  // Note: this is the FIELD NAMED IN THE CONDITION, not the Lookup's refField.
  const lhsField = refTable.fields.find(f => f.id === cond.refFieldId);
  if (!lhsField) return false;
  const lhs = refRecord.cells[cond.refFieldId];
  const op = cond.operator;

  // Unary operators
  if (op === "isEmpty") return isEmpty(lhs);
  if (op === "isNotEmpty") return !isEmpty(lhs);

  // Resolve RHS: either currentRecord.cells[currentFieldId] or the stored constant.
  let rhsRaw: unknown;
  if (cond.valueType === "field") {
    if (!cond.currentFieldId) return false;
    rhsRaw = currentRecord.cells[cond.currentFieldId];
  } else {
    rhsRaw = cond.value;
  }

  // Date handling
  if (DATE_TYPES.includes(lhsField.type)) {
    const lhsTs = toEpoch(lhs);
    if (lhsTs == null) return false;
    let range: { start: number; end: number } | null = null;
    if (cond.valueType === "constant") {
      range = resolveLookupDateConstant(rhsRaw as LookupDateConstant);
    } else {
      const rhsTs = toEpoch(rhsRaw);
      if (rhsTs == null) return false;
      const d = new Date(rhsTs);
      const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
      range = { start: startOfDay, end: endOfDay };
    }
    if (!range) return false;
    switch (op) {
      case "eq":     return lhsTs >= range.start && lhsTs <= range.end;
      case "neq":    return lhsTs < range.start || lhsTs > range.end;
      case "after":  return lhsTs > range.end;
      case "before": return lhsTs < range.start;
      case "gte":    return lhsTs >= range.start;
      case "lte":    return lhsTs <= range.end;
      case "contains": return String(lhs ?? "").includes(String(rhsRaw ?? ""));
      default: return false;
    }
  }

  // Numeric handling
  if (NUMERIC_TYPES.includes(lhsField.type)) {
    const lhsNum = Number(lhs);
    const rhsNum = Number(rhsRaw);
    if (isNaN(lhsNum)) return false;
    switch (op) {
      case "eq":  return lhsNum === rhsNum;
      case "neq": return lhsNum !== rhsNum;
      case "gt":  return !isNaN(rhsNum) && lhsNum > rhsNum;
      case "gte": return !isNaN(rhsNum) && lhsNum >= rhsNum;
      case "lt":  return !isNaN(rhsNum) && lhsNum < rhsNum;
      case "lte": return !isNaN(rhsNum) && lhsNum <= rhsNum;
      case "contains": return String(lhs ?? "").includes(String(rhsRaw ?? ""));
      default: return false;
    }
  }

  // Default: string / multi-valued comparison
  const lhsArr = Array.isArray(lhs) ? lhs.map(String) : lhs != null ? [String(lhs)] : [];
  const rhsArr = Array.isArray(rhsRaw) ? rhsRaw.map(String) : rhsRaw != null ? [String(rhsRaw)] : [];
  const lhsJoined = lhsArr.join(",");
  const rhsJoined = rhsArr.join(",");
  switch (op) {
    case "eq":       return lhsJoined === rhsJoined;
    case "neq":      return lhsJoined !== rhsJoined;
    case "contains": return rhsArr.every(r => lhsArr.includes(r));
    default: return false;
  }
}

// ─── Aggregation ───

function flattenValues(values: CellValue[]): CellValue[] {
  const out: CellValue[] = [];
  for (const v of values) {
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
}

function aggregate(values: CellValue[], calcMethod: LookupCalcMethod): CellValue {
  const flat = flattenValues(values).filter(v => v !== null && v !== undefined);

  switch (calcMethod) {
    case "original":
      return flat as unknown as CellValue;
    case "deduplicate": {
      const seen = new Set<string>();
      const out: CellValue[] = [];
      for (const v of flat) {
        const k = JSON.stringify(v);
        if (!seen.has(k)) { seen.add(k); out.push(v); }
      }
      return out as unknown as CellValue;
    }
    case "count":
      return flat.length;
    case "deduplicateCount": {
      const seen = new Set<string>();
      for (const v of flat) seen.add(JSON.stringify(v));
      return seen.size;
    }
    case "sum": {
      let s = 0;
      let any = false;
      for (const v of flat) {
        const n = Number(v);
        if (!isNaN(n)) { s += n; any = true; }
      }
      return any ? s : 0;
    }
    case "average": {
      const nums: number[] = [];
      for (const v of flat) { const n = Number(v); if (!isNaN(n)) nums.push(n); }
      if (nums.length === 0) return null;
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    case "max": {
      const nums: number[] = [];
      for (const v of flat) {
        const n = typeof v === "number" ? v : toEpoch(v);
        if (n != null && !isNaN(n)) nums.push(n);
      }
      if (nums.length === 0) return null;
      return Math.max(...nums);
    }
    case "min": {
      const nums: number[] = [];
      for (const v of flat) {
        const n = typeof v === "number" ? v : toEpoch(v);
        if (n != null && !isNaN(n)) nums.push(n);
      }
      if (nums.length === 0) return null;
      return Math.min(...nums);
    }
    default:
      return null;
  }
}

// ─── Public API ───

export const LOOKUP_REF_SENTINEL = "#REF!";
export const LOOKUP_CYCLE_SENTINEL = "#CYCLE!";

export interface LookupContext {
  currentTable: Table;
  allTables: Table[];
}

/** The "effective" field type of a Lookup — used by filter/sort/group to route correctly. */
export function effectiveTypeFor(config: LookupConfig, refFieldType: FieldType): FieldType {
  if (config.calcMethod === "count" || config.calcMethod === "deduplicateCount") return "Number";
  if (config.calcMethod === "sum" || config.calcMethod === "average") return "Number";
  // max/min follow the underlying type (numeric or date)
  // original/deduplicate preserve the underlying type
  return refFieldType;
}

export function computeLookup(
  field: Field,
  currentRecord: TableRecord,
  ctx: LookupContext,
): CellValue {
  const cfg = field.config.lookup;
  if (!cfg) return null;

  const refTable = ctx.allTables.find(t => t.id === cfg.refTableId);
  if (!refTable) return LOOKUP_REF_SENTINEL;
  const refField = refTable.fields.find(f => f.id === cfg.refFieldId);
  if (!refField) return LOOKUP_REF_SENTINEL;

  // Phase 1: refuse nested Lookups for now; return #REF! if we hit one.
  if (refField.type === "Lookup") return LOOKUP_REF_SENTINEL;

  // 1. filter ref records by conditions
  const matched = refTable.records.filter(r => {
    const results = cfg.conditions.map(c => evaluateLookupCondition(c, r, currentRecord, refTable));
    if (cfg.conditionLogic === "or") return results.some(Boolean);
    return results.every(Boolean);
  });

  // 2. extract values
  const values = matched.map(r => r.cells[cfg.refFieldId] as CellValue);

  // 3. aggregate
  return aggregate(values, cfg.calcMethod);
}

export function computeLookupBatch(
  field: Field,
  records: TableRecord[],
  ctx: LookupContext,
): Map<string, CellValue> {
  const out = new Map<string, CellValue>();
  for (const r of records) out.set(r.id, computeLookup(field, r, ctx));
  return out;
}

/**
 * Materialize all Lookup fields of `table` onto a clone of `records`.
 * Returns: the cloned records (with Lookup values written in) + a patched fields Map
 * where each Lookup field's `type` is replaced with its effectiveType so downstream
 * filter/sort/group can route correctly.
 */
export function materializeLookups(
  table: Table,
  records: TableRecord[],
  allTables: Table[],
): { records: TableRecord[]; fields: Map<string, Field> } {
  const lookupFields = table.fields.filter(f => f.type === "Lookup" && f.config.lookup);
  const fieldsMap = new Map<string, Field>(table.fields.map(f => [f.id, f]));

  if (lookupFields.length === 0) {
    return { records, fields: fieldsMap };
  }

  const ctx: LookupContext = { currentTable: table, allTables };
  // Shallow clone each record with a fresh cells object so we don't mutate the source.
  const cloned = records.map(r => ({ ...r, cells: { ...r.cells } }));

  for (const lookupField of lookupFields) {
    const cfg = lookupField.config.lookup!;
    // Compute per-record values against the cloned (not original) records — but conditions
    // only read the current record via currentFieldId, so it doesn't matter which copy.
    for (const r of cloned) {
      r.cells[lookupField.id] = computeLookup(lookupField, r, ctx);
    }
    // Replace the Field's type with the effective type in the fields map
    const refTable = allTables.find(t => t.id === cfg.refTableId);
    const refField = refTable?.fields.find(f => f.id === cfg.refFieldId);
    if (refField) {
      fieldsMap.set(lookupField.id, { ...lookupField, type: effectiveTypeFor(cfg, refField.type) });
    }
  }

  return { records: cloned, fields: fieldsMap };
}
