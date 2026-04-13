import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import {
  Table, Field, TableRecord, View, CellValue,
  CreateTableDTO, CreateFieldDTO, UpdateFieldDTO,
  CreateRecordDTO, UpdateRecordDTO,
  CreateViewDTO, UpdateViewDTO,
  ViewFilter, FieldType, FieldConfig,
  AutoNumberRule,
} from "../types.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Prisma lifecycle ───

export async function connectDB(): Promise<void> {
  await prisma.$connect();
}

export async function disconnectDB(): Promise<void> {
  await prisma.$disconnect();
}

// ─── Helpers ───

function sanitizeName(name: string): string {
  return name.replace(/\[\*/g, "").replace(/\*\]/g, "").slice(0, 100);
}

function isReadOnly(type: FieldType): boolean {
  return ["AutoNumber", "CreatedUser", "ModifiedUser", "CreatedTime", "ModifiedTime", "Formula", "Lookup"].includes(type);
}

function formatAutoNumber(counter: number, rules: AutoNumberRule[]): string {
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
          yyyyMMdd: `${y}${m}${d}`, yyyyMM: `${y}${m}`, yyMM: `${y.slice(2)}${m}`,
          MMdd: `${m}${d}`, MM: m, dd: d,
        };
        return fmtMap[rule.format] ?? "";
      }
    }
  }).join("");
}

function getDefaultCellValue(
  field: Field,
  counters: Record<string, number>,
  record: TableRecord,
): CellValue {
  switch (field.type) {
    case "AutoNumber": {
      const counter = (counters[field.id] ?? 0) + 1;
      counters[field.id] = counter;
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

// ─── Convert DB row → app Table ───

function toRecord(row: { id: string; tableId: string; cells: unknown; createdAt: Date; updatedAt: Date; createdBy: string | null; modifiedBy: string | null }): TableRecord {
  return {
    id: row.id,
    tableId: row.tableId,
    cells: (row.cells ?? {}) as Record<string, CellValue>,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    createdBy: row.createdBy ?? undefined,
    modifiedBy: row.modifiedBy ?? undefined,
  };
}

function toTable(row: { id: string; name: string; fields: unknown; views: unknown; autoNumberCounters: unknown }, records: TableRecord[]): Table {
  return {
    id: row.id,
    name: row.name,
    fields: (row.fields ?? []) as Field[],
    records,
    views: (row.views ?? []) as View[],
    autoNumberCounters: (row.autoNumberCounters ?? {}) as Record<string, number>,
  };
}

// ─── Table ───

export async function listTables(): Promise<Table[]> {
  const rows = await prisma.table.findMany();
  const result: Table[] = [];
  for (const row of rows) {
    const records = await prisma.record.findMany({ where: { tableId: row.id }, orderBy: { createdAt: "asc" } });
    result.push(toTable(row, records.map(toRecord)));
  }
  return result;
}

export async function getTable(id: string): Promise<Table | undefined> {
  const row = await prisma.table.findUnique({ where: { id } });
  if (!row) return undefined;
  const records = await prisma.record.findMany({ where: { tableId: id }, orderBy: { createdAt: "asc" } });
  return toTable(row, records.map(toRecord));
}

export async function createTable(dto: CreateTableDTO): Promise<Table> {
  const defaultView: View = {
    id: `viw_${Date.now().toString(36)}`,
    tableId: "", // will be set after creation
    name: "Grid",
    type: "grid",
    filter: { logic: "and", conditions: [] },
  };
  const row = await prisma.table.create({
    data: {
      name: sanitizeName(dto.name),
      documentId: DEFAULT_DOCUMENT_ID,
      fields: [],
      views: [defaultView],
      autoNumberCounters: {},
    },
  });
  // Update view tableId
  defaultView.tableId = row.id;
  await prisma.table.update({ where: { id: row.id }, data: { views: [defaultView] as any } });
  return toTable({ ...row, views: [defaultView] as any }, []);
}

export async function deleteTable(id: string): Promise<boolean> {
  try {
    await prisma.table.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

// ─── Field ───

export async function getFields(tableId: string): Promise<Field[]> {
  const row = await prisma.table.findUnique({ where: { id: tableId } });
  return row ? (row.fields as Field[]) : [];
}

export async function getField(tableId: string, fieldId: string): Promise<Field | undefined> {
  const fields = await getFields(tableId);
  return fields.find(f => f.id === fieldId);
}

export async function createField(tableId: string, dto: CreateFieldDTO): Promise<Field | null> {
  const row = await prisma.table.findUnique({ where: { id: tableId } });
  if (!row) return null;

  const fields = (row.fields ?? []) as Field[];
  const counters = (row.autoNumberCounters ?? {}) as Record<string, number>;

  const field: Field = {
    id: `fld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    tableId,
    name: dto.name.slice(0, 100),
    type: dto.type,
    isPrimary: fields.length === 0,
    config: dto.config ?? {},
  };

  fields.push(field);

  if (dto.type === "AutoNumber") {
    counters[field.id] = 0;
  }

  // Initialize cells for existing records
  const records = await prisma.record.findMany({ where: { tableId } });
  for (const rec of records) {
    const cells = (rec.cells ?? {}) as Record<string, CellValue>;
    const appRec = toRecord(rec);
    cells[field.id] = getDefaultCellValue(field, counters, appRec);
    await prisma.record.update({ where: { id: rec.id }, data: { cells: cells as any } });
  }

  // Append new field to all views' fieldOrder
  const views = (row.views ?? []) as View[];
  for (const view of views) {
    if (view.fieldOrder) {
      view.fieldOrder.push(field.id);
    }
  }

  await prisma.table.update({
    where: { id: tableId },
    data: { fields: fields as any, views: views as any, autoNumberCounters: counters as any },
  });

  return field;
}

export async function updateField(tableId: string, fieldId: string, dto: UpdateFieldDTO): Promise<Field | null> {
  const row = await prisma.table.findUnique({ where: { id: tableId } });
  if (!row) return null;

  const fields = (row.fields ?? []) as Field[];
  const field = fields.find(f => f.id === fieldId);
  if (!field) return null;

  if (dto.name !== undefined) field.name = dto.name.slice(0, 100);
  if (dto.config !== undefined) field.config = { ...field.config, ...dto.config };

  await prisma.table.update({ where: { id: tableId }, data: { fields: fields as any } });
  return field;
}

export async function deleteField(tableId: string, fieldId: string): Promise<boolean> {
  const row = await prisma.table.findUnique({ where: { id: tableId } });
  if (!row) return false;

  const fields = (row.fields ?? []) as Field[];
  const idx = fields.findIndex(f => f.id === fieldId);
  if (idx === -1) return false;
  if (fields[idx].isPrimary) return false;

  fields.splice(idx, 1);

  // Remove from views' filters/sorts/fieldOrder/hiddenFields
  const views = (row.views ?? []) as View[];
  for (const view of views) {
    view.filter.conditions = view.filter.conditions.filter(c => c.fieldId !== fieldId);
    if (view.sort) {
      view.sort.rules = view.sort.rules.filter(r => r.fieldId !== fieldId);
    }
    if (view.group) {
      view.group.rules = view.group.rules.filter(r => r.fieldId !== fieldId);
    }
    if (view.fieldOrder) {
      view.fieldOrder = view.fieldOrder.filter(id => id !== fieldId);
    }
    if (view.hiddenFields) {
      view.hiddenFields = view.hiddenFields.filter(id => id !== fieldId);
    }
  }

  // Remove from auto number counters
  const counters = (row.autoNumberCounters ?? {}) as Record<string, number>;
  delete counters[fieldId];

  await prisma.table.update({
    where: { id: tableId },
    data: { fields: fields as any, views: views as any, autoNumberCounters: counters as any },
  });

  // Remove from records' cells
  const records = await prisma.record.findMany({ where: { tableId } });
  for (const rec of records) {
    const cells = (rec.cells ?? {}) as Record<string, CellValue>;
    if (fieldId in cells) {
      delete cells[fieldId];
      await prisma.record.update({ where: { id: rec.id }, data: { cells: cells as any } });
    }
  }

  return true;
}

// ─── Record ───

export async function getRecords(tableId: string): Promise<TableRecord[]> {
  const rows = await prisma.record.findMany({ where: { tableId }, orderBy: { createdAt: "asc" } });
  return rows.map(toRecord);
}

export async function getRecord(tableId: string, recordId: string): Promise<TableRecord | undefined> {
  const row = await prisma.record.findFirst({ where: { id: recordId, tableId } });
  return row ? toRecord(row) : undefined;
}

export async function createRecord(tableId: string, dto: CreateRecordDTO, userId?: string): Promise<TableRecord | null> {
  const tableRow = await prisma.table.findUnique({ where: { id: tableId } });
  if (!tableRow) return null;

  const fields = (tableRow.fields ?? []) as Field[];
  const counters = (tableRow.autoNumberCounters ?? {}) as Record<string, number>;
  const now = new Date();
  const nowMs = now.getTime();
  const cells: Record<string, CellValue> = {};

  const tempRecord: TableRecord = {
    id: "", tableId, cells: {},
    createdAt: nowMs, updatedAt: nowMs,
    createdBy: userId, modifiedBy: userId,
  };

  for (const field of fields) {
    if (dto.cells[field.id] !== undefined) {
      cells[field.id] = dto.cells[field.id];
    } else {
      cells[field.id] = getDefaultCellValue(field, counters, tempRecord);
    }
  }

  // Persist updated auto number counters
  const hasAutoNumber = fields.some(f => f.type === "AutoNumber");
  if (hasAutoNumber) {
    await prisma.table.update({ where: { id: tableId }, data: { autoNumberCounters: counters as any } });
  }

  const row = await prisma.record.create({
    data: {
      tableId,
      cells: cells as any,
      createdAt: now,
      updatedAt: now,
      createdBy: userId ?? null,
      modifiedBy: userId ?? null,
    },
  });

  return toRecord(row);
}

export async function updateRecord(tableId: string, recordId: string, dto: UpdateRecordDTO, userId?: string): Promise<TableRecord | null> {
  const existing = await prisma.record.findFirst({ where: { id: recordId, tableId } });
  if (!existing) return null;

  const tableRow = await prisma.table.findUnique({ where: { id: tableId } });
  const fields = tableRow ? (tableRow.fields as Field[]) : [];
  const cells = (existing.cells ?? {}) as Record<string, CellValue>;
  const now = new Date();

  for (const [fieldId, value] of Object.entries(dto.cells)) {
    const field = fields.find(f => f.id === fieldId);
    if (!field) continue;
    if (isReadOnly(field.type)) continue;
    cells[fieldId] = value;
  }

  for (const field of fields) {
    if (field.type === "ModifiedTime") cells[field.id] = now.getTime();
    if (field.type === "ModifiedUser") cells[field.id] = userId ?? null;
  }

  const row = await prisma.record.update({
    where: { id: recordId },
    data: { cells: cells as any, updatedAt: now, modifiedBy: userId ?? null },
  });

  return toRecord(row);
}

export async function deleteRecord(tableId: string, recordId: string): Promise<boolean> {
  const result = await prisma.record.deleteMany({ where: { id: recordId, tableId } });
  return result.count > 0;
}

export async function batchDeleteRecords(tableId: string, recordIds: string[]): Promise<number> {
  const result = await prisma.record.deleteMany({
    where: { tableId, id: { in: recordIds } },
  });
  return result.count;
}

// ─── View ───

export async function getViews(tableId: string): Promise<View[]> {
  const row = await prisma.table.findUnique({ where: { id: tableId } });
  return row ? (row.views as View[]) : [];
}

export async function getView(viewId: string): Promise<View | undefined> {
  const tables = await prisma.table.findMany();
  for (const t of tables) {
    const views = (t.views ?? []) as View[];
    const v = views.find(v => v.id === viewId);
    if (v) return v;
  }
  return undefined;
}

export async function createView(tableId: string, dto: CreateViewDTO): Promise<View | null> {
  const row = await prisma.table.findUnique({ where: { id: tableId } });
  if (!row) return null;

  const name = sanitizeName(dto.name);
  if (name.length < 1 || name.length > 100) return null;
  if (dto.type !== "grid" && dto.type !== "kanban") return null;
  if (dto.group && dto.group.rules.length > 3) return null;

  const views = (row.views ?? []) as View[];
  const fields = (row.fields ?? []) as Field[];
  const view: View = {
    id: `viw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    tableId,
    name,
    type: dto.type,
    filter: dto.filter ?? { logic: "and", conditions: [] },
    sort: dto.sort,
    group: dto.group,
    kanbanFieldId: dto.kanbanFieldId,
    fieldOrder: fields.map(f => f.id),  // 默认按 fields 数组顺序
    hiddenFields: [],
  };

  views.push(view);
  await prisma.table.update({ where: { id: tableId }, data: { views: views as any } });
  return view;
}

export async function updateView(viewId: string, dto: UpdateViewDTO): Promise<View | null> {
  const tables = await prisma.table.findMany();
  for (const t of tables) {
    const views = (t.views ?? []) as View[];
    const view = views.find(v => v.id === viewId);
    if (!view) continue;

    if (dto.name !== undefined) {
      const name = sanitizeName(dto.name);
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
    if (dto.fieldOrder !== undefined) view.fieldOrder = dto.fieldOrder;
    if (dto.hiddenFields !== undefined) view.hiddenFields = dto.hiddenFields;

    await prisma.table.update({ where: { id: t.id }, data: { views: views as any } });
    return view;
  }
  return null;
}

export async function deleteView(tableId: string, viewId: string): Promise<boolean> {
  const row = await prisma.table.findUnique({ where: { id: tableId } });
  if (!row) return false;

  const views = (row.views ?? []) as View[];
  if (views.length <= 1) return false;

  const idx = views.findIndex(v => v.id === viewId);
  if (idx === -1) return false;

  views.splice(idx, 1);
  await prisma.table.update({ where: { id: tableId }, data: { views: views as any } });
  return true;
}

// ─── Initialization ───

export async function loadTable(table: Table): Promise<void> {
  await ensureDefaults();

  await prisma.table.upsert({
    where: { id: table.id },
    update: {
      name: table.name,
      fields: table.fields as any,
      views: table.views as any,
      autoNumberCounters: table.autoNumberCounters as any,
    },
    create: {
      id: table.id,
      documentId: DEFAULT_DOCUMENT_ID,
      name: table.name,
      fields: table.fields as any,
      views: table.views as any,
      autoNumberCounters: table.autoNumberCounters as any,
    },
  });

  for (const r of table.records) {
    await prisma.record.upsert({
      where: { id: r.id },
      update: { cells: r.cells as any, updatedAt: new Date(r.updatedAt), createdBy: r.createdBy ?? null, modifiedBy: r.modifiedBy ?? null },
      create: {
        id: r.id,
        tableId: table.id,
        cells: r.cells as any,
        createdAt: new Date(r.createdAt),
        updatedAt: new Date(r.updatedAt),
        createdBy: r.createdBy ?? null,
        modifiedBy: r.modifiedBy ?? null,
      },
    });
  }
}

export async function clearAll(): Promise<void> {
  await prisma.record.deleteMany();
  await prisma.table.deleteMany();
  await prisma.document.deleteMany();
  await prisma.workspaceMember.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
}

// ─── Default scaffold ───

const DEFAULT_USER_ID = "user_default";
const DEFAULT_WORKSPACE_ID = "ws_default";
const DEFAULT_DOCUMENT_ID = "doc_default";

let defaultsEnsured = false;

async function ensureDefaults(): Promise<void> {
  if (defaultsEnsured) return;

  await prisma.user.upsert({
    where: { id: DEFAULT_USER_ID },
    update: {},
    create: { id: DEFAULT_USER_ID, email: "default@local", name: "Default User" },
  });

  await prisma.workspace.upsert({
    where: { id: DEFAULT_WORKSPACE_ID },
    update: {},
    create: { id: DEFAULT_WORKSPACE_ID, name: "Default Workspace" },
  });

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_USER_ID } },
    update: {},
    create: { workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_USER_ID, role: "owner" },
  });

  await prisma.document.upsert({
    where: { id: DEFAULT_DOCUMENT_ID },
    update: {},
    create: {
      id: DEFAULT_DOCUMENT_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      createdById: DEFAULT_USER_ID,
      name: "Default Document",
    },
  });

  defaultsEnsured = true;
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

export async function getTableBriefInfo(tableId: string): Promise<TableBriefInfo | null> {
  const table = await getTable(tableId);
  if (!table) return null;

  return {
    tableId: table.id,
    tableName: table.name,
    recordCount: table.records.length,
    fields: table.fields.map((f) => ({
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

export async function searchRecord(
  tableId: string,
  keyword: string,
  fieldId?: string,
  maxResults = 20,
): Promise<SearchRecordResult[]> {
  const table = await getTable(tableId);
  if (!table) return [];

  const lowerKeyword = keyword.toLowerCase();
  const results: SearchRecordResult[] = [];

  const fieldsToSearch = fieldId
    ? table.fields.filter((f) => f.id === fieldId)
    : table.fields;

  for (const field of fieldsToSearch) {
    const matches: SearchRecordResult["matches"] = [];

    for (const record of table.records) {
      const cellValue = record.cells[field.id];
      if (cellValue == null) continue;

      const displayValue = cellValueToString(cellValue, field, table);
      if (displayValue.toLowerCase().includes(lowerKeyword)) {
        if (!matches.some((m) => m.displayValue === displayValue)) {
          matches.push({ recordId: record.id, value: cellValue, displayValue });
        }
        if (matches.length >= maxResults) break;
      }
    }

    if (matches.length > 0) {
      results.push({ fieldId: field.id, fieldName: field.name, fieldType: field.type, matches });
    }
  }

  return results;
}

function cellValueToString(value: CellValue, field: Field, table: Table): string {
  if (value == null) return "";
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
    if (field.type === "DateTime" || field.type === "CreatedTime" || field.type === "ModifiedTime") {
      return new Date(value).toISOString().slice(0, 10);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === "string") return v;
      if (typeof v === "object" && v !== null && "id" in v) {
        const userId = (v as { id: string }).id;
        const users = field.config.users;
        if (users) {
          const user = users.find((u) => u.id === userId);
          if (user) return `${user.name}(${user.id})`;
        }
        return userId;
      }
      return JSON.stringify(v);
    }).join(", ");
  }
  return String(value);
}
