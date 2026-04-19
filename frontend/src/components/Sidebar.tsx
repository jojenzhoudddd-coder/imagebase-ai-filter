import { useState, useRef, useCallback, useEffect, ReactNode } from "react";
import { useTranslation } from "../i18n/index";
import InlineEdit from "./InlineEdit";
import DropdownMenu from "./DropdownMenu";
import type { MenuItem } from "./DropdownMenu";
import ConfirmDialog from "./ConfirmDialog/index";
import CreateTablePopover from "./CreateTablePopover";
import type { CreateTablePopoverHandle } from "./CreateTablePopover";
import CreateDesignPopover from "./CreateDesignPopover";
import type { CreateDesignPopoverHandle } from "./CreateDesignPopover";
import TreeView from "./TreeView";
import type { TreeNodeData } from "./TreeView";
import type { GeneratedField } from "../api";
import type { TreeItemType } from "../types";
import "./Sidebar.css";
import "./TreeView.css";

export interface SidebarItem {
  id: string;
  type: TreeItemType | "static";
  displayName: string;
  active: boolean;
  order: number;
  parentId?: string | null;
}

interface Props {
  items: SidebarItem[];
  onRenameItem: (id: string, newName: string) => void;
  activeItemId: string;
  onSelectItem: (id: string, type?: TreeItemType) => void;
  onReorderItems: (updates: Array<{ id: string; type: TreeItemType; order: number }>) => void;
  onDeleteTable: (id: string) => void;
  tableCount: number;
  onCreateWithAI: (tableName: string, fields: GeneratedField[]) => Promise<string>;
  onResetToDefault: (tableId: string, tableName: string) => Promise<void>;
  onCreateBlank: () => Promise<void>;
  folders?: Array<{ id: string; name: string }>;
  onCreateFolder?: () => void;
  onCreateDesign?: (name: string, figmaUrl: string) => Promise<string>;
  onDeleteItem?: (id: string, type: TreeItemType) => void;
  onMoveItem?: (itemId: string, itemType: "table" | "folder" | "design", newParentId: string | null) => void;
  /** When set, the TreeView scrolls the node with this id into view on the
   * next render. Used after creating a folder (which cannot become the active
   * item) so the user can see where the new node landed. */
  scrollToItemId?: string | null;
}

const DRAG_THRESHOLD = 4;

/* ── Sidebar item icons (use currentColor to inherit active/hover color) ── */
const ICONS: Record<string, ReactNode> = {
  table: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.33337 2.66671C1.33337 1.93033 1.93033 1.33337 2.66671 1.33337H13.3334C14.0698 1.33337 14.6667 1.93033 14.6667 2.66671V13.3334C14.6667 14.0698 14.0698 14.6667 13.3334 14.6667H2.66671C1.93033 14.6667 1.33337 14.0698 1.33337 13.3334V2.66671ZM2.66671 2.66671V13.3334H13.3334V2.66671H2.66671Z" fill="currentColor"/><path d="M8.33337 4.66671C7.96518 4.66671 7.66671 4.96518 7.66671 5.33337C7.66671 5.70156 7.96518 6.00004 8.33337 6.00004H11.3334C11.7016 6.00004 12 5.70156 12 5.33337C12 4.96518 11.7016 4.66671 11.3334 4.66671H8.33337Z" fill="currentColor"/><path d="M4.00004 5.33337C4.00004 4.96518 4.29852 4.66671 4.66671 4.66671H6.00004C6.36823 4.66671 6.66671 4.96518 6.66671 5.33337C6.66671 5.70156 6.36823 6.00004 6.00004 6.00004H4.66671C4.29852 6.00004 4.00004 5.70156 4.00004 5.33337Z" fill="currentColor"/><path d="M8.33337 7.33337C7.96518 7.33337 7.66671 7.63185 7.66671 8.00004C7.66671 8.36823 7.96518 8.66671 8.33337 8.66671H11.3334C11.7016 8.66671 12 8.36823 12 8.00004C12 7.63185 11.7016 7.33337 11.3334 7.33337H8.33337Z" fill="currentColor"/><path d="M4.00004 8.00004C4.00004 7.63185 4.29852 7.33337 4.66671 7.33337H6.00004C6.36823 7.33337 6.66671 7.63185 6.66671 8.00004C6.66671 8.36823 6.36823 8.66671 6.00004 8.66671H4.66671C4.29852 8.66671 4.00004 8.36823 4.00004 8.00004Z" fill="currentColor"/><path d="M8.33337 10C7.96518 10 7.66671 10.2985 7.66671 10.6667C7.66671 11.0349 7.96518 11.3334 8.33337 11.3334H11.3334C11.7016 11.3334 12 11.0349 12 10.6667C12 10.2985 11.7016 10 11.3334 10H8.33337Z" fill="currentColor"/><path d="M4.00004 10.6667C4.00004 10.2985 4.29852 10 4.66671 10H6.00004C6.36823 10 6.66671 10.2985 6.66671 10.6667C6.66671 11.0349 6.36823 11.3334 6.00004 11.3334H4.66671C4.29852 11.3334 4.00004 11.0349 4.00004 10.6667Z" fill="currentColor"/></svg>
  ),
  dashboard: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.33 3.201C4.1 2.936 3.699 2.894 3.443 3.134C2.145 4.351 1.333 6.081 1.333 8C1.333 11.682 4.318 14.667 8 14.667C11.682 14.667 14.667 11.682 14.667 8C14.667 4.318 11.682 1.333 8 1.333C7.976 1.333 7.952 1.334 7.929 1.334C7.59 1.337 7.333 1.624 7.333 1.963V4C7.333 4.368 7.632 4.667 8 4.667C8.368 4.667 8.667 4.368 8.667 4V2.708C11.298 3.036 13.333 5.28 13.333 8C13.333 10.946 10.946 13.333 8 13.333C5.054 13.333 2.667 10.946 2.667 8C2.667 6.513 3.276 5.167 4.258 4.2C4.531 3.931 4.581 3.491 4.33 3.201Z" fill="currentColor"/><path d="M8.712 7.321C8.61 7.218 5.753 5.406 5.753 5.406C5.709 5.359 5.648 5.331 5.584 5.328C5.52 5.326 5.457 5.348 5.409 5.392C5.361 5.435 5.333 5.495 5.329 5.559C5.325 5.623 5.346 5.687 5.388 5.735L5.405 5.753C5.405 5.753 7.218 8.611 7.32 8.712C7.504 8.897 7.755 9 8.016 9C8.277 9 8.527 8.897 8.712 8.712C8.803 8.621 8.876 8.512 8.925 8.393C8.974 8.274 9 8.146 9 8.017C9 7.887 8.974 7.759 8.925 7.64C8.876 7.521 8.803 7.412 8.712 7.321Z" fill="currentColor"/></svg>
  ),
  workflow: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.203 11H11.797C11.964 10.9 12.143 10.82 12.333 10.763V9.333C12.333 9.156 12.263 8.986 12.138 8.861C12.013 8.736 11.844 8.666 11.667 8.666H4.333C4.157 8.666 3.987 8.736 3.862 8.861C3.737 8.986 3.667 9.156 3.667 9.333V10.763C3.857 10.82 4.036 10.9 4.203 11ZM2.333 10.763V9.333C2.333 8.802 2.544 8.293 2.919 7.918C3.294 7.543 3.803 7.333 4.333 7.333H7.333V5.915C6.705 5.753 6.157 5.367 5.793 4.83C5.429 4.293 5.273 3.641 5.355 2.997C5.437 2.353 5.75 1.761 6.237 1.332C6.724 0.903 7.351 0.667 8 0.667C8.649 0.667 9.276 0.903 9.763 1.332C10.25 1.761 10.564 2.353 10.646 2.997C10.727 3.641 10.571 4.293 10.207 4.83C9.843 5.367 9.295 5.753 8.667 5.915V7.333H11.667C12.197 7.333 12.706 7.543 13.081 7.918C13.456 8.293 13.667 8.802 13.667 9.333V10.763C14.18 10.916 14.625 11.241 14.927 11.683C15.229 12.124 15.37 12.657 15.326 13.19C15.282 13.724 15.056 14.226 14.686 14.613C14.316 14.999 13.824 15.247 13.293 15.314C12.762 15.381 12.224 15.264 11.77 14.982C11.315 14.699 10.971 14.269 10.796 13.764C10.62 13.258 10.624 12.707 10.807 12.204C10.989 11.701 11.339 11.276 11.797 11H4.203C4.661 11.276 5.011 11.701 5.194 12.204C5.376 12.707 5.38 13.258 5.205 13.764C5.029 14.269 4.685 14.699 4.231 14.982C3.776 15.264 3.238 15.381 2.707 15.314C2.176 15.247 1.684 14.999 1.314 14.613C0.944 14.226 0.718 13.724 0.674 13.19C0.631 12.657 0.772 12.124 1.074 11.683C1.376 11.241 1.82 10.916 2.333 10.763ZM8 4.666C8.354 4.666 8.693 4.525 8.943 4.275C9.193 4.025 9.333 3.686 9.333 3.333C9.333 2.979 9.193 2.64 8.943 2.39C8.693 2.14 8.354 1.999 8 1.999C7.646 1.999 7.307 2.14 7.057 2.39C6.807 2.64 6.667 2.979 6.667 3.333C6.667 3.686 6.807 4.025 7.057 4.275C7.307 4.525 7.646 4.666 8 4.666ZM13 14C13.265 14 13.52 13.894 13.707 13.707C13.895 13.519 14 13.265 14 13C14 12.735 13.895 12.48 13.707 12.293C13.52 12.105 13.265 12 13 12C12.735 12 12.48 12.105 12.293 12.293C12.105 12.48 12 12.735 12 13C12 13.265 12.105 13.519 12.293 13.707C12.48 13.894 12.735 14 13 14ZM3 14C3.265 14 3.52 13.894 3.707 13.707C3.895 13.519 4 13.265 4 13C4 12.735 3.895 12.48 3.707 12.293C3.52 12.105 3.265 12 3 12C2.735 12 2.48 12.105 2.293 12.293C2.105 12.48 2 12.735 2 13C2 13.265 2.105 13.519 2.293 13.707C2.48 13.894 2.735 14 3 14Z" fill="currentColor"/></svg>
  ),
};

/* ── Create-menu icons from Figma (colorful, each has its own fill) ── */
const ARROW_RIGHT = (
  <svg width="16" height="16" viewBox="0 0 22 22" fill="none"><path d="M8.52864 5.86189C8.26829 6.12224 8.26829 6.54435 8.52864 6.8047L12.7239 11L8.52864 15.1952C8.26829 15.4556 8.26829 15.8777 8.52864 16.138C8.78899 16.3984 9.2111 16.3984 9.47145 16.138L14.1381 11.4714C14.2631 11.3463 14.3334 11.1768 14.3334 11C14.3334 10.8231 14.2631 10.6536 14.1381 10.5286L9.47145 5.86189C9.2111 5.60154 8.78899 5.60154 8.52864 5.86189Z" fill="#8F959E"/></svg>
);

const CM_ICONS = {
  aiCreate: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 .335c.234 0 .427.183.456.418.074.585.21 1.15.401 1.688l.268.657c.781 1.698 2.136 3.07 3.813 3.861l.648.272.212.073c.497.166 1.016.282 1.552.345.177.02.315.17.315.35l-.007.067a.344.344 0 01-.309.284l-.083.01a7.98 7.98 0 00-1.681.418l-.648.272c-1.676.791-3.031 2.163-3.813 3.861l-.267.657a7.98 7.98 0 00-.401 1.688l-.018.085a.354.354 0 01-.438.333l-.085-.009a.344.344 0 01-.353-.173l-.018-.085a7.98 7.98 0 00-.401-1.688l-.268-.657c-.781-1.698-2.136-3.07-3.813-3.861l-.648-.272a7.98 7.98 0 00-1.535-.388l-.229-.03a.354.354 0 01-.315-.35c0-.181.138-.331.315-.351a7.98 7.98 0 001.552-.345l.212-.073.648-.272c1.676-.791 3.031-2.163 3.813-3.861l.267-.657A7.98 7.98 0 007.544.753C7.573.518 7.766.335 8 .335z" fill="url(#ai_g)"/><defs><linearGradient id="ai_g" x1=".335" y1="15.665" x2="15.665" y2="15.665" gradientUnits="userSpaceOnUse"><stop stopColor="#4752E6"/><stop offset="1" stopColor="#CF5ECF"/></linearGradient></defs></svg>
  ),
  template: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M7.434 1.69c.128-.496.616-.791 1.091-.658l5.147 1.441c.475.133.757.643.63 1.14l-1.38 5.378a.874.874 0 01-.516.617l-1.696-3.071c-.428-.776-1.5-.776-1.929 0L7.703 8.493l-1.018-.285c-.475-.133-.757-.643-.63-1.14L7.434 1.69z" fill="#447CFD"/><path d="M9.554 7.003a.222.222 0 01.386 0l3.855 6.981a.222.222 0 01-.193.35H5.893a.222.222 0 01-.193-.35l3.854-6.981z" fill="#447CFD"/><path d="M5.66 5.012a3.946 3.946 0 00-.762-.078c-2.153 0-3.898 1.823-3.898 4.073 0 2.249 1.745 4.073 3.898 4.073.093 0 .186-.004.277-.01l2.066-3.742--.787-.22c-.95-.267-1.514-1.288-1.26-2.281l.466-1.815z" fill="#91BDFD"/></svg>
  ),
  table: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.333 2.667C1.333 1.93 1.93 1.333 2.667 1.333h10.666C14.07 1.333 14.667 1.93 14.667 2.667v10.666c0 .737-.597 1.334-1.334 1.334H2.667c-.737 0-1.334-.597-1.334-1.334V2.667zm1.334 0v10.666h10.666V2.667H2.667z" fill="#8D55ED"/><path d="M8.333 4.667a.667.667 0 000 1.333h3a.667.667 0 000-1.333h-3z" fill="#8D55ED"/><path d="M4 5.333a.667.667 0 01.667-.666h1.333a.667.667 0 010 1.333H4.667A.667.667 0 014 5.333z" fill="#8D55ED"/><path d="M8.333 7.333a.667.667 0 000 1.334h3a.667.667 0 000-1.334h-3z" fill="#8D55ED"/><path d="M4 8a.667.667 0 01.667-.667h1.333a.667.667 0 010 1.334H4.667A.667.667 0 014 8z" fill="#8D55ED"/><path d="M8.333 10a.667.667 0 100 1.333h3a.667.667 0 100-1.333h-3z" fill="#8D55ED"/><path d="M4 10.667A.667.667 0 014.667 10h1.333a.667.667 0 010 1.333H4.667A.667.667 0 014 10.667z" fill="#8D55ED"/></svg>
  ),
  form: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11.139 4.529a.667.667 0 010 .942L7.805 8.805a.667.667 0 01-.943 0L4.978 6.92a.667.667 0 01.943-.943l1.413 1.414 3.862-3.862a.667.667 0 01.943 0z" fill="#FF811A"/><path d="M4.333 11a.667.667 0 01.667-.667h6a.667.667 0 010 1.334H5a.667.667 0 01-.667-.667z" fill="#FF811A"/><path d="M1.333 2.667C1.333 1.93 1.93 1.333 2.667 1.333h10.666C14.07 1.333 14.667 1.93 14.667 2.667v10.666c0 .737-.597 1.334-1.334 1.334H2.667c-.737 0-1.334-.597-1.334-1.334V2.667zm1.334 0v10.666h10.666V2.667H2.667z" fill="#FF811A"/></svg>
  ),
  dashboard: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.33 3.201c-.23-.266-.631-.307-.887-.067C2.145 4.351 1.333 6.081 1.333 8c0 3.682 2.985 6.667 6.667 6.667 3.682 0 6.667-2.985 6.667-6.667 0-3.682-2.985-6.667-6.667-6.667-.024 0-.048 0-.072.001-.338.003-.595.29-.595.629V4c0 .368.299.667.667.667A.667.667 0 008.667 4V2.708c2.631.328 4.666 2.572 4.666 5.292 0 2.946-2.387 5.333-5.333 5.333S2.667 10.946 2.667 8c0-1.487.608-2.833 1.591-3.8.273-.269.323-.709.072-.999z" fill="#5B65F5"/><path d="M8.712 7.32c-.102-.103-2.958-1.915-2.958-1.915a.222.222 0 00-.345.153.222.222 0 00.04.176l.017.018s1.812 2.858 1.914 2.96A.99.99 0 008.016 9a.99.99 0 00.696-.288.993.993 0 000-1.392z" fill="#5B65F5"/></svg>
  ),
  workflow: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.203 11h7.594c.167-.1.346-.18.536-.237V9.333a.667.667 0 00-.666-.667H4.333a.667.667 0 00-.666.667v1.43c.19.057.369.137.536.237zM2.333 10.763V9.333c0-.53.211-1.04.586-1.415A2 2 0 014.333 7.333h3V5.915A2 2 0 015.793 4.83a2 2 0 01-.438-1.833 2 2 0 01.882-1.665A2 2 0 018 .667c.649 0 1.276.237 1.763.665a2 2 0 01.883 1.665 2 2 0 01-.439 1.833A2 2 0 018.667 5.915v1.418h3a2 2 0 011.414.585c.375.375.586.886.586 1.415v1.43a2 2 0 011.26 1.92c-.044.533-.27 1.036-.64 1.422-.37.387-.861.634-1.393.702a2 2 0 01-1.524-.333 2 2 0 01-.974-1.218 2 2 0 01.011-1.56 2 2 0 01.99-1.128H4.203a2 2 0 01.99 1.128 2 2 0 01.012 1.56 2 2 0 01-.974 1.218 2 2 0 01-1.524.333 2 2 0 01-1.393-.702 2 2 0 01-.64-1.422 2 2 0 011.66-2.08zM8 4.666a1.333 1.333 0 100-2.667 1.333 1.333 0 000 2.667zM13 14a1 1 0 100-2 1 1 0 000 2zM3 14a1 1 0 100-2 1 1 0 000 2z" fill="#8D55ED"/></svg>
  ),
  doc: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.667 2h8.396c.62 0 1.204.237 1.626.64.42.403.644.935.644 1.478V14H4.937a2.26 2.26 0 01-1.626-.64A2.098 2.098 0 012.667 11.882V2zM2 .667A.667.667 0 001.333 1.333v10.549c0 .915.38 1.793 1.056 2.44A3.594 3.594 0 004.937 15.333H14a.667.667 0 00.667-.666V4.118c0-.915-.38-1.793-1.056-2.44A3.594 3.594 0 0011.063.667H2z" fill="#336DF4"/><path d="M4.5 5.333a.667.667 0 01.667-.666h5.666a.667.667 0 010 1.333H5.167a.667.667 0 01-.667-.667z" fill="#336DF4"/><path d="M4.5 8a.667.667 0 01.667-.667h5.666a.667.667 0 010 1.334H5.167A.667.667 0 014.5 8z" fill="#336DF4"/><path d="M4.5 10.667a.667.667 0 01.667-.667h3a.667.667 0 010 1.333h-3a.667.667 0 01-.667-.666z" fill="#336DF4"/></svg>
  ),
  folder: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5.575 6.285L8 8.71l2.422-2.422a.494.494 0 01.813.715L8.202 10.124a.286.286 0 01-.404 0L4.767 7.093a.494.494 0 01.808-.808z" fill="#5B65F5"/><path d="M1.333 2.667C1.333 1.93 1.93 1.333 2.667 1.333h10.666C14.07 1.333 14.667 1.93 14.667 2.667v10.666c0 .737-.597 1.334-1.334 1.334H2.667c-.737 0-1.334-.597-1.334-1.334V2.667zm12 10.666V2.667H2.667v10.666h10.666z" fill="#5B65F5"/></svg>
  ),
  transfer: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.333 2h8.397c.62 0 1.204.237 1.626.64.42.403.644.935.644 1.478V14H7.162l-1.334 1.333h8.839a.667.667 0 00.666-.666V4.118c0-.915-.38-1.793-1.056-2.44A3.594 3.594 0 0011.73.667H2.667A.667.667 0 002 1.333v6.894a1.18 1.18 0 01.252-.308c.306-.305.685-.491 1.081-.554V2z" fill="#2DBEAB"/><path d="M5.828 8.667l-.747-.748a1.037 1.037 0 00-.197-.173.667.667 0 01.616-.413h1a.667.667 0 010 1.334h-.672z" fill="#2DBEAB"/><path d="M4.833 5.333a.667.667 0 01.667-.666h1a.667.667 0 010 1.333h-1a.667.667 0 01-.667-.667z" fill="#2DBEAB"/><path d="M8.833 4.667a.667.667 0 000 1.333h3a.667.667 0 000-1.333h-3z" fill="#2DBEAB"/><path d="M8.167 8a.667.667 0 01.666-.667h3a.667.667 0 010 1.334h-3A.667.667 0 018.167 8z" fill="#2DBEAB"/><path d="M8.833 10a.667.667 0 100 1.333h3a.667.667 0 100-1.333h-3z" fill="#2DBEAB"/><path d="M6.805 11.529a.667.667 0 010 .942l-2.667 2.667a.667.667 0 01-.943-.943L4.724 12.667H1a.667.667 0 010-1.334h3.724L3.195 9.805a.667.667 0 01.943-.943l2.667 2.667z" fill="#2DBEAB"/></svg>
  ),
  app: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.954 10.027c.261.102.562.203.898.292l-.59 1.18a.534.534 0 01-.894-.298l.515-1.03c.113.05.236.104.37.155z" fill="#336DF4"/><path d="M7.702 3.937a.534.534 0 01.894.297l3.334 6.667a.534.534 0 01-.894.597L7.404 4.831a.534.534 0 01.298-.894z" fill="#336DF4"/><path d="M3.783 8.158a.534.534 0 01.926-.176s.003.002.005.003l.037.026a5.15 5.15 0 00.166.096c.11.06.259.136.444.216a5.96 5.96 0 00.197.082c.009.003.018.007.027.011a5.47 5.47 0 00.446.166c.19.058.396.113.618.159a5.97 5.97 0 001.352 0 6.45 6.45 0 00.939-.069l.623 1.246a7.36 7.36 0 01-1.562.156c-.822 0-1.549-.13-2.151-.298l-.11-.03a7.65 7.65 0 01-.139-.043 6.03 6.03 0 01-.151-.049 5.2 5.2 0 01-.115-.039 5.98 5.98 0 01-.236-.081 5.76 5.76 0 01-.822-.62 3.41 3.41 0 01-.227-.14 1.67 1.67 0 01-.063-.057l-.002-.002-.001-.001-.001 0a.534.534 0 01.204-.834z" fill="#336DF4"/><path d="M11.292 7.982a.534.534 0 01.925.176c.207.304.129.718-.176.926l-.001 0-.001.001-.002.002a1.67 1.67 0 01-.063.057 3.41 3.41 0 01-.227.14l-.147.086-.597-1.194c.031-.015.06-.028.085-.04a2.9 2.9 0 00.166-.096l.037-.026.002-.003z" fill="#336DF4"/><path d="M7.045 5.01l.73 1.462-.941 1.882a4.4 4.4 0 01-.62-.248 4.07 4.07 0 01-.19-.078l1.492-2.983.032.021c.005.01.009.02.014.03l-.002-.016-.515-.068z" fill="#336DF4"/><path d="M11.063.667c.957 0 1.873.364 2.549 1.011.676.647 1.055 1.525 1.055 2.44v10.549a.667.667 0 01-.667.666H4.937a3.594 3.594 0 01-2.548-1.011A3.432 3.432 0 011.333 11.882V1.333A.667.667 0 012 .667h9.063zM2.667 11.882c0 .542.224 1.075.644 1.477.422.404 1.006.641 1.626.641H13.333V4.118c0-.543-.224-1.075-.644-1.477A2.26 2.26 0 0011.063 2H2.667v9.882z" fill="#336DF4"/></svg>
  ),
  design: (
    /* Same shape as the new-design popover title icon — keeps the create-menu
     * entry, popover heading, and sidebar row visually unified. */
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M10.141 17.9883L5.86567 17.978C5.69999 17.9776 5.56599 17.843 5.56639 17.6773C5.56658 17.598 5.59818 17.522 5.65426 17.4659L9.78706 13.3331C9.94327 13.1769 10.1965 13.1769 10.3527 13.3331L12.2598 15.2402L17.3172 10.1829C17.4734 10.0266 17.7266 10.0266 17.8828 10.1829C17.9579 10.2579 18 10.3596 18 10.4657V17.7C18 17.8657 17.8657 18 17.7 18H10.2243C10.1954 18 10.1674 17.9959 10.141 17.9883ZM4 22C2.9 22 2 21.1 2 20V4C2 2.9 2.9 2 4 2H20C21.1 2 22 2.9 22 4V20C22 21.1 21.1 22 20 22H4ZM4 20H20V4H4V20ZM6 6H9V9H6V6Z" fill="#336DF4"/></svg>
  ),
  album: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.667 1.333A1.333 1.333 0 001.333 2.667v8A1.333 1.333 0 002.667 12h8a1.333 1.333 0 001.333-1.333v-8A1.333 1.333 0 0010.667 1.333h-8zm0 1.334h8v8h-8v-8z" fill="#8D55ED"/><path d="M13.333 4v9.333H4v1.334h9.333A1.333 1.333 0 0014.667 13.333V4h-1.334z" fill="#8D55ED"/></svg>
  ),
};

const SIDEBAR_WIDTH_KEY = "sidebar_width";
const SIDEBAR_MIN_W = 120;
const SIDEBAR_MAX_W = 400;
const SIDEBAR_DEFAULT_W = 190;

export default function Sidebar({ items, onRenameItem, activeItemId, onSelectItem, onReorderItems, onDeleteTable, tableCount, onCreateWithAI, onResetToDefault, onCreateBlank, folders = [], onCreateFolder, onCreateDesign, onDeleteItem, onMoveItem, scrollToItemId }: Props) {
  const { t } = useTranslation();
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [menuItemId, setMenuItemId] = useState<string | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const moreRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const newBtnRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // ── Auto-scroll to active item ──
  useEffect(() => {
    const el = itemRefs.current.get(activeItemId);
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeItemId]);

  // ── Sidebar resize state ──
  // `sidebarWidth` is the persisted "at rest" value. During an active drag we
  // do NOT update React state — instead we mutate `asideRef.current.style.width`
  // directly inside a requestAnimationFrame so the whole Sidebar subtree (tree,
  // footer, AI popovers…) doesn't reconcile at pointer frequency. One React
  // state commit happens at mouseup to persist the final width.
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return stored ? Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, Number(stored))) : SIDEBAR_DEFAULT_W;
  });
  const asideRef = useRef<HTMLElement>(null);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = asideRef.current?.offsetWidth ?? SIDEBAR_DEFAULT_W;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // Neutralise every iframe's pointer-events during the drag. Figma's embed
    // eagerly swaps the cursor to "hand" when hovered — that fight the
    // col-resize cursor and can swallow the mouseup, making the drag feel
    // sticky. CSS rule: body.sidebar-resizing iframe { pointer-events:none }.
    document.body.classList.add("sidebar-resizing");

    let rafId: number | null = null;
    let latestW = startW;

    const flush = () => {
      rafId = null;
      if (asideRef.current) asideRef.current.style.width = `${latestW}px`;
    };

    const onMouseMove = (ev: MouseEvent) => {
      latestW = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, startW + ev.clientX - startX));
      if (rafId == null) rafId = requestAnimationFrame(flush);
    };
    const onMouseUp = () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.body.classList.remove("sidebar-resizing");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      // Single React commit — persists width and keeps inline style in sync
      // with the final DOM style we already applied during the drag.
      setSidebarWidth(latestW);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(latestW));
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  // Drag state
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPos, setDragOverPos] = useState<"above" | "below" | null>(null);
  const dragRef = useRef<{
    tableId: string;
    startY: number;
    isDragging: boolean;
    rects: Map<string, DOMRect>;
  } | null>(null);
  // Use refs for drop target so mouseup handler sees latest values
  const dragOverIdRef = useRef<string | null>(null);
  const dragOverPosRef = useRef<"above" | "below" | null>(null);

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // ── AI Create sub-menu state ──
  const [showAIPopover, setShowAIPopover] = useState(false);
  const [showDesignPopover, setShowDesignPopover] = useState(false);
  const [menuEl, setMenuEl] = useState<HTMLDivElement | null>(null);
  const [tableItemEl, setTableItemEl] = useState<HTMLButtonElement | null>(null);
  const [designItemEl, setDesignItemEl] = useState<HTMLButtonElement | null>(null);
  const popoverContainerRef = useRef<HTMLDivElement | null>(null);
  const popoverHandleRef = useRef<CreateTablePopoverHandle | null>(null);
  const designPopoverHandleRef = useRef<CreateDesignPopoverHandle | null>(null);
  const designPopoverContainerRef = useRef<HTMLDivElement | null>(null);

  const tableItems = items.filter(i => i.type === "table");
  const staticItems = items.filter(i => i.type === "static");

  const getContextMenuItems = (item: SidebarItem): MenuItem[] => [
    { key: "rename", label: t("contextMenu.rename"), icon: <RenameIcon /> },
    ...(item.type === "table" ? [{ key: "delete", label: t("contextMenu.delete"), icon: <DeleteIcon /> }] : []),
  ];

  // Hidden-by-default "+" menu entries. Code kept intact for easy re-enable:
  // just remove the key here (or flip HIDE_CREATE_MENU_KEYS to an empty Set).
  // Currently hidden per product decision: template center / form / dashboard
  // / workflow / import / app.
  const HIDE_CREATE_MENU_KEYS = new Set<string>([
    "template",
    "form",
    "cm_dashboard",
    "cm_workflow",
    "import",
    "app",
  ]);
  const createMenuItems: MenuItem[] = [
    { key: "ai_create", label: t("createMenu.aiCreate"), section: t("createMenu.quickCreate"), icon: CM_ICONS.aiCreate, noop: true },
    { key: "template", label: t("createMenu.template"), icon: CM_ICONS.template, suffix: ARROW_RIGHT, noop: true },
    { key: "table", label: t("createMenu.table"), section: t("createMenu.new"), icon: CM_ICONS.table, suffix: ARROW_RIGHT },
    { key: "design", label: t("createMenu.design"), icon: CM_ICONS.design || CM_ICONS.doc, suffix: ARROW_RIGHT },
    { key: "form", label: t("createMenu.form"), icon: CM_ICONS.form, suffix: ARROW_RIGHT, noop: true },
    { key: "cm_dashboard", label: t("createMenu.dashboard"), icon: CM_ICONS.dashboard, noop: true },
    { key: "cm_workflow", label: t("createMenu.workflow"), icon: CM_ICONS.workflow, noop: true },
    { key: "doc", label: t("createMenu.doc"), icon: CM_ICONS.doc, noop: true },
    { key: "folder", label: t("createMenu.folder"), section: t("createMenu.manage"), icon: CM_ICONS.folder },
    { key: "import", label: t("createMenu.import"), icon: CM_ICONS.transfer, suffix: ARROW_RIGHT, noop: true },
    { key: "app", label: t("createMenu.app"), section: t("createMenu.appSection"), icon: CM_ICONS.app, suffix: ARROW_RIGHT, noop: true },
  ].filter((it) => !HIDE_CREATE_MENU_KEYS.has(it.key));

  // Close everything handler
  const handleCloseAll = useCallback(() => {
    setShowAIPopover(false);
    setShowDesignPopover(false);
    setNewMenuOpen(false);
  }, []);

  // Stable callbacks for menu/item refs
  const handleMenuRef = useCallback((el: HTMLDivElement | null) => {
    if (el) setMenuEl(el);
  }, []);
  const handleItemRef = useCallback((key: string, el: HTMLButtonElement | null) => {
    if (key === "table" && el) setTableItemEl(el);
    if (key === "design" && el) setDesignItemEl(el);
  }, []);

  // ── Drag handlers (table items only) ──
  const handleDragMouseDown = useCallback((e: React.MouseEvent, tableId: string) => {
    // Only left mouse button
    if (e.button !== 0) return;
    e.preventDefault();

    const rects = new Map<string, DOMRect>();
    itemRefs.current.forEach((el, id) => rects.set(id, el.getBoundingClientRect()));

    dragRef.current = {
      tableId,
      startY: e.clientY,
      isDragging: false,
      rects,
    };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dy = ev.clientY - dragRef.current.startY;

      if (!dragRef.current.isDragging && Math.abs(dy) < DRAG_THRESHOLD) return;

      if (!dragRef.current.isDragging) {
        dragRef.current.isDragging = true;
        setDragId(tableId);
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }

      // Find hover target
      let overId: string | null = null;
      let overPos: "above" | "below" | null = null;
      dragRef.current.rects.forEach((r, id) => {
        if (id === tableId) return;
        // Only consider table items
        if (!tableItems.some(t => t.id === id)) return;
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
          overId = id;
          overPos = ev.clientY < r.top + r.height / 2 ? "above" : "below";
        }
      });
      setDragOverId(overId);
      setDragOverPos(overPos);
      dragOverIdRef.current = overId;
      dragOverPosRef.current = overPos;
    };

    const onMouseUp = () => {
      if (dragRef.current?.isDragging && dragOverIdRef.current && dragOverPosRef.current) {
        const currentOrder = tableItems.map(t => t.id);
        const arr = [...currentOrder];
        const fromIdx = arr.indexOf(tableId);
        arr.splice(fromIdx, 1);
        let toIdx = arr.indexOf(dragOverIdRef.current);
        if (dragOverPosRef.current === "below") toIdx += 1;
        arr.splice(toIdx, 0, tableId);

        const updates = arr.map((id, i) => ({ id, type: "table" as TreeItemType, order: i }));
        onReorderItems(updates);
      }

      dragRef.current = null;
      setDragId(null);
      setDragOverId(null);
      setDragOverPos(null);
      dragOverIdRef.current = null;
      dragOverPosRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [tableItems, onReorderItems]);

  const getIcon = (item: SidebarItem) => {
    if (item.type === "table") return ICONS.table;
    return ICONS[item.id] ?? ICONS.table;
  };

  const renderItem = (item: SidebarItem) => {
    const isDragging = dragId === item.id;
    const isOver = dragOverId === item.id;
    let className = `sidebar-item${item.active ? " active" : ""}`;
    if (isDragging) className += " is-dragging";
    if (isOver && dragOverPos === "above") className += " drag-over-above";
    if (isOver && dragOverPos === "below") className += " drag-over-below";

    return (
      <div
        key={item.id}
        ref={(el) => { if (el) itemRefs.current.set(item.id, el); else itemRefs.current.delete(item.id); }}
        className={className}
        onClick={() => onSelectItem(item.id)}
        onMouseDown={item.type === "table" ? (e) => handleDragMouseDown(e, item.id) : undefined}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditingItemId(item.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuItemId(menuItemId === item.id ? null : item.id);
        }}
      >
        <span className="sidebar-icon">{getIcon(item)}</span>
        <span className="sidebar-label">
          <InlineEdit
            value={item.displayName}
            isEditing={editingItemId === item.id}
            onStartEdit={() => setEditingItemId(item.id)}
            onSave={(name) => {
              setEditingItemId(null);
              onRenameItem(item.id, name);
            }}
            onCancelEdit={() => setEditingItemId(null)}
            className="sidebar-edit"
          />
        </span>
        <span
          className="sidebar-item-more"
          role="button"
          title={t("topbar.more")}
          ref={(el) => { if (el) moreRefs.current.set(item.id, el); }}
          onClick={(e) => {
            e.stopPropagation();
            setMenuItemId(menuItemId === item.id ? null : item.id);
          }}
        >
          <svg width="14" height="14" viewBox="207 119 4 14" fill="none">
            <path d="M209 122.208C208.436 122.208 207.979 121.751 207.979 121.187C207.979 120.624 208.436 120.167 209 120.167C209.564 120.167 210.021 120.624 210.021 121.187C210.021 121.751 209.564 122.208 209 122.208Z" fill="currentColor"/>
            <path d="M209 127.006C208.436 127.006 207.979 126.549 207.979 125.985C207.979 125.422 208.436 124.965 209 124.965C209.564 124.965 210.021 125.422 210.021 125.985C210.021 126.549 209.564 127.006 209 127.006Z" fill="currentColor"/>
            <path d="M209 131.833C208.436 131.833 207.979 131.376 207.979 130.812C207.979 130.249 208.436 129.792 209 129.792C209.564 129.792 210.021 130.249 210.021 130.812C210.021 131.376 209.564 131.833 209 131.833Z" fill="currentColor"/>
          </svg>
        </span>
        {menuItemId === item.id && moreRefs.current.get(item.id) && (
          <DropdownMenu
            items={getContextMenuItems(item)}
            anchorEl={moreRefs.current.get(item.id)!}
            onSelect={(key) => {
              setMenuItemId(null);
              if (key === "rename") setEditingItemId(item.id);
              if (key === "delete") setDeleteConfirmId(item.id);
            }}
            onClose={() => setMenuItemId(null)}
            width={180}
          />
        )}
      </div>
    );
  };

  // Determine if popover is in a blocking state (generating/creating)
  const isPopoverBlocking = (showAIPopover && popoverHandleRef.current &&
    ["generating", "creating"].includes(popoverHandleRef.current.getState())) ||
    (showDesignPopover && designPopoverHandleRef.current &&
    designPopoverHandleRef.current.getState() === "creating");

  return (
    <aside ref={asideRef} className="sidebar" style={{ width: sidebarWidth }}>
      <div className="sidebar-resize-handle" onMouseDown={handleResizeMouseDown} />
      <div className="sidebar-header">
        <div className="sidebar-search-trigger">
          <svg className="sidebar-search-icon" width="14" height="14" viewBox="20 80 15 15" fill="none">
            <path d="M30.982 91.9251C29.8941 92.8058 28.5086 93.3334 26.9998 93.3334C23.502 93.3334 20.6665 90.4979 20.6665 87.0001C20.6665 83.5023 23.502 80.6667 26.9998 80.6667C30.4976 80.6667 33.3332 83.5023 33.3332 87.0001C33.3332 88.5088 32.8056 89.8944 31.9249 90.9823L34.4399 93.4973C34.6987 93.7561 34.6938 94.1765 34.435 94.4353C34.1763 94.694 33.7559 94.6989 33.4971 94.4402L30.982 91.9251ZM31.9998 87.0001C31.9998 84.2387 29.7613 82.0001 26.9998 82.0001C24.2384 82.0001 21.9998 84.2387 21.9998 87.0001C21.9998 89.7615 24.2384 92.0001 26.9998 92.0001C29.7613 92.0001 31.9998 89.7615 31.9998 87.0001Z" fill="currentColor"/>
          </svg>
          <span>{t("sidebar.search")}</span>
        </div>
      </div>
      <div className="sidebar-nav">
        {(() => {
          // Build tree nodes from items that have a parentId property (table, design, folder)
          const treeItemTypes = new Set(["table", "folder", "design", "album"]);
          const treeItems = items.filter(i => treeItemTypes.has(i.type));
          const flatNodes: TreeNodeData[] = treeItems.map(i => ({
            id: i.id,
            type: i.type as TreeItemType,
            name: i.displayName,
            parentId: i.parentId ?? null,
            order: i.order,
            children: [],
          }));
          // Build id→node map, then attach each node to its parent's children[].
          // Roots = nodes with parentId === null (or parent not found, treat as root).
          const nodeMap = new Map(flatNodes.map(n => [n.id, n]));
          const treeNodes: TreeNodeData[] = [];
          for (const n of flatNodes) {
            const parent = n.parentId ? nodeMap.get(n.parentId) : null;
            if (parent) parent.children!.push(n);
            else treeNodes.push(n);
          }
          // Sort each sibling group by order
          const sortByOrder = (arr: TreeNodeData[]) => {
            arr.sort((a, b) => a.order - b.order);
            for (const c of arr) if (c.children?.length) sortByOrder(c.children);
          };
          sortByOrder(treeNodes);

          if (treeNodes.length > 0) {
            return (
              <TreeView
                nodes={treeNodes}
                activeItemId={activeItemId}
                onSelectItem={(id, type) => onSelectItem(id, type)}
                onRenameItem={(id, _type, newName) => onRenameItem(id, newName)}
                onDeleteItem={(id, type) => {
                  if (type === "table") {
                    setDeleteConfirmId(id);
                  } else if (onDeleteItem) {
                    onDeleteItem(id, type);
                  }
                }}
                onMoveItem={(itemId, itemType, newParentId) => {
                  if (onMoveItem) onMoveItem(itemId, itemType as "table" | "folder" | "design", newParentId);
                }}
                onReorderItems={onReorderItems}
                folders={folders}
                scrollToItemId={scrollToItemId ?? null}
              />
            );
          }

          // Fallback: flat list for tables + statics
          return (
            <>
              {tableItems.map(renderItem)}
              {staticItems.map(renderItem)}
            </>
          );
        })()}
      </div>
      <div className="sidebar-footer">
        <button
          ref={newBtnRef}
          className="sidebar-new-btn"
          onClick={() => {
            if (newMenuOpen && !isPopoverBlocking) {
              setNewMenuOpen(false);
              setShowAIPopover(false);
            } else if (!newMenuOpen) {
              setNewMenuOpen(true);
            }
          }}
        >
          <svg width="14" height="14" viewBox="97.5 861.5 13 13" fill="none">
            <path d="M104 862.167C103.678 862.167 103.417 862.428 103.417 862.75V867.417H98.75C98.4278 867.417 98.1666 867.678 98.1666 868C98.1666 868.322 98.4278 868.583 98.75 868.583H103.417V873.25C103.417 873.572 103.678 873.833 104 873.833C104.322 873.833 104.583 873.572 104.583 873.25V868.583H109.25C109.572 868.583 109.833 868.322 109.833 868C109.833 867.678 109.572 867.417 109.25 867.417H104.583V862.75C104.583 862.428 104.322 862.167 104 862.167Z" fill="currentColor"/>
          </svg>
          {t("sidebar.new")}
        </button>
        {newMenuOpen && newBtnRef.current && (
          <DropdownMenu
            items={createMenuItems}
            anchorEl={newBtnRef.current}
            onSelect={(key) => {
              if (key === "table") {
                setShowAIPopover(true);
                setShowDesignPopover(false);
              } else if (key === "design") {
                setShowDesignPopover(true);
                setShowAIPopover(false);
              } else if (key === "folder") {
                if (onCreateFolder) onCreateFolder();
                handleCloseAll();
              } else {
                setShowAIPopover(false);
                setShowDesignPopover(false);
              }
            }}
            onClose={() => {
              if (!isPopoverBlocking) {
                setNewMenuOpen(false);
                setShowAIPopover(false);
                setShowDesignPopover(false);
              }
            }}
            position="above"
            width={240}
            activeSubMenuKey={showAIPopover ? "table" : showDesignPopover ? "design" : null}
            className="sidebar-new-menu"
            onMenuRef={handleMenuRef}
            onItemRef={handleItemRef}
            extraContainers={[popoverContainerRef, designPopoverContainerRef]}
          />
        )}
        {showAIPopover && menuEl && tableItemEl && (
          <CreateTablePopover
            ref={(handle) => { popoverHandleRef.current = handle; }}
            anchorItemEl={tableItemEl}
            menuEl={menuEl}
            onClose={() => setShowAIPopover(false)}
            onCreateWithAI={onCreateWithAI}
            onResetToDefault={onResetToDefault}
            onCreateBlank={onCreateBlank}
          />
        )}
        {showDesignPopover && menuEl && designItemEl && onCreateDesign && (
          <CreateDesignPopover
            ref={(handle) => { designPopoverHandleRef.current = handle; }}
            anchorItemEl={designItemEl}
            menuEl={menuEl}
            onClose={() => setShowDesignPopover(false)}
            onCreateDesign={onCreateDesign}
          />
        )}
      </div>
      <ConfirmDialog
        open={!!deleteConfirmId}
        title={t("app.deleteTable")}
        message={t("app.deleteTableMsg", { name: items.find(i => i.id === deleteConfirmId)?.displayName ?? "" })}
        confirmLabel={t("confirm.delete")}
        cancelLabel={t("confirm.cancel")}
        variant="danger"
        onConfirm={() => {
          if (deleteConfirmId) onDeleteTable(deleteConfirmId);
          setDeleteConfirmId(null);
        }}
        onCancel={() => setDeleteConfirmId(null)}
      />
    </aside>
  );
}

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
