import { TableRecord, View, Field, ViewQueryResult } from "../types.js";
import { filterRecords } from "./filterEngine.js";
import { sortRecords } from "./sortEngine.js";
import { groupRecords } from "./groupEngine.js";

export function queryView(
  records: TableRecord[],
  view: View,
  fields: Map<string, Field>
): ViewQueryResult {
  // 1. Filter
  let result = filterRecords(records, view.filter, fields);

  // 2. Sort
  if (view.sort && view.sort.rules.length > 0) {
    result = sortRecords(result, view.sort, fields);
  }

  // 3. Group
  let groups = undefined;
  if (view.group && view.group.rules.length > 0) {
    groups = groupRecords(result, view.group, fields);
  }

  return {
    records: result,
    total: result.length,
    groups,
  };
}
