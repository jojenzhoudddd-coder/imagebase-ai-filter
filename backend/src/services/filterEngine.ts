import {
  FilterCondition,
  RelativeDate,
  TableRecord,
  ViewFilter,
  Field,
  CellValue,
  FieldType,
} from "../types.js";

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// ─── Date Resolution ───

function resolveDateRange(value: CellValue): { start: number; end: number } | null {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
  const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

  const relativeMap: Record<RelativeDate, () => { start: number; end: number }> = {
    today: () => ({ start: startOfDay(now), end: endOfDay(now) }),
    yesterday: () => { const d = addDays(now, -1); return { start: startOfDay(d), end: endOfDay(d) }; },
    tomorrow: () => { const d = addDays(now, 1); return { start: startOfDay(d), end: endOfDay(d) }; },
    thisWeek: () => {
      const day = now.getDay();
      return { start: startOfDay(addDays(now, -day)), end: endOfDay(addDays(now, 6 - day)) };
    },
    lastWeek: () => {
      const day = now.getDay();
      return { start: startOfDay(addDays(now, -day - 7)), end: endOfDay(addDays(now, -day - 1)) };
    },
    thisMonth: () => ({
      start: startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)),
      end: endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    }),
    lastMonth: () => ({
      start: startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      end: endOfDay(new Date(now.getFullYear(), now.getMonth(), 0)),
    }),
    last7Days: () => ({ start: startOfDay(addDays(now, -6)), end: endOfDay(now) }),
    next7Days: () => ({ start: startOfDay(now), end: endOfDay(addDays(now, 6)) }),
    last30Days: () => ({ start: startOfDay(addDays(now, -29)), end: endOfDay(now) }),
    next30Days: () => ({ start: startOfDay(now), end: endOfDay(addDays(now, 29)) }),
  };

  if (typeof value === "string" && value in relativeMap) {
    return relativeMap[value as RelativeDate]();
  }

  // absolute date: yyyy/MM/dd or yyyy-MM-dd
  if (typeof value === "string" && /^\d{4}[-/]\d{2}[-/]\d{2}$/.test(value)) {
    const d = new Date(value.replace(/\//g, "-"));
    if (!isNaN(d.getTime())) {
      return { start: startOfDay(d), end: endOfDay(d) };
    }
  }

  return null;
}

// ─── Field type categories for operator routing ───

const DATE_TYPES: FieldType[] = ["DateTime", "CreatedTime", "ModifiedTime"];
const NUMERIC_TYPES: FieldType[] = ["Number", "AutoNumber", "Progress", "Currency", "Rating"];
const TEXT_TYPES: FieldType[] = [
  "Text", "Url", "Phone", "Email", "Location", "Barcode",
  "ai_summary", "ai_transition", "ai_extract",
];
const SELECT_TYPES: FieldType[] = ["SingleSelect", "ai_classify"];
const MULTI_SELECT_TYPES: FieldType[] = ["MultiSelect", "ai_tag"];
const USER_TYPES: FieldType[] = ["User", "CreatedUser", "ModifiedUser"];
const LINK_TYPES: FieldType[] = ["SingleLink", "DuplexLink"];

// ─── Evaluate a single condition ───

function evaluateCondition(record: TableRecord, cond: FilterCondition, field: Field): boolean {
  const raw = record.cells[cond.fieldId];
  const op = cond.operator;

  // Universal operators
  if (op === "isEmpty") return isEmpty(raw);
  if (op === "isNotEmpty") return !isEmpty(raw);

  const fieldType = field.type;

  // ── Checkbox ──
  if (fieldType === "Checkbox") {
    if (op === "checked") return Boolean(raw);
    if (op === "unchecked") return !raw;
    if (op === "eq") return cond.value === "checked" ? Boolean(raw) : !raw;
    return false;
  }

  // ── Date types ──
  if (DATE_TYPES.includes(fieldType)) {
    const ts = typeof raw === "number" ? raw : raw ? new Date(String(raw)).getTime() : null;
    if (ts === null || isNaN(ts)) return false;
    const range = resolveDateRange(cond.value);
    if (!range) return false;
    switch (op) {
      case "eq": return ts >= range.start && ts <= range.end;
      case "neq": return ts < range.start || ts > range.end;
      case "after":
      case "gt": return ts > range.end;
      case "gte": return ts >= range.start;
      case "before":
      case "lt": return ts < range.start;
      case "lte": return ts <= range.end;
      default: return false;
    }
  }

  // ── Numeric types ──
  if (NUMERIC_TYPES.includes(fieldType)) {
    const num = Number(raw);
    const condNum = Number(cond.value);
    if (isNaN(num)) return false;
    switch (op) {
      case "eq": return num === condNum;
      case "neq": return num !== condNum;
      case "gt": return num > condNum;
      case "gte": return num >= condNum;
      case "lt": return num < condNum;
      case "lte": return num <= condNum;
      case "contains": return String(raw).includes(String(cond.value ?? ""));
      default: return false;
    }
  }

  // ── MultiSelect / ai_tag ──
  if (MULTI_SELECT_TYPES.includes(fieldType)) {
    const arr = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
    const condValues = Array.isArray(cond.value) ? cond.value.map(String) : cond.value ? [String(cond.value)] : [];
    switch (op) {
      case "eq": return condValues.length === arr.length && condValues.every(v => arr.includes(v));
      case "neq": return !(condValues.length === arr.length && condValues.every(v => arr.includes(v)));
      case "contains": return condValues.some(v => arr.includes(v));
      case "notContains": return condValues.every(v => !arr.includes(v));
      default: return false;
    }
  }

  // ── SingleSelect / ai_classify ──
  if (SELECT_TYPES.includes(fieldType)) {
    const str = raw != null ? String(raw) : "";
    const condValues = Array.isArray(cond.value) ? cond.value.map(String) : cond.value != null ? [String(cond.value)] : [];
    switch (op) {
      case "eq": return condValues.length === 1 && str === condValues[0];
      case "neq": return condValues.length === 1 && str !== condValues[0];
      case "contains": return condValues.includes(str);
      case "notContains": return !condValues.includes(str);
      default: return false;
    }
  }

  // ── User / CreatedUser / ModifiedUser ──
  if (USER_TYPES.includes(fieldType) || fieldType === "Group") {
    // Only isEmpty / isNotEmpty supported for user types (already handled above)
    return false;
  }

  // ── Link types ──
  if (LINK_TYPES.includes(fieldType)) {
    const arr = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
    const condValues = Array.isArray(cond.value) ? cond.value.map(String) : cond.value ? [String(cond.value)] : [];
    switch (op) {
      case "eq": return condValues.every(v => arr.includes(v));
      case "neq": return condValues.every(v => !arr.includes(v));
      case "contains": return condValues.some(v => arr.includes(v));
      case "notContains": return condValues.every(v => !arr.includes(v));
      default: return false;
    }
  }

  // ── Attachment ──
  if (fieldType === "Attachment") {
    const str = raw != null ? String(raw) : "";
    const v = String(cond.value ?? "");
    switch (op) {
      case "eq": return str === v;
      case "neq": return str !== v;
      case "contains": return str.includes(v);
      case "notContains": return !str.includes(v);
      default: return false;
    }
  }

  // ── Formula ──
  if (fieldType === "Formula") {
    const str = raw != null ? String(raw) : "";
    const v = String(cond.value ?? "");
    const num = Number(raw);
    const condNum = Number(cond.value);
    switch (op) {
      case "eq": return !isNaN(num) && !isNaN(condNum) ? num === condNum : str === v;
      case "neq": return !isNaN(num) && !isNaN(condNum) ? num !== condNum : str !== v;
      case "gt": return !isNaN(num) && !isNaN(condNum) ? num > condNum : false;
      case "gte": return !isNaN(num) && !isNaN(condNum) ? num >= condNum : false;
      case "lt": return !isNaN(num) && !isNaN(condNum) ? num < condNum : false;
      case "lte": return !isNaN(num) && !isNaN(condNum) ? num <= condNum : false;
      case "contains": return str.includes(v);
      case "notContains": return !str.includes(v);
      default: return false;
    }
  }

  // ── Lookup ── follows referenced field type
  if (fieldType === "Lookup") {
    const str = raw != null ? String(raw) : "";
    const v = String(cond.value ?? "");
    const num = Number(raw);
    const condNum = Number(cond.value);
    switch (op) {
      case "eq": return !isNaN(num) && !isNaN(condNum) ? num === condNum : str === v;
      case "neq": return !isNaN(num) && !isNaN(condNum) ? num !== condNum : str !== v;
      case "gt": return !isNaN(num) ? num > condNum : false;
      case "gte": return !isNaN(num) ? num >= condNum : false;
      case "lt": return !isNaN(num) ? num < condNum : false;
      case "lte": return !isNaN(num) ? num <= condNum : false;
      case "contains": return str.includes(v);
      case "notContains": return !str.includes(v);
      default: return false;
    }
  }

  // ── Text, Url, Phone, Email, Location, Barcode, AI text types (default) ──
  const str = raw != null ? String(raw) : "";
  const v = String(cond.value ?? "");
  switch (op) {
    case "eq": return str === v;
    case "neq": return str !== v;
    case "contains": return str.includes(v);
    case "notContains": return !str.includes(v);
    default: return false;
  }
}

// ─── Public API ───

export function filterRecords(
  records: TableRecord[],
  filter: ViewFilter,
  fields: Map<string, Field>
): TableRecord[] {
  if (!filter.conditions.length) return records;

  return records.filter((record) => {
    const results = filter.conditions.map((cond) => {
      const field = fields.get(cond.fieldId);
      if (!field) return false;
      return evaluateCondition(record, cond, field);
    });
    return filter.logic === "and" ? results.every(Boolean) : results.some(Boolean);
  });
}
