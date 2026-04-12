/**
 * 前端纯客户端筛选引擎
 * 将后端 filterEngine.ts 的逻辑移植到浏览器端，确保多用户互不干扰
 */
import { Field, FilterCondition, FilterOperator, TableRecord, ViewFilter, RelativeDateValue } from "../types";

type CellValue = string | number | boolean | string[] | null;

// ─── 判空 ───

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// ─── 日期范围解析 ───

function resolveDateRange(value: unknown): { start: number; end: number } | null {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
  const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

  const relativeMap: Record<RelativeDateValue, () => { start: number; end: number }> = {
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
    return relativeMap[value as RelativeDateValue]();
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

// ─── 字段类型分类 ───

const DATE_TYPES = new Set(["DateTime", "CreatedTime", "ModifiedTime"]);
const NUMERIC_TYPES = new Set(["Number", "AutoNumber", "Progress", "Currency", "Rating"]);
const SELECT_TYPES = new Set(["SingleSelect", "ai_classify"]);
const MULTI_SELECT_TYPES = new Set(["MultiSelect", "ai_tag"]);
const USER_TYPES = new Set(["User", "CreatedUser", "ModifiedUser"]);
const LINK_TYPES = new Set(["SingleLink", "DuplexLink"]);

// ─── 单条件评估 ───

function evaluateCondition(record: TableRecord, cond: FilterCondition, field: Field): boolean {
  const raw = record.cells[cond.fieldId] as CellValue;
  const op = cond.operator;

  // 通用操作符
  if (op === "isEmpty") return isEmpty(raw);
  if (op === "isNotEmpty") return !isEmpty(raw);

  const fieldType = field.type;

  // ── 复选框 ──
  if (fieldType === "Checkbox") {
    if (op === "checked") return Boolean(raw);
    if (op === "unchecked") return !raw;
    if (op === "eq") return cond.value === true || cond.value === "true" ? Boolean(raw) : !raw;
    return false;
  }

  // ── 日期类 ──
  if (DATE_TYPES.has(fieldType)) {
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

  // ── 数值类 ──
  if (NUMERIC_TYPES.has(fieldType)) {
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

  // ── 多选 ──
  if (MULTI_SELECT_TYPES.has(fieldType)) {
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

  // ── 单选 ──
  if (SELECT_TYPES.has(fieldType)) {
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

  // ── 人员/群组 ──
  if (USER_TYPES.has(fieldType) || fieldType === ("Group" as string)) {
    const userId = typeof raw === "string" ? raw : "";
    const condIds = Array.isArray(cond.value)
      ? cond.value.map((v) => (typeof v === "object" && v !== null && "id" in v ? (v as { id: string }).id : String(v)))
      : cond.value != null ? [String(cond.value)] : [];
    switch (op) {
      case "eq": return condIds.includes(userId);
      case "neq": return !condIds.includes(userId);
      case "contains": return condIds.includes(userId);
      case "notContains": return !condIds.includes(userId);
      default: return false;
    }
  }

  // ── 关联 ──
  if (LINK_TYPES.has(fieldType)) {
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

  // ── 默认：文本类 ──
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

// ─── 公开 API ───

export function filterRecords(
  records: TableRecord[],
  filter: ViewFilter,
  fields: Field[]
): TableRecord[] {
  if (!filter.conditions.length) return records;

  const fieldMap = new Map<string, Field>();
  for (const f of fields) {
    fieldMap.set(f.id, f);
  }

  return records.filter((record) => {
    const results = filter.conditions.map((cond) => {
      const field = fieldMap.get(cond.fieldId);
      if (!field) return false;
      return evaluateCondition(record, cond, field);
    });
    return filter.logic === "and" ? results.every(Boolean) : results.some(Boolean);
  });
}
