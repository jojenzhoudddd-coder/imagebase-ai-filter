export type FieldType =
  | "Text"
  | "Number"
  | "SingleSelect"
  | "MultiSelect"
  | "User"
  | "DateTime"
  | "Checkbox"
  | "AutoNumber";

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

export interface FieldConfig {
  options?: SelectOption[];
  users?: UserOption[];
  format?: string;
  includeTime?: boolean;
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

export type FilterValue = string | number | boolean | string[] | RelativeDateValue | null;

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
  cells: Record<string, string | number | boolean | string[] | null>;
  createdAt: number;
  updatedAt: number;
}

export interface View {
  id: string;
  tableId: string;
  name: string;
  filter: ViewFilter;
}

export type AIGenerateStatus = "idle" | "generating" | "done" | "error";
