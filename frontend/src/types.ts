// Keep in sync with backend/src/types.ts (only the subset the frontend uses).

export type FieldType =
  // Basic
  | "Text"
  | "Number"
  | "SingleSelect"
  | "MultiSelect"
  | "User"
  | "DateTime"
  | "Attachment"
  | "Checkbox"
  | "Stage"
  | "AutoNumber"
  | "Url"
  | "Phone"
  | "Email"
  | "Location"
  | "Barcode"
  | "Progress"
  | "Currency"
  | "Rating"
  // System
  | "CreatedUser"
  | "ModifiedUser"
  | "CreatedTime"
  | "ModifiedTime"
  // Extended
  | "Formula"
  | "SingleLink"
  | "DuplexLink"
  | "Lookup"
  // AI
  | "ai_summary"
  | "ai_transition"
  | "ai_extract"
  | "ai_classify"
  | "ai_tag"
  | "ai_custom";

export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

export interface UserOption {
  id: string;
  name: string;
  avatar: string;
}

// ─── Lookup ───

export type LookupCalcMethod =
  | "original"
  | "deduplicate"
  | "deduplicateCount"
  | "count"
  | "sum"
  | "average"
  | "max"
  | "min";

export type LookupOutputFormat =
  | "default"
  | "text"
  | "number"
  | "date"
  | "currency"
  | "autoNumber";

export type LookupDateConstant =
  | "yesterday"
  | "today"
  | "tomorrow"
  | { type: "absolute"; value: string };

export interface LookupCondition {
  refFieldId: string;
  operator: FilterOperator;
  valueType: "field" | "constant";
  currentFieldId?: string;
  value?: CellValue | LookupDateConstant;
}

export interface LookupConfig {
  refTableId: string;
  refFieldId: string;
  conditions: LookupCondition[];
  conditionLogic: "and" | "or";
  calcMethod: LookupCalcMethod;
  lookupOutputFormat: LookupOutputFormat;
}

export interface FieldConfig {
  options?: SelectOption[];
  users?: UserOption[];
  format?: string;
  includeTime?: boolean;
  // Lookup
  lookup?: LookupConfig;
}

export interface Field {
  id: string;
  tableId: string;
  name: string;
  type: FieldType;
  isPrimary: boolean;
  config: FieldConfig;
}

export type FilterLogic = "and" | "or";

export type FilterOperator =
  | "isEmpty"
  | "isNotEmpty"
  | "eq"
  | "neq"
  | "contains"
  | "notContains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "after"
  | "before"
  | "checked"
  | "unchecked";

export type RelativeDateValue =
  | "today"
  | "tomorrow"
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
  | "thisMonth"
  | "lastMonth"
  | "last7Days"
  | "next7Days"
  | "last30Days"
  | "next30Days";

export type CellValue = string | number | boolean | string[] | null;

export type FilterValue = CellValue | RelativeDateValue;

export interface FilterCondition {
  id: string;
  fieldId: string;
  operator: FilterOperator;
  value: FilterValue;
}

export interface ViewFilter {
  logic: FilterLogic;
  conditions: FilterCondition[];
}

export interface TableRecord {
  id: string;
  tableId: string;
  cells: Record<string, CellValue>;
  createdAt: number;
  updatedAt: number;
}

export interface View {
  id: string;
  tableId: string;
  name: string;
  filter: ViewFilter;
  fieldOrder?: string[];
  hiddenFields?: string[];
}

export type AIGenerateStatus = "idle" | "generating" | "done" | "error";

export type TreeItemType = "table" | "folder" | "design" | "album";

export interface FolderNode {
  id: string;
  type: "folder";
  name: string;
  parentId: string | null;
  order: number;
  expanded: boolean;
}

export interface FileNode {
  id: string;
  type: TreeItemType;
  name: string;
  parentId: string | null;
  order: number;
}

export type TreeNode = FolderNode | FileNode;
