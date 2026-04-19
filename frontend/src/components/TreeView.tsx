import { useState, useRef, useCallback, useEffect, useMemo, ReactNode } from "react";
import { useTranslation } from "../i18n/index";
import InlineEdit from "./InlineEdit";
import DropdownMenu from "./DropdownMenu";
import type { MenuItem } from "./DropdownMenu";
import type { TreeItemType } from "../types";

// ─── Icons ───

/* Folder chevrons — 16x16 to match tree-icon size, so folder rows have
 * a single icon (the chevron) instead of chevron + separate folder icon. */
const CHEVRON_RIGHT_16 = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M6.195 3.528a.667.667 0 01.943 0l4 4a.667.667 0 010 .944l-4 4a.667.667 0 11-.943-.944L9.724 8 6.195 4.472a.667.667 0 010-.944z" fill="currentColor"/>
  </svg>
);

const CHEVRON_DOWN_16 = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M3.528 6.195a.667.667 0 01.944 0L8 9.724l3.528-3.529a.667.667 0 11.944.944l-4 4a.667.667 0 01-.944 0l-4-4a.667.667 0 010-.944z" fill="currentColor"/>
  </svg>
);

/* Table icon: reuses the original Sidebar ICONS.table with currentColor */
const TABLE_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.33337 2.66671C1.33337 1.93033 1.93033 1.33337 2.66671 1.33337H13.3334C14.0698 1.33337 14.6667 1.93033 14.6667 2.66671V13.3334C14.6667 14.0698 14.0698 14.6667 13.3334 14.6667H2.66671C1.93033 14.6667 1.33337 14.0698 1.33337 13.3334V2.66671ZM2.66671 2.66671V13.3334H13.3334V2.66671H2.66671Z" fill="currentColor"/><path d="M8.33337 4.66671C7.96518 4.66671 7.66671 4.96518 7.66671 5.33337C7.66671 5.70156 7.96518 6.00004 8.33337 6.00004H11.3334C11.7016 6.00004 12 5.70156 12 5.33337C12 4.96518 11.7016 4.66671 11.3334 4.66671H8.33337Z" fill="currentColor"/><path d="M4.00004 5.33337C4.00004 4.96518 4.29852 4.66671 4.66671 4.66671H6.00004C6.36823 4.66671 6.66671 4.96518 6.66671 5.33337C6.66671 5.70156 6.36823 6.00004 6.00004 6.00004H4.66671C4.29852 6.00004 4.00004 5.70156 4.00004 5.33337Z" fill="currentColor"/><path d="M8.33337 7.33337C7.96518 7.33337 7.66671 7.63185 7.66671 8.00004C7.66671 8.36823 7.96518 8.66671 8.33337 8.66671H11.3334C11.7016 8.66671 12 8.36823 12 8.00004C12 7.63185 11.7016 7.33337 11.3334 7.33337H8.33337Z" fill="currentColor"/><path d="M4.00004 8.00004C4.00004 7.63185 4.29852 7.33337 4.66671 7.33337H6.00004C6.36823 7.33337 6.66671 7.63185 6.66671 8.00004C6.66671 8.36823 6.36823 8.66671 6.00004 8.66671H4.66671C4.29852 8.66671 4.00004 8.36823 4.00004 8.00004Z" fill="currentColor"/><path d="M8.33337 10C7.96518 10 7.66671 10.2985 7.66671 10.6667C7.66671 11.0349 7.96518 11.3334 8.33337 11.3334H11.3334C11.7016 11.3334 12 11.0349 12 10.6667C12 10.2985 11.7016 10 11.3334 10H8.33337Z" fill="currentColor"/><path d="M4.00004 10.6667C4.00004 10.2985 4.29852 10 4.66671 10H6.00004C6.36823 10 6.66671 10.2985 6.66671 10.6667C6.66671 11.0349 6.36823 11.3334 6.00004 11.3334H4.66671C4.29852 11.3334 4.00004 11.0349 4.00004 10.6667Z" fill="currentColor"/></svg>
);

const DESIGN_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2 2.667A1.333 1.333 0 013.333 1.333h9.334A1.333 1.333 0 0114 2.667v10.666A1.333 1.333 0 0112.667 14.667H3.333A1.333 1.333 0 012 13.333V2.667zm1.333 0v10.666h9.334V2.667H3.333z" fill="currentColor"/>
    <path d="M6 6a1.333 1.333 0 100 2.667A1.333 1.333 0 006 6zM3.333 11.333l2.334-3.5 1.666 2.5 2.334-3.5 2.666 4.5H3.333z" fill="currentColor"/>
  </svg>
);

const ALBUM_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2.667 1.333A1.333 1.333 0 001.333 2.667v8A1.333 1.333 0 002.667 12h8a1.333 1.333 0 001.333-1.333v-8A1.333 1.333 0 0010.667 1.333h-8zm0 1.334h8v8h-8v-8z" fill="currentColor"/>
    <path d="M13.333 4v9.333H4v1.334h9.333A1.333 1.333 0 0014.667 13.333V4h-1.334z" fill="currentColor"/>
  </svg>
);

function RenameIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M6 2a1 1 0 00-1 1h6a1 1 0 00-1-1H6zM4 4h8v9a1 1 0 01-1 1H5a1 1 0 01-1-1V4zM3 4h10V3H3v1zM6.5 6v5M9.5 6v5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}

function MoveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M1.333 3.333C1.333 2.597 1.93 2 2.667 2h3.057c.398 0 .775.178 1.027.485L7.838 4h5.495c.737 0 1.334.597 1.334 1.333v7.334c0 .736-.597 1.333-1.334 1.333H2.667c-.737 0-1.334-.597-1.334-1.333V3.333z" stroke="currentColor" strokeWidth="1.2" fill="none"/>
      <path d="M8 7v4M6 9l2-2 2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ─── Types ───

export interface TreeNodeData {
  id: string;
  type: TreeItemType;
  name: string;
  parentId: string | null;
  order: number;
  children?: TreeNodeData[];
}

interface TreeViewProps {
  nodes: TreeNodeData[];
  activeItemId: string;
  onSelectItem: (id: string, type: TreeItemType) => void;
  onRenameItem: (id: string, type: TreeItemType, newName: string) => void;
  onDeleteItem: (id: string, type: TreeItemType) => void;
  onMoveItem: (itemId: string, itemType: "table" | "folder", newParentId: string | null) => void;
  onReorderItems: (updates: Array<{ id: string; order: number }>) => void;
  folders: Array<{ id: string; name: string }>;
}

const INDENT_PX = 20;
const DRAG_THRESHOLD = 4;

export default function TreeView({ nodes, activeItemId, onSelectItem, onRenameItem, onDeleteItem, onMoveItem, onReorderItems, folders }: TreeViewProps) {
  const { t } = useTranslation();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("tree_expanded_ids");
      return stored ? new Set(JSON.parse(stored)) : new Set<string>();
    } catch { return new Set<string>(); }
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [moveMenuId, setMoveMenuId] = useState<string | null>(null);
  const moreRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Drag state — supports reorder (above/below) AND move-to-folder
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPos, setDragOverPos] = useState<"above" | "below" | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; type: TreeItemType; startY: number; isDragging: boolean } | null>(null);
  const dragOverIdRef = useRef<string | null>(null);
  const dragOverPosRef = useRef<"above" | "below" | null>(null);
  const dragOverFolderRef = useRef<string | null>(null);

  // Persist expanded state
  useEffect(() => {
    localStorage.setItem("tree_expanded_ids", JSON.stringify([...expandedIds]));
  }, [expandedIds]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Auto-scroll to active
  useEffect(() => {
    const el = itemRefs.current.get(activeItemId);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeItemId]);

  const getIcon = (type: TreeItemType, id: string): ReactNode => {
    if (type === "folder") return expandedIds.has(id) ? CHEVRON_DOWN_16 : CHEVRON_RIGHT_16;
    if (type === "design") return DESIGN_ICON;
    if (type === "album") return ALBUM_ICON;
    return TABLE_ICON;
  };

  const getContextMenuItems = (node: TreeNodeData): MenuItem[] => {
    const items: MenuItem[] = [
      { key: "rename", label: t("contextMenu.rename"), icon: <RenameIcon /> },
    ];

    // Move to folder submenu (only for non-folder items or for folder items)
    if (folders.length > 0) {
      items.push({ key: "moveTo", label: t("contextMenu.moveTo"), icon: <MoveIcon /> });
    }
    if (node.parentId) {
      items.push({ key: "moveToRoot", label: t("contextMenu.moveToRoot"), icon: <MoveIcon /> });
    }

    items.push({ key: "delete", label: t("contextMenu.delete"), icon: <DeleteIcon /> });
    return items;
  };

  // Collect flat list of root-level item IDs for reorder
  const rootItemIds = useMemo(() => nodes.map(n => n.id), [nodes]);

  // Drag handlers — reorder (above/below siblings) + move-to-folder
  const handleDragMouseDown = useCallback((e: React.MouseEvent, node: TreeNodeData) => {
    if (e.button !== 0) return;
    e.preventDefault();

    dragRef.current = { id: node.id, type: node.type, startY: e.clientY, isDragging: false };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      if (!dragRef.current.isDragging && Math.abs(ev.clientY - dragRef.current.startY) < DRAG_THRESHOLD) return;

      if (!dragRef.current.isDragging) {
        dragRef.current.isDragging = true;
        setDragId(node.id);
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }

      let overId: string | null = null;
      let overPos: "above" | "below" | null = null;
      let overFolder: string | null = null;

      itemRefs.current.forEach((el, id) => {
        if (id === node.id) return;
        const rect = el.getBoundingClientRect();
        if (ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
          const isFolder = el.getAttribute("data-type") === "folder";
          if (isFolder) {
            // Middle third = move into folder; top/bottom thirds = reorder
            const third = rect.height / 3;
            if (ev.clientY > rect.top + third && ev.clientY < rect.bottom - third) {
              overFolder = id;
            } else {
              overId = id;
              overPos = ev.clientY < rect.top + rect.height / 2 ? "above" : "below";
            }
          } else {
            overId = id;
            overPos = ev.clientY < rect.top + rect.height / 2 ? "above" : "below";
          }
        }
      });

      setDragOverId(overId);
      setDragOverPos(overPos);
      setDragOverFolderId(overFolder);
      dragOverIdRef.current = overId;
      dragOverPosRef.current = overPos;
      dragOverFolderRef.current = overFolder;
    };

    const onMouseUp = () => {
      if (dragRef.current?.isDragging) {
        if (dragOverFolderRef.current) {
          // Move into folder
          const itemType = dragRef.current.type === "folder" ? "folder" : "table";
          onMoveItem(node.id, itemType as "table" | "folder", dragOverFolderRef.current);
        } else if (dragOverIdRef.current && dragOverPosRef.current) {
          // Reorder among siblings
          const arr = [...rootItemIds];
          const fromIdx = arr.indexOf(node.id);
          if (fromIdx !== -1) {
            arr.splice(fromIdx, 1);
            let toIdx = arr.indexOf(dragOverIdRef.current);
            if (dragOverPosRef.current === "below") toIdx += 1;
            arr.splice(toIdx, 0, node.id);
            const updates = arr.map((id, i) => ({ id, order: i }));
            onReorderItems(updates);
          }
        }
      }
      dragRef.current = null;
      setDragId(null);
      setDragOverId(null);
      setDragOverPos(null);
      setDragOverFolderId(null);
      dragOverIdRef.current = null;
      dragOverPosRef.current = null;
      dragOverFolderRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [onMoveItem, onReorderItems, rootItemIds]);

  const renderNode = (node: TreeNodeData, depth: number): ReactNode => {
    const isFolder = node.type === "folder";
    const isExpanded = expandedIds.has(node.id);
    const isActive = node.id === activeItemId;
    const isDragging = dragId === node.id;
    const isDragOver = dragOverFolderId === node.id;

    const isReorderOver = dragOverId === node.id;

    let className = "tree-item";
    if (isActive) className += " active";
    if (isDragging) className += " is-dragging";
    if (isDragOver && isFolder) className += " drag-over-folder";
    if (isReorderOver && dragOverPos === "above") className += " drag-over-above";
    if (isReorderOver && dragOverPos === "below") className += " drag-over-below";

    return (
      <div key={node.id}>
        <div
          ref={el => { if (el) { itemRefs.current.set(node.id, el); } else { itemRefs.current.delete(node.id); } }}
          className={className}
          style={depth > 0 ? { paddingLeft: 8 + depth * INDENT_PX } : undefined}
          data-type={node.type}
          onClick={() => {
            if (isFolder) {
              toggleExpand(node.id);
            } else {
              onSelectItem(node.id, node.type);
            }
          }}
          onMouseDown={(e) => handleDragMouseDown(e, node)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditingId(node.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuId(menuId === node.id ? null : node.id);
          }}
        >
          {/* For folders the icon IS the chevron; for files, just the type icon */}
          <span className="tree-icon">{getIcon(node.type, node.id)}</span>

          <span className="tree-label">
            <InlineEdit
              value={node.name}
              isEditing={editingId === node.id}
              onStartEdit={() => setEditingId(node.id)}
              onSave={(name) => {
                setEditingId(null);
                onRenameItem(node.id, node.type, name);
              }}
              onCancelEdit={() => setEditingId(null)}
              className="tree-edit"
            />
          </span>

          <span
            className="tree-item-more"
            role="button"
            ref={el => { if (el) moreRefs.current.set(node.id, el); }}
            onClick={(e) => {
              e.stopPropagation();
              setMenuId(menuId === node.id ? null : node.id);
            }}
          >
            <svg width="14" height="14" viewBox="207 119 4 14" fill="none">
              <path d="M209 122.208C208.436 122.208 207.979 121.751 207.979 121.187C207.979 120.624 208.436 120.167 209 120.167C209.564 120.167 210.021 120.624 210.021 121.187C210.021 121.751 209.564 122.208 209 122.208Z" fill="currentColor"/>
              <path d="M209 127.006C208.436 127.006 207.979 126.549 207.979 125.985C207.979 125.422 208.436 124.965 209 124.965C209.564 124.965 210.021 125.422 210.021 125.985C210.021 126.549 209.564 127.006 209 127.006Z" fill="currentColor"/>
              <path d="M209 131.833C208.436 131.833 207.979 131.376 207.979 130.812C207.979 130.249 208.436 129.792 209 129.792C209.564 129.792 210.021 130.249 210.021 130.812C210.021 131.376 209.564 131.833 209 131.833Z" fill="currentColor"/>
            </svg>
          </span>

          {menuId === node.id && moreRefs.current.get(node.id) && (
            <DropdownMenu
              items={getContextMenuItems(node)}
              anchorEl={moreRefs.current.get(node.id)!}
              onSelect={(key) => {
                setMenuId(null);
                if (key === "rename") setEditingId(node.id);
                else if (key === "delete") onDeleteItem(node.id, node.type);
                else if (key === "moveToRoot") onMoveItem(node.id, node.type === "folder" ? "folder" : "table", null);
                else if (key === "moveTo") setMoveMenuId(node.id);
              }}
              onClose={() => setMenuId(null)}
              width={180}
            />
          )}

          {moveMenuId === node.id && moreRefs.current.get(node.id) && (
            <DropdownMenu
              items={folders
                .filter(f => f.id !== node.id && f.id !== node.parentId)
                .map(f => ({ key: f.id, label: f.name, icon: CHEVRON_RIGHT_16 }))}
              anchorEl={moreRefs.current.get(node.id)!}
              onSelect={(folderId) => {
                setMoveMenuId(null);
                onMoveItem(node.id, node.type === "folder" ? "folder" : "table", folderId);
              }}
              onClose={() => setMoveMenuId(null)}
              width={180}
            />
          )}
        </div>

        {/* Render children if folder is expanded */}
        {isFolder && isExpanded && node.children && (
          <div className="tree-children">
            {node.children.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="tree-view">
      {nodes.map(node => renderNode(node, 0))}
    </div>
  );
}
