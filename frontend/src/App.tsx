import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import Toolbar from "./components/Toolbar";
import { SidebarToggleProvider } from "./contexts/sidebarToggleContext";
import TableView, { TableViewHandle } from "./components/TableView/index";
import FilterPanel from "./components/FilterPanel/index";
import FieldConfigPanel from "./components/FieldConfigPanel/index";
import { AddFieldPopover, useFieldSuggestions } from "./components/FieldConfig/AddFieldPopover";
import "./App.css";
import { Field, TableRecord, View, ViewFilter } from "./types";
import { fetchFields, fetchRecords, fetchViews, updateViewFilter, updateView, deleteField, deleteRecords, batchCreateRecords, batchDeleteFields, batchRestoreFields, updateRecord, createRecord, renameTable, fetchWorkspace, renameWorkspace, fetchWorkspaceTables, createTable as apiCreateTable, reorderTables, reorderFolders, reorderDesigns, reorderIdeas, reorderDemos, deleteTable as apiDeleteTable, resetTable, CLIENT_ID, fetchWorkspaceTree, createFolder as apiCreateFolder, renameFolder as apiRenameFolder, deleteFolder as apiDeleteFolder, moveItem as apiMoveItem, createDesign as apiCreateDesign, renameDesign as apiRenameDesign, deleteDesign as apiDeleteDesign, createIdea as apiCreateIdea, renameIdea as apiRenameIdea, deleteIdea as apiDeleteIdea, renameDemo as apiRenameDemo, deleteDemo as apiDeleteDemo, fetchIncomingMentions, listDemos } from "./api";
import type { GeneratedField, FolderBrief, DesignBrief, IncomingMentionRef } from "./api";
import type { SidebarItem } from "./components/Sidebar";
import type { TreeItemType, IdeaBrief, FocusEntity } from "./types";
import SvgCanvas from "./components/SvgCanvas/index";
import IdeaEditor from "./components/IdeaEditor/index";
import DemoPreviewPanel from "./components/DemoPreviewPanel/index";
import { useToast } from "./components/Toast/index";
import { useTranslation } from "./i18n/index";
import ConfirmDialog, { ConfirmReference } from "./components/ConfirmDialog/index";
import { filterRecords } from "./services/filterEngine";
import { useTableSync } from "./hooks/useTableSync";
import { useWorkspaceSync } from "./hooks/useWorkspaceSync";
import { useSplitResize } from "./hooks/useSplitResize";
import ChatSidebar from "./components/ChatSidebar/index";
import { useAuth } from "./auth/AuthContext";

// WORKSPACE_ID + AGENT_ID 都在组件内部根据 AuthContext 动态派生（见 App()
// 顶部）。之前两者都是 module-level 常量 `"doc_default"` / `"agent_default"`，
// 导致所有登录用户都共享同一套数据 + 同一个 chatbot identity —— 是严重的
// 跨用户泄漏，已修掉。

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
  // 空串占位 —— 真实的 workspace.name 会在 bootstrap effect 里从后端拉回来
  // 覆盖。之前是 "Default Document"，在接口返回前会闪一下英文文案，很丑。
  const [documentName, setDocumentName] = useState("");
  const [activeTableId, setActiveTableId] = useState<string>("tbl_requirements");
  const activeTableIdRef = useRef(activeTableId);
  activeTableIdRef.current = activeTableId;
  const [documentTables, setDocumentTables] = useState<Array<{ id: string; name: string; order: number; parentId: string | null }>>([]);
  const [documentFolders, setDocumentFolders] = useState<FolderBrief[]>([]);
  const [documentDesigns, setDocumentDesigns] = useState<DesignBrief[]>([]);
  const [documentIdeas, setDocumentIdeas] = useState<IdeaBrief[]>([]);
  // Vibe Demo V1 — sidebar entries for Demo artifacts (loaded alongside the
  // other artifact types). Demo detail is fetched on-demand inside
  // DemoPreviewPanel, so here we only track {id, name, order, parentId}.
  const [documentDemos, setDocumentDemos] = useState<Array<{
    id: string;
    name: string;
    order: number;
    parentId: string | null;
    publishSlug: string | null;
  }>>([]);
  /* When the user clicks a @mention chip inside an idea, we park the entity
   * here so the destination view (TableView / SvgCanvas) can highlight the
   * field / record / taste on its next render. Cleared by the view after it
   * applies focus so re-entering the same idea doesn't re-trigger highlight. */
  const [focusEntity, setFocusEntity] = useState<FocusEntity>(null);
  /* Transient id used to scroll the sidebar to a specific tree node — set
   * after creating a folder (since folders can't become the activeItemId, the
   * normal auto-scroll doesn't apply). Cleared on next user-driven change. */
  const [scrollToItemId, setScrollToItemId] = useState<string | null>(null);
  const [activeItemType, setActiveItemType] = useState<TreeItemType>("table");

  // ── URL ↔ state sync (Vibe Demo V1) ────────────────────────────────────
  //
  // Routes we handle (declared in main.tsx):
  //   /workspace/:workspaceId
  //   /workspace/:workspaceId/:artifactType/:artifactId
  //
  // One-way flow: URL → state. When the URL changes (user typed, back/forward,
  // or navigate() called elsewhere), reflect it into activeTableId +
  // activeItemType. The setter callsites that do `setActiveTableId(...) +
  // setActiveItemType(...)` additionally call navigateToArtifact() to push
  // the change back to the URL — see navigateToArtifact() below.
  const navigate = useNavigate();
  const urlParams = useParams<{ workspaceId?: string; artifactType?: string; artifactId?: string }>();

  // ── Workspace scoping ────────────────────────────────────────────────
  // Derived from URL first; falls back to the user's own first workspace
  // when URL is missing (e.g. deep links that dropped the segment).
  // A guard effect below kicks any user off URLs targeting a workspace
  // they don't actually own.
  const { workspaces: userWorkspaces, workspaceId: authWorkspaceId, agentId: authAgentId } = useAuth();
  const WORKSPACE_ID = urlParams.workspaceId || authWorkspaceId || "";
  // Agent id 跟登录用户绑定（后端 /me 返回）。空字符串保护：未加载完成时
  // 不应触发 agent-scoped 请求。所有用到它的地方都是在 RequireAuth 之后，
  // AuthContext 已经拿到数据。
  const AGENT_ID = authAgentId || "";
  const userOwnsThisWorkspace = useMemo(
    () => userWorkspaces.some((w) => w.id === WORKSPACE_ID),
    [userWorkspaces, WORKSPACE_ID],
  );
  useEffect(() => {
    if (!urlParams.workspaceId) return; // no URL workspace → fall through to auth default
    if (userWorkspaces.length === 0) return; // /me not loaded yet
    if (userOwnsThisWorkspace) return; // fine
    if (authWorkspaceId && urlParams.workspaceId !== authWorkspaceId) {
      // eslint-disable-next-line no-console
      console.warn(
        `[auth] URL targets workspace ${urlParams.workspaceId} which isn't yours — redirecting to ${authWorkspaceId}`,
      );
      navigate(`/workspace/${authWorkspaceId}`, { replace: true });
    }
  }, [urlParams.workspaceId, userWorkspaces, userOwnsThisWorkspace, authWorkspaceId, navigate]);

  useEffect(() => {
    const { artifactType, artifactId } = urlParams;
    if (!artifactType || !artifactId) return;
    // Map URL artifactType → TreeItemType (they're mostly the same)
    const mapped: TreeItemType | null =
      artifactType === "table" ? "table"
      : artifactType === "idea" ? "idea"
      : artifactType === "design" ? "design"
      : artifactType === "demo" ? "demo"
      : null;
    if (!mapped) return;
    if (activeTableId !== artifactId) setActiveTableId(artifactId);
    if (activeItemType !== mapped) setActiveItemType(mapped);
  }, [urlParams.artifactType, urlParams.artifactId]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Push state-driven changes back to the URL. Used everywhere that was
  // previously calling `setActiveTableId + setActiveItemType` as a pair.
  const navigateToArtifact = useCallback(
    (type: TreeItemType, id: string) => {
      const ws = urlParams.workspaceId || authWorkspaceId || WORKSPACE_ID;
      const urlType =
        type === "table" ? "table"
        : type === "idea" ? "idea"
        : type === "design" ? "design"
        : type === "demo" ? "demo"
        : null;
      if (!urlType) return;
      navigate(`/workspace/${ws}/${urlType}/${id}`);
    },
    [navigate, urlParams.workspaceId, authWorkspaceId, WORKSPACE_ID],
  );

  // Note: we do NOT have a state→URL sync effect. Prior experiment showed it
  // re-fires infinitely because `useParams()` returns a new object reference
  // every render and including it in deps triggers each cycle. Instead,
  // user-intent handlers (handleSelectItem, mention chip clicks, create flows)
  // call navigateToArtifact() **directly** after their setState calls. The
  // URL→state effect above handles back/forward + direct URL entry.

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

  // Sidebar 折叠状态 —— 用户关掉后整个 .sidebar 不渲染（没有动画压缩,直接消失）；
  // TopBar 显示一个 expand icon 让用户重新展开。
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("sidebar_collapsed_v1") === "true"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("sidebar_collapsed_v1", String(sidebarCollapsed)); } catch { /* ignore */ }
  }, [sidebarCollapsed]);

  // Phase 4 Day 3 — unread inbox count for the four-pointed star button.
  // Polled every 30 s; also refetched whenever the chat drawer opens/closes so
  // the badge clears promptly after the user reads messages inside the chat.
  const [agentUnread, setAgentUnread] = useState<number>(0);
  useEffect(() => {
    if (!AGENT_ID) return; // /me 还没加载完，agent 未知 —— 先不 poll
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
  }, [chatAgentOpen, AGENT_ID]);

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
  /**
   * Idea-delete confirmation — separate from the table-scoped confirmDialog
   * above because deletes of idea docs need a 2-step flow that first fetches
   * incoming mentions (so the user sees which other docs point at it and
   * will turn into dead links). `loading` covers the GET /api/mentions/reverse
   * round-trip so the button spinner renders correctly even when the reverse
   * lookup is slow. `refs` is an empty list when nothing links here.
   */
  const [ideaDeleteConfirm, setIdeaDeleteConfirm] = useState<{
    open: boolean;
    ideaId: string | null;
    refs: IncomingMentionRef[];
    total: number;
    loading: boolean;
  }>({ open: false, ideaId: null, refs: [], total: 0, loading: false });
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

  // Load initial data: workspace tree → decide active artifact → load it.
  //
  // Selection precedence (first-match wins):
  //   1. URL-carried artifact (?/workspace/:ws/:type/:id) — user arrived via
  //      deep link, back/forward, or a deliberate refresh on a non-root URL.
  //      We honour the URL as-is, don't override.
  //   2. lastActiveArtifact_v2 in localStorage — refresh on a root URL
  //      restores whichever artifact (table / idea / design / demo) was
  //      active before reload. Promoted to the URL via navigateToArtifact
  //      so subsequent refreshes at the new URL stay stable.
  //   3. Legacy lastActiveTableId in localStorage — backward-compat for
  //      users whose only stored preference is a table id.
  //   4. First table in the workspace tree — fresh entry.
  //
  // Non-table artifacts (idea / design / demo) only need state + URL set;
  // their respective panels (IdeaEditor / SvgCanvas / DemoPreviewPanel)
  // fetch their own detail from the active id. Tables are loaded inline
  // here because fields/records/views feed the main TableView.
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
      setDocumentIdeas((treeData.ideas || []).map(i => ({ ...i, parentId: i.parentId ?? null })));
      // Vibe Demo V1 — fetched separately (not part of /tree endpoint yet).
      // Await here (not fire-and-forget) because we may need to resolve a
      // persisted lastActiveArtifact_v2 of type "demo" against this list.
      let demos: Array<{
        id: string; name: string; order: number; parentId: string | null; publishSlug: string | null;
      }> = [];
      try {
        const fetched = await listDemos(WORKSPACE_ID);
        demos = fetched.map((d) => ({
          id: d.id, name: d.name, order: d.order,
          parentId: d.parentId ?? null, publishSlug: d.publishSlug ?? null,
        }));
        setDocumentDemos(demos);
      } catch { /* sidebar demos stay empty */ }
      const ideas = (treeData.ideas || []).map(i => ({ ...i, parentId: i.parentId ?? null }));
      const designs = (treeData.designs || []).map(d => ({ ...d, parentId: d.parentId ?? null }));
      if (doc) setDocumentName(doc.name);

      // ── Pick a target artifact ─────────────────────────────────────────
      type Target =
        | { type: "table"; id: string }
        | { type: "idea"; id: string }
        | { type: "design"; id: string }
        | { type: "demo"; id: string };
      let target: Target | null = null;

      // 1. URL
      const urlType = urlParams.artifactType;
      const urlId = urlParams.artifactId;
      if (urlType && urlId) {
        if (urlType === "table" && tables.find(t => t.id === urlId)) target = { type: "table", id: urlId };
        else if (urlType === "idea" && ideas.find(i => i.id === urlId)) target = { type: "idea", id: urlId };
        else if (urlType === "design" && designs.find(d => d.id === urlId)) target = { type: "design", id: urlId };
        else if (urlType === "demo" && demos.find(d => d.id === urlId)) target = { type: "demo", id: urlId };
        // else: URL references a now-deleted artifact — fall through to
        // localStorage / first-table. We intentionally don't navigate the
        // URL yet; if we end up with a different target, the
        // `navigateToArtifact` call below replaces the URL cleanly.
      }

      // 2. lastActiveArtifact_v2
      if (!target) {
        try {
          const stored = localStorage.getItem("lastActiveArtifact_v2");
          if (stored) {
            const parsed = JSON.parse(stored) as { type?: string; id?: string };
            if (parsed?.type && parsed?.id) {
              if (parsed.type === "table" && tables.find(t => t.id === parsed.id)) target = { type: "table", id: parsed.id };
              else if (parsed.type === "idea" && ideas.find(i => i.id === parsed.id)) target = { type: "idea", id: parsed.id };
              else if (parsed.type === "design" && designs.find(d => d.id === parsed.id)) target = { type: "design", id: parsed.id };
              else if (parsed.type === "demo" && demos.find(d => d.id === parsed.id)) target = { type: "demo", id: parsed.id };
            }
          }
        } catch { /* bad JSON — ignore */ }
      }

      // 3. Legacy lastActiveTableId
      if (!target) {
        const legacy = localStorage.getItem("lastActiveTableId");
        if (legacy && tables.find(t => t.id === legacy)) target = { type: "table", id: legacy };
      }

      // 4. First table fallback
      if (!target && tables.length > 0) target = { type: "table", id: tables[0].id };

      if (!target) return; // empty workspace — nothing to select

      // ── Apply selection ───────────────────────────────────────────────
      setActiveTableId(target.id);
      setActiveItemType(target.type);
      // Reflect into URL if the URL doesn't already match — needed for
      // localStorage-restored / first-table-fallback paths so refresh stays
      // on the artifact.
      if (target.id !== urlId || target.type !== urlType) {
        navigateToArtifact(target.type, target.id);
      }

      // Tables need their fields/records/views loaded here because the main
      // TableView reads them from App state. Other artifact types own their
      // own load inside their panel, so we stop here for non-tables.
      if (target.type === "table") {
        const tbl = tables.find(t => t.id === target!.id);
        if (tbl) setTableName(tbl.name);

        const [f, r, v] = await Promise.all([
          fetchFields(target.id),
          fetchRecords(target.id),
          fetchViews(target.id),
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
      }
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ── Add a single empty record ──
  // position: "start" → 插到第一行（top toolbar 用）、"end" → 末行（table 底部 +）
  // 服务端按 createdAt asc 返回，所以 end 是天然位置；start 是 FE-only 视觉插入,
  // 刷新后会回到 end —— 后续要持久化"首行"需要在 backend 加 order 字段。
  const handleAddRecord = useCallback(async (position: "start" | "end" = "end"): Promise<string> => {
    const tableId = activeTableIdRef.current;
    const record = await createRecord(tableId, {});
    setAllRecords(prev => {
      if (prev.some(r => r.id === record.id)) return prev;
      return position === "start" ? [record, ...prev] : [...prev, record];
    });
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
    const ideaItems: SidebarItem[] = documentIdeas.map(i => ({
      id: i.id,
      type: "idea" as const,
      displayName: i.name,
      active: i.id === activeTableId && activeItemType === "idea",
      order: i.order,
      parentId: i.parentId,
    }));
    // Vibe Demo V1 — 4th artifact type in sidebar. Display name is plain —
    // publish status lives in the preview panel toolbar, not the sidebar
    // row, per product decision.
    const demoItems: SidebarItem[] = documentDemos.map(d => ({
      id: d.id,
      type: "demo" as const,
      displayName: d.name,
      active: d.id === activeTableId && activeItemType === "demo",
      order: d.order,
      parentId: d.parentId,
    }));
    // 不再显示 "Dashboard / Workflow" 两个静态占位项（产品决策：这两个
    // 功能目前没有实现，占位会误导用户）。
    return [...folderItems, ...tableItems, ...designItems, ...ideaItems, ...demoItems];
  }, [documentTables, documentFolders, documentDesigns, documentIdeas, documentDemos, activeTableId, activeItemType, tableName, sidebarNames, t]);

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
    const ideaUpdates = updates.filter(u => u.type === "idea");
    const demoUpdates = updates.filter(u => u.type === "demo");

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
    if (ideaUpdates.length > 0) {
      const orderMap = new Map(ideaUpdates.map(u => [u.id, u.order]));
      setDocumentIdeas(prev =>
        prev.map(i => orderMap.has(i.id) ? { ...i, order: orderMap.get(i.id)! } : i)
            .sort((a, b) => a.order - b.order)
      );
    }
    if (demoUpdates.length > 0) {
      const orderMap = new Map(demoUpdates.map(u => [u.id, u.order]));
      setDocumentDemos(prev =>
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
      if (ideaUpdates.length > 0) {
        calls.push(reorderIdeas(ideaUpdates.map(u => ({ id: u.id, order: u.order })), WORKSPACE_ID));
      }
      if (demoUpdates.length > 0) {
        calls.push(reorderDemos(demoUpdates.map(u => ({ id: u.id, order: u.order })), WORKSPACE_ID));
      }
      await Promise.all(calls);
    } catch {
      toast.error(t("toast.reorderFailed"));
      fetchWorkspaceTree(WORKSPACE_ID).then(tree => {
        setDocumentTables(tree.tables.map(t => ({ ...t, parentId: t.parentId ?? null })));
        setDocumentFolders(tree.folders);
        setDocumentDesigns((tree.designs || []).map(d => ({ ...d, parentId: d.parentId ?? null })));
        setDocumentIdeas((tree.ideas || []).map(i => ({ ...i, parentId: i.parentId ?? null })));
      });
      // Demos are fetched separately (not part of /tree yet) — refetch in
      // parallel so an errant reorder rolls back to canonical order.
      listDemos(WORKSPACE_ID).then(demos =>
        setDocumentDemos(demos.map(d => ({
          id: d.id, name: d.name, order: d.order,
          parentId: d.parentId, publishSlug: d.publishSlug,
        })))
      ).catch(() => { /* ignore */ });
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

  // ── Create idea (Markdown document artifact) ──
  const handleCreateIdea = useCallback(async (): Promise<string> => {
    try {
      // Backend generates the default name + dedup suffix, so we just pass
      // the localised base name ("灵感" / "Idea").
      const baseName = t("createMenu.doc");
      const idea = await apiCreateIdea(baseName, WORKSPACE_ID);
      setDocumentIdeas(prev => [...prev, { ...idea, parentId: idea.parentId ?? null }]);
      setActiveTableId(idea.id);
      setActiveItemType("idea");
      setFocusEntity(null);
      return idea.id;
    } catch (err) {
      toast.error((err as Error).message || t("toast.createTableFailed"));
      throw err;
    }
  }, [toast, t]);

  // ── Delete item (folder, design, or idea) ──
  const handleDeleteItem = useCallback(async (id: string, type: TreeItemType) => {
    try {
      if (type === "folder") {
        await apiDeleteFolder(id);
        setDocumentFolders(prev => prev.filter(f => f.id !== id));
        // Move children to root
        setDocumentTables(prev => prev.map(t => t));
        setDocumentDesigns(prev => prev.map(d => d.parentId === id ? { ...d, parentId: null } : d));
        setDocumentIdeas(prev => prev.map(i => i.parentId === id ? { ...i, parentId: null } : i));
      } else if (type === "design") {
        await apiDeleteDesign(id);
        setDocumentDesigns(prev => prev.filter(d => d.id !== id));
        if (id === activeTableId) {
          const firstTable = documentTables[0];
          if (firstTable) {
            setActiveTableId(firstTable.id);
            setActiveItemType("table");
            switchTable(firstTable.id);
          }
        }
      } else if (type === "demo") {
        await apiDeleteDemo(id);
        setDocumentDemos(prev => prev.filter(d => d.id !== id));
        if (id === activeTableId) {
          const firstTable = documentTables[0];
          if (firstTable) {
            setActiveTableId(firstTable.id);
            setActiveItemType("table");
            switchTable(firstTable.id);
          }
        }
      } else if (type === "idea") {
        // Ideas can be targets of @mentions from other ideas. Delete is
        // destructive (those mentions become dead links), so we open the
        // confirmation dialog first and pre-fetch incoming refs so the user
        // sees the blast radius before committing. Actual delete fires from
        // `handleConfirmDeleteIdea` below.
        setIdeaDeleteConfirm({ open: true, ideaId: id, refs: [], total: 0, loading: true });
        try {
          const { refs, total } = await fetchIncomingMentions(WORKSPACE_ID, "idea", id);
          setIdeaDeleteConfirm(prev =>
            prev.ideaId === id ? { ...prev, refs, total, loading: false } : prev
          );
        } catch {
          // Reverse lookup failed — let the user proceed anyway (the list
          // just shows empty). We deliberately don't toast here because the
          // dialog itself is the feedback surface.
          setIdeaDeleteConfirm(prev =>
            prev.ideaId === id ? { ...prev, loading: false } : prev
          );
        }
      }
    } catch {
      toast.error(t("toast.deleteFailed"));
    }
  }, [activeTableId, documentTables, switchTable, toast, t]);

  // ── Confirm idea deletion (fires from the references-aware ConfirmDialog) ──
  const handleConfirmDeleteIdea = useCallback(async () => {
    const id = ideaDeleteConfirm.ideaId;
    if (!id) return;
    setIdeaDeleteConfirm({ open: false, ideaId: null, refs: [], total: 0, loading: false });
    try {
      await apiDeleteIdea(id);
      setDocumentIdeas(prev => prev.filter(i => i.id !== id));
      if (id === activeTableId) {
        const firstTable = documentTables[0];
        if (firstTable) {
          setActiveTableId(firstTable.id);
          setActiveItemType("table");
          switchTable(firstTable.id);
        }
      }
    } catch {
      toast.error(t("toast.deleteFailed"));
    }
  }, [ideaDeleteConfirm.ideaId, activeTableId, documentTables, switchTable, toast, t]);

  // ── Move item ──
  const handleMoveItem = useCallback(async (itemId: string, itemType: "table" | "folder" | "design" | "idea" | "demo", newParentId: string | null) => {
    // Optimistic update FIRST
    if (itemType === "table") {
      setDocumentTables(prev => prev.map(t => t.id === itemId ? { ...t, parentId: newParentId } : t));
    } else if (itemType === "folder") {
      setDocumentFolders(prev => prev.map(f => f.id === itemId ? { ...f, parentId: newParentId } : f));
    } else if (itemType === "design") {
      setDocumentDesigns(prev => prev.map(d => d.id === itemId ? { ...d, parentId: newParentId } : d));
    } else if (itemType === "idea") {
      setDocumentIdeas(prev => prev.map(i => i.id === itemId ? { ...i, parentId: newParentId } : i));
    } else if (itemType === "demo") {
      setDocumentDemos(prev => prev.map(d => d.id === itemId ? { ...d, parentId: newParentId } : d));
    }
    try {
      await apiMoveItem(itemId, itemType, newParentId);
    } catch {
      // Rollback — refetch tree
      const treeData = await fetchWorkspaceTree(WORKSPACE_ID);
      setDocumentTables(treeData.tables.map(t => ({ ...t, parentId: t.parentId ?? null })));
      setDocumentFolders(treeData.folders);
      setDocumentDesigns((treeData.designs || []).map(d => ({ ...d, parentId: d.parentId ?? null })));
      setDocumentIdeas((treeData.ideas || []).map(i => ({ ...i, parentId: i.parentId ?? null })));
      listDemos(WORKSPACE_ID).then(demos =>
        setDocumentDemos(demos.map(d => ({
          id: d.id, name: d.name, order: d.order,
          parentId: d.parentId, publishSlug: d.publishSlug,
        })))
      ).catch(() => { /* ignore */ });
      toast.error(t("toast.reorderFailed"));
    }
  }, [toast, t]);

  // ── Select item (table, design, idea, or demo) ──
  const handleSelectItem = useCallback((id: string, type?: TreeItemType) => {
    if (type === "design") {
      setActiveTableId(id);
      setActiveItemType("design");
      setFocusEntity(null);
      navigateToArtifact("design", id);
    } else if (type === "idea") {
      setActiveTableId(id);
      setActiveItemType("idea");
      setFocusEntity(null);
      navigateToArtifact("idea", id);
    } else if (type === "demo") {
      setActiveTableId(id);
      setActiveItemType("demo");
      setFocusEntity(null);
      navigateToArtifact("demo", id);
    } else if (type === "folder") {
      // Folders are not selectable as content
      return;
    } else {
      const isTable = documentTables.some(t => t.id === id);
      if (isTable) {
        setActiveItemType("table");
        setFocusEntity(null);
        switchTable(id);
        navigateToArtifact("table", id);
      }
    }
  }, [documentTables, switchTable, navigateToArtifact]);

  // ── Navigate to a mentioned entity (from an @mention chip click) ──
  // v2 mention scope: view / taste / idea. View = open the parent table and
  // switch its active view. Taste = open the parent design and flag the SVG
  // for highlight (consumed by SvgCanvas on next render). Idea = open the
  // target idea document.
  const handleNavigateToEntity = useCallback((target:
    | { type: "view";  tableId: string; viewId: string }
    | { type: "taste"; designId: string; tasteId: string }
    | { type: "idea";  id: string }
    | { type: "idea-section"; ideaId: string; headingSlug: string }
  ) => {
    if (target.type === "view") {
      setActiveItemType("table");
      setFocusEntity({ type: "view", id: target.viewId });
      setActiveViewId(target.viewId);
      void switchTable(target.tableId);
      navigateToArtifact("table", target.tableId);
    } else if (target.type === "taste") {
      setActiveTableId(target.designId);
      setActiveItemType("design");
      setFocusEntity({ type: "taste", id: target.tasteId });
      navigateToArtifact("design", target.designId);
    } else if (target.type === "idea") {
      setActiveTableId(target.id);
      setActiveItemType("idea");
      setFocusEntity(null);
      navigateToArtifact("idea", target.id);
    } else if (target.type === "idea-section") {
      // Open the parent idea and stash the heading slug on `window` so the
      // IdeaEditor that mounts (or is already mounted) can pick it up and
      // scroll. Using a window-scoped handoff avoids routing the anchor
      // through every intermediate state atom.
      (window as unknown as { __pendingIdeaAnchor?: { ideaId: string; slug: string } })
        .__pendingIdeaAnchor = { ideaId: target.ideaId, slug: target.headingSlug };
      setActiveTableId(target.ideaId);
      setActiveItemType("idea");
      setFocusEntity(null);
      navigateToArtifact("idea", target.ideaId);
      // Fire a DOM event so an already-mounted IdeaEditor for the same idea
      // (common case: jumping between sections in the same doc) can re-scroll
      // without waiting for an unmount cycle.
      window.dispatchEvent(new CustomEvent("idea-anchor", {
        detail: { ideaId: target.ideaId, slug: target.headingSlug },
      }));
    }
  }, [switchTable, navigateToArtifact]);

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
    // Check if it's an idea
    const isIdea = documentIdeas.some(i => i.id === itemId);
    if (isIdea) {
      setDocumentIdeas(prev => prev.map(i => i.id === itemId ? { ...i, name: newName } : i));
      try {
        await apiRenameIdea(itemId, newName);
      } catch {
        toast.error(t("toast.renameFailed"));
      }
      return;
    }
    // Check if it's a demo
    const isDemo = documentDemos.some(d => d.id === itemId);
    if (isDemo) {
      setDocumentDemos(prev => prev.map(d => d.id === itemId ? { ...d, name: newName } : d));
      try {
        await apiRenameDemo(itemId, newName);
      } catch {
        toast.error(t("toast.renameFailed"));
      }
      return;
    }
    // Fall through to original handler (tables + statics)
    handleRenameSidebarItem(itemId, newName);
  }, [documentFolders, documentDesigns, documentIdeas, documentDemos, handleRenameSidebarItem, toast, t]);

  // ── Persist active artifact (type + id) to localStorage ──
  // Used on next load to restore the previously-selected artifact when the
  // URL doesn't already carry it (e.g. user lands on /workspace/doc_default
  // from the shortcut). Stored as JSON {type, id}; legacy "lastActiveTableId"
  // is kept in sync as a fallback for any older code path that still reads it.
  useEffect(() => {
    if (!activeTableId) return;
    try {
      localStorage.setItem(
        "lastActiveArtifact_v2",
        JSON.stringify({ type: activeItemType, id: activeTableId })
      );
      if (activeItemType === "table") {
        localStorage.setItem("lastActiveTableId", activeTableId);
      }
    } catch { /* quota / disabled — swallow */ }
  }, [activeTableId, activeItemType]);

  // ── Keep tableName in sync with the active table's entry in documentTables.
  // Acts as a safety net for paths that bump activeTableId before the
  // workspace-level SSE `table:create` event has flushed into documentTables
  // (e.g. the Agent's `create_table` tool → onActiveTableChange → switchTable
  // fires before SSE arrives, so switchTable's documentTables.find() returns
  // undefined and the header ends up pinned at the previously-displayed name).
  // As soon as documentTables catches up, this effect re-runs and corrects the
  // header label without needing a manual refresh.
  useEffect(() => {
    if (!activeTableId) return;
    const tbl = documentTables.find(t => t.id === activeTableId);
    if (tbl && tbl.name !== tableName) setTableName(tbl.name);
    // Intentionally not depending on `tableName` — we only want this effect to
    // fire when the active id or the table list changes. Otherwise it would
    // fight optimistic renames (which setTableName directly) during the brief
    // window between optimistic update and SSE echo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTableId, documentTables]);

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
    onIdeaCreate: useCallback((idea: { id: string; name: string; parentId: string | null; order: number }) => {
      setDocumentIdeas(prev =>
        prev.some(i => i.id === idea.id)
          ? prev
          : [...prev, { ...idea, workspaceId: WORKSPACE_ID }].sort((a, b) => a.order - b.order)
      );
    }, []),
    onIdeaDelete: useCallback((ideaId: string) => {
      setDocumentIdeas(prev => prev.filter(i => i.id !== ideaId));
    }, []),
    onIdeaRename: useCallback((ideaId: string, name: string) => {
      setDocumentIdeas(prev => prev.map(i => i.id === ideaId ? { ...i, name } : i));
    }, []),
    onIdeaReorder: useCallback((updates: Array<{ id: string; order: number }>) => {
      setDocumentIdeas(prev => {
        const orderMap = new Map(updates.map(u => [u.id, u.order]));
        return prev.map(i => orderMap.has(i.id) ? { ...i, order: orderMap.get(i.id)! } : i)
                    .sort((a, b) => a.order - b.order);
      });
    }, []),
    onDemoCreate: useCallback((demo: { id: string; name: string; parentId: string | null; order: number }) => {
      setDocumentDemos((prev) =>
        prev.some((d) => d.id === demo.id)
          ? prev
          : [...prev, { ...demo, publishSlug: null }].sort((a, b) => a.order - b.order),
      );
    }, []),
    onDemoDelete: useCallback((demoId: string) => {
      setDocumentDemos((prev) => prev.filter((d) => d.id !== demoId));
    }, []),
    onDemoRename: useCallback((demoId: string, name: string) => {
      setDocumentDemos((prev) => prev.map((d) => (d.id === demoId ? { ...d, name } : d)));
    }, []),
    onDemoReorder: useCallback((updates: Array<{ id: string; order: number }>) => {
      setDocumentDemos((prev) => {
        const orderMap = new Map(updates.map((u) => [u.id, u.order]));
        return prev
          .map((d) => (orderMap.has(d.id) ? { ...d, order: orderMap.get(d.id)! } : d))
          .sort((a, b) => a.order - b.order);
      });
    }, []),
    onDemoPublish: useCallback((demoId: string, slug: string) => {
      setDocumentDemos((prev) => prev.map((d) => (d.id === demoId ? { ...d, publishSlug: slug } : d)));
    }, []),
    onDemoUnpublish: useCallback((demoId: string) => {
      setDocumentDemos((prev) => prev.map((d) => (d.id === demoId ? { ...d, publishSlug: null } : d)));
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
    <SidebarToggleProvider value={{
      collapsed: sidebarCollapsed,
      onToggle: () => setSidebarCollapsed((v) => !v),
      expandTitle: t("sidebar.expand"),
    }}>
    <div className="app">
      <TopBar
        tableName={tableName}
        documentName={documentName}
        workspaceId={WORKSPACE_ID}
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
        {!sidebarCollapsed && (
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
            onCreateIdea={handleCreateIdea}
            onDeleteItem={handleDeleteItem}
            onMoveItem={handleMoveItem}
            scrollToItemId={scrollToItemId}
            onCollapse={() => setSidebarCollapsed(true)}
          />
        )}
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
                workspaceId={WORKSPACE_ID}
                onRename={(name) => handleRenameSidebarItemExtended(activeTableId, name)}
              />
            );
          })()}
          {/* Idea Editor — shown when an idea artifact is active */}
          {activeItemType === "idea" && (() => {
            const idea = documentIdeas.find(x => x.id === activeTableId);
            if (!idea) return null;
            return (
              <IdeaEditor
                key={activeTableId}
                ideaId={activeTableId}
                ideaName={idea.name}
                workspaceId={WORKSPACE_ID}
                clientId={CLIENT_ID}
                onRename={(name) => handleRenameSidebarItemExtended(activeTableId, name)}
                onNavigate={handleNavigateToEntity}
              />
            );
          })()}
          {/* Vibe Demo preview — shown when a demo artifact is active */}
          {activeItemType === "demo" && (() => {
            const demo = documentDemos.find((x) => x.id === activeTableId);
            if (!demo) return null;
            return (
              <DemoPreviewPanel
                key={activeTableId}
                demoId={activeTableId}
                workspaceId={WORKSPACE_ID}
              />
            );
          })()}
          {activeItemType !== "design" && activeItemType !== "idea" && activeItemType !== "demo" && (
          <>
          {/* ViewTabs 已废弃 —— 表名 + filter apply pill 全部进入 Toolbar 顶栏 */}
          <Toolbar
            tableName={tableName}
            onRenameTable={(name) => handleRenameSidebarItem(activeTableId, name)}
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
      <ConfirmDialog
        open={ideaDeleteConfirm.open}
        title={t("confirm.deleteIdeaTitle")}
        message={t("confirm.deleteIdeaMsg")}
        confirmLabel={t("confirm.delete")}
        cancelLabel={t("confirm.cancel")}
        variant="danger"
        references={ideaDeleteConfirm.refs.map<ConfirmReference>(r => ({
          sourceLabel: r.sourceLabel,
          contextExcerpt: r.contextExcerpt,
        }))}
        referencesTotal={ideaDeleteConfirm.total}
        onConfirm={handleConfirmDeleteIdea}
        onCancel={() => setIdeaDeleteConfirm({ open: false, ideaId: null, refs: [], total: 0, loading: false })}
      />
    </div>
    </SidebarToggleProvider>
  );
}
