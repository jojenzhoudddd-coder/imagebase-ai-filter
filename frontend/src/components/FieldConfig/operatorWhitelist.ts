// Mirrors backend/src/services/lookupValidator.ts operator whitelist.
// Must stay in sync — used by the UI to show only legal operators per LHS field type.

import { FieldType, FilterOperator } from "../../types";

const TEXT_LIKE: FieldType[] = [
  "Text", "SingleSelect", "MultiSelect", "User",
];

const NUMERIC: FieldType[] = ["Number", "AutoNumber"];
const DATE: FieldType[] = ["DateTime"];

const TEXT_OPS: FilterOperator[] = ["isEmpty", "isNotEmpty", "eq", "neq", "contains"];
const NUMERIC_OPS: FilterOperator[] = ["isEmpty", "isNotEmpty", "eq", "neq", "contains", "gt", "gte", "lte", "lt"];
const DATE_OPS: FilterOperator[] = ["isEmpty", "isNotEmpty", "eq", "neq", "contains", "after", "gte", "lte", "before"];

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
  eq: "is",
  neq: "is not",
  contains: "contains",
  notContains: "not contains",
  gt: "greater than",
  gte: "greater or equal",
  lt: "less than",
  lte: "less or equal",
  after: "later than",
  before: "earlier than",
  checked: "checked",
  unchecked: "unchecked",
};

export function getAllowedOperators(fieldType: FieldType): FilterOperator[] {
  if (DATE.includes(fieldType)) return DATE_OPS;
  if (NUMERIC.includes(fieldType)) return NUMERIC_OPS;
  if (TEXT_LIKE.includes(fieldType)) return TEXT_OPS;
  return TEXT_OPS; // safe default
}

export function isUnary(op: FilterOperator): boolean {
  return op === "isEmpty" || op === "isNotEmpty";
}
