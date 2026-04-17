import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import ViewTabs from "./components/ViewTabs";
import Toolbar from "./components/Toolbar";
import TableView, { TableViewHandle } from "./components/TableView/index";
import FilterPanel from "./components/FilterPanel/index";
import FieldConfigPanel from "./components/FieldConfigPanel/index";
import { AddFieldPopover, useFieldSuggestions } from "./components/FieldConfig/AddFieldPopover";
import "./App.css";
import { Field, TableRecord, View, ViewFilter } from "./types";
import { fetchFields, fetchRecords, fetchViews, updateViewFilter, updateView, deleteField, deleteRecords, batchCreateRecords, batchDeleteFields, batchRestoreFields, updateRecord, renameTable, fetchDocument, renameDocument, fetchDocumentTables, createTable as apiCreateTable, reorderTables, deleteTable as apiDeleteTable, resetTable, CLIENT_ID } from "./api";
import type { GeneratedField } from "./api";
import type { SidebarItem } from "./components/Sidebar";
import { useToast } from "./components/Toast/index";
import { useTranslation } from "./i18n/index";
import ConfirmDialog from "./components/ConfirmDialog/index";
import { filterRecords } from "./services/filterEngine";
import { useTableSync } from "./hooks/useTableSync";
import { useDocumentSync } from "./hooks/useDocumentSync";

const DOCUMENT_ID = "doc_default";

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
  const [tableName, setTableName] = useState("需求管理表");
  const [documentName, setDocumentName] = useState("Default Document");
  const [activeTableId, setActiveTableId] = useState<string>("tbl_requirements");
  const activeTableIdRef = useRef(activeTableId);
  activeTableIdRef.current = activeTableId;
  const [documentTables, setDocumentTables] = useState<Array<{ id: string; name: string; order: number }>>([]);
  const SIDEBAR_NAMES_KEY = "sidebar_item_names";
  const [sidebarNames, setSidebarNames] = useState<Record<string, string>>(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_NAMES_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });
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
  const { t, locale } = useTranslation();
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

  // Load initial data: document tables list, then active table data
  useEffect(() => {
    const init = async () => {
      const [tables, doc] = await Promise.all([
        fetchDocumentTables(DOCUMENT_ID),
        fetchDocument(DOCUMENT_ID).catch(() => null),
      ]);
      setDocumentTables(tables);
      if (doc) setDocumentName(doc.name);

      // Determine which table to activate
      const lastActive = localStorage.getItem("lastActiveTableId");
      const targetId = tables.find(t => t.id === lastActive)?.id ?? tables[0]?.id;
      if (!targetId) return;

      setActiveTableId(targetId);
      const tbl = tables.find(t => t.id === targetId);
      if (tbl) setTableName(tbl.name);

      const [f, r, v] = await Promise.all([
        fetchFields(targetId),
        fetchRecords(targetId),
        fetchViews(targetId),
      ]);
      setFields(f);
      setAllRecords(r);
      setViews(v);

      const activeView = v[0];
      if (activeView) {
        setActiveViewId(activeView.id);
        const viewFilter = activeView.filter ?? { logic: "and", conditions: [] };
        setSavedFilter(viewFilter);
        setFilter(viewFilter);
        initFieldOrderFromView(activeView, f);
      }
    };
    init();
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
    updateRecord(activeTableIdRef.current, recordId, { [fieldId]: value })
      .catch(() => {
        // Rollback optimistic update
        setAllRecords(prev =>
          prev.map(r =>
            r.id === recordId
              ? { ...r, cells: { ...r.cells, [fieldId]: oldValue } }
              : r
          )
        );
        // Remove the undo entry we just pushed (it's the last one)
        undoStackRef.current.pop();
        setCanUndo(undoStackRef.current.length > 0);
        toast.error(t("toast.saveFailed"));
      });
  }, [allRecords, pushUndo, toast]);

  // ── Pending delete promise (prevents undo race condition) ──
  const deletePendingRef = useRef<Promise<any> | null>(null);

  // ── Undo helper (multi-step stack, max 20) ──
  const performUndo = useCallback(async () => {
    // Wait for any in-flight delete to finish before undoing
    if (deletePendingRef.current) {
      try { await deletePendingRef.current; } catch { /* already handled */ }
    }

    const item = undoStackRef.current.pop();
    if (!item) return;

    if (item.type === "records") {
      // Optimistic: restore records at original positions
      setAllRecords(prev => {
        const arr = [...prev];
        item.indices.forEach((idx, i) => {
          arr.splice(Math.min(idx, arr.length), 0, item.records[i]);
        });
        return arr;
      });
      try {
        await batchCreateRecords(activeTableIdRef.current, item.records.map(r => ({
          id: r.id,
          cells: r.cells as Record<string, any>,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })));
      } catch {
        // Rollback: remove the records we just restored
        const restoredIds = new Set(item.records.map(r => r.id));
        setAllRecords(prev => prev.filter(r => !restoredIds.has(r.id)));
        toast.error(t("toast.undoFailed"));
      }
    } else if (item.type === "fields") {
      // Optimistic: restore fields — skip the fieldOrder sync effect
      skipFieldSyncRef.current = true;
      setFields(prev => [...prev, ...item.fieldDefs]);
      setFilter(prev => ({
        ...prev,
        conditions: [...prev.conditions, ...item.removedConditions],
      }));
      setSavedFilter(prev => ({
        ...prev,
        conditions: [...prev.conditions, ...item.removedSavedConditions],
      }));
      setViewHiddenFields(prev => {
        const nextSet = new Set(prev);
        for (const id of item.removedHiddenIds) nextSet.add(id);
        return Array.from(nextSet);
      });
      setViewFieldOrder(item.fieldOrderBefore);
      persistFieldOrder(item.fieldOrderBefore);
      try {
        await batchRestoreFields(activeTableIdRef.current, item.snapshot);
      } catch {
        // Rollback: remove the fields we just restored
        const restoredIds = new Set(item.fieldDefs.map(f => f.id));
        skipFieldSyncRef.current = true;
        setFields(prev => prev.filter(f => !restoredIds.has(f.id)));
        setFilter(prev => ({
          ...prev,
          conditions: prev.conditions.filter(c => !restoredIds.has(c.fieldId)),
        }));
        setSavedFilter(prev => ({
          ...prev,
          conditions: prev.conditions.filter(c => !restoredIds.has(c.fieldId)),
        }));
        toast.error(t("toast.undoFailed"));
      }
    } else if (item.type === "cellEdit") {
      // Optimistic: restore cell to old value (skip if record no longer exists)
      setAllRecords(prev => {
        const exists = prev.some(r => r.id === item.recordId);
        if (!exists) return prev;
        return prev.map(r =>
          r.id === item.recordId
            ? { ...r, cells: { ...r.cells, [item.fieldId]: item.oldValue } }
            : r
        );
      });
      try {
        await updateRecord(activeTableIdRef.current, item.recordId, { [item.fieldId]: item.oldValue });
      } catch {
        // Rollback: revert to the newValue (what was before undo)
        setAllRecords(prev =>
          prev.map(r =>
            r.id === item.recordId
              ? { ...r, cells: { ...r.cells, [item.fieldId]: item.newValue } }
              : r
          )
        );
        toast.error(t("toast.undoFailed"));
      }
    } else if (item.type === "cellBatchClear") {
      // Optimistic: restore all cleared cells to their old values
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
      // Persist undo to backend — await all
      try {
        await Promise.all(
          Array.from(restoreMap).map(([recordId, cells]) =>
            updateRecord(activeTableIdRef.current, recordId, cells)
          )
        );
      } catch {
        // Rollback: re-clear the cells (set back to null)
        setAllRecords(prev =>
          prev.map(r => {
            const cellChanges = item.changes.filter(c => c.recordId === r.id);
            if (cellChanges.length === 0) return r;
            const newCells = { ...r.cells };
            for (const c of cellChanges) newCells[c.fieldId] = null;
            return { ...r, cells: newCells };
          })
        );
        toast.error(t("toast.undoFailed"));
      }
    }

    setCanUndo(undoStackRef.current.length > 0);
  }, [persistFieldOrder, toast]);

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

    // API call — store promise so undo can wait for it
    const deletePromise = deleteRecords(activeTableIdRef.current, recordIds).catch(() => {
      // Revert on failure — pop the item we just pushed
      undoStackRef.current.pop();
      setCanUndo(undoStackRef.current.length > 0);
      setAllRecords(prev => {
        const arr = [...prev];
        snapIndices.forEach((idx, i) => arr.splice(idx, 0, snapRecords[i]));
        return arr;
      });
      toast.error(t("toast.deleteFailed"));
    }).finally(() => {
      deletePendingRef.current = null;
    });
    deletePendingRef.current = deletePromise;

    // Toast with undo
    toast.success(
      t("toast.deletedRecords", { count: recordIds.length }),
      {
        duration: 5000,
        action: {
          label: t("toast.undo"),
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
      const result = await batchDeleteFields(activeTableIdRef.current, fieldIds);
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
        t("toast.deletedFields", { count }),
        { duration: 5000, action: { label: t("toast.undo"), onClick: () => performUndo() } },
      );
    } catch (err) {
      console.error("Failed to delete fields:", err);
      toast.error((err as Error).message || t("toast.failedDeleteFields"));
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
    const clearPromises: Promise<any>[] = [];
    for (const [recordId, fieldIds] of clearMap) {
      const nullCells: Record<string, null> = {};
      for (const fId of fieldIds) nullCells[fId] = null;
      clearPromises.push(updateRecord(activeTableIdRef.current, recordId, nullCells));
    }
    Promise.all(clearPromises).catch(() => {
      // Rollback: restore old values
      setAllRecords(prev =>
        prev.map(r => {
          const cellChanges = changes.filter(c => c.recordId === r.id);
          if (cellChanges.length === 0) return r;
          const newCells = { ...r.cells };
          for (const c of cellChanges) newCells[c.fieldId] = c.oldValue;
          return { ...r, cells: newCells };
        })
      );
      undoStackRef.current.pop();
      setCanUndo(undoStackRef.current.length > 0);
      toast.error(t("toast.clearFailed"));
    });

    const msg = toastLabel ?? t("toast.clearedCells", { count: changes.length });
    toast.success(msg, { duration: 5000, action: { label: t("toast.undo"), onClick: () => performUndo() } });
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
      executeClearCells(cells, t("toast.clearedRecords", { count: rowCount }));
      tableViewRef.current?.clearRowSelection();
    }
  }, [deleteProtection, executeClearCells, t]);

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
        executeClearCells(cells, t("toast.clearedRecords", { count: rowCount }));
        tableViewRef.current?.clearRowSelection();
      } else {
        executeClearCells(cells);
      }
    }
  }, [confirmDialog, executeDelete, executeDeleteFields, executeClearCells]);

  // Add-field popover state
  const [addFieldAnchor, setAddFieldAnchor] = useState<DOMRect | null>(null);
  const fieldSuggestions = useFieldSuggestions(activeTableId);

  // Edit-field popover state
  const [editFieldState, setEditFieldState] = useState<{ fieldId: string; anchorRect: DOMRect } | null>(null);

  const handleOpenAddField = useCallback((rect: DOMRect) => {
    setEditFieldState(null);
    setAddFieldAnchor(rect);
  }, []);

  const handleEditField = useCallback((fieldId: string, anchorRect: DOMRect) => {
    setAddFieldAnchor(null);
    setEditFieldState({ fieldId, anchorRect });
  }, []);

  const handleCreateFieldConfirm = useCallback(async (newField: Field) => {
    setFields((prev) => [...prev, newField]);
    const r = await fetchRecords(activeTableIdRef.current);
    setAllRecords(r);
    setAddFieldAnchor(null);
  }, []);

  const handleEditFieldConfirm = useCallback(async (updatedField: Field) => {
    const oldField = fields.find(f => f.id === updatedField.id);
    const typeChanged = oldField && oldField.type !== updatedField.type;
    setFields((prev) => prev.map(f => f.id === updatedField.id ? updatedField : f));
    if (typeChanged) {
      const r = await fetchRecords(activeTableIdRef.current);
      setAllRecords(r);
    }
    setEditFieldState(null);
  }, [fields]);

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
    fetchRecords(activeTableIdRef.current).then(records => setAllRecords(records));
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
    fetchRecords(activeTableIdRef.current).then(records => setAllRecords(records));
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

  const handleRemoteTableUpdate = useCallback((changes: { name?: string }) => {
    if (changes.name) {
      setTableName(changes.name);
      // Also update documentTables for sidebar
      setDocumentTables(prev => prev.map(t =>
        t.id === activeTableIdRef.current ? { ...t, name: changes.name! } : t
      ));
    }
  }, []);

  const handleRemoteDocumentUpdate = useCallback((changes: { documentId: string; name: string }) => {
    if (changes.documentId === DOCUMENT_ID && changes.name) {
      setDocumentName(changes.name);
    }
  }, []);

  const handleFullSync = useCallback((syncFields: Field[], syncRecords: TableRecord[], syncViews: View[]) => {
    setFields(syncFields);
    setAllRecords(syncRecords);
    setViews(syncViews);
  }, []);

  // ── Rename handlers ──

  const handleRenameSidebarItem = useCallback(async (itemId: string, newName: string) => {
    const isTable = documentTables.some(t => t.id === itemId);
    if (isTable) {
      const oldName = documentTables.find(t => t.id === itemId)?.name ?? "";
      // Optimistic update
      setDocumentTables(prev => prev.map(t => t.id === itemId ? { ...t, name: newName } : t));
      if (itemId === activeTableIdRef.current) setTableName(newName);
      try {
        await renameTable(itemId, newName);
      } catch {
        setDocumentTables(prev => prev.map(t => t.id === itemId ? { ...t, name: oldName } : t));
        if (itemId === activeTableIdRef.current) setTableName(oldName);
        toast.error(t("toast.renameFailed"));
      }
    } else {
      setSidebarNames(prev => {
        const next = { ...prev, [itemId]: newName };
        localStorage.setItem(SIDEBAR_NAMES_KEY, JSON.stringify(next));
        return next;
      });
    }
  }, [documentTables, toast, t]);

  const handleRenameDocument = useCallback(async (newName: string) => {
    const oldName = documentName;
    setDocumentName(newName);
    try {
      await renameDocument(DOCUMENT_ID, newName);
    } catch {
      setDocumentName(oldName);
      toast.error(t("toast.renameFailed"));
    }
  }, [documentName, toast, t]);

  const handleRenameView = useCallback(async (viewId: string, newName: string) => {
    setViews(prev => prev.map(v => v.id === viewId ? { ...v, name: newName } : v));
    try {
      await updateView(viewId, { name: newName });
    } catch {
      fetchViews(activeTableIdRef.current).then(setViews);
      toast.error(t("toast.renameFailed"));
    }
  }, [toast, t]);

  const sidebarItems: SidebarItem[] = useMemo(() => {
    const tableItems: SidebarItem[] = documentTables.map(tbl => ({
      id: tbl.id,
      type: "table" as const,
      displayName: tbl.id === activeTableId ? tableName : tbl.name,
      active: tbl.id === activeTableId,
      order: tbl.order,
    }));
    const staticItems: SidebarItem[] = [
      { id: "dashboard", type: "static" as const, displayName: sidebarNames.dashboard ?? t("sidebar.dashboard"), active: false, order: Infinity },
      { id: "workflow", type: "static" as const, displayName: sidebarNames.workflow ?? t("sidebar.workflow"), active: false, order: Infinity },
    ];
    return [...tableItems, ...staticItems];
  }, [documentTables, activeTableId, tableName, sidebarNames, t]);

  // ── Table switching ──
  const switchTable = useCallback(async (tableId: string) => {
    if (tableId === activeTableIdRef.current) return;
    undoStackRef.current = [];
    setCanUndo(false);
    setActiveTableId(tableId);
    const tbl = documentTables.find(t => t.id === tableId);
    if (tbl) setTableName(tbl.name);
    try {
      const [f, r, v] = await Promise.all([
        fetchFields(tableId),
        fetchRecords(tableId),
        fetchViews(tableId),
      ]);
      setFields(f);
      setAllRecords(r);
      setViews(v);
      const firstView = v[0];
      if (firstView) {
        setActiveViewId(firstView.id);
        const viewFilter = firstView.filter ?? { logic: "and", conditions: [] };
        setSavedFilter(viewFilter);
        setFilter(viewFilter);
        initFieldOrderFromView(firstView, f);
      }
    } catch (err) {
      console.error("Failed to load table:", err);
      toast.error(t("toast.createTableFailed"));
    }
  }, [documentTables, initFieldOrderFromView, toast, t]);

  // ── AI Create table (create + reset with AI-generated fields, returns tableId) ──
  const handleCreateWithAI = useCallback(async (aiTableName: string, generatedFields: GeneratedField[]): Promise<string> => {
    const result = await apiCreateTable(aiTableName, DOCUMENT_ID, locale as "en" | "zh");
    setDocumentTables(prev => [...prev, { id: result.id, name: result.name, order: result.order }]);
    await switchTable(result.id);
    setTableName(result.name);

    const resetResult = await resetTable(result.id, generatedFields, locale as "en" | "zh");
    setFields(resetResult.fields);
    setAllRecords(resetResult.records);
    setViews(resetResult.views);
    if (resetResult.views[0]) {
      setActiveViewId(resetResult.views[0].id);
      initFieldOrderFromView(resetResult.views[0], resetResult.fields);
    }
    return result.id;
  }, [locale, switchTable, initFieldOrderFromView]);

  // ── Reset to default: replace AI fields with a single Text column + 5 empty rows ──
  const handleResetToDefault = useCallback(async (tableId: string, _aiTableName: string): Promise<void> => {
    const defaultFieldName = locale === "zh" ? "\u6587\u672c" : "Text";
    const defaultFields: GeneratedField[] = [{ name: defaultFieldName, type: "Text", isPrimary: true }];
    const result = await resetTable(tableId, defaultFields, locale as "en" | "zh");
    setFields(result.fields);
    setAllRecords(result.records);
    setViews(result.views);
    if (result.views[0]) {
      setActiveViewId(result.views[0].id);
      initFieldOrderFromView(result.views[0], result.fields);
    }
  }, [locale, initFieldOrderFromView]);

  // ── Create blank table (1 Text column + 5 empty rows) ──
  const handleCreateBlankTable = useCallback(async (): Promise<void> => {
    const baseName = locale === "zh" ? "数据表" : "Table";
    const result = await apiCreateTable(baseName, DOCUMENT_ID, locale as "en" | "zh");
    setDocumentTables(prev => [...prev, { id: result.id, name: result.name, order: result.order }]);
    await switchTable(result.id);
    setTableName(result.name);
  }, [locale, switchTable]);

  // ── Reorder tables ──
  const handleReorderTables = useCallback(async (updates: Array<{ id: string; order: number }>) => {
    // Optimistic update
    setDocumentTables(prev => {
      const orderMap = new Map(updates.map(u => [u.id, u.order]));
      return prev.map(t => orderMap.has(t.id) ? { ...t, order: orderMap.get(t.id)! } : t)
                  .sort((a, b) => a.order - b.order);
    });
    try {
      await reorderTables(updates, DOCUMENT_ID);
    } catch {
      toast.error(t("toast.reorderFailed"));
      // Refetch on failure
      fetchDocumentTables(DOCUMENT_ID).then(setDocumentTables);
    }
  }, [toast, t]);

  // ── Delete table ──
  const handleDeleteTable = useCallback(async (tableId: string) => {
    // Don't allow deleting the last table
    if (documentTables.length <= 1) return;
    // Optimistic: remove from list
    setDocumentTables(prev => prev.filter(t => t.id !== tableId));
    // If deleting the active table, switch to the previous table (or next if first)
    if (tableId === activeTableIdRef.current) {
      const idx = documentTables.findIndex(t => t.id === tableId);
      const remaining = documentTables.filter(t => t.id !== tableId);
      if (remaining.length > 0) {
        const target = remaining[Math.max(0, idx - 1)];
        setActiveTableId(target.id);
        setTableName(target.name);
        try {
          const [f, r, v] = await Promise.all([fetchFields(target.id), fetchRecords(target.id), fetchViews(target.id)]);
          setFields(f); setAllRecords(r); setViews(v);
          if (v[0]) { setActiveViewId(v[0].id); setSavedFilter(v[0].filter ?? { logic: "and", conditions: [] }); setFilter(v[0].filter ?? { logic: "and", conditions: [] }); initFieldOrderFromView(v[0], f); }
        } catch { /* ignore, table switch will handle */ }
      }
    }
    try {
      await apiDeleteTable(tableId);
    } catch {
      toast.error(t("toast.deleteFailed"));
      fetchDocumentTables(DOCUMENT_ID).then(setDocumentTables);
    }
  }, [documentTables, initFieldOrderFromView, toast, t]);

  // ── Persist active table to localStorage ──
  useEffect(() => {
    if (activeTableId) localStorage.setItem("lastActiveTableId", activeTableId);
  }, [activeTableId]);

  // ── Document-level SSE for sidebar sync ──
  useDocumentSync(DOCUMENT_ID, CLIENT_ID, {
    onTableCreate: useCallback((table: { id: string; name: string; order: number }) => {
      setDocumentTables(prev =>
        prev.some(t => t.id === table.id) ? prev : [...prev, table].sort((a, b) => a.order - b.order)
      );
    }, []),
    onTableDelete: useCallback((tableId: string) => {
      setDocumentTables(prev => prev.filter(t => t.id !== tableId));
    }, []),
    onTableReorder: useCallback((updates: Array<{ id: string; order: number }>) => {
      setDocumentTables(prev => {
        const orderMap = new Map(updates.map(u => [u.id, u.order]));
        return prev.map(t => orderMap.has(t.id) ? { ...t, order: orderMap.get(t.id)! } : t)
                    .sort((a, b) => a.order - b.order);
      });
    }, []),
  });

  useTableSync(activeTableId, CLIENT_ID, {
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
    onTableUpdate: handleRemoteTableUpdate,
    onDocumentUpdate: handleRemoteDocumentUpdate,
    onFullSync: handleFullSync,
  });

  return (
    <div className="app">
      <TopBar
        tableName={tableName}
        documentName={documentName}
        deleteProtection={deleteProtection}
        onDeleteProtectionChange={setDeleteProtection}
        onRenameTable={(name) => handleRenameSidebarItem(activeTableId, name)}
        onRenameDocument={handleRenameDocument}
      />
      <div className="app-body">
        <Sidebar
          items={sidebarItems}
          onRenameItem={handleRenameSidebarItem}
          activeItemId={activeTableId}
          onSelectItem={(id: string) => {
            const isTable = documentTables.some(t => t.id === id);
            if (isTable) switchTable(id);
          }}
          onReorderTables={handleReorderTables}
          onDeleteTable={handleDeleteTable}
          tableCount={documentTables.length}
          onCreateWithAI={handleCreateWithAI}
          onResetToDefault={handleResetToDefault}
          onCreateBlank={handleCreateBlankTable}
        />
        <div className="app-main">
          <ViewTabs
            views={views}
            activeViewId={activeViewId}
            onSelect={setActiveViewId}
            isFiltered={isFiltered}
            isFilterDirty={isFilterDirty}
            onSaveView={handleSaveView}
            onClearFilter={handleClearFilter}
            onRenameView={handleRenameView}
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
              onAddField={handleOpenAddField}
              onEditField={handleEditField}
            />
            {filterPanelOpen && (
              <FilterPanel
                ref={filterPanelRef}
                tableId={activeTableId}
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
            {addFieldAnchor && (
              <AddFieldPopover
                currentTableId={activeTableIdRef.current}
                currentFields={fields}
                anchorRect={addFieldAnchor}
                onCancel={() => setAddFieldAnchor(null)}
                onConfirm={handleCreateFieldConfirm}
                fieldSuggestions={fieldSuggestions}
              />
            )}
            {editFieldState && (
              <AddFieldPopover
                key={editFieldState.fieldId}
                currentTableId={activeTableId}
                currentFields={fields}
                anchorRect={editFieldState.anchorRect}
                onCancel={() => setEditFieldState(null)}
                onConfirm={handleEditFieldConfirm}
                fieldSuggestions={fieldSuggestions}
                editingField={fields.find(f => f.id === editFieldState.fieldId)}
              />
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDialog.open}
        title={
          confirmDialog.type === "fields" ? t("app.deleteFields")
          : confirmDialog.type === "rowCells" ? t("app.clearRecords")
          : confirmDialog.type === "cells" ? t("app.clearCells")
          : t("app.deleteRecords")
        }
        message={
          confirmDialog.type === "fields"
            ? t("app.deleteFieldsMsg", { count: confirmDialog.fieldIds.length })
            : confirmDialog.type === "rowCells"
            ? (() => {
                const rowCount = new Set(confirmDialog.cellsToClear.map(c => c.recordId)).size;
                return t("app.clearRecordsMsg", { count: rowCount });
              })()
            : confirmDialog.type === "cells"
            ? t("app.clearCellsMsg", { count: confirmDialog.cellsToClear.length })
            : t("app.deleteRecordsMsg", { count: confirmDialog.recordIds.length })
        }
        confirmLabel={confirmDialog.type === "rowCells" || confirmDialog.type === "cells" ? t("confirm.clear") : t("confirm.delete")}
        cancelLabel={t("confirm.cancel")}
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDialog({ open: false, type: "records", recordIds: [], fieldIds: [], cellsToClear: [] })}
      />
    </div>
  );
}
