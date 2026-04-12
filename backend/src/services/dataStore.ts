import {
  Table, Field, TableRecord, View, CellValue,
  CreateTableDTO, CreateFieldDTO, UpdateFieldDTO,
  CreateRecordDTO, UpdateRecordDTO,
  CreateViewDTO, UpdateViewDTO,
  ViewFilter, FieldType,
} from "../types.js";

let tables: Map<string, Table> = new Map();
let idCounter = 0;

function genId(prefix: string): string {
  return `${prefix}_${(++idCounter).toString(36).padStart(4, "0")}`;
}

// ─── Table ───

export function listTables(): Table[] {
  return [...tables.values()];
}

export function getTable(id: string): Table | undefined {
  return tables.get(id);
}

export function createTable(dto: CreateTableDTO): Table {
  const id = genId("tbl");
  const table: Table = {
    id,
    name: sanitizeTableName(dto.name),
    fields: [],
    records: [],
    views: [{
      id: genId("viw"),
      tableId: id,
      name: "Grid",
      type: "grid",
      filter: { logic: "and", conditions: [] },
    }],
    autoNumberCounters: {},
  };
  tables.set(id, table);
  return table;
}

export function deleteTable(id: string): boolean {
  return tables.delete(id);
}

// ─── Field ───

export function getFields(tableId: string): Field[] {
  const t = tables.get(tableId);
  return t ? t.fields : [];
}

export function getField(tableId: string, fieldId: string): Field | undefined {
  const t = tables.get(tableId);
  return t?.fields.find(f => f.id === fieldId);
}

export function createField(tableId: string, dto: CreateFieldDTO): Field | null {
  const t = tables.get(tableId);
  if (!t) return null;

  const field: Field = {
    id: genId("fld"),
    tableId,
    name: dto.name.slice(0, 100),
    type: dto.type,
    isPrimary: t.fields.length === 0,
    config: dto.config ?? {},
  };

  // Initialize auto number counter
  if (dto.type === "AutoNumber") {
    t.autoNumberCounters[field.id] = 0;
  }

  t.fields.push(field);

  // Initialize cells for existing records
  for (const rec of t.records) {
    rec.cells[field.id] = getDefaultCellValue(field, t, rec);
  }

  return field;
}

export function updateField(tableId: string, fieldId: string, dto: UpdateFieldDTO): Field | null {
  const t = tables.get(tableId);
  if (!t) return null;
  const field = t.fields.find(f => f.id === fieldId);
  if (!field) return null;

  if (dto.name !== undefined) field.name = dto.name.slice(0, 100);
  if (dto.config !== undefined) field.config = { ...field.config, ...dto.config };

  return field;
}

export function deleteField(tableId: string, fieldId: string): boolean {
  const t = tables.get(tableId);
  if (!t) return false;

  const idx = t.fields.findIndex(f => f.id === fieldId);
  if (idx === -1) return false;
  if (t.fields[idx].isPrimary) return false; // cannot delete primary

  t.fields.splice(idx, 1);

  // Remove from records
  for (const rec of t.records) {
    delete rec.cells[fieldId];
  }

  // Remove from view filters/sorts/groups
  for (const view of t.views) {
    view.filter.conditions = view.filter.conditions.filter(c => c.fieldId !== fieldId);
    if (view.sort) {
      view.sort.rules = view.sort.rules.filter(r => r.fieldId !== fieldId);
    }
    if (view.group) {
      view.group.rules = view.group.rules.filter(r => r.fieldId !== fieldId);
    }
  }

  delete t.autoNumberCounters[fieldId];
  return true;
}

// ─── Record ───

export function getRecords(tableId: string): TableRecord[] {
  const t = tables.get(tableId);
  return t ? t.records : [];
}

export function getRecord(tableId: string, recordId: string): TableRecord | undefined {
  const t = tables.get(tableId);
  return t?.records.find(r => r.id === recordId);
}

export function createRecord(tableId: string, dto: CreateRecordDTO, userId?: string): TableRecord | null {
  const t = tables.get(tableId);
  if (!t) return null;

  const now = Date.now();
  const record: TableRecord = {
    id: genId("rec"),
    tableId,
    cells: {},
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    modifiedBy: userId,
  };

  // Fill cells with provided values or defaults
  for (const field of t.fields) {
    if (dto.cells[field.id] !== undefined) {
      record.cells[field.id] = dto.cells[field.id];
    } else {
      record.cells[field.id] = getDefaultCellValue(field, t, record);
    }
  }

  t.records.push(record);
  return record;
}

export function updateRecord(tableId: string, recordId: string, dto: UpdateRecordDTO, userId?: string): TableRecord | null {
  const t = tables.get(tableId);
  if (!t) return null;
  const record = t.records.find(r => r.id === recordId);
  if (!record) return null;

  const now = Date.now();
  for (const [fieldId, value] of Object.entries(dto.cells)) {
    const field = t.fields.find(f => f.id === fieldId);
    if (!field) continue;

    // Skip read-only fields
    if (isReadOnly(field.type)) continue;

    record.cells[fieldId] = value;
  }

  record.updatedAt = now;
  record.modifiedBy = userId;

  // Update ModifiedTime / ModifiedUser fields
  for (const field of t.fields) {
    if (field.type === "ModifiedTime") {
      record.cells[field.id] = now;
    }
    if (field.type === "ModifiedUser") {
      record.cells[field.id] = userId ?? null;
    }
  }

  return record;
}

export function deleteRecord(tableId: string, recordId: string): boolean {
  const t = tables.get(tableId);
  if (!t) return false;
  const idx = t.records.findIndex(r => r.id === recordId);
  if (idx === -1) return false;
  t.records.splice(idx, 1);
  return true;
}

export function batchDeleteRecords(tableId: string, recordIds: string[]): number {
  const t = tables.get(tableId);
  if (!t) return 0;
  const idSet = new Set(recordIds);
  const before = t.records.length;
  t.records = t.records.filter(r => !idSet.has(r.id));
  return before - t.records.length;
}

// ─── View ───

export function getViews(tableId: string): View[] {
  const t = tables.get(tableId);
  return t ? t.views : [];
}

export function getView(viewId: string): View | undefined {
  for (const t of tables.values()) {
    const v = t.views.find(v => v.id === viewId);
    if (v) return v;
  }
  return undefined;
}

export function createView(tableId: string, dto: CreateViewDTO): View | null {
  const t = tables.get(tableId);
  if (!t) return null;

  const name = sanitizeViewName(dto.name);
  if (name.length < 1 || name.length > 100) return null;

  // Only grid and kanban allowed
  if (dto.type !== "grid" && dto.type !== "kanban") return null;

  // Validate group rules max 3
  if (dto.group && dto.group.rules.length > 3) return null;

  const view: View = {
    id: genId("viw"),
    tableId,
    name,
    type: dto.type,
    filter: dto.filter ?? { logic: "and", conditions: [] },
    sort: dto.sort,
    group: dto.group,
    kanbanFieldId: dto.kanbanFieldId,
  };
  t.views.push(view);
  return view;
}

export function updateView(viewId: string, dto: UpdateViewDTO): View | null {
  const view = getView(viewId);
  if (!view) return null;

  if (dto.name !== undefined) {
    const name = sanitizeViewName(dto.name);
    if (name.length < 1 || name.length > 100) return null;
    view.name = name;
  }
  if (dto.filter !== undefined) view.filter = dto.filter;
  if (dto.sort !== undefined) view.sort = dto.sort;
  if (dto.group !== undefined) {
    if (dto.group.rules.length > 3) return null;
    view.group = dto.group;
  }
  if (dto.kanbanFieldId !== undefined) view.kanbanFieldId = dto.kanbanFieldId;

  return view;
}

export function deleteView(tableId: string, viewId: string): boolean {
  const t = tables.get(tableId);
  if (!t) return false;
  if (t.views.length <= 1) return false; // must keep at least 1 view
  const idx = t.views.findIndex(v => v.id === viewId);
  if (idx === -1) return false;
  t.views.splice(idx, 1);
  return true;
}

// ─── Initialization ───

export function loadTable(table: Table): void {
  tables.set(table.id, table);
  // Ensure idCounter stays ahead
  const allIds = [
    table.id,
    ...table.fields.map(f => f.id),
    ...table.records.map(r => r.id),
    ...table.views.map(v => v.id),
  ];
  for (const id of allIds) {
    const parts = id.split("_");
    const numPart = parts[parts.length - 1];
    const num = parseInt(numPart, 36);
    if (!isNaN(num) && num > idCounter) idCounter = num;
  }
}

export function clearAll(): void {
  tables.clear();
  idCounter = 0;
}

// ─── Helpers ───

function sanitizeTableName(name: string): string {
  return name.replace(/\[\*/g, "").replace(/\*\]/g, "").slice(0, 100);
}

function sanitizeViewName(name: string): string {
  return name.replace(/\[\*/g, "").replace(/\*\]/g, "").slice(0, 100);
}

function isReadOnly(type: FieldType): boolean {
  return ["AutoNumber", "CreatedUser", "ModifiedUser", "CreatedTime", "ModifiedTime", "Formula", "Lookup"].includes(type);
}

function getDefaultCellValue(field: Field, table: Table, record: TableRecord): CellValue {
  switch (field.type) {
    case "AutoNumber": {
      const counter = (table.autoNumberCounters[field.id] ?? 0) + 1;
      table.autoNumberCounters[field.id] = counter;
      if (field.config.autoNumberMode === "custom" && field.config.autoNumberRules) {
        return formatAutoNumber(counter, field.config.autoNumberRules);
      }
      return counter;
    }
    case "CreatedTime":
      return record.createdAt;
    case "ModifiedTime":
      return record.updatedAt;
    case "CreatedUser":
      return record.createdBy ?? null;
    case "ModifiedUser":
      return record.modifiedBy ?? null;
    case "Checkbox":
      return false;
    default:
      return null;
  }
}

function formatAutoNumber(counter: number, rules: import("../types.js").AutoNumberRule[]): string {
  const now = new Date();
  return rules.map(rule => {
    switch (rule.type) {
      case "increment":
        return String(counter);
      case "fixed":
        return rule.value;
      case "date": {
        const y = String(now.getFullYear());
        const m = String(now.getMonth() + 1).padStart(2, "0");
        const d = String(now.getDate()).padStart(2, "0");
        const fmtMap: Record<string, string> = {
          yyyyMMdd: `${y}${m}${d}`,
          yyyyMM: `${y}${m}`,
          yyMM: `${y.slice(2)}${m}`,
          MMdd: `${m}${d}`,
          MM: m,
          dd: d,
        };
        return fmtMap[rule.format] ?? "";
      }
    }
  }).join("");
}

// ─── AI Tool functions ───

export interface TableBriefInfo {
  tableId: string;
  tableName: string;
  recordCount: number;
  fields: {
    id: string;
    name: string;
    type: string;
    isPrimary: boolean;
    options?: string[];
  }[];
}

export function getTableBriefInfo(tableId: string): TableBriefInfo | null {
  const t = tables.get(tableId);
  if (!t) return null;

  return {
    tableId: t.id,
    tableName: t.name,
    recordCount: t.records.length,
    fields: t.fields.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      isPrimary: f.isPrimary,
      options: f.config.options?.map((o) => o.name),
    })),
  };
}

export interface SearchRecordResult {
  fieldId: string;
  fieldName: string;
  fieldType: string;
  matches: {
    recordId: string;
    value: CellValue;
    displayValue: string;
  }[];
}

export function searchRecord(
  tableId: string,
  keyword: string,
  fieldId?: string,
  maxResults = 20
): SearchRecordResult[] {
  const t = tables.get(tableId);
  if (!t) return [];

  const lowerKeyword = keyword.toLowerCase();
  const results: SearchRecordResult[] = [];

  const fieldsToSearch = fieldId
    ? t.fields.filter((f) => f.id === fieldId)
    : t.fields;

  for (const field of fieldsToSearch) {
    const matches: SearchRecordResult["matches"] = [];

    for (const record of t.records) {
      const cellValue = record.cells[field.id];
      if (cellValue == null) continue;

      const displayValue = cellValueToString(cellValue, field, t);
      if (displayValue.toLowerCase().includes(lowerKeyword)) {
        // Deduplicate by display value
        if (!matches.some((m) => m.displayValue === displayValue)) {
          matches.push({
            recordId: record.id,
            value: cellValue,
            displayValue,
          });
        }
        if (matches.length >= maxResults) break;
      }
    }

    if (matches.length > 0) {
      results.push({
        fieldId: field.id,
        fieldName: field.name,
        fieldType: field.type,
        matches,
      });
    }
  }

  return results;
}

function cellValueToString(value: CellValue, field: Field, table: Table): string {
  if (value == null) return "";
  // User field (single value stored as string ID) — must check before generic string
  if (typeof value === "string" && (field.type === "User" || field.type === "CreatedUser" || field.type === "ModifiedUser")) {
    const users = field.config.users;
    if (users) {
      const user = users.find((u) => u.id === value);
      if (user) return `${user.name}(${user.id})`;
    }
    return value;
  }
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    // DateTime fields: format as date string
    if (field.type === "DateTime" || field.type === "CreatedTime" || field.type === "ModifiedTime") {
      return new Date(value).toISOString().slice(0, 10);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === "string") return v;
        if (typeof v === "object" && v !== null && "id" in v) {
          // User type: resolve name from config
          const userId = (v as { id: string }).id;
          const users = field.config.users;
          if (users) {
            const user = users.find((u) => u.id === userId);
            if (user) return `${user.name}(${user.id})`;
          }
          return userId;
        }
        return JSON.stringify(v);
      })
      .join(", ");
  }
  return String(value);
}
