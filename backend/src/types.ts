// ─── Field Types ───
export const FIELD_TYPES = [
  // 基础类型字段
  "Text", "SingleSelect", "MultiSelect", "User", "Group",
  "DateTime", "Attachment", "Number", "Checkbox", "Url",
  "AutoNumber", "Phone", "Email", "Location", "Barcode",
  "Progress", "Currency", "Rating",
  "CreatedUser", "ModifiedUser", "CreatedTime", "ModifiedTime",
  // 扩展字段类型
  "Formula", "SingleLink", "DuplexLink", "Lookup",
  // AI 能力字段类型
  "ai_summary", "ai_transition", "ai_extract", "ai_classify", "ai_tag", "ai_custom",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

// ─── Select Option ───
export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

// ─── User / Group Option ───
export interface UserOption {
  id: string;
  name: string;
  avatar: string;
}

export interface GroupOption {
  id: string;
  name: string;
  avatar?: string;
}

// ─── Number Formats ───
export type NumberFormat =
  | "integer"
  | "thousands"
  | "thousandsDecimal"
  | "decimal1" | "decimal2" | "decimal3" | "decimal4"
  | "decimal5" | "decimal6" | "decimal7" | "decimal8" | "decimal9"
  | "percent"
  | "percentDecimal";

// ─── Currency ───
export type CurrencyCode = "CNY" | "USD" | "EUR" | "GBP" | "JPY" | "KRW" | "HKD" | "TWD" | "SGD" | "AUD" | "CAD" | "INR";
export type CurrencyPrecision = 0 | 1 | 2 | 3 | 4;

// ─── Rating ───
export type RatingSymbol = "star" | "heart" | "thumbsUp" | "fire" | "smile" | "lightning" | "flower" | "number";

// ─── Progress ───
export type ProgressFormat = "number" | "percent";
export type ProgressPrecision = 0 | 1 | 2;

// ─── AutoNumber Rule ───
export interface AutoNumberRuleIncrement { type: "increment"; }
export interface AutoNumberRuleFixed { type: "fixed"; value: string; }
export interface AutoNumberRuleDate { type: "date"; format: "yyyyMMdd" | "yyyyMM" | "yyMM" | "MMdd" | "MM" | "dd"; }
export type AutoNumberRule = AutoNumberRuleIncrement | AutoNumberRuleFixed | AutoNumberRuleDate;

// ─── Formula ───
export type FormulaOutputType = "text" | "singleSelect" | "dateTime" | "number";

// ─── Lookup ───
export type LookupCalcMethod = "original" | "deduplicate" | "deduplicateCount" | "count" | "sum" | "average" | "max" | "min";

export type LookupOutputFormat = "default" | "text" | "number" | "date" | "currency" | "autoNumber";

// Date constant used on the RHS of a Lookup condition when the LHS is a date/time field.
// Only static constants allowed — no last7Days / thisWeek / etc.
export type LookupDateConstant =
  | "yesterday"
  | "today"
  | "tomorrow"
  | { type: "absolute"; value: string /* yyyy/MM/dd */ };

export interface LookupCondition {
  /** Left-hand side: a field on the referenced table. */
  refFieldId: string;
  operator: FilterOperator;
  /** "field" = compare to a field on the CURRENT table; "constant" = compare to a literal. */
  valueType: "field" | "constant";
  /** Required when valueType === "field": the field id on the current table. */
  currentFieldId?: string;
  /** Required when valueType === "constant": the literal value (or LookupDateConstant for date fields). */
  value?: CellValue | LookupDateConstant;
}

export interface LookupConfig {
  refTableId: string;
  refFieldId: string;
  conditions: LookupCondition[];
  conditionLogic: "and" | "or";
  calcMethod: LookupCalcMethod;
  /** Output format; required. See §3.6 of the design doc for the whitelist by calc method. */
  lookupOutputFormat: LookupOutputFormat;
}

// ─── Link Range ───
export interface LinkRangeCondition {
  fieldId: string;
  operator: FilterOperator;
  value?: CellValue;
}

export interface LinkRange {
  type: "all" | "specified";
  conditions?: LinkRangeCondition[];
  logic?: "and" | "or";
}

// ─── AI ───
export const AI_LANGUAGES = [
  "zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "pt", "ru", "it", "ar",
] as const;
export type AILanguage = (typeof AI_LANGUAGES)[number];
export type AICustomOutputType = "text" | "number" | "singleSelect" | "multiSelect" | "dateTime";

// ─── Filter ───
export interface FilterCondition {
  id: string;
  fieldId: string;
  operator: FilterOperator;
  value?: CellValue;
}

export type FilterOperator =
  | "isEmpty" | "isNotEmpty"
  | "eq" | "neq"
  | "contains" | "notContains"
  | "gt" | "gte" | "lt" | "lte"
  | "after" | "before"
  | "checked" | "unchecked";

export type RelativeDate =
  | "today" | "tomorrow" | "yesterday"
  | "thisWeek" | "lastWeek"
  | "thisMonth" | "lastMonth"
  | "last7Days" | "next7Days"
  | "last30Days" | "next30Days";

export interface ViewFilter {
  logic: "and" | "or";
  conditions: FilterCondition[];
}

// ─── Sort ───
export interface ViewSortRule {
  fieldId: string;
  order: "asc" | "desc";
}

export interface ViewSort {
  rules: ViewSortRule[];
}

// ─── Group ───
export interface ViewGroupRule {
  fieldId: string;
  order: "asc" | "desc";
}

export interface ViewGroup {
  rules: ViewGroupRule[];  // max 3
}

// ─── View ───
export type ViewType = "grid" | "kanban";

export interface View {
  id: string;
  tableId: string;
  name: string;
  type: ViewType;
  filter: ViewFilter;
  sort?: ViewSort;
  group?: ViewGroup;
  kanbanFieldId?: string;
  fieldOrder?: string[];    // 字段显示顺序（fieldId 数组），未设置时按 fields 数组顺序
  hiddenFields?: string[];  // 隐藏的字段 ID 列表
}

// ─── Field Config ───
export interface FieldConfig {
  // SingleSelect / MultiSelect
  options?: SelectOption[];
  refOptionFieldId?: string;

  // User
  users?: UserOption[];
  allowMultipleUsers?: boolean;

  // Group
  groups?: GroupOption[];
  allowMultipleGroups?: boolean;

  // DateTime / CreatedTime / ModifiedTime
  format?: string;
  includeTime?: boolean;

  // Attachment
  mobileCameraOnly?: boolean;

  // Number
  numberFormat?: NumberFormat;

  // AutoNumber
  autoNumberMode?: "increment" | "custom";
  autoNumberRules?: AutoNumberRule[];

  // Progress
  progressFormat?: ProgressFormat;
  progressPrecision?: ProgressPrecision;

  // Currency
  currencyCode?: CurrencyCode;
  currencyPrecision?: CurrencyPrecision;

  // Rating
  ratingSymbol?: RatingSymbol;
  ratingMin?: 0 | 1;
  ratingMax?: number;

  // Location
  locationInputMode?: "any" | "mobileGps";

  // Barcode
  barcodeMobileScanOnly?: boolean;

  // Formula
  formulaExpression?: string;
  formulaOutputType?: FormulaOutputType;
  formulaOutputFormat?: string;

  // SingleLink / DuplexLink
  linkTargetTableId?: string;
  linkAllowMultiple?: boolean;
  linkRange?: LinkRange;
  linkReverseFieldId?: string;

  // Lookup
  lookup?: LookupConfig;

  // AI Summary
  aiSummarySourceFields?: string[];
  aiSummaryCustomPrompt?: string;

  // AI Translation
  aiTranslationSourceField?: string;
  aiTranslationTargetLang?: AILanguage;
  aiTranslationCustomPrompt?: string;

  // AI Extract
  aiExtractSourceField?: string;
  aiExtractTarget?: string;
  aiExtractExample?: string;
  aiExtractCustomPrompt?: string;

  // AI Classify
  aiClassifySourceField?: string;
  aiClassifyMode?: "auto" | "ref";
  aiClassifyRefFieldId?: string;
  aiClassifyExample?: string;
  aiClassifyCustomPrompt?: string;

  // AI Tag
  aiTagSourceField?: string;
  aiTagMode?: "auto" | "ref";
  aiTagRefFieldId?: string;
  aiTagExample?: string;
  aiTagCustomPrompt?: string;

  // AI Custom
  aiCustomInstruction?: string;
  aiCustomOutputType?: AICustomOutputType;
  aiCustomSourceFields?: string[];
}

// ─── Field ───
export interface Field {
  id: string;
  tableId: string;
  name: string;
  type: FieldType;
  isPrimary: boolean;
  config: FieldConfig;
}

// ─── Cell Value ───
export type CellValue = string | number | boolean | string[] | null | undefined;

// ─── Record ───
export interface TableRecord {
  id: string;
  tableId: string;
  cells: Record<string, CellValue>;
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
  modifiedBy?: string;
}

// ─── Table ───
export interface Table {
  id: string;
  name: string;
  fields: Field[];
  records: TableRecord[];
  views: View[];
  autoNumberCounters: Record<string, number>;
}

// ─── API Types ───
export interface FilterGenerateRequest {
  tableId: string;
  viewId?: string;
  query: string;
  existingFilter?: ViewFilter;
}

export interface GroupedRecords {
  groupField: string;
  groupValue: CellValue;
  records: TableRecord[];
}

export interface ViewQueryResult {
  records: TableRecord[];
  total: number;
  groups?: GroupedRecords[];
}

export interface GeneratedField {
  name: string;
  type: string;
  isPrimary?: boolean;
  config?: Record<string, any>;
}

export interface CreateTableDTO { name: string; workspaceId?: string; language?: "en" | "zh"; }
export interface CreateFieldDTO { name: string; type: FieldType; config?: FieldConfig; }
export interface UpdateFieldDTO { name?: string; type?: FieldType; config?: FieldConfig; }
export interface CreateRecordDTO { cells: Record<string, CellValue>; }
export interface UpdateRecordDTO { cells: Record<string, CellValue>; }
export interface CreateViewDTO {
  name: string;
  type: ViewType;
  filter?: ViewFilter;
  sort?: ViewSort;
  group?: ViewGroup;
  kanbanFieldId?: string;
}
export interface UpdateViewDTO {
  name?: string;
  filter?: ViewFilter;
  sort?: ViewSort;
  group?: ViewGroup;
  kanbanFieldId?: string;
  fieldOrder?: string[];
  hiddenFields?: string[];
}
