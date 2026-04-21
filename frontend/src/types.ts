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

export type TreeItemType = "table" | "folder" | "design" | "album" | "idea";

// ─── Idea（Markdown 文档 artifact） ───
export interface IdeaBrief {
  id: string;
  workspaceId: string;
  name: string;
  parentId: string | null;
  order: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface IdeaDetail extends IdeaBrief {
  content: string;
  version: number;
}

// ─── Mention system ───
// v3: four workspace-level targets. The label already carries the
// fully-qualified "Parent.Child" form for view / taste / idea-section, so the
// picker and chip render it directly — no need for a separate parentLabel.
//
//   view          — a saved view inside a table  (label: "Table.View")
//   taste         — an SVG inside a design       (label: "Design.Taste")
//   idea          — a Markdown doc artifact      (label: "IdeaName")
//   idea-section  — a heading inside an idea     (label: "IdeaName.Heading")
export type MentionType = "view" | "taste" | "idea" | "idea-section";

export interface MentionHit {
  type: MentionType;
  /** Primary identifier. For `idea-section` this is the heading slug (unique
   * within the parent idea); the parent idea's id lives in `ideaId`. */
  id: string;
  /** Composite display label, e.g. "CRM.Kanban" (table.view),
   * "Logo.Hero" (design.taste), "Launch plan" (idea), or
   * "Launch plan.Timeline" (idea-section). */
  label: string;
  /** Navigation parent — set for view (tableId), taste (designId),
   * idea-section (ideaId). */
  tableId?: string;
  designId?: string;
  ideaId?: string;
  /** Raw heading text for idea-section hits — preserved so the chip can show
   * it verbatim if the label is truncated. */
  headingText?: string;
}

export type FocusEntity =
  | { type: "view";  id: string }
  | { type: "taste"; id: string }
  | null;

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
