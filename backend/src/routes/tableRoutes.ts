import { Router, Request, Response } from "express";
import * as store from "../services/dbStore.js";
import { filterRecords } from "../services/filterEngine.js";
import { sortRecords } from "../services/sortEngine.js";
import { queryView } from "../services/viewEngine.js";
import { validateCellValue } from "../services/fieldValidator.js";
import { validateLookupConfig } from "../services/lookupValidator.js";
import { Field, ViewFilter, ViewSort, LookupConfig, GeneratedField } from "../types.js";
import { eventBus } from "../services/eventBus.js";
import { warmupSuggestions, invalidateSuggestionCache } from "../services/fieldSuggestService.js";

function getClientId(req: Request): string {
  return (req.headers["x-client-id"] as string) || "unknown";
}

const router = Router();

// ═══════ Table CRUD ═══════

// GET /api/tables — list all tables
router.get("/", async (_req: Request, res: Response) => {
  const tables = await store.listTables();
  res.json(tables.map(t => ({
    id: t.id,
    name: t.name,
    fieldCount: t.fields.length,
    recordCount: t.records.length,
  })));
});

// POST /api/tables — create table
router.post("/", async (req: Request, res: Response) => {
  const { name, documentId, language } = req.body;
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "表名不能为空" });
    return;
  }
  const docId = documentId || "doc_default";
  const finalName = await store.generateTableName(docId, name);
  const table = await store.createTable({ name: finalName, documentId: docId, language });
  eventBus.emitDocumentChange({
    type: "table:create",
    documentId: docId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { table: { id: table.id, name: table.name, order: table.order } },
  });
  res.status(201).json({ id: table.id, name: table.name, order: table.order });
});

// PUT /api/tables/reorder — batch reorder tables (must be before /:tableId)
router.put("/reorder", async (req: Request, res: Response) => {
  const { updates, documentId } = req.body;
  if (!Array.isArray(updates)) {
    res.status(400).json({ error: "updates must be an array" });
    return;
  }
  await store.batchReorderTables(updates);
  eventBus.emitDocumentChange({
    type: "table:reorder",
    documentId: documentId || "doc_default",
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { updates },
  });
  res.json({ ok: true });
});

// DELETE /api/tables/:tableId
router.delete("/:tableId", async (req: Request, res: Response) => {
  const tableId = req.params.tableId;
  if (!(await store.deleteTable(tableId))) {
    res.status(404).json({ error: "Table not found" });
    return;
  }
  eventBus.emitDocumentChange({
    type: "table:delete",
    documentId: "doc_default",
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { tableId },
  });
  res.json({ ok: true });
});

// PUT /api/tables/:tableId — rename table
router.put("/:tableId", async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "表名不能为空" });
    return;
  }
  const table = await store.updateTable(req.params.tableId, { name: name.trim() });
  if (!table) { res.status(404).json({ error: "Table not found" }); return; }
  eventBus.emitChange({
    type: "table:update",
    tableId: req.params.tableId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { name: table.name },
  });
  res.json({ id: table.id, name: table.name });
});

// POST /api/tables/:tableId/reset — replace table structure with AI-generated fields
router.post("/:tableId/reset", async (req: Request, res: Response) => {
  const { fields: generatedFields, language } = req.body as { fields: GeneratedField[]; language?: "en" | "zh" };
  if (!Array.isArray(generatedFields) || generatedFields.length === 0) {
    res.status(400).json({ error: "fields must be a non-empty array" });
    return;
  }

  const result = await store.resetTableWithFields(req.params.tableId, generatedFields, language || "zh");
  if (!result) {
    res.status(404).json({ error: "Table not found" });
    return;
  }

  // Emit full-sync so connected clients reload
  eventBus.emitChange({
    type: "full-sync",
    tableId: req.params.tableId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: {},
  });

  res.json(result);
});

// ═══════ Field CRUD ═══════

// GET /api/tables/:tableId/fields
router.get("/:tableId/fields", async (req: Request, res: Response) => {
  const table = await store.getTable(req.params.tableId);
  if (!table) { res.status(404).json({ error: "Table not found" }); return; }
  // Fire-and-forget: warm up AI field suggestions cache for this table
  warmupSuggestions(req.params.tableId);
  res.json(table.fields);
});

// POST /api/tables/:tableId/fields — create field
router.post("/:tableId/fields", async (req: Request, res: Response) => {
  const { name, type, config } = req.body;
  if (!name || !type) {
    res.status(400).json({ error: "字段名和类型不能为空" });
    return;
  }
  if (type === "Lookup") {
    const tables = await store.listTables();
    const currentTable = tables.find(t => t.id === req.params.tableId) ?? null;
    const r = validateLookupConfig(
      (config as { lookup?: LookupConfig } | undefined)?.lookup,
      req.params.tableId,
      currentTable,
      tables,
      null,
    );
    if (!r.valid) {
      res.status(400).json({ error: "LOOKUP_CONFIG_INVALID", message: r.error, path: r.path });
      return;
    }
  }
  const field = await store.createField(req.params.tableId, { name, type, config });
  if (!field) { res.status(404).json({ error: "Table not found" }); return; }
  eventBus.emitChange({ type: "field:create", tableId: req.params.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { field } });
  invalidateSuggestionCache(req.params.tableId);
  res.status(201).json(field);
});

// PUT /api/tables/:tableId/fields/:fieldId — update field
router.put("/:tableId/fields/:fieldId", async (req: Request, res: Response) => {
  const { name, type, config } = req.body;
  // Re-validate if this field is a Lookup and config is being updated
  const existing = (await store.getTable(req.params.tableId))?.fields.find(f => f.id === req.params.fieldId);
  if (existing && existing.type === "Lookup" && config) {
    const tables = await store.listTables();
    const currentTable = tables.find(t => t.id === req.params.tableId) ?? null;
    const r = validateLookupConfig(
      (config as { lookup?: LookupConfig }).lookup,
      req.params.tableId,
      currentTable,
      tables,
      req.params.fieldId,
    );
    if (!r.valid) {
      res.status(400).json({ error: "LOOKUP_CONFIG_INVALID", message: r.error, path: r.path });
      return;
    }
  }
  const field = await store.updateField(req.params.tableId, req.params.fieldId, { name, type, config });
  if (!field) { res.status(404).json({ error: "Field not found" }); return; }
  eventBus.emitChange({ type: "field:update", tableId: req.params.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { fieldId: req.params.fieldId, changes: { name, type, config } } });
  invalidateSuggestionCache(req.params.tableId);
  res.json(field);
});

// DELETE /api/tables/:tableId/fields/:fieldId
router.delete("/:tableId/fields/:fieldId", async (req: Request, res: Response) => {
  if (!(await store.deleteField(req.params.tableId, req.params.fieldId))) {
    res.status(400).json({ error: "无法删除字段（可能是主字段或不存在）" });
    return;
  }
  eventBus.emitChange({ type: "field:delete", tableId: req.params.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { fieldId: req.params.fieldId } });
  invalidateSuggestionCache(req.params.tableId);
  res.json({ ok: true });
});

// POST /api/tables/:tableId/fields/batch-delete — batch delete fields (returns snapshot for undo)
router.post("/:tableId/fields/batch-delete", async (req: Request, res: Response) => {
  const { fieldIds } = req.body;
  if (!Array.isArray(fieldIds) || fieldIds.length === 0) {
    res.status(400).json({ error: "fieldIds must be a non-empty array" });
    return;
  }
  const snapshot = await store.batchDeleteFields(req.params.tableId, fieldIds);
  if (!snapshot) {
    res.status(400).json({ error: "No fields could be deleted (primary fields or not found)" });
    return;
  }
  eventBus.emitChange({ type: "field:batch-delete", tableId: req.params.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { fieldIds: snapshot.fieldDefs.map((f: any) => f.id) } });
  res.json({ deleted: snapshot.fieldDefs.length, snapshot });
});

// POST /api/tables/:tableId/fields/batch-restore — restore fields from snapshot (undo)
router.post("/:tableId/fields/batch-restore", async (req: Request, res: Response) => {
  const { snapshot } = req.body;
  if (!snapshot) {
    res.status(400).json({ error: "snapshot is required" });
    return;
  }
  const ok = await store.batchRestoreFields(req.params.tableId, snapshot);
  if (!ok) {
    res.status(400).json({ error: "Failed to restore fields" });
    return;
  }
  eventBus.emitChange({ type: "field:batch-restore", tableId: req.params.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { fields: snapshot.fieldDefs } });
  res.json({ ok: true });
});

// ═══════ Record CRUD ═══════

// GET /api/tables/:tableId/records
router.get("/:tableId/records", async (req: Request, res: Response) => {
  const table = await store.getTable(req.params.tableId);
  if (!table) { res.status(404).json({ error: "Table not found" }); return; }
  const hasLookup = table.fields.some(f => f.type === "Lookup");
  if (hasLookup) {
    const { materializeLookups } = await import("../services/lookupEngine.js");
    const allTables = await store.listTables();
    const { records } = materializeLookups(table, table.records, allTables);
    res.json(records);
    return;
  }
  res.json(table.records);
});

// GET /api/tables/:tableId/records/:recordId
router.get("/:tableId/records/:recordId", async (req: Request, res: Response) => {
  const record = await store.getRecord(req.params.tableId, req.params.recordId);
  if (!record) { res.status(404).json({ error: "Record not found" }); return; }
  res.json(record);
});

// POST /api/tables/:tableId/records — create record
router.post("/:tableId/records", async (req: Request, res: Response) => {
  const table = await store.getTable(req.params.tableId);
  if (!table) { res.status(404).json({ error: "Table not found" }); return; }

  const { cells } = req.body;
  if (!cells || typeof cells !== "object") {
    res.status(400).json({ error: "cells 不能为空" });
    return;
  }

  // Validate each cell value
  for (const [fieldId, value] of Object.entries(cells)) {
    const field = table.fields.find(f => f.id === fieldId);
    if (!field) continue;
    const result = validateCellValue(field, value as any);
    if (!result.valid) {
      res.status(400).json({ error: result.error });
      return;
    }
  }

  const record = await store.createRecord(req.params.tableId, { cells });
  if (!record) { res.status(500).json({ error: "创建记录失败" }); return; }
  eventBus.emitChange({ type: "record:create", tableId: req.params.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { record } });
  res.status(201).json(record);
});

// PUT /api/tables/:tableId/records/:recordId — update record
router.put("/:tableId/records/:recordId", async (req: Request, res: Response) => {
  const table = await store.getTable(req.params.tableId);
  if (!table) { res.status(404).json({ error: "Table not found" }); return; }

  const { cells } = req.body;
  if (!cells || typeof cells !== "object") {
    res.status(400).json({ error: "cells 不能为空" });
    return;
  }

  // Validate
  for (const [fieldId, value] of Object.entries(cells)) {
    const field = table.fields.find(f => f.id === fieldId);
    if (!field) continue;
    const result = validateCellValue(field, value as any);
    if (!result.valid) {
      res.status(400).json({ error: result.error });
      return;
    }
  }

  const record = await store.updateRecord(req.params.tableId, req.params.recordId, { cells });
  if (!record) { res.status(404).json({ error: "Record not found" }); return; }
  eventBus.emitChange({ type: "record:update", tableId: req.params.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { recordId: req.params.recordId, cells: req.body.cells, updatedAt: record.updatedAt } });
  res.json(record);
});

// DELETE /api/tables/:tableId/records/:recordId
router.delete("/:tableId/records/:recordId", async (req: Request, res: Response) => {
  if (!(await store.deleteRecord(req.params.tableId, req.params.recordId))) {
    res.status(404).json({ error: "Record not found" });
    return;
  }
  eventBus.emitChange({ type: "record:delete", tableId: req.params.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { recordId: req.params.recordId } });
  res.json({ ok: true });
});

// POST /api/tables/:tableId/records/batch-delete
router.post("/:tableId/records/batch-delete", async (req: Request, res: Response) => {
  const { recordIds } = req.body;
  if (!Array.isArray(recordIds)) {
    res.status(400).json({ error: "recordIds 必须是数组" });
    return;
  }
  const count = await store.batchDeleteRecords(req.params.tableId, recordIds);
  eventBus.emitChange({ type: "record:batch-delete", tableId: req.params.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { recordIds } });
  res.json({ deleted: count });
});

// POST /api/tables/:tableId/records/batch-create — restore records (for undo)
router.post("/:tableId/records/batch-create", async (req: Request, res: Response) => {
  const { records } = req.body;
  if (!Array.isArray(records)) {
    res.status(400).json({ error: "records must be an array" });
    return;
  }
  const count = await store.batchCreateRecords(req.params.tableId, records);
  eventBus.emitChange({ type: "record:batch-create", tableId: req.params.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { records } });
  res.json({ created: count });
});

// POST /api/tables/:tableId/records/query — filter/sort records
router.post("/:tableId/records/query", async (req: Request, res: Response) => {
  const table = await store.getTable(req.params.tableId);
  if (!table) { res.status(404).json({ error: "Table not found" }); return; }

  const filter: ViewFilter = req.body.filter ?? { logic: "and", conditions: [] };
  const sort: ViewSort | undefined = req.body.sort;
  const fieldMap = new Map<string, Field>(table.fields.map(f => [f.id, f]));

  let records = filterRecords(table.records, filter, fieldMap);
  if (sort && sort.rules.length > 0) {
    records = sortRecords(records, sort, fieldMap);
  }

  res.json({ records, total: records.length });
});

// ═══════ View CRUD ═══════

// GET /api/tables/:tableId/views
router.get("/:tableId/views", async (req: Request, res: Response) => {
  const table = await store.getTable(req.params.tableId);
  if (!table) { res.status(404).json({ error: "Table not found" }); return; }
  res.json(table.views);
});

// POST /api/tables/:tableId/views — create view
router.post("/:tableId/views", async (req: Request, res: Response) => {
  const { name, type, filter, sort, group, kanbanFieldId } = req.body;
  if (!name || !type) {
    res.status(400).json({ error: "视图名和类型不能为空" });
    return;
  }
  if (type !== "grid" && type !== "kanban") {
    res.status(400).json({ error: "仅支持表格视图(grid)和看板视图(kanban)" });
    return;
  }
  const view = await store.createView(req.params.tableId, { name, type, filter, sort, group, kanbanFieldId });
  if (!view) { res.status(400).json({ error: "创建视图失败" }); return; }
  eventBus.emitChange({ type: "view:create", tableId: req.params.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { view } });
  res.status(201).json(view);
});

// GET /api/tables/views/:viewId
router.get("/views/:viewId", async (req: Request, res: Response) => {
  const view = await store.getView(req.params.viewId);
  if (!view) { res.status(404).json({ error: "View not found" }); return; }
  res.json(view);
});

// PUT /api/tables/views/:viewId — update view
router.put("/views/:viewId", async (req: Request, res: Response) => {
  const { name, filter, sort, group, kanbanFieldId, fieldOrder, hiddenFields } = req.body;
  const view = await store.updateView(req.params.viewId, { name, filter, sort, group, kanbanFieldId, fieldOrder, hiddenFields });
  if (!view) { res.status(400).json({ error: "更新视图失败" }); return; }
  eventBus.emitChange({ type: "view:update", tableId: view.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { viewId: req.params.viewId, changes: { name, filter, sort, group, kanbanFieldId, fieldOrder, hiddenFields } } });
  res.json(view);
});

// PUT /api/tables/views/:viewId/filter — update view filter (backward compat)
router.put("/views/:viewId/filter", async (req: Request, res: Response) => {
  const view = await store.updateView(req.params.viewId, { filter: req.body });
  if (!view) { res.status(404).json({ error: "View not found" }); return; }
  eventBus.emitChange({ type: "view:update", tableId: view.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { viewId: req.params.viewId, changes: { filter: req.body } } });
  res.json(view);
});

// DELETE /api/tables/:tableId/views/:viewId
router.delete("/:tableId/views/:viewId", async (req: Request, res: Response) => {
  if (!(await store.deleteView(req.params.tableId, req.params.viewId))) {
    res.status(400).json({ error: "无法删除视图（至少保留一个视图）" });
    return;
  }
  eventBus.emitChange({ type: "view:delete", tableId: req.params.tableId, clientId: getClientId(req), timestamp: Date.now(), payload: { viewId: req.params.viewId } });
  res.json({ ok: true });
});

// POST /api/tables/:tableId/views/:viewId/query — query through view
router.post("/:tableId/views/:viewId/query", async (req: Request, res: Response) => {
  const table = await store.getTable(req.params.tableId);
  if (!table) { res.status(404).json({ error: "Table not found" }); return; }

  const view = await store.getView(req.params.viewId);
  if (!view) { res.status(404).json({ error: "View not found" }); return; }

  const fieldMap = new Map<string, Field>(table.fields.map(f => [f.id, f]));
  const hasLookup = table.fields.some(f => f.type === "Lookup");
  const allTables = hasLookup ? await store.listTables() : [];
  const result = queryView(
    table.records,
    view,
    fieldMap,
    hasLookup ? { currentTable: table, allTables } : undefined,
  );
  res.json(result);
});

export default router;
