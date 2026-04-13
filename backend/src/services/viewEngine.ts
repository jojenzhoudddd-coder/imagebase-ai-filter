import { TableRecord, View, Field, ViewQueryResult, Table } from "../types.js";
import { filterRecords } from "./filterEngine.js";
import { sortRecords } from "./sortEngine.js";
import { groupRecords } from "./groupEngine.js";
import { materializeLookups } from "./lookupEngine.js";

export function queryView(
  records: TableRecord[],
  view: View,
  fields: Map<string, Field>,
  /** Optional Lookup materialization context. When provided, any Lookup fields on the
   *  current table are computed and joined onto the records before filter/sort/group. */
  lookupCtx?: { currentTable: Table; allTables: Table[] },
): ViewQueryResult {
  let workingRecords = records;
  let workingFields = fields;

  // 0. Materialize Lookup fields (if context provided and there are any Lookups)
  if (lookupCtx) {
    const mat = materializeLookups(lookupCtx.currentTable, records, lookupCtx.allTables);
    workingRecords = mat.records;
    // Merge materialized field map with caller's map (caller's takes precedence unless Lookup)
    workingFields = new Map(fields);
    for (const [id, f] of mat.fields) {
      if (f !== fields.get(id)) workingFields.set(id, f);
    }
  }

  // 1. Filter
  let result = filterRecords(workingRecords, view.filter, workingFields);

  // 2. Sort
  if (view.sort && view.sort.rules.length > 0) {
    result = sortRecords(result, view.sort, workingFields);
  }

  // 3. Group
  let groups = undefined;
  if (view.group && view.group.rules.length > 0) {
    groups = groupRecords(result, view.group, workingFields);
  }

  return {
    records: result,
    total: result.length,
    groups,
  };
}
