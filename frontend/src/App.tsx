import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import ViewTabs from "./components/ViewTabs";
import Toolbar from "./components/Toolbar";
import TableView, { TableViewHandle } from "./components/TableView/index";
import FilterPanel from "./components/FilterPanel/index";
import FieldConfigPanel from "./components/FieldConfigPanel/index";
import "./App.css";
import { Field, TableRecord, View, ViewFilter } from "./types";
import { fetchFields, fetchRecords, fetchViews, updateViewFilter, updateView, deleteField, deleteRecords, batchCreateRecords, batchDeleteFields, batchRestoreFields, updateRecord, CLIENT_ID } from "./api";
import { useToast } from "./components/Toast/index";
import ConfirmDialog from "./components/ConfirmDialog/index";
import { filterRecords } from "./services/filterEngine";
import { useTableSync } from "./hooks/useTableSync";

const TABLE_ID = "tbl_requirements";

const MAX_UNDO = 20;
type CellValue = string | number | boolean | string[] | null;
type UndoItem =
  | { type: "records"; records: TableRecord[]; indices: number[] }
  | { type: "fields"; fieldDefs: Field[]; snapshot: any; removedConditions: ViewFilter["conditions"]; removedSavedConditions: ViewFilter["conditions"]; removedHiddenIds: string[]; fieldOrderBefore: string[] }
  | { type: "cellEdit"; recordId: string; fieldId: string; oldValue: CellValue; newValue: CellValue }
  | { type: "cellBatchClear"; changes: Array<{ recordId: string; fieldId: string; oldValue: CellValue }> };

export default function App() {
  const [fields, setFields] = useState<Field[]>([]);
  const [allRecords, setAllRecords] = useState<TableRecord[]>([]);
  const [views, setViews] = useState<View[]>([]);
  const [activeViewId, setActiveViewId] = useState("view_all");
  const [filter, setFilter] = useState<ViewFilter>({ logic: "and", conditions: [] });
  const [savedFilter, setSavedFilter] = useState<ViewFilter>({ logic: "and", conditions: [] });
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [fieldConfigOpen, setFieldConfigOpen] = useState(false);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);
  const customizeFieldBtnRef = useRef<HTMLButtonElement>(null);
  const tableViewRef = useRef<TableViewHandle>(null);

  // Delete protection & undo (document-level, persisted in localStorage)
  const DELETE_PROTECTION_KEY = "doc_delete_protection";
  const [deleteProtection, setDeleteProtectionRaw] = useState(() => {
    const stored = localStorage.getItem(DELETE_PROTECTION_KEY);
    return stored === null ? true : stored === "true";
  });
  const setDeleteProtection = useCallback((val: boolean | ((prev: boolean) => boolean)) => {
    setDeleteProtectionRaw(prev => {
      const next = typeof val === "function" ? val(prev) : val;
      localStorage.setItem(DELETE_PROTECTION_KEY, String(next));
      return next;
    });
  }, []);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    type: "records" | "fields" | "cells" | "rowCells";
    recordIds: string[];
    fieldIds: string[];
    cellsToClear: Array<{ recordId: string; fieldId: string }>;
  }>({ open: false, type: "records", recordIds: [], fieldIds: [], cellsToClear: [] });
  const undoStackRef = useRef<UndoItem[]>([]);
  const pushUndo = useCallback((item: UndoItem) => {
    undoStackRef.current.push(item);
    if (undoStackRef.current.length > MAX_UNDO) {
      undoStackRef.current.shift();
    }
    setCanUndo(true);
  }, []);
  const [canUndo, setCanUndo] = useState(false);
  const toast = useToast();

  // View-level field order & visibility
  const [viewFieldOrder, setViewFieldOrder] = useState<string[]>([]);
  const [viewHiddenFields, setViewHiddenFields] = useState<string[]>([]);

  // Close filter panel on outside click
  useEffect(() => {
    if (!filterPanelOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        filterPanelRef.current &&
        !filterPanelRef.current.contains(target) &&
        filterBtnRef.current &&
        !filterBtnRef.current.contains(target)
      ) {
        setFilterPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filterPanelOpen]);

  // Load initial data: fields, all records, views
  useEffect(() => {
    Promise.all([
      fetchFields(TABLE_ID),
      fetchRecords(TABLE_ID),
      fetchViews(TABLE_ID),
    ]).then(([f, r, v]) => {
      setFields(f);
      setAllRecords(r);
      setViews(v);
      // Store the initial saved filter from the active view
      const activeView = v.find(view => view.id === "view_all");
      if (activeView) {
        const viewFilter = activeView.filter ?? { logic: "and", conditions: [] };
        setSavedFilter(viewFilter);
        setFilter(viewFilter);
        // Initialize field order & hidden fields from view
        initFieldOrderFromView(activeView, f);
      }
    });
  }, []);

  // Initialize fieldOrder & hiddenFields from a view
  const initFieldOrderFromView = useCallback((view: View, fieldList: Field[]) => {
    const allFieldIds = fieldList.map(f => f.id);
    if (view.fieldOrder && view.fieldOrder.length > 0) {
      // Use view's fieldOrder, but sync: remove stale, append new
      const validIds = new Set(allFieldIds);
      const seen = new Set<string>();
      const cleaned = view.fieldOrder.filter(id => {
        if (!validIds.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      const newIds = allFieldIds.filter(id => !seen.has(id));
      setViewFieldOrder([...cleaned, ...newIds]);
    } else {
      setViewFieldOrder(allFieldIds);
    }
    setViewHiddenFields(view.hiddenFields ?? []);
  }, []);

  // Skip sync flag — set during undo to prevent useEffect from overriding restored fieldOrder
  const skipFieldSyncRef = useRef(false);

  // When fields change (add/delete), sync fieldOrder
  useEffect(() => {
    if (skipFieldSyncRef.current) {
      skipFieldSyncRef.current = false;
      return;
    }
    if (fields.length === 0 || viewFieldOrder.length === 0) return;
    const allFieldIds = new Set(fields.map(f => f.id));
    const seen = new Set<string>();
    const cleaned = viewFieldOrder.filter(id => {
      if (!allFieldIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const newIds = fields.filter(f => !seen.has(f.id)).map(f => f.id);
    const updated = [...cleaned, ...newIds];
    if (JSON.stringify(updated) !== JSON.stringify(viewFieldOrder)) {
      setViewFieldOrder(updated);
    }
    // Also clean hiddenFields
    const cleanedHidden = viewHiddenFields.filter(id => allFieldIds.has(id));
    if (JSON.stringify(cleanedHidden) !== JSON.stringify(viewHiddenFields)) {
      setViewHiddenFields(cleanedHidden);
    }
  }, [fields]);

  // Compute ordered fields lists
  const fieldMap = useMemo(() => {
    const m = new Map<string, Field>();
    for (const f of fields) m.set(f.id, f);
    return m;
  }, [fields]);

  // All fields in view order (including hidden)
  const allOrderedFields = useMemo(() => {
    return viewFieldOrder.map(id => fieldMap.get(id)).filter(Boolean) as Field[];
  }, [viewFieldOrder, fieldMap]);

  // Visible fields only (excluding hidden), in order
  const visibleOrderedFields = useMemo(() => {
    const hiddenSet = new Set(viewHiddenFields);
    return allOrderedFields.filter(f => !hiddenSet.has(f.id));
  }, [allOrderedFields, viewHiddenFields]);

  // Persist fieldOrder to backend
  const persistFieldOrder = useCallback(async (newOrder: string[]) => {
    try {
      await updateView(activeViewId, { fieldOrder: newOrder });
    } catch (err) {
      console.error("Failed to save field order:", err);
    }
  }, [activeViewId]);

  // Persist hiddenFields to backend
  const persistHiddenFields = useCallback(async (newHidden: string[]) => {
    try {
      await updateView(activeViewId, { hiddenFields: newHidden });
    } catch (err) {
      console.error("Failed to save hidden fields:", err);
    }
  }, [activeViewId]);

  // Handler: reorder fields (from FieldConfigPanel or TableView drag)
  const handleFieldOrderChange = useCallback((newOrder: string[]) => {
    setViewFieldOrder(newOrder);
    persistFieldOrder(newOrder);
  }, [persistFieldOrder]);

  // Handler: toggle a single field's visibility
  const handleToggleFieldVisibility = useCallback((fieldId: string) => {
    setViewHiddenFields(prev => {
      const next = prev.includes(fieldId)
        ? prev.filter(id => id !== fieldId)
        : [...prev, fieldId];
      persistHiddenFields(next);
      return next;
    });
  }, [persistHiddenFields]);

  // Handler: hide a field (from TableView context menu)
  const handleHideField = useCallback((fieldId: string) => {
    setViewHiddenFields(prev => {
      if (prev.includes(fieldId)) return prev;
      const next = [...prev, fieldId];
      persistHiddenFields(next);
      return next;
    });
  }, [persistHiddenFields]);

  // Handler: select and scroll to a field from FieldConfigPanel
  const handleSelectField = useCallback((fieldId: string) => {
    tableViewRef.current?.selectAndScrollToField(fieldId);
  }, []);

  // Pure client-side filtering — each user's filter is local, no server calls
  const displayRecords = useMemo(() => {
    if (filter.conditions.length === 0) return allRecords;
    return filterRecords(allRecords, filter, fields);
  }, [allRecords, filter, fields]);

  const handleFilterChange = useCallback((newFilter: ViewFilter) => {
    setFilter(newFilter);
  }, []);

  const handleClearFilter = useCallback(() => {
    setFilter(savedFilter);
  }, [savedFilter]);

  const handleSaveView = useCallback(async () => {
    try {
      await updateViewFilter(activeViewId, filter);
      setSavedFilter(filter);
    } catch (err) {
      console.error("Failed to save view:", err);
    }
  }, [activeViewId, filter]);

  const handleCellChange = useCallback((recordId: string, fieldId: string, value: string | number | boolean | string[] | null) => {
    // Capture old value for undo
    const record = allRecords.find(r => r.id === recordId);
    const oldValue = (record?.cells[fieldId] ?? null) as CellValue;
    // Skip if value unchanged
    if (oldValue === value) return;
    if (Array.isArray(oldValue) && Array.isArray(value) && JSON.stringify(oldValue) === JSON.stringify(value)) return;

    pushUndo({ type: "cellEdit", recordId, fieldId, oldValue, newValue: value });

    // Optimistic update
    setAllRecords((prev) =>
      prev.map((r) =>
        r.id === recordId ? { ...r, cells: { ...r.cells, [fieldId]: value } } : r
      )
    );
    // Persist to backend
    updateRecord(TABLE_ID, recordId, { [fieldId]: value })
      .catch(err => console.warn("Failed to persist cell change:", err));
  }, [allRecords, pushUndo]);

  // ── Undo helper (multi-step stack, max 20) ──
  const performUndo = useCallback(() => {
    const item = undoStackRef.current.pop();
    if (!item) return;

    if (item.type === "records") {
      // Restore records at original positions
      setAllRecords(prev => {
        const arr = [...prev];
        item.indices.forEach((idx, i) => {
          arr.splice(Math.min(idx, arr.length), 0, item.records[i]);
        });
        return arr;
      });
      batchCreateRecords(TABLE_ID, item.records.map(r => ({
        id: r.id,
        cells: r.cells as Record<string, any>,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }))).catch(err => console.warn("Failed to restore records:", err));
    } else if (item.type === "fields") {
      // Restore fields — skip the fieldOrder sync effect
      skipFieldSyncRef.current = true;
      setFields(prev => [...prev, ...item.fieldDefs]);
      // Incremental filter restore: add back removed conditions
      setFilter(prev => ({
        ...prev,
        conditions: [...prev.conditions, ...item.removedConditions],
      }));
      setSavedFilter(prev => ({
        ...prev,
        conditions: [...prev.conditions, ...item.removedSavedConditions],
      }));
      // Incremental hiddenFields restore: add back removed hidden ids
      setViewHiddenFields(prev => {
        const nextSet = new Set(prev);
        for (const id of item.removedHiddenIds) nextSet.add(id);
        return Array.from(nextSet);
      });
      // Full snapshot restore for fieldOrder
      setViewFieldOrder(item.fieldOrderBefore);
      persistFieldOrder(item.fieldOrderBefore);
      batchRestoreFields(TABLE_ID, item.snapshot)
        .catch(err => console.warn("Failed to restore fields:", err));
    } else if (item.type === "cellEdit") {
      // Restore cell to old value (skip if record no longer exists)
      setAllRecords(prev => {
        const exists = prev.some(r => r.id === item.recordId);
        if (!exists) return prev;
        return prev.map(r =>
          r.id === item.recordId
            ? { ...r, cells: { ...r.cells, [item.fieldId]: item.oldValue } }
            : r
        );
      });
      // Persist undo to backend
      updateRecord(TABLE_ID, item.recordId, { [item.fieldId]: item.oldValue })
        .catch(err => console.warn("Failed to persist cell undo:", err));
    } else if (item.type === "cellBatchClear") {
      // Restore all cleared cells to their old values
      const restoreMap = new Map<string, Record<string, any>>();
      setAllRecords(prev =>
        prev.map(r => {
          const cellChanges = item.changes.filter(c => c.recordId === r.id);
          if (cellChanges.length === 0) return r;
          const newCells = { ...r.cells };
          const restoreCells: Record<string, any> = {};
          for (const c of cellChanges) {
            newCells[c.fieldId] = c.oldValue;
            restoreCells[c.fieldId] = c.oldValue;
          }
          restoreMap.set(r.id, restoreCells);
          return { ...r, cells: newCells };
        })
      );
      // Persist undo to backend
      for (const [recordId, cells] of restoreMap) {
        updateRecord(TABLE_ID, recordId, cells)
          .catch(err => console.warn("Failed to persist batch cell undo:", err));
      }
    }

    setCanUndo(undoStackRef.current.length > 0);
  }, [persistFieldOrder]);

  // ── Ctrl+Z / ⌘+Z global undo shortcut ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        // Don't intercept when user is typing in an input/textarea (let browser native undo work)
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        performUndo();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [performUndo]);

  // ── Delete records ──
  const executeDelete = useCallback((recordIds: string[]) => {
    // Snapshot records and their indices for undo
    const idSet = new Set(recordIds);
    const snapRecords: TableRecord[] = [];
    const snapIndices: number[] = [];
    allRecords.forEach((r, i) => {
      if (idSet.has(r.id)) {
        snapRecords.push(r);
        snapIndices.push(i);
      }
    });
    pushUndo({ type: "records", records: snapRecords, indices: snapIndices });

    // Optimistic removal
    setAllRecords(prev => prev.filter(r => !idSet.has(r.id)));

    // API call
    deleteRecords(TABLE_ID, recordIds).catch(() => {
      // Revert on failure — pop the item we just pushed
      undoStackRef.current.pop();
      setCanUndo(undoStackRef.current.length > 0);
      setAllRecords(prev => {
        const arr = [...prev];
        snapIndices.forEach((idx, i) => arr.splice(idx, 0, snapRecords[i]));
        return arr;
      });
      toast.error("Failed to delete records");
    });

    // Toast with undo
    toast.success(
      `Deleted ${recordIds.length} record${recordIds.length > 1 ? "s" : ""}`,
      {
        duration: 5000,
        action: {
          label: "Undo",
          onClick: () => performUndo(),
        },
      }
    );
  }, [allRecords, toast, performUndo, pushUndo]);

  // ── Batch delete fields with undo ──
  const executeDeleteFields = useCallback(async (fieldIds: string[]) => {
    const fieldOrderBefore = [...viewFieldOrder];
    const deletedFieldDefs = fields.filter(f => fieldIds.includes(f.id));

    try {
      const result = await batchDeleteFields(TABLE_ID, fieldIds);
      const deletedIds = new Set(result.snapshot.fieldDefs.map((f: Field) => f.id));

      // Compute incremental data for undo
      const removedConditions = filter.conditions.filter(c => deletedIds.has(c.fieldId));
      const removedSavedConditions = savedFilter.conditions.filter(c => deletedIds.has(c.fieldId));
      const removedHiddenIds = viewHiddenFields.filter(id => deletedIds.has(id));

      pushUndo({
        type: "fields",
        fieldDefs: deletedFieldDefs.filter(f => deletedIds.has(f.id)),
        snapshot: result.snapshot,
        removedConditions,
        removedSavedConditions,
        removedHiddenIds,
        fieldOrderBefore,
      });

      setFields(prev => prev.filter(f => !deletedIds.has(f.id)));
      setFilter(prev => ({
        ...prev,
        conditions: prev.conditions.filter(c => !deletedIds.has(c.fieldId)),
      }));
      setSavedFilter(prev => ({
        ...prev,
        conditions: prev.conditions.filter(c => !deletedIds.has(c.fieldId)),
      }));

      const count = result.deleted;
      toast.success(
        `Deleted ${count} field${count > 1 ? "s" : ""}`,
        { duration: 5000, action: { label: "Undo", onClick: () => performUndo() } },
      );
    } catch (err) {
      console.error("Failed to delete fields:", err);
      toast.error((err as Error).message || "Failed to delete fields");
    }
  }, [fields, filter, savedFilter, viewHiddenFields, viewFieldOrder, toast, performUndo, pushUndo]);

  const handleDeleteFields = useCallback((fieldIds: string[]) => {
    if (deleteProtection) {
      setConfirmDialog({ open: true, type: "fields", recordIds: [], fieldIds, cellsToClear: [] });
    } else {
      executeDeleteFields(fieldIds);
    }
  }, [deleteProtection, executeDeleteFields]);

  // ── Batch hide fields ──
  const handleHideFields = useCallback((fieldIds: string[]) => {
    setViewHiddenFields(prev => {
      const nextSet = new Set(prev);
      for (const id of fieldIds) nextSet.add(id);
      const next = Array.from(nextSet);
      persistHiddenFields(next);
      return next;
    });
  }, [persistHiddenFields]);

  // Legacy single-field delete (keep for backward compat)
  const handleDeleteField = useCallback((fieldId: string) => {
    handleDeleteFields([fieldId]);
  }, [handleDeleteFields]);

  const handleDeleteRecords = useCallback((recordIds: string[]) => {
    if (deleteProtection) {
      setConfirmDialog({ open: true, type: "records", recordIds, fieldIds: [], cellsToClear: [] });
    } else {
      executeDelete(recordIds);
    }
  }, [deleteProtection, executeDelete]);

  // ── Batch clear cells (Delete key on selected cells) ──
  const executeClearCells = useCallback((cells: Array<{ recordId: string; fieldId: string }>, toastLabel?: string) => {
    const recordMap = new Map(allRecords.map(r => [r.id, r]));
    const changes: Array<{ recordId: string; fieldId: string; oldValue: CellValue }> = [];
    for (const cell of cells) {
      const record = recordMap.get(cell.recordId);
      const oldValue = (record?.cells[cell.fieldId] ?? null) as CellValue;
      if (oldValue !== null && oldValue !== "" && !(Array.isArray(oldValue) && oldValue.length === 0)) {
        changes.push({ recordId: cell.recordId, fieldId: cell.fieldId, oldValue });
      }
    }
    if (changes.length === 0) return;

    pushUndo({ type: "cellBatchClear", changes });

    // Group changes by recordId for optimistic update + backend persist
    const clearMap = new Map<string, Set<string>>();
    for (const c of changes) {
      if (!clearMap.has(c.recordId)) clearMap.set(c.recordId, new Set());
      clearMap.get(c.recordId)!.add(c.fieldId);
    }

    // Optimistic update
    setAllRecords(prev =>
      prev.map(r => {
        const fieldsToClear = clearMap.get(r.id);
        if (!fieldsToClear) return r;
        const newCells = { ...r.cells };
        for (const fId of fieldsToClear) newCells[fId] = null;
        return { ...r, cells: newCells };
      })
    );

    // Persist to backend (one call per record)
    for (const [recordId, fieldIds] of clearMap) {
      const nullCells: Record<string, null> = {};
      for (const fId of fieldIds) nullCells[fId] = null;
      updateRecord(TABLE_ID, recordId, nullCells)
        .catch(err => console.warn("Failed to persist cell clear:", err));
    }

    const msg = toastLabel ?? `Cleared ${changes.length} cell${changes.length > 1 ? "s" : ""}`;
    toast.success(msg, { duration: 5000, action: { label: "Undo", onClick: () => performUndo() } });
  }, [allRecords, pushUndo, toast, performUndo]);

  // Cell clearing (from cell range selection) always executes directly, undo is sufficient
  const handleClearCells = useCallback((cells: Array<{ recordId: string; fieldId: string }>) => {
    executeClearCells(cells);
  }, [executeClearCells]);

  // Row cell clearing (from checkbox selection + Delete key) goes through safety delete
  const handleClearRowCells = useCallback((cells: Array<{ recordId: string; fieldId: string }>) => {
    if (deleteProtection) {
      setConfirmDialog({ open: true, type: "rowCells", recordIds: [], fieldIds: [], cellsToClear: cells });
    } else {
      const rowCount = new Set(cells.map(c => c.recordId)).size;
      executeClearCells(cells, `Cleared ${rowCount} record${rowCount > 1 ? "s" : ""}`);
      tableViewRef.current?.clearRowSelection();
    }
  }, [deleteProtection, executeClearCells]);

  const handleConfirmDelete = useCallback(() => {
    const reset = { open: false, type: "records" as const, recordIds: [] as string[], fieldIds: [] as string[], cellsToClear: [] as Array<{ recordId: string; fieldId: string }> };
    if (confirmDialog.type === "records") {
      const ids = confirmDialog.recordIds;
      setConfirmDialog(reset);
      executeDelete(ids);
    } else if (confirmDialog.type === "fields") {
      const ids = confirmDialog.fieldIds;
      setConfirmDialog(reset);
      executeDeleteFields(ids);
    } else if (confirmDialog.type === "cells" || confirmDialog.type === "rowCells") {
      const isRowCells = confirmDialog.type === "rowCells";
      const cells = confirmDialog.cellsToClear;
      setConfirmDialog(reset);
      if (isRowCells) {
        const rowCount = new Set(cells.map(c => c.recordId)).size;
        executeClearCells(cells, `Cleared ${rowCount} record${rowCount > 1 ? "s" : ""}`);
        tableViewRef.current?.clearRowSelection();
      } else {
        executeClearCells(cells);
      }
    }
  }, [confirmDialog, executeDelete, executeDeleteFields, executeClearCells]);

  const isFiltered = filter.conditions.length > 0;

  // Dirty = local filter differs from the saved (backend) filter
  const isFilterDirty = useMemo(() => {
    return JSON.stringify(filter) !== JSON.stringify(savedFilter);
  }, [filter, savedFilter]);

  // ── Real-time sync: remote event handlers ──
  const handleRemoteRecordCreate = useCallback((record: TableRecord) => {
    setAllRecords(prev => prev.some(r => r.id === record.id) ? prev : [...prev, record]);
  }, []);

  const handleRemoteRecordUpdate = useCallback((recordId: string, cells: Record<string, any>, updatedAt: number) => {
    setAllRecords(prev => prev.map(r =>
      r.id === recordId ? { ...r, cells: { ...r.cells, ...cells }, updatedAt } : r
    ));
  }, []);

  const handleRemoteRecordDelete = useCallback((recordId: string) => {
    setAllRecords(prev => prev.filter(r => r.id !== recordId));
  }, []);

  const handleRemoteRecordBatchDelete = useCallback((recordIds: string[]) => {
    const idSet = new Set(recordIds);
    setAllRecords(prev => prev.filter(r => !idSet.has(r.id)));
  }, []);

  const handleRemoteRecordBatchCreate = useCallback((records: TableRecord[]) => {
    setAllRecords(prev => {
      const existingIds = new Set(prev.map(r => r.id));
      const newRecords = records.filter(r => !existingIds.has(r.id));
      return newRecords.length > 0 ? [...prev, ...newRecords] : prev;
    });
  }, []);

  const handleRemoteFieldCreate = useCallback((field: Field) => {
    setFields(prev => prev.some(f => f.id === field.id) ? prev : [...prev, field]);
    fetchRecords(TABLE_ID).then(records => setAllRecords(records));
  }, []);

  const handleRemoteFieldUpdate = useCallback((fieldId: string, changes: { name?: string; config?: any }) => {
    setFields(prev => prev.map(f => f.id === fieldId ? { ...f, ...changes } : f));
  }, []);

  const handleRemoteFieldDelete = useCallback((fieldId: string) => {
    setFields(prev => prev.filter(f => f.id !== fieldId));
    setFilter(prev => ({ ...prev, conditions: prev.conditions.filter(c => c.fieldId !== fieldId) }));
    setSavedFilter(prev => ({ ...prev, conditions: prev.conditions.filter(c => c.fieldId !== fieldId) }));
  }, []);

  const handleRemoteFieldBatchDelete = useCallback((fieldIds: string[]) => {
    const idSet = new Set(fieldIds);
    setFields(prev => prev.filter(f => !idSet.has(f.id)));
    setFilter(prev => ({ ...prev, conditions: prev.conditions.filter(c => !idSet.has(c.fieldId)) }));
    setSavedFilter(prev => ({ ...prev, conditions: prev.conditions.filter(c => !idSet.has(c.fieldId)) }));
  }, []);

  const handleRemoteFieldBatchRestore = useCallback((restoredFields: Field[]) => {
    setFields(prev => {
      const existingIds = new Set(prev.map(f => f.id));
      const newFields = restoredFields.filter(f => !existingIds.has(f.id));
      return newFields.length > 0 ? [...prev, ...newFields] : prev;
    });
    fetchRecords(TABLE_ID).then(records => setAllRecords(records));
  }, []);

  const handleRemoteViewUpdate = useCallback((viewId: string, changes: Partial<View>) => {
    setViews(prev => prev.map(v => v.id === viewId ? { ...v, ...changes } : v));
    if (viewId === activeViewId) {
      if (changes.fieldOrder) setViewFieldOrder(changes.fieldOrder);
      if (changes.hiddenFields) setViewHiddenFields(changes.hiddenFields);
    }
  }, [activeViewId]);

  const handleRemoteViewCreate = useCallback((view: View) => {
    setViews(prev => prev.some(v => v.id === view.id) ? prev : [...prev, view]);
  }, []);

  const handleRemoteViewDelete = useCallback((viewId: string) => {
    setViews(prev => prev.filter(v => v.id !== viewId));
  }, []);

  const handleFullSync = useCallback((syncFields: Field[], syncRecords: TableRecord[], syncViews: View[]) => {
    setFields(syncFields);
    setAllRecords(syncRecords);
    setViews(syncViews);
  }, []);

  useTableSync(TABLE_ID, CLIENT_ID, {
    onRecordCreate: handleRemoteRecordCreate,
    onRecordUpdate: handleRemoteRecordUpdate,
    onRecordDelete: handleRemoteRecordDelete,
    onRecordBatchDelete: handleRemoteRecordBatchDelete,
    onRecordBatchCreate: handleRemoteRecordBatchCreate,
    onFieldCreate: handleRemoteFieldCreate,
    onFieldUpdate: handleRemoteFieldUpdate,
    onFieldDelete: handleRemoteFieldDelete,
    onFieldBatchDelete: handleRemoteFieldBatchDelete,
    onFieldBatchRestore: handleRemoteFieldBatchRestore,
    onViewUpdate: handleRemoteViewUpdate,
    onViewCreate: handleRemoteViewCreate,
    onViewDelete: handleRemoteViewDelete,
    onFullSync: handleFullSync,
  });

  return (
    <div className="app">
      <TopBar
        tableName="需求管理表"
        deleteProtection={deleteProtection}
        onDeleteProtectionChange={setDeleteProtection}
      />
      <div className="app-body">
        <Sidebar />
        <div className="app-main">
          <ViewTabs
            views={views}
            activeViewId={activeViewId}
            onSelect={setActiveViewId}
            isFiltered={isFiltered}
            isFilterDirty={isFilterDirty}
            onSaveView={handleSaveView}
            onClearFilter={handleClearFilter}
          />
          <Toolbar
            isFiltered={isFiltered}
            filterConditionCount={filter.conditions.length}
            filterPanelOpen={filterPanelOpen}
            onFilterClick={() => setFilterPanelOpen((o) => !o)}
            onClearFilter={handleClearFilter}
            filterBtnRef={filterBtnRef}
            fieldConfigOpen={fieldConfigOpen}
            onCustomizeFieldClick={() => setFieldConfigOpen((o) => !o)}
            customizeFieldBtnRef={customizeFieldBtnRef}
            canUndo={canUndo}
            onUndo={performUndo}
          />
          <div className="app-content">
            <TableView
              ref={tableViewRef}
              fields={visibleOrderedFields}
              records={displayRecords}
              onCellChange={handleCellChange}
              onDeleteField={handleDeleteField}
              onDeleteFields={handleDeleteFields}
              onFieldOrderChange={handleFieldOrderChange}
              onHideField={handleHideField}
              onHideFields={handleHideFields}
              fieldOrder={viewFieldOrder}
              onDeleteRecords={handleDeleteRecords}
              onClearCells={handleClearCells}
              onClearRowCells={handleClearRowCells}
            />
            {filterPanelOpen && (
              <FilterPanel
                ref={filterPanelRef}
                tableId={TABLE_ID}
                fields={visibleOrderedFields}
                filter={filter}
                onFilterChange={handleFilterChange}
                onClose={() => setFilterPanelOpen(false)}
                anchorRef={filterBtnRef}
              />
            )}
            {fieldConfigOpen && (
              <FieldConfigPanel
                fields={allOrderedFields}
                hiddenFields={viewHiddenFields}
                onFieldOrderChange={handleFieldOrderChange}
                onToggleVisibility={handleToggleFieldVisibility}
                onSelectField={handleSelectField}
                onClose={() => setFieldConfigOpen(false)}
                anchorRef={customizeFieldBtnRef}
              />
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDialog.open}
        title={
          confirmDialog.type === "fields" ? "Delete Fields"
          : confirmDialog.type === "rowCells" ? "Clear Records"
          : confirmDialog.type === "cells" ? "Clear Cells"
          : "Delete Records"
        }
        message={
          confirmDialog.type === "fields"
            ? `Are you sure you want to delete ${confirmDialog.fieldIds.length} field${confirmDialog.fieldIds.length > 1 ? "s" : ""}? All data in ${confirmDialog.fieldIds.length > 1 ? "these fields" : "this field"} will be removed. This action can be undone.`
            : confirmDialog.type === "rowCells"
            ? (() => {
                const rowCount = new Set(confirmDialog.cellsToClear.map(c => c.recordId)).size;
                return `Are you sure you want to clear all cells of ${rowCount} record${rowCount > 1 ? "s" : ""}? This action can be undone.`;
              })()
            : confirmDialog.type === "cells"
            ? `Are you sure you want to clear ${confirmDialog.cellsToClear.length} cell${confirmDialog.cellsToClear.length > 1 ? "s" : ""}? This action can be undone.`
            : `Are you sure you want to delete ${confirmDialog.recordIds.length} record${confirmDialog.recordIds.length > 1 ? "s" : ""}? This action can be undone.`
        }
        confirmLabel={confirmDialog.type === "rowCells" || confirmDialog.type === "cells" ? "Clear" : "Delete"}
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDialog({ open: false, type: "records", recordIds: [], fieldIds: [], cellsToClear: [] })}
      />
    </div>
  );
}
