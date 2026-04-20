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
import { fetchFields, fetchRecords, fetchViews, updateViewFilter, updateView, deleteField, deleteRecords, batchCreateRecords, batchDeleteFields, batchRestoreFields, updateRecord, createRecord, renameTable, fetchWorkspace, renameWorkspace, fetchWorkspaceTables, createTable as apiCreateTable, reorderTables, reorderFolders, reorderDesigns, deleteTable as apiDeleteTable, resetTable, CLIENT_ID, fetchWorkspaceTree, createFolder as apiCreateFolder, renameFolder as apiRenameFolder, deleteFolder as apiDeleteFolder, moveItem as apiMoveItem, createDesign as apiCreateDesign, renameDesign as apiRenameDesign, deleteDesign as apiDeleteDesign } from "./api";
import type { GeneratedField, FolderBrief, DesignBrief } from "./api";
import type { SidebarItem } from "./components/Sidebar";
import type { TreeItemType } from "./types";
import SvgCanvas from "./components/SvgCanvas/index";
import { useToast } from "./components/Toast/index";
import { useTranslation } from "./i18n/index";
import ConfirmDialog from "./components/ConfirmDialog/index";
import { filterRecords } from "./services/filterEngine";
import { useTableSync } from "./hooks/useTableSync";
import { useWorkspaceSync } from "./hooks/useWorkspaceSync";
import { useSplitResize } from "./hooks/useSplitResize";
import ChatSidebar from "./components/ChatSidebar/index";

const WORKSPACE_ID = "doc_default";
// Phase 1 MVP: the user has exactly one Agent (seeded on first boot as
// `agent_default`, display name "Claw"). It's workspace-agnostic — the same
// Agent follows you across every workspace and owns the persistent identity
// / memory. When multi-agent support lands this becomes a state + picker.
const AGENT_ID = "agent_default";

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
  const [documentTables, setDocumentTables] = useState<Array<{ id: string; name: string; order: number; parentId: string | null }>>([]);
  const [documentFolders, setDocumentFolders] = useState<FolderBrief[]>([]);
  const [documentDesigns, setDocumentDesigns] = useState<DesignBrief[]>([]);
  /* Transient id used to scroll the sidebar to a specific tree node — set
   * after creating a folder (since folders can't become the activeItemId, the
   * normal auto-scroll doesn't apply). Cleared on next user-driven change. */
  const [scrollToItemId, setScrollToItemId] = useState<string | null>(null);
  const [activeItemType, setActiveItemType] = useState<TreeItemType>("table");
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
  // Chat agent defaults to OPEN on first mount so the welcome page is the
  // entry experience. Persist the user's open/close preference so their
  // choice sticks across reloads.
  const [chatAgentOpen, setChatAgentOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("chat_agent_open_v1");
      return v === null ? true : v === "true";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try { localStorage.setItem("chat_agent_open_v1", String(chatAgentOpen)); } catch { /* ignore */ }
  }, [chatAgentOpen]);

  // Phase 4 Day 3 — unread inbox count for the four-pointed star button.
  // Polled every 30 s; also refetched whenever the chat drawer opens/closes so
  // the badge clears promptly after the user reads messages inside the chat.
  const [agentUnread, setAgentUnread] = useState<number>(0);
  useEffect(() => {
    let alive = true;
    const fetchUnread = async () => {
      try {
        const res = await fetch(`/api/agents/${AGENT_ID}/inbox?unread=1&limit=1`);
        if (!res.ok) return;
        const data = await res.json();
        if (alive && typeof data?.unreadCount === "number") {
          setAgentUnread(data.unreadCount);
        }
      } catch { /* network blip — try again on next tick */ }
    };
    fetchUnread();
    const id = window.setInterval(fetchUnread, 30_000);
    return () => { alive = false; window.clearInterval(id); };
  }, [chatAgentOpen]);

  // Which side the chat panel is on. Persisted in localStorage so swap sticks.
  const [chatSide, setChatSide] = useState<"left" | "right">(() => {
    try {
      const v = localStorage.getItem("chat_panel_side_v1");
      return v === "left" ? "left" : "right";
    } catch {
      return "right";
    }
  });

  // Horizontal split between the artifact (table view) and chat panels.
  // Only active while chatAgentOpen; the ratio persists across sessions.
  // `anchorSide` mirrors chatSide so drag direction always tracks the chat
  // panel regardless of which side it lives on.
  const {
    ratio: chatRatio,
    containerRef: workspaceRef,
    onDividerMouseDown: onSplitDragStart,
    isDragging: isSplitDragging,
  } = useSplitResize({
    storageKey: "chat_artifact_ratio_v1",
    defaultRatio: 0.35,
    minLeftPx: 480,
    minRightPx: 320,
    maxRatio: 0.6,
    anchorSide: chatSide,
  });
  const setChatSidePersisted = useCallback((side: "left" | "right") => {
    setChatSide(side);
    try { localStorage.setItem("chat_panel_side_v1", side); } catch { /* ignore */ }
  }, []);

  // iOS-style move bar drag: tracks the horizontal delta so we know when the
  // user has pulled far enough across the divider to trigger a swap.
  const [movingPart, setMovingPart] = useState<null | "artifact" | "chat">(null);
  const onMoveBarMouseDown = useCallback(
    (which: "artifact" | "chat") => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const container = workspaceRef.current;
      if (!container) return;

      const startX = e.clientX;
      const rect = container.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      setMovingPart(which);

      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";

      const onMove = (ev: MouseEvent) => {
        // Visual-only signal during drag; no layout changes until release.
        void ev;
      };
      const onUp = (ev: MouseEvent) => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);

        const endX = ev.clientX;
        const dx = endX - startX;
        // Swap only if the release happened on the opposite half AND the
        // user moved at least 40px.
        if (Math.abs(dx) >= 40) {
          const releasedSide: "left" | "right" = endX < midX ? "left" : "right";
          if (which === "chat") {
            setChatSidePersisted(releasedSide);
          } else {
            // Dragging the artifact bar to the other side implies chat goes
            // to the opposite side of the artifact's new position.
            setChatSidePersisted(releasedSide === "left" ? "right" : "left");
          }
        }
        setMovingPart(null);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [setChatSidePersisted, workspaceRef]
  );
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
      const [treeData, doc] = await Promise.all([
        fetchWorkspaceTree(WORKSPACE_ID),
        fetchWorkspace(WORKSPACE_ID).catch(() => null),
      ]);
      const tables = treeData.tables.map(t => ({ ...t, parentId: t.parentId ?? null }));
      setDocumentTables(tables);
      setDocumentFolders(treeData.folders);
      setDocumentDesigns((treeData.designs || []).map(d => ({ ...d, parentId: d.parentId ?? null })));
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

  // ── Add a single empty record (from ".add-record-btn" in TableView / Toolbar) ──
  const handleAddRecord = useCallback(async (): Promise<string> => {
    const tableId = activeTableIdRef.current;
    const record = await createRecord(tableId, {});
    // Optimistically append to local state; SSE echo is deduped by id in handleRemoteRecordCreate
    setAllRecords(prev => prev.some(r => r.id === record.id) ? prev : [...prev, record]);
    return record.id;
  }, []);

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

  const handleRemoteWorkspaceUpdate = useCallback((changes: { workspaceId: string; name: string }) => {
    if (changes.workspaceId === WORKSPACE_ID && changes.name) {
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
      await renameWorkspace(WORKSPACE_ID, newName);
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
      active: tbl.id === activeTableId && activeItemType === "table",
      order: tbl.order,
      parentId: tbl.parentId ?? null,
    }));
    const folderItems: SidebarItem[] = documentFolders.map(f => ({
      id: f.id,
      type: "folder" as const,
      displayName: f.name,
      active: false,
      order: f.order,
      parentId: f.parentId,
    }));
    const designItems: SidebarItem[] = documentDesigns.map(d => ({
      id: d.id,
      type: "design" as const,
      displayName: d.name,
      active: d.id === activeTableId && activeItemType === "design",
      order: d.order,
      parentId: d.parentId,
    }));
    const staticItems: SidebarItem[] = [
      { id: "dashboard", type: "static" as const, displayName: sidebarNames.dashboard ?? t("sidebar.dashboard"), active: false, order: Infinity },
      { id: "workflow", type: "static" as const, displayName: sidebarNames.workflow ?? t("sidebar.workflow"), active: false, order: Infinity },
    ];
    return [...folderItems, ...tableItems, ...designItems, ...staticItems];
  }, [documentTables, documentFolders, documentDesigns, activeTableId, activeItemType, tableName, sidebarNames, t]);

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
    // 1. Create table
    const result = await apiCreateTable(aiTableName, WORKSPACE_ID, locale as "en" | "zh");
    setDocumentTables(prev => [...prev, { id: result.id, name: result.name, order: result.order, parentId: null }]);

    // 2. Reset with AI fields (skip switchTable to avoid premature warmup)
    const resetResult = await resetTable(result.id, generatedFields, locale as "en" | "zh");

    // 3. Now set active table and load data in one shot (with correct AI fields)
    undoStackRef.current = [];
    setCanUndo(false);
    setActiveTableId(result.id);
    setTableName(result.name);
    setFields(resetResult.fields);
    setAllRecords(resetResult.records);
    setViews(resetResult.views);
    if (resetResult.views[0]) {
      setActiveViewId(resetResult.views[0].id);
      const viewFilter = resetResult.views[0].filter ?? { logic: "and", conditions: [] };
      setSavedFilter(viewFilter);
      setFilter(viewFilter);
      initFieldOrderFromView(resetResult.views[0], resetResult.fields);
    }
    // activeTableId change will trigger useFieldSuggestions auto-fetch with correct AI fields
    return result.id;
  }, [locale, initFieldOrderFromView]);

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
    const result = await apiCreateTable(baseName, WORKSPACE_ID, locale as "en" | "zh");
    setDocumentTables(prev => [...prev, { id: result.id, name: result.name, order: result.order, parentId: null }]);
    await switchTable(result.id);
    setTableName(result.name);
  }, [locale, switchTable]);

  // ── Reorder items (tables, folders, designs) ──
  const handleReorderItems = useCallback(async (updates: Array<{ id: string; type: TreeItemType; order: number }>) => {
    // Optimistic update per type
    const tableUpdates = updates.filter(u => u.type === "table");
    const folderUpdates = updates.filter(u => u.type === "folder");
    const designUpdates = updates.filter(u => u.type === "design");

    if (tableUpdates.length > 0) {
      const orderMap = new Map(tableUpdates.map(u => [u.id, u.order]));
      setDocumentTables(prev =>
        prev.map(t => orderMap.has(t.id) ? { ...t, order: orderMap.get(t.id)! } : t)
            .sort((a, b) => a.order - b.order)
      );
    }
    if (folderUpdates.length > 0) {
      const orderMap = new Map(folderUpdates.map(u => [u.id, u.order]));
      setDocumentFolders(prev =>
        prev.map(f => orderMap.has(f.id) ? { ...f, order: orderMap.get(f.id)! } : f)
            .sort((a, b) => a.order - b.order)
      );
    }
    if (designUpdates.length > 0) {
      const orderMap = new Map(designUpdates.map(u => [u.id, u.order]));
      setDocumentDesigns(prev =>
        prev.map(d => orderMap.has(d.id) ? { ...d, order: orderMap.get(d.id)! } : d)
            .sort((a, b) => a.order - b.order)
      );
    }

    try {
      const calls: Promise<void>[] = [];
      if (tableUpdates.length > 0) {
        calls.push(reorderTables(tableUpdates.map(u => ({ id: u.id, order: u.order })), WORKSPACE_ID));
      }
      if (folderUpdates.length > 0) {
        calls.push(reorderFolders(folderUpdates.map(u => ({ id: u.id, order: u.order })), WORKSPACE_ID));
      }
      if (designUpdates.length > 0) {
        calls.push(reorderDesigns(designUpdates.map(u => ({ id: u.id, order: u.order })), WORKSPACE_ID));
      }
      await Promise.all(calls);
    } catch {
      toast.error(t("toast.reorderFailed"));
      fetchWorkspaceTree(WORKSPACE_ID).then(tree => {
        setDocumentTables(tree.tables.map(t => ({ ...t, parentId: t.parentId ?? null })));
        setDocumentFolders(tree.folders);
        setDocumentDesigns((tree.designs || []).map(d => ({ ...d, parentId: d.parentId ?? null })));
      });
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
      fetchWorkspaceTree(WORKSPACE_ID).then(tree => setDocumentTables(tree.tables.map(t => ({ ...t, parentId: t.parentId ?? null }))));
    }
  }, [documentTables, initFieldOrderFromView, toast, t]);

  // ── Create folder ──
  const handleCreateFolder = useCallback(async () => {
    const name = locale === "zh" ? "新建文件夹" : "New Folder";
    try {
      const folder = await apiCreateFolder(name, WORKSPACE_ID);
      setDocumentFolders(prev => [...prev, folder]);
      // Folders can't become the activeItemId (they have no content view), so
      // request an explicit scroll to the new row — otherwise the user won't
      // see where it landed when the sidebar is scrolled away from the
      // bottom, which is where new folders are created.
      setScrollToItemId(folder.id);
    } catch {
      toast.error("Failed to create folder");
    }
  }, [locale, toast]);

  // ── Create design ──
  const handleCreateDesign = useCallback(async (name: string, figmaUrl?: string): Promise<string> => {
    try {
      const design = await apiCreateDesign(name, figmaUrl || "", WORKSPACE_ID);
      setDocumentDesigns(prev => [...prev, design]);
      setActiveTableId(design.id);
      setActiveItemType("design");
      return design.id;
    } catch (err) {
      toast.error((err as Error).message || t("toast.createTableFailed"));
      throw err;
    }
  }, [toast, t]);

  // ── Delete item (folder or design) ──
  const handleDeleteItem = useCallback(async (id: string, type: TreeItemType) => {
    try {
      if (type === "folder") {
        await apiDeleteFolder(id);
        setDocumentFolders(prev => prev.filter(f => f.id !== id));
        // Move children to root
        setDocumentTables(prev => prev.map(t => t));
        setDocumentDesigns(prev => prev.map(d => d.parentId === id ? { ...d, parentId: null } : d));
      } else if (type === "design") {
        await apiDeleteDesign(id);
        setDocumentDesigns(prev => prev.filter(d => d.id !== id));
        if (id === activeTableId) {
          // Switch to first table
          const firstTable = documentTables[0];
          if (firstTable) {
            setActiveTableId(firstTable.id);
            setActiveItemType("table");
            switchTable(firstTable.id);
          }
        }
      }
    } catch {
      toast.error(t("toast.deleteFailed"));
    }
  }, [activeTableId, documentTables, switchTable, toast, t]);

  // ── Move item ──
  const handleMoveItem = useCallback(async (itemId: string, itemType: "table" | "folder" | "design", newParentId: string | null) => {
    // Optimistic update FIRST
    if (itemType === "table") {
      setDocumentTables(prev => prev.map(t => t.id === itemId ? { ...t, parentId: newParentId } : t));
    } else if (itemType === "folder") {
      setDocumentFolders(prev => prev.map(f => f.id === itemId ? { ...f, parentId: newParentId } : f));
    } else if (itemType === "design") {
      setDocumentDesigns(prev => prev.map(d => d.id === itemId ? { ...d, parentId: newParentId } : d));
    }
    try {
      await apiMoveItem(itemId, itemType, newParentId);
    } catch {
      // Rollback — refetch tree
      const treeData = await fetchWorkspaceTree(WORKSPACE_ID);
      setDocumentTables(treeData.tables.map(t => ({ ...t, parentId: t.parentId ?? null })));
      setDocumentFolders(treeData.folders);
      setDocumentDesigns((treeData.designs || []).map(d => ({ ...d, parentId: d.parentId ?? null })));
      toast.error(t("toast.reorderFailed"));
    }
  }, [toast, t]);

  // ── Select item (table or design) ──
  const handleSelectItem = useCallback((id: string, type?: TreeItemType) => {
    if (type === "design") {
      setActiveTableId(id);
      setActiveItemType("design");
    } else if (type === "folder") {
      // Folders are not selectable as content
      return;
    } else {
      const isTable = documentTables.some(t => t.id === id);
      if (isTable) {
        setActiveItemType("table");
        switchTable(id);
      }
    }
  }, [documentTables, switchTable]);

  // ── Rename for design/folder ──
  const handleRenameSidebarItemExtended = useCallback(async (itemId: string, newName: string) => {
    // Check if it's a folder
    const isFolder = documentFolders.some(f => f.id === itemId);
    if (isFolder) {
      setDocumentFolders(prev => prev.map(f => f.id === itemId ? { ...f, name: newName } : f));
      try {
        await apiRenameFolder(itemId, newName);
      } catch {
        toast.error(t("toast.renameFailed"));
      }
      return;
    }
    // Check if it's a design
    const isDesign = documentDesigns.some(d => d.id === itemId);
    if (isDesign) {
      setDocumentDesigns(prev => prev.map(d => d.id === itemId ? { ...d, name: newName } : d));
      try {
        await apiRenameDesign(itemId, newName);
      } catch {
        toast.error(t("toast.renameFailed"));
      }
      return;
    }
    // Fall through to original handler (tables + statics)
    handleRenameSidebarItem(itemId, newName);
  }, [documentFolders, documentDesigns, handleRenameSidebarItem, toast, t]);

  // ── Persist active table to localStorage ──
  useEffect(() => {
    if (activeTableId) localStorage.setItem("lastActiveTableId", activeTableId);
  }, [activeTableId]);

  // ── Workspace-level SSE for sidebar sync ──
  useWorkspaceSync(WORKSPACE_ID, CLIENT_ID, {
    onTableCreate: useCallback((table: { id: string; name: string; order: number }) => {
      setDocumentTables(prev =>
        prev.some(t => t.id === table.id) ? prev : [...prev, { ...table, parentId: null }].sort((a, b) => a.order - b.order)
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
    onTableRename: useCallback((tableId: string, name: string) => {
      setDocumentTables(prev => prev.map(t => t.id === tableId ? { ...t, name } : t));
      // If the renamed table is the active one, update the displayed name too
      if (tableId === activeTableIdRef.current) {
        setTableName(name);
      }
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
    onWorkspaceUpdate: handleRemoteWorkspaceUpdate,
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
        onOpenChatAgent={() => setChatAgentOpen((v) => !v)}
        chatAgentOpen={chatAgentOpen}
        agentUnreadCount={agentUnread}
      />
      <div className={`workspace${chatAgentOpen ? " chat-open" : ""}${chatAgentOpen && chatSide === "left" ? " chat-left" : ""}${movingPart ? " moving" : ""}`} ref={workspaceRef}>
        <div
          className="artifact-part"
          /* When chat is open, let artifact flex-grow into the remaining
           * space (= 100% - chat% - 6px divider). */
          style={chatAgentOpen ? { flex: "1 1 auto", minWidth: 0 } : undefined}
        >
        <div className="app-body">
        <Sidebar
          items={sidebarItems}
          onRenameItem={handleRenameSidebarItemExtended}
          activeItemId={activeTableId}
          onSelectItem={handleSelectItem}
          onReorderItems={handleReorderItems}
          onDeleteTable={handleDeleteTable}
          tableCount={documentTables.length}
          onCreateWithAI={handleCreateWithAI}
          onResetToDefault={handleResetToDefault}
          onCreateBlank={handleCreateBlankTable}
          folders={documentFolders.map(f => ({ id: f.id, name: f.name }))}
          onCreateFolder={handleCreateFolder}
          onCreateDesign={handleCreateDesign}
          onDeleteItem={handleDeleteItem}
          onMoveItem={handleMoveItem}
          scrollToItemId={scrollToItemId}
        />
        <div className="app-main">
          {/* SVG Canvas — shown when a design is active */}
          {activeItemType === "design" && (() => {
            const d = documentDesigns.find(x => x.id === activeTableId);
            if (!d) return null;
            return (
              <SvgCanvas
                key={activeTableId}
                designId={activeTableId}
                designName={d.name}
                onRename={(name) => handleRenameSidebarItemExtended(activeTableId, name)}
              />
            );
          })()}
          {activeItemType !== "design" && (
          <>
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
            onAddRecord={() => { void tableViewRef.current?.addRecord(); }}
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
          </>
          )}
        </div>
      </div>
          {chatAgentOpen && (
            <>
              <div className="part-hover-zone" aria-hidden="true" />
              <div
                className={`part-move-bar${movingPart === "artifact" ? " dragging" : ""}`}
                onMouseDown={onMoveBarMouseDown("artifact")}
                title="拖动以切换左右位置"
                role="button"
                aria-label="Swap panel positions"
              />
            </>
          )}
        </div>
        {chatAgentOpen && (
          <>
            <div
              className={`split-divider${isSplitDragging ? " dragging" : ""}`}
              onMouseDown={onSplitDragStart}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat panel"
            />
            <div
              className="chat-part"
              style={{ flex: `0 0 ${(chatRatio * 100).toFixed(3)}%` }}
            >
              <ChatSidebar
                open={chatAgentOpen}
                workspaceId={WORKSPACE_ID}
                agentId={AGENT_ID}
                onClose={() => setChatAgentOpen(false)}
                onActiveTableChange={(tableId) => {
                  // Virtual pointer: follow the Agent to whichever table it's
                  // currently operating on. switchTable short-circuits when
                  // the id is already active, so back-to-back tool calls
                  // against the same table don't thrash the loader. For a
                  // freshly-created table the workspace-level SSE may still
                  // be en route — switchTable handles fetch itself, and the
                  // sidebar row will light up once useWorkspaceSync arrives.
                  setActiveItemType("table");
                  void switchTable(tableId);
                }}
              />
              <div className="part-hover-zone" aria-hidden="true" />
              <div
                className={`part-move-bar${movingPart === "chat" ? " dragging" : ""}`}
                onMouseDown={onMoveBarMouseDown("chat")}
                title="拖动以切换左右位置"
                role="button"
                aria-label="Swap panel positions"
              />
            </div>
          </>
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
