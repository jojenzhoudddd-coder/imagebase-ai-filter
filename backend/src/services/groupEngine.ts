import { TableRecord, ViewGroup, Field, CellValue, GroupedRecords } from "../types.js";
import { sortRecords } from "./sortEngine.js";

export function groupRecords(
  records: TableRecord[],
  group: ViewGroup,
  fields: Map<string, Field>
): GroupedRecords[] {
  if (!group.rules.length) return [];

  // Only use first group rule for flat grouping
  const rule = group.rules[0];
  const field = fields.get(rule.fieldId);
  if (!field) return [];

  // Sort within groups by the group field order
  const sorted = sortRecords(records, { rules: [rule] }, fields);

  const groupMap = new Map<string, TableRecord[]>();
  const groupOrder: string[] = [];

  for (const record of sorted) {
    const val = record.cells[rule.fieldId];
    const key = val != null ? String(val) : "__empty__";
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
      groupOrder.push(key);
    }
    groupMap.get(key)!.push(record);
  }

  return groupOrder.map(key => ({
    groupField: rule.fieldId,
    groupValue: key === "__empty__" ? null : key,
    records: groupMap.get(key)!,
  }));
}
