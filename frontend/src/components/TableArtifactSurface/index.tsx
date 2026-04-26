/**
 * TableArtifactSurface —— per-block 自包含的"表格视图"组件。
 *
 * 等同于 idea/design/demo 那样:接收一个 id (tableId) + workspaceId,内部
 * 自管 fetch / state / 编辑 / 撤销 / SSE 同步,渲染 Toolbar + TableView +
 * Filter / FieldConfig / AddField popovers。
 *
 * 多个实例(多个 artifact block 同时显示不同 tableId,或同 tableId)互不干扰:
 *   - 各自独立 fields / records / views / filter / undo / editing state
 *   - 各自 useTableSync(tableId) 订阅,SSE 远程变更各自处理
 *   - 实例间通过 eventBus 广播 + 本地 state 互不影响
 *
 * 已知限制:
 *   - 删除保护 + ConfirmDialog 在 component 内部本地一份(与全局 deleteProtection
 *     偏好同步,从 localStorage 读)。
 *
 * 多实例独立性:
 *   - 每个实例 mount 时生成独立的 instanceClientId(`useMemo` 一次)。
 *   - 所有 mutation 通过 `withClientId(instanceClientId, () => api(...))` 同步注入,
 *     使 backend 回放的 SSE event.clientId 各 block 不同。
 *   - useTableSync 也用 instanceClientId 订阅,既能跳过自己的回声又能收到其它
 *     block 的事件。
 *   - 所以 N 个 block 同时打开同一张 table 时,任何一个 block 的编辑/新增/
 *     删除/字段操作都会通过 SSE 推送给其它同表 block 实时更新,无需刷新。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Field, TableRecord, View, ViewFilter } from "../../types";
import {
  fetchFields,
  fetchRecords,
  fetchViews,
  updateViewFilter,
  updateView,
  deleteRecords,
  batchCreateRecords,
  batchDeleteFields,
  batchRestoreFields,
  updateRecord,
  createRecord,
  withClientId,
} from "../../api";
import { useToast } from "../Toast/index";
import { useTranslation } from "../../i18n/index";
import { filterRecords } from "../../services/filterEngine";
import { useTableSync } from "../../hooks/useTableSync";
import Toolbar from "../Toolbar";
import TableView, { type TableViewHandle } from "../TableView/index";
import FilterPanel from "../FilterPanel/index";
import FieldConfigPanel from "../FieldConfigPanel/index";
import { AddFieldPopover, useFieldSuggestions } from "../FieldConfig/AddFieldPopover";
import ConfirmDialog from "../ConfirmDialog/index";
import { useWorkspace } from "../../contexts/workspaceContext";

const MAX_UNDO = 20;
const DELETE_PROTECTION_KEY = "doc_delete_protection";

type CellValue = string | number | boolean | string[] | null;
type UndoItem =
  | { type: "records"; records: TableRecord[]; indices: number[] }
  | { type: "fields"; fieldDefs: Field[]; snapshot: any; removedConditions: ViewFilter["conditions"]; removedSavedConditions: ViewFilter["conditions"]; removedHiddenIds: string[]; fieldOrderBefore: string[] }
  | { type: "cellEdit"; recordId: string; fieldId: string; oldValue: CellValue; newValue: CellValue }
  | { type: "cellBatchClear"; changes: Array<{ recordId: string; fieldId: string; oldValue: CellValue }> };

interface Props {
  tableId: string;
  workspaceId: string;
  onRename?: (name: string) => void;
}

function readDeleteProtection(): boolean {
  try {
    const v = localStorage.getItem(DELETE_PROTECTION_KEY);
    return v === null ? true : v === "true";
  } catch { return true; }
}

export default function TableArtifactSurface({ tableId, workspaceId: _workspaceId, onRename }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const ws = useWorkspace();

  // 每个实例独立的 clientId —— 用于 SSE echo 过滤 + mutation 头。
  // 同 table 双开时:A 编辑发 X-Client-Id=instanceA,B 订阅 ?clientId=instanceB,
  // B 收到 event.clientId=instanceA ≠ instanceB → 应用,实时同步。
  const instanceClientId = useMemo(
    () =>
      (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `tas-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    [],
  );

  // ── Core data ──
  const [fields, setFields] = useState<Field[]>([]);
  const [allRecords, setAllRecords] = useState<TableRecord[]>([]);
  const [views, setViews] = useState<View[]>([]);
  const [activeViewId, setActiveViewId] = useState("view_all");

  // ── Filter / view state ──
  const [filter, setFilter] = useState<ViewFilter>({ logic: "and", conditions: [] });
  const [savedFilter, setSavedFilter] = useState<ViewFilter>({ logic: "and", conditions: [] });
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [fieldConfigOpen, setFieldConfigOpen] = useState(false);
  const [viewFieldOrder, setViewFieldOrder] = useState<string[]>([]);
  const [viewHiddenFields, setViewHiddenFields] = useState<string[]>([]);

  // ── Undo ──
  const undoStackRef = useRef<UndoItem[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const pushUndo = useCallback((item: UndoItem) => {
    undoStackRef.current.push(item);
    if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
    setCanUndo(true);
  }, []);
  const deletePendingRef = useRef<Promise<any> | null>(null);
  const skipFieldSyncRef = useRef(false);

  // ── Refs ──
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);
  const customizeFieldBtnRef = useRef<HTMLButtonElement>(null);
  const tableViewRef = useRef<TableViewHandle>(null);

  // ── Add / edit field popovers ──
  const [addFieldAnchor, setAddFieldAnchor] = useState<DOMRect | null>(null);
  const [editFieldState, setEditFieldState] = useState<{ fieldId: string; anchorRect: DOMRect } | null>(null);
  const fieldSuggestions = useFieldSuggestions(tableId);

  // ── ConfirmDialog ──
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    type: "records" | "fields" | "cells" | "rowCells";
    recordIds: string[];
    fieldIds: string[];
    cellsToClear: Array<{ recordId: string; fieldId: string }>;
  }>({ open: false, type: "records", recordIds: [], fieldIds: [], cellsToClear: [] });
  const deleteProtection = readDeleteProtection();

  // ── Resolve tableName from workspace context ──
  const tableName = useMemo(() => {
    // documentTables not in workspaceContext directly, but ws.sidebarItems has them
    // Fallback to "" if not found
    const item = ws.sidebarItems.find((s) => s.id === tableId && s.type === "table");
    return item?.displayName ?? "";
  }, [ws.sidebarItems, tableId]);

  // ── Initial fetch + reload on tableId change ──
  useEffect(() => {
    let alive = true;
    undoStackRef.current = [];
    setCanUndo(false);
    setFilterPanelOpen(false);
    setFieldConfigOpen(false);
    setAddFieldAnchor(null);
    setEditFieldState(null);
    Promise.all([fetchFields(tableId), fetchRecords(tableId), fetchViews(tableId)])
      .then(([f, r, v]) => {
        if (!alive) return;
        setFields(f);
        setAllRecords(r);
        setViews(v);
        const firstView = v[0];
        if (firstView) {
          setActiveViewId(firstView.id);
          const vf = firstView.filter ?? { logic: "and", conditions: [] };
          setSavedFilter(vf);
          setFilter(vf);
          initFieldOrderFromView(firstView, f);
        }
      })
      .catch((err) => {
        console.error("[TableArtifactSurface] fetch failed:", err);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId]);

  // ── initFieldOrderFromView ──
  const initFieldOrderFromView = useCallback((view: View, fieldList: Field[]) => {
    const allFieldIds = fieldList.map((f) => f.id);
    if (view.fieldOrder && view.fieldOrder.length > 0) {
      const validIds = new Set(allFieldIds);
      const seen = new Set<string>();
      const cleaned = view.fieldOrder.filter((id) => {
        if (!validIds.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      const newIds = allFieldIds.filter((id) => !seen.has(id));
      setViewFieldOrder([...cleaned, ...newIds]);
    } else {
      setViewFieldOrder(allFieldIds);
    }
    setViewHiddenFields(view.hiddenFields ?? []);
  }, []);

  // ── Sync fieldOrder when fields change ──
  useEffect(() => {
    if (skipFieldSyncRef.current) {
      skipFieldSyncRef.current = false;
      return;
    }
    if (fields.length === 0 || viewFieldOrder.length === 0) return;
    const allFieldIds = new Set(fields.map((f) => f.id));
    const seen = new Set<string>();
    const cleaned = viewFieldOrder.filter((id) => {
      if (!allFieldIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const newIds = fields.filter((f) => !seen.has(f.id)).map((f) => f.id);
    const updated = [...cleaned, ...newIds];
    if (JSON.stringify(updated) !== JSON.stringify(viewFieldOrder)) {
      setViewFieldOrder(updated);
    }
    const cleanedHidden = viewHiddenFields.filter((id) => allFieldIds.has(id));
    if (JSON.stringify(cleanedHidden) !== JSON.stringify(viewHiddenFields)) {
      setViewHiddenFields(cleanedHidden);
    }
  }, [fields, viewFieldOrder, viewHiddenFields]);

  // ── Filter outside-click ──
  useEffect(() => {
    if (!filterPanelOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        filterPanelRef.current && !filterPanelRef.current.contains(target) &&
        filterBtnRef.current && !filterBtnRef.current.contains(target)
      ) setFilterPanelOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filterPanelOpen]);

  // ── persist field order / hidden to backend view ──
  const persistFieldOrder = useCallback(async (newOrder: string[]) => {
    try {
      await withClientId(instanceClientId, () => updateView(activeViewId, { fieldOrder: newOrder }));
    } catch (err) {
      console.error("Failed to persist field order:", err);
    }
  }, [activeViewId, instanceClientId]);

  const persistHiddenFields = useCallback(async (newHidden: string[]) => {
    try {
      await withClientId(instanceClientId, () => updateView(activeViewId, { hiddenFields: newHidden }));
    } catch (err) {
      console.error("Failed to persist hidden fields:", err);
    }
  }, [activeViewId, instanceClientId]);

  const handleFieldOrderChange = useCallback((newOrder: string[]) => {
    setViewFieldOrder(newOrder);
    persistFieldOrder(newOrder);
  }, [persistFieldOrder]);

  const handleToggleFieldVisibility = useCallback((fieldId: string) => {
    setViewHiddenFields((prev) => {
      const next = prev.includes(fieldId) ? prev.filter((id) => id !== fieldId) : [...prev, fieldId];
      persistHiddenFields(next);
      return next;
    });
  }, [persistHiddenFields]);

  const handleHideField = useCallback((fieldId: string) => {
    setViewHiddenFields((prev) => {
      if (prev.includes(fieldId)) return prev;
      const next = [...prev, fieldId];
      persistHiddenFields(next);
      return next;
    });
  }, [persistHiddenFields]);

  const handleHideFields = useCallback((fieldIds: string[]) => {
    setViewHiddenFields((prev) => {
      const set = new Set(prev);
      for (const id of fieldIds) set.add(id);
      const next = Array.from(set);
      persistHiddenFields(next);
      return next;
    });
  }, [persistHiddenFields]);

  const handleSelectField = useCallback((fieldId: string) => {
    tableViewRef.current?.selectAndScrollToField(fieldId);
  }, []);

  // ── Filter handlers ──
  const displayRecords = useMemo(() => {
    if (filter.conditions.length === 0) return allRecords;
    return filterRecords(allRecords, filter, fields);
  }, [allRecords, filter, fields]);

  const handleFilterChange = useCallback((next: ViewFilter) => setFilter(next), []);
  const handleClearFilter = useCallback(() => setFilter(savedFilter), [savedFilter]);
  const handleSaveView = useCallback(async () => {
    try {
      await withClientId(instanceClientId, () => updateViewFilter(activeViewId, filter));
      setSavedFilter(filter);
    } catch (err) {
      console.error("Failed to save view:", err);
    }
  }, [activeViewId, filter, instanceClientId]);

  // ── Cell change ──
  const handleCellChange = useCallback((recordId: string, fieldId: string, value: CellValue) => {
    const record = allRecords.find((r) => r.id === recordId);
    const oldValue = (record?.cells[fieldId] ?? null) as CellValue;
    if (oldValue === value) return;
    if (Array.isArray(oldValue) && Array.isArray(value) && JSON.stringify(oldValue) === JSON.stringify(value)) return;
    pushUndo({ type: "cellEdit", recordId, fieldId, oldValue, newValue: value });
    setAllRecords((prev) =>
      prev.map((r) => (r.id === recordId ? { ...r, cells: { ...r.cells, [fieldId]: value } } : r)),
    );
    withClientId(instanceClientId, () => updateRecord(tableId, recordId, { [fieldId]: value })).catch(() => {
      setAllRecords((prev) =>
        prev.map((r) => (r.id === recordId ? { ...r, cells: { ...r.cells, [fieldId]: oldValue } } : r)),
      );
      undoStackRef.current.pop();
      setCanUndo(undoStackRef.current.length > 0);
      toast.error(t("toast.saveFailed"));
    });
  }, [allRecords, pushUndo, toast, t, tableId, instanceClientId]);

  // ── Add record ──
  const handleAddRecord = useCallback(async (position: "start" | "end" = "end"): Promise<string> => {
    const record = await withClientId(instanceClientId, () => createRecord(tableId, {}));
    setAllRecords((prev) => {
      if (prev.some((r) => r.id === record.id)) return prev;
      return position === "start" ? [record, ...prev] : [...prev, record];
    });
    return record.id;
  }, [tableId, instanceClientId]);

  // ── Undo ──
  const performUndo = useCallback(async () => {
    if (deletePendingRef.current) {
      try { await deletePendingRef.current; } catch { /* */ }
    }
    const item = undoStackRef.current.pop();
    if (!item) return;
    if (item.type === "records") {
      setAllRecords((prev) => {
        const arr = [...prev];
        item.indices.forEach((idx, i) => arr.splice(Math.min(idx, arr.length), 0, item.records[i]));
        return arr;
      });
      try {
        await withClientId(instanceClientId, () =>
          batchCreateRecords(tableId, item.records.map((r) => ({
            id: r.id, cells: r.cells as Record<string, any>, createdAt: r.createdAt, updatedAt: r.updatedAt,
          }))),
        );
      } catch {
        const restoredIds = new Set(item.records.map((r) => r.id));
        setAllRecords((prev) => prev.filter((r) => !restoredIds.has(r.id)));
        toast.error(t("toast.undoFailed"));
      }
    } else if (item.type === "fields") {
      skipFieldSyncRef.current = true;
      setFields((prev) => [...prev, ...item.fieldDefs]);
      setFilter((prev) => ({ ...prev, conditions: [...prev.conditions, ...item.removedConditions] }));
      setSavedFilter((prev) => ({ ...prev, conditions: [...prev.conditions, ...item.removedSavedConditions] }));
      setViewHiddenFields((prev) => {
        const set = new Set(prev);
        for (const id of item.removedHiddenIds) set.add(id);
        return Array.from(set);
      });
      setViewFieldOrder(item.fieldOrderBefore);
      persistFieldOrder(item.fieldOrderBefore);
      try {
        await withClientId(instanceClientId, () => batchRestoreFields(tableId, item.snapshot));
      } catch {
        const restoredIds = new Set(item.fieldDefs.map((f) => f.id));
        skipFieldSyncRef.current = true;
        setFields((prev) => prev.filter((f) => !restoredIds.has(f.id)));
        setFilter((prev) => ({ ...prev, conditions: prev.conditions.filter((c) => !restoredIds.has(c.fieldId)) }));
        setSavedFilter((prev) => ({ ...prev, conditions: prev.conditions.filter((c) => !restoredIds.has(c.fieldId)) }));
        toast.error(t("toast.undoFailed"));
      }
    } else if (item.type === "cellEdit") {
      setAllRecords((prev) => {
        const exists = prev.some((r) => r.id === item.recordId);
        if (!exists) return prev;
        return prev.map((r) =>
          r.id === item.recordId ? { ...r, cells: { ...r.cells, [item.fieldId]: item.oldValue } } : r,
        );
      });
      try {
        await withClientId(instanceClientId, () =>
          updateRecord(tableId, item.recordId, { [item.fieldId]: item.oldValue }),
        );
      } catch {
        setAllRecords((prev) =>
          prev.map((r) => (r.id === item.recordId ? { ...r, cells: { ...r.cells, [item.fieldId]: item.newValue } } : r)),
        );
        toast.error(t("toast.undoFailed"));
      }
    } else if (item.type === "cellBatchClear") {
      const restoreMap = new Map<string, Record<string, any>>();
      setAllRecords((prev) =>
        prev.map((r) => {
          const cs = item.changes.filter((c) => c.recordId === r.id);
          if (cs.length === 0) return r;
          const newCells = { ...r.cells };
          const restoreCells: Record<string, any> = {};
          for (const c of cs) {
            newCells[c.fieldId] = c.oldValue;
            restoreCells[c.fieldId] = c.oldValue;
          }
          restoreMap.set(r.id, restoreCells);
          return { ...r, cells: newCells };
        }),
      );
      try {
        await Promise.all(
          Array.from(restoreMap).map(([rid, cells]) =>
            withClientId(instanceClientId, () => updateRecord(tableId, rid, cells)),
          ),
        );
      } catch {
        setAllRecords((prev) =>
          prev.map((r) => {
            const cs = item.changes.filter((c) => c.recordId === r.id);
            if (cs.length === 0) return r;
            const newCells = { ...r.cells };
            for (const c of cs) newCells[c.fieldId] = null;
            return { ...r, cells: newCells };
          }),
        );
        toast.error(t("toast.undoFailed"));
      }
    }
    setCanUndo(undoStackRef.current.length > 0);
  }, [persistFieldOrder, toast, t, tableId, instanceClientId]);

  // ── Cmd/Ctrl+Z keyboard ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
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
    setAllRecords((prev) => prev.filter((r) => !idSet.has(r.id)));
    const promise = withClientId(instanceClientId, () => deleteRecords(tableId, recordIds)).catch(() => {
      undoStackRef.current.pop();
      setCanUndo(undoStackRef.current.length > 0);
      setAllRecords((prev) => {
        const arr = [...prev];
        snapIndices.forEach((idx, i) => arr.splice(idx, 0, snapRecords[i]));
        return arr;
      });
      toast.error(t("toast.deleteFailed"));
    }).finally(() => { deletePendingRef.current = null; });
    deletePendingRef.current = promise;
    toast.success(t("toast.deletedRecords", { count: recordIds.length }), {
      duration: 5000,
      action: { label: t("toast.undo"), onClick: () => performUndo() },
    });
  }, [allRecords, pushUndo, toast, t, performUndo, tableId, instanceClientId]);

  // ── Delete fields ──
  const executeDeleteFields = useCallback(async (fieldIds: string[]) => {
    const fieldOrderBefore = [...viewFieldOrder];
    const deletedFieldDefs = fields.filter((f) => fieldIds.includes(f.id));
    try {
      const result = await withClientId(instanceClientId, () => batchDeleteFields(tableId, fieldIds));
      const deletedIds = new Set(result.snapshot.fieldDefs.map((f: Field) => f.id));
      const removedConditions = filter.conditions.filter((c) => deletedIds.has(c.fieldId));
      const removedSavedConditions = savedFilter.conditions.filter((c) => deletedIds.has(c.fieldId));
      const removedHiddenIds = viewHiddenFields.filter((id) => deletedIds.has(id));
      pushUndo({
        type: "fields",
        fieldDefs: deletedFieldDefs.filter((f) => deletedIds.has(f.id)),
        snapshot: result.snapshot,
        removedConditions,
        removedSavedConditions,
        removedHiddenIds,
        fieldOrderBefore,
      });
      setFields((prev) => prev.filter((f) => !deletedIds.has(f.id)));
      setFilter((prev) => ({ ...prev, conditions: prev.conditions.filter((c) => !deletedIds.has(c.fieldId)) }));
      setSavedFilter((prev) => ({ ...prev, conditions: prev.conditions.filter((c) => !deletedIds.has(c.fieldId)) }));
      toast.success(t("toast.deletedFields", { count: result.deleted }), {
        duration: 5000,
        action: { label: t("toast.undo"), onClick: () => performUndo() },
      });
    } catch (err) {
      console.error("Failed to delete fields:", err);
      toast.error((err as Error).message || t("toast.failedDeleteFields"));
    }
  }, [fields, filter, savedFilter, viewHiddenFields, viewFieldOrder, toast, t, performUndo, pushUndo, tableId, instanceClientId]);

  const handleDeleteFields = useCallback((fieldIds: string[]) => {
    if (deleteProtection) {
      setConfirmDialog({ open: true, type: "fields", recordIds: [], fieldIds, cellsToClear: [] });
    } else {
      executeDeleteFields(fieldIds);
    }
  }, [deleteProtection, executeDeleteFields]);

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

  // ── Clear cells ──
  const executeClearCells = useCallback((cells: Array<{ recordId: string; fieldId: string }>, toastLabel?: string) => {
    const recordMap = new Map(allRecords.map((r) => [r.id, r]));
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
    const clearMap = new Map<string, Set<string>>();
    for (const c of changes) {
      if (!clearMap.has(c.recordId)) clearMap.set(c.recordId, new Set());
      clearMap.get(c.recordId)!.add(c.fieldId);
    }
    setAllRecords((prev) =>
      prev.map((r) => {
        const fSet = clearMap.get(r.id);
        if (!fSet) return r;
        const newCells = { ...r.cells };
        for (const fid of fSet) newCells[fid] = null;
        return { ...r, cells: newCells };
      }),
    );
    const promises: Promise<any>[] = [];
    for (const [rid, fSet] of clearMap) {
      const nullCells: Record<string, null> = {};
      for (const fid of fSet) nullCells[fid] = null;
      promises.push(withClientId(instanceClientId, () => updateRecord(tableId, rid, nullCells)));
    }
    Promise.all(promises).catch(() => {
      setAllRecords((prev) =>
        prev.map((r) => {
          const cs = changes.filter((c) => c.recordId === r.id);
          if (cs.length === 0) return r;
          const newCells = { ...r.cells };
          for (const c of cs) newCells[c.fieldId] = c.oldValue;
          return { ...r, cells: newCells };
        }),
      );
      undoStackRef.current.pop();
      setCanUndo(undoStackRef.current.length > 0);
      toast.error(t("toast.clearFailed"));
    });
    const msg = toastLabel ?? t("toast.clearedCells", { count: changes.length });
    toast.success(msg, { duration: 5000, action: { label: t("toast.undo"), onClick: () => performUndo() } });
  }, [allRecords, pushUndo, toast, t, performUndo, tableId, instanceClientId]);

  const handleClearCells = useCallback((cells: Array<{ recordId: string; fieldId: string }>) => {
    executeClearCells(cells);
  }, [executeClearCells]);

  const handleClearRowCells = useCallback((cells: Array<{ recordId: string; fieldId: string }>) => {
    if (deleteProtection) {
      setConfirmDialog({ open: true, type: "rowCells", recordIds: [], fieldIds: [], cellsToClear: cells });
    } else {
      const rowCount = new Set(cells.map((c) => c.recordId)).size;
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
      const isRow = confirmDialog.type === "rowCells";
      const cells = confirmDialog.cellsToClear;
      setConfirmDialog(reset);
      if (isRow) {
        const rowCount = new Set(cells.map((c) => c.recordId)).size;
        executeClearCells(cells, t("toast.clearedRecords", { count: rowCount }));
        tableViewRef.current?.clearRowSelection();
      } else {
        executeClearCells(cells);
      }
    }
  }, [confirmDialog, executeDelete, executeDeleteFields, executeClearCells, t]);

  // ── Add field popover ──
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
    const r = await fetchRecords(tableId);
    setAllRecords(r);
    setAddFieldAnchor(null);
  }, [tableId]);

  const handleEditFieldConfirm = useCallback(async (updatedField: Field) => {
    const oldField = fields.find((f) => f.id === updatedField.id);
    const typeChanged = oldField && oldField.type !== updatedField.type;
    setFields((prev) => prev.map((f) => (f.id === updatedField.id ? updatedField : f)));
    if (typeChanged) {
      const r = await fetchRecords(tableId);
      setAllRecords(r);
    }
    setEditFieldState(null);
  }, [fields, tableId]);

  // ── Remote handlers ──
  const handleRemoteRecordCreate = useCallback((record: TableRecord) => {
    setAllRecords((prev) => (prev.some((r) => r.id === record.id) ? prev : [...prev, record]));
  }, []);
  const handleRemoteRecordUpdate = useCallback((recordId: string, cells: Record<string, any>, updatedAt: number) => {
    setAllRecords((prev) =>
      prev.map((r) => (r.id === recordId ? { ...r, cells: { ...r.cells, ...cells }, updatedAt } : r)),
    );
  }, []);
  const handleRemoteRecordDelete = useCallback((recordId: string) => {
    setAllRecords((prev) => prev.filter((r) => r.id !== recordId));
  }, []);
  const handleRemoteRecordBatchDelete = useCallback((recordIds: string[]) => {
    const set = new Set(recordIds);
    setAllRecords((prev) => prev.filter((r) => !set.has(r.id)));
  }, []);
  const handleRemoteRecordBatchCreate = useCallback((records: TableRecord[]) => {
    setAllRecords((prev) => {
      const ex = new Set(prev.map((r) => r.id));
      const fresh = records.filter((r) => !ex.has(r.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, []);
  const handleRemoteFieldCreate = useCallback((field: Field) => {
    setFields((prev) => (prev.some((f) => f.id === field.id) ? prev : [...prev, field]));
    fetchRecords(tableId).then(setAllRecords);
  }, [tableId]);
  const handleRemoteFieldUpdate = useCallback((fieldId: string, changes: { name?: string; config?: any }) => {
    setFields((prev) => prev.map((f) => (f.id === fieldId ? { ...f, ...changes } : f)));
  }, []);
  const handleRemoteFieldDelete = useCallback((fieldId: string) => {
    setFields((prev) => prev.filter((f) => f.id !== fieldId));
    setFilter((prev) => ({ ...prev, conditions: prev.conditions.filter((c) => c.fieldId !== fieldId) }));
    setSavedFilter((prev) => ({ ...prev, conditions: prev.conditions.filter((c) => c.fieldId !== fieldId) }));
  }, []);
  const handleRemoteFieldBatchDelete = useCallback((fieldIds: string[]) => {
    const set = new Set(fieldIds);
    setFields((prev) => prev.filter((f) => !set.has(f.id)));
    setFilter((prev) => ({ ...prev, conditions: prev.conditions.filter((c) => !set.has(c.fieldId)) }));
    setSavedFilter((prev) => ({ ...prev, conditions: prev.conditions.filter((c) => !set.has(c.fieldId)) }));
  }, []);
  const handleRemoteFieldBatchRestore = useCallback((restored: Field[]) => {
    setFields((prev) => {
      const ex = new Set(prev.map((f) => f.id));
      const fresh = restored.filter((f) => !ex.has(f.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
    fetchRecords(tableId).then(setAllRecords);
  }, [tableId]);
  const handleRemoteViewUpdate = useCallback((viewId: string, changes: Partial<View>) => {
    setViews((prev) => prev.map((v) => (v.id === viewId ? { ...v, ...changes } : v)));
    if (viewId === activeViewId) {
      if (changes.fieldOrder) setViewFieldOrder(changes.fieldOrder);
      if (changes.hiddenFields) setViewHiddenFields(changes.hiddenFields);
    }
  }, [activeViewId]);
  const handleRemoteViewCreate = useCallback((view: View) => {
    setViews((prev) => (prev.some((v) => v.id === view.id) ? prev : [...prev, view]));
  }, []);
  const handleRemoteViewDelete = useCallback((viewId: string) => {
    setViews((prev) => prev.filter((v) => v.id !== viewId));
  }, []);
  const handleRemoteTableUpdate = useCallback((changes: { name?: string }) => {
    if (changes.name) {
      // 通过 workspace context 让 sidebar / topbar 都更新(走 onRenameItem 或直接调外部 onRename)
      onRename?.(changes.name);
    }
  }, [onRename]);
  const handleRemoteWorkspaceUpdate = useCallback(() => { /* no-op in table surface */ }, []);
  const handleFullSync = useCallback((syncFields: Field[], syncRecords: TableRecord[], syncViews: View[]) => {
    setFields(syncFields);
    setAllRecords(syncRecords);
    setViews(syncViews);
  }, []);

  useTableSync(tableId, instanceClientId, {
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
    onWorkspaceUpdate: handleRemoteWorkspaceUpdate,
    onFullSync: handleFullSync,
  });

  // ── Derived ──
  const allOrderedFields = useMemo(() => {
    const map = new Map(fields.map((f) => [f.id, f]));
    return viewFieldOrder.map((id) => map.get(id)).filter(Boolean) as Field[];
  }, [fields, viewFieldOrder]);

  const visibleOrderedFields = useMemo(
    () => allOrderedFields.filter((f) => !viewHiddenFields.includes(f.id)),
    [allOrderedFields, viewHiddenFields],
  );

  const isFiltered = filter.conditions.length > 0;
  const isFilterDirty = useMemo(() => JSON.stringify(filter) !== JSON.stringify(savedFilter), [filter, savedFilter]);

  return (
    <>
      <Toolbar
        tableName={tableName}
        onRenameTable={(name) => onRename?.(name)}
        isFiltered={isFiltered}
        isFilterDirty={isFilterDirty}
        filterConditionCount={filter.conditions.length}
        filterPanelOpen={filterPanelOpen}
        onFilterClick={() => setFilterPanelOpen((o) => !o)}
        onClearFilter={handleClearFilter}
        onSaveView={handleSaveView}
        filterBtnRef={filterBtnRef}
        fieldConfigOpen={fieldConfigOpen}
        onCustomizeFieldClick={() => setFieldConfigOpen((o) => !o)}
        customizeFieldBtnRef={customizeFieldBtnRef}
        canUndo={canUndo}
        onUndo={performUndo}
        onAddRecord={() => { void tableViewRef.current?.addRecord("start"); }}
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
          onAddRecord={handleAddRecord}
        />
        {filterPanelOpen && (
          <FilterPanel
            ref={filterPanelRef}
            tableId={tableId}
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
            currentTableId={tableId}
            currentFields={fields}
            anchorRect={addFieldAnchor}
            onCancel={() => setAddFieldAnchor(null)}
            onConfirm={handleCreateFieldConfirm}
            fieldSuggestions={fieldSuggestions}
            clientId={instanceClientId}
          />
        )}
        {editFieldState && (
          <AddFieldPopover
            key={editFieldState.fieldId}
            currentTableId={tableId}
            currentFields={fields}
            anchorRect={editFieldState.anchorRect}
            onCancel={() => setEditFieldState(null)}
            onConfirm={handleEditFieldConfirm}
            fieldSuggestions={fieldSuggestions}
            editingField={fields.find((f) => f.id === editFieldState.fieldId)}
            clientId={instanceClientId}
          />
        )}
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
                  const rowCount = new Set(confirmDialog.cellsToClear.map((c) => c.recordId)).size;
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
    </>
  );
}
