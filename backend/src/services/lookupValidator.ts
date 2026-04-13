// Validation for Lookup field configs.
// Implements §6.1 of the design doc (9 rules) + the operator / output-format whitelists (§3.4, §3.5, §3.6).

import {
  Field,
  FieldType,
  FilterOperator,
  LookupConfig,
  LookupCalcMethod,
  LookupOutputFormat,
  LookupCondition,
  LookupDateConstant,
  Table,
} from "../types.js";

export interface LookupValidationResult {
  valid: boolean;
  error?: string;
  /** dot-path of the offending config field, e.g. "conditions[0].refFieldId" */
  path?: string;
}

// ─── §3.4 Operator whitelist by field-type group ───

const TEXT_LIKE_TYPES: FieldType[] = [
  "Text", "Url", "Phone", "Email", "Location", "Barcode",
  "ai_summary", "ai_transition", "ai_extract",
  "SingleSelect", "MultiSelect", "ai_classify", "ai_tag",
  "User", "Attachment", "SingleLink", "DuplexLink",
  "CreatedUser", "ModifiedUser",
];

const NUMERIC_TYPES: FieldType[] = [
  "Number", "AutoNumber", "Progress", "Currency", "Rating",
];

const DATE_TYPES: FieldType[] = [
  "DateTime", "CreatedTime", "ModifiedTime",
];

const TEXT_OPS: FilterOperator[] = ["isEmpty", "isNotEmpty", "eq", "neq", "contains"];
const NUMERIC_OPS: FilterOperator[] = ["isEmpty", "isNotEmpty", "eq", "neq", "contains", "gt", "gte", "lte", "lt"];
const DATE_OPS: FilterOperator[] = ["isEmpty", "isNotEmpty", "eq", "neq", "contains", "after", "gte", "lte", "before"];

export function getAllowedOperators(fieldType: FieldType): FilterOperator[] {
  if (DATE_TYPES.includes(fieldType)) return DATE_OPS;
  if (NUMERIC_TYPES.includes(fieldType)) return NUMERIC_OPS;
  if (TEXT_LIKE_TYPES.includes(fieldType)) return TEXT_OPS;
  // Unknown/unsupported field type as LHS of a Lookup condition — disallow everything.
  return [];
}

// ─── §3.5 Date constant validator ───

const DATE_ABSOLUTE_RE = /^\d{4}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;

function isLookupDateConstant(value: unknown): value is LookupDateConstant {
  if (value === "yesterday" || value === "today" || value === "tomorrow") return true;
  if (
    typeof value === "object" &&
    value !== null &&
    (value as any).type === "absolute" &&
    typeof (value as any).value === "string" &&
    DATE_ABSOLUTE_RE.test((value as any).value)
  ) {
    return true;
  }
  return false;
}

// ─── §3.6 Output format whitelist by calc method ───

const FORMATS_FOR_ORIGINAL: LookupOutputFormat[] = ["default", "text", "number", "date", "currency", "autoNumber"];
const FORMATS_FOR_AGGREGATE: LookupOutputFormat[] = ["number", "date", "currency"];

function isOutputFormatAllowed(calcMethod: LookupCalcMethod, fmt: LookupOutputFormat): boolean {
  if (calcMethod === "original" || calcMethod === "deduplicate") {
    return FORMATS_FOR_ORIGINAL.includes(fmt);
  }
  return FORMATS_FOR_AGGREGATE.includes(fmt);
}

// ─── Calc method vs ref field type compatibility ───

function isCalcMethodAllowed(calcMethod: LookupCalcMethod, refFieldType: FieldType): boolean {
  // sum / average require numeric
  if (calcMethod === "sum" || calcMethod === "average") {
    return NUMERIC_TYPES.includes(refFieldType);
  }
  // max / min require numeric or date
  if (calcMethod === "max" || calcMethod === "min") {
    return NUMERIC_TYPES.includes(refFieldType) || DATE_TYPES.includes(refFieldType);
  }
  // original / deduplicate / count / dedupeCount are always allowed
  return true;
}

// ─── Core validator ───

function fail(error: string, path?: string): LookupValidationResult {
  return { valid: false, error, path };
}

export function validateLookupConfig(
  config: LookupConfig | undefined,
  currentTableId: string,
  currentTable: Table | null,
  allTables: Table[],
  /** The id of the field being created/edited — used for circular-dependency detection. Pass null when creating. */
  selfFieldId: string | null,
): LookupValidationResult {
  // Rule 1: required block + all 5 subfields
  if (!config || typeof config !== "object") return fail("查找引用配置缺失", "lookup");
  const { refTableId, refFieldId, conditions, conditionLogic, calcMethod, lookupOutputFormat } = config;
  if (!refTableId) return fail("引用表必填", "refTableId");
  if (!refFieldId) return fail("引用字段必填", "refFieldId");
  if (!Array.isArray(conditions)) return fail("查找条件必须是数组", "conditions");
  if (!calcMethod) return fail("计算方式必填", "calcMethod");
  if (!lookupOutputFormat) return fail("字段格式必填", "lookupOutputFormat");

  // Rule 2: forbid self-reference
  if (refTableId === currentTableId) return fail("引用表不能是当前表", "refTableId");

  // Rule 3: ref table must exist
  const refTable = allTables.find(t => t.id === refTableId);
  if (!refTable) return fail("引用表不存在", "refTableId");

  // Rule 3b: ref field must exist on ref table
  const refField = refTable.fields.find(f => f.id === refFieldId);
  if (!refField) return fail("引用字段不存在于引用表", "refFieldId");

  // Rule 4: condition count 1..5
  if (conditions.length < 1) return fail("至少需要 1 条查找条件", "conditions");
  if (conditions.length > 5) return fail("最多 5 条查找条件", "conditions");

  // Rule 5: conditionLogic must be and/or
  if (conditionLogic !== "and" && conditionLogic !== "or") {
    return fail("查找条件逻辑必须是 and 或 or", "conditionLogic");
  }

  // Rule 6: per-condition validation
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i];
    const path = `conditions[${i}]`;
    const r = validateCondition(c, i, refTable, currentTable);
    if (!r.valid) return { valid: false, error: r.error, path: r.path ?? path };
  }

  // Rule 7: calc method vs ref field type
  if (!isCalcMethodAllowed(calcMethod, refField.type)) {
    return fail(`计算方式「${calcMethod}」不支持字段类型「${refField.type}」`, "calcMethod");
  }

  // Rule 8: output format whitelist
  if (!isOutputFormatAllowed(calcMethod, lookupOutputFormat)) {
    return fail(`字段格式「${lookupOutputFormat}」不支持计算方式「${calcMethod}」`, "lookupOutputFormat");
  }

  // Rule 9: circular dependency detection
  // Walk the Lookup graph starting from refField, see if it transitively hits selfFieldId.
  if (selfFieldId) {
    const cycle = hasLookupCycle(refFieldId, refTable, allTables, selfFieldId, currentTableId);
    if (cycle) return fail("查找引用依赖成环", "refFieldId");
  }

  return { valid: true };
}

function validateCondition(
  c: LookupCondition,
  idx: number,
  refTable: Table,
  currentTable: Table | null,
): LookupValidationResult {
  const pathBase = `conditions[${idx}]`;
  if (!c || typeof c !== "object") return fail("条件项无效", pathBase);
  if (!c.refFieldId) return fail("条件左值（引用表字段）必填", `${pathBase}.refFieldId`);

  // LHS field must exist on ref table
  const leftField = refTable.fields.find(f => f.id === c.refFieldId);
  if (!leftField) return fail("条件左值字段不存在", `${pathBase}.refFieldId`);

  // Operator must be in whitelist for this LHS field type
  const allowed = getAllowedOperators(leftField.type);
  if (!c.operator) return fail("条件判断逻辑必填", `${pathBase}.operator`);
  if (!allowed.includes(c.operator)) {
    return fail(`字段类型「${leftField.type}」不支持运算符「${c.operator}」`, `${pathBase}.operator`);
  }

  // Unary operators don't need a RHS
  const isUnary = c.operator === "isEmpty" || c.operator === "isNotEmpty";

  if (!isUnary) {
    if (c.valueType !== "field" && c.valueType !== "constant") {
      return fail("条件右值类型必须是 field 或 constant", `${pathBase}.valueType`);
    }

    if (c.valueType === "field") {
      if (!c.currentFieldId) return fail("条件右值字段必填", `${pathBase}.currentFieldId`);
      if (!currentTable) return fail("当前表信息缺失，无法校验字段引用", `${pathBase}.currentFieldId`);
      const rightField = currentTable.fields.find(f => f.id === c.currentFieldId);
      if (!rightField) {
        return fail("条件右值字段必须属于当前表，禁止引用其他表", `${pathBase}.currentFieldId`);
      }
    } else {
      // constant: for date fields, enforce LookupDateConstant shape
      if (DATE_TYPES.includes(leftField.type)) {
        if (c.value === undefined) return fail("条件右值常量必填", `${pathBase}.value`);
        if (!isLookupDateConstant(c.value)) {
          return fail("日期常量只允许 yesterday/today/tomorrow 或 yyyy/MM/dd", `${pathBase}.value`);
        }
      } else {
        if (c.value === undefined) return fail("条件右值常量必填", `${pathBase}.value`);
      }
    }
  }

  return { valid: true };
}

/**
 * Returns true if walking from `startFieldId` (a field on `startTable`) through
 * nested Lookup fields reaches `selfFieldId`/`selfTableId`.
 * Bounded by MAX_DEPTH to guarantee termination.
 */
function hasLookupCycle(
  startFieldId: string,
  startTable: Table,
  allTables: Table[],
  selfFieldId: string,
  selfTableId: string,
  depth: number = 0,
  visited: Set<string> = new Set(),
): boolean {
  const MAX_DEPTH = 10;
  if (depth > MAX_DEPTH) return true; // treat runaway as cycle
  const key = `${startTable.id}:${startFieldId}`;
  if (visited.has(key)) return true;
  visited.add(key);

  const field = startTable.fields.find(f => f.id === startFieldId);
  if (!field) return false;
  if (field.id === selfFieldId && startTable.id === selfTableId) return true;
  if (field.type !== "Lookup" || !field.config.lookup) return false;

  const cfg = field.config.lookup;
  const nextTable = allTables.find(t => t.id === cfg.refTableId);
  if (!nextTable) return false;

  // Did the next Lookup hit self directly?
  if (cfg.refFieldId === selfFieldId && cfg.refTableId === selfTableId) return true;

  return hasLookupCycle(cfg.refFieldId, nextTable, allTables, selfFieldId, selfTableId, depth + 1, visited);
}
