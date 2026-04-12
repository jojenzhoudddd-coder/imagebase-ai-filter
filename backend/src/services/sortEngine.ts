import { TableRecord, ViewSort, Field, FieldType } from "../types.js";

const DATE_TYPES: FieldType[] = ["DateTime", "CreatedTime", "ModifiedTime"];
const NUMERIC_TYPES: FieldType[] = ["Number", "AutoNumber", "Progress", "Currency", "Rating"];
const SELECT_TYPES: FieldType[] = ["SingleSelect", "MultiSelect", "ai_classify", "ai_tag"];

function compareValues(
  a: TableRecord,
  b: TableRecord,
  fieldId: string,
  field: Field,
  order: "asc" | "desc"
): number {
  const va = a.cells[fieldId];
  const vb = b.cells[fieldId];
  const dir = order === "asc" ? 1 : -1;

  // Nulls always go last
  const aEmpty = va === null || va === undefined;
  const bEmpty = vb === null || vb === undefined;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  const ft = field.type;

  // Date types: sort by timestamp
  if (DATE_TYPES.includes(ft)) {
    const na = typeof va === "number" ? va : new Date(String(va)).getTime();
    const nb = typeof vb === "number" ? vb : new Date(String(vb)).getTime();
    return (na - nb) * dir;
  }

  // Numeric types: sort by number
  if (NUMERIC_TYPES.includes(ft)) {
    return (Number(va) - Number(vb)) * dir;
  }

  // Select types: sort by option order (index in options array)
  if (SELECT_TYPES.includes(ft) && field.config.options) {
    const opts = field.config.options;
    const idxA = opts.findIndex(o => o.name === String(va));
    const idxB = opts.findIndex(o => o.name === String(vb));
    return ((idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB)) * dir;
  }

  // Default: string dictionary order
  return String(va).localeCompare(String(vb), "zh-CN") * dir;
}

export function sortRecords(
  records: TableRecord[],
  sort: ViewSort,
  fields: Map<string, Field>
): TableRecord[] {
  if (!sort.rules.length) return records;

  return [...records].sort((a, b) => {
    for (const rule of sort.rules) {
      const field = fields.get(rule.fieldId);
      if (!field) continue;
      const cmp = compareValues(a, b, rule.fieldId, field, rule.order);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}
