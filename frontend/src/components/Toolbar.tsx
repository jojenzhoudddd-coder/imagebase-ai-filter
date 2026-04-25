/**
 * Toolbar —— Table artifact 的"顶部条"，对齐 IdeaEditor 和 SvgCanvas 的 topbar
 * 结构（44px 高，左 name + filter pill / 右多个动作按钮）。
 *
 * V2 设计要点（2026-04-25 用户反馈后回调）：
 *   · 左侧：表名（InlineEdit）+ filter dirty 时的 apply pill —— pill 用 ViewTabs
 *     时代的蓝底设计（primary-light 背景、28px 高、圆角 14px），不用之前 V1 的
 *     gray border 风格
 *   · 右侧：保留之前 toolbar 的「带文字标签」的多个视图相关按钮（不简化为 icon）：
 *     Customize field / View settings / Filter / Group by / Sort / Row height /
 *     Conditional color；末尾的 Undo 用 26px icon-only（与之前一致）
 *   · Add record 主按钮带文字 + 下拉箭头，紧贴左侧
 */

import { RefObject, useState } from "react";
import { useTranslation } from "../i18n/index";
import InlineEdit from "./InlineEdit";
import "./Toolbar.css";

interface Props {
  /** 表名 —— 双击进 InlineEdit；保存触发 onRenameTable */
  tableName: string;
  onRenameTable?: (next: string) => void;
  /** Filter 状态 */
  isFiltered: boolean;
  isFilterDirty: boolean;
  filterConditionCount: number;
  filterPanelOpen: boolean;
  onFilterClick: () => void;
  onClearFilter?: () => void;
  /** Filter dirty 时点 "Save" 把当前 filter 写到 view */
  onSaveView?: () => void;
  filterBtnRef: RefObject<HTMLButtonElement | null>;
  /** Customize field */
  fieldConfigOpen: boolean;
  onCustomizeFieldClick: () => void;
  customizeFieldBtnRef: RefObject<HTMLButtonElement | null>;
  /** Undo */
  canUndo?: boolean;
  onUndo?: () => void;
  /** Add record */
  onAddRecord?: () => void;
}

export default function Toolbar({
  tableName,
  onRenameTable,
  isFiltered,
  isFilterDirty,
  filterConditionCount,
  filterPanelOpen,
  onFilterClick,
  onClearFilter,
  onSaveView,
  filterBtnRef,
  fieldConfigOpen,
  onCustomizeFieldClick,
  customizeFieldBtnRef,
  canUndo,
  onUndo,
  onAddRecord,
}: Props) {
  const { t } = useTranslation();
  const [editingName, setEditingName] = useState(false);

  return (
    <div className="table-topbar">
      {/* Left: 表名 + filter apply pill + Add record */}
      <div className="table-topbar-left">
        <span className="table-topbar-name">
          <InlineEdit
            value={tableName}
            isEditing={editingName}
            onStartEdit={() => setEditingName(true)}
            onSave={(name) => {
              setEditingName(false);
              onRenameTable?.(name);
            }}
            onCancelEdit={() => setEditingName(false)}
          />
        </span>
        {isFilterDirty && (
          <span className="view-tab-apply-pill" onClick={(e) => e.stopPropagation()}>
            <FilterConfigIcon />
            <span className="view-tab-apply-text">{t("viewTabs.filterConfigured")}</span>
            <button
              className="view-tab-apply-btn"
              onClick={(e) => { e.stopPropagation(); onClearFilter?.(); }}
            >
              {t("viewTabs.clear")}
            </button>
            <button
              className="view-tab-apply-btn"
              onClick={(e) => { e.stopPropagation(); onSaveView?.(); }}
            >
              {t("viewTabs.save")}
            </button>
          </span>
        )}
      </div>

      {/* Right: 视图相关多按钮（带文字标签）+ 末尾 Undo */}
      <div className="table-topbar-actions">
        <button className="table-topbar-add-record" onClick={onAddRecord} title={t("toolbar.addRecord")}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          {t("toolbar.addRecord")}
          <svg className="table-topbar-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 4l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <span className="table-topbar-sep" />
        <ToolbarBtn
          icon={<CustomizeFieldIcon />}
          label={t("toolbar.customizeField")}
          active={fieldConfigOpen}
          onClick={onCustomizeFieldClick}
          btnRef={customizeFieldBtnRef}
        />
        <ToolbarBtn icon={<ViewSettingsIcon />} label={t("toolbar.viewSettings")} />
        <ToolbarBtn
          icon={<FilterIcon />}
          label={filterConditionCount > 0 ? t("toolbar.filterCount", { count: filterConditionCount }) : t("toolbar.filter")}
          active={isFiltered || filterPanelOpen}
          onClick={onFilterClick}
          btnRef={filterBtnRef}
        />
        <ToolbarBtn icon={<GroupByIcon />} label={t("toolbar.groupBy")} />
        <ToolbarBtn icon={<SortIcon />} label={t("toolbar.sort")} />
        <ToolbarBtn icon={<RowHeightIcon />} label={t("toolbar.rowHeight")} />
        <ToolbarBtn icon={<ConditionalColorIcon />} label={t("toolbar.conditionalColoring")} />
        <span className="table-topbar-sep" />
        <button
          className={`table-topbar-undo${canUndo ? "" : " disabled"}`}
          title={t("toolbar.undo")}
          onClick={() => canUndo && onUndo?.()}
          disabled={!canUndo}
        >
          <svg width="20" height="20" viewBox="0 0 26 26" fill="none">
            <path d="M10.8047 6.52876C11.065 6.78911 11.065 7.21122 10.8047 7.47157L8.60939 9.66683H14.6666C17.428 9.66683 19.6666 11.9054 19.6666 14.6668C19.6666 17.4283 17.428 19.6668 14.6666 19.6668H12.3333C11.9651 19.6668 11.6666 19.3684 11.6666 19.0002C11.6666 18.632 11.9651 18.3335 12.3333 18.3335H14.6666C16.6916 18.3335 18.3333 16.6919 18.3333 14.6668C18.3333 12.6418 16.6916 11.0002 14.6666 11.0002H8.60939L10.8047 13.1954C11.065 13.4558 11.065 13.8779 10.8047 14.1382C10.5443 14.3986 10.1222 14.3986 9.86185 14.1382L6.52851 10.8049C6.26816 10.5446 6.26816 10.1224 6.52851 9.86209L9.86185 6.52876C10.1222 6.26841 10.5443 6.26841 10.8047 6.52876Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

interface ToolbarBtnProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
  btnRef?: RefObject<HTMLButtonElement | null>;
}

function ToolbarBtn({ icon, label, active, onClick, btnRef }: ToolbarBtnProps) {
  return (
    <button
      ref={btnRef as RefObject<HTMLButtonElement>}
      className={`table-topbar-btn${active ? " active" : ""}`}
      onClick={onClick}
    >
      {icon}
      <span className="table-topbar-btn-label">{label}</span>
    </button>
  );
}

/* ─── Icons ─────────────────────────────────────────────────────────── */

function CustomizeFieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M6.86 2h2.28l.3 1.62c.46.16.89.39 1.27.68l1.52-.63 1.14 1.97-1.22.99c.09.44.09.9 0 1.34l1.22.99-1.14 1.97-1.52-.63c-.38.29-.81.52-1.27.68L9.14 14H6.86l-.3-1.62a4.7 4.7 0 01-1.27-.68l-1.52.63-1.14-1.97 1.22-.99a4.7 4.7 0 010-1.34l-1.22-.99 1.14-1.97 1.52.63c.38-.29.81-.52 1.27-.68L6.86 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  );
}

function ViewSettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="9.5" y="2" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="1.5" y="10" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      <circle cx="12" cy="11.5" r="2.5" stroke="currentColor" strokeWidth="1.1"/>
      <path d="M12 9.5v.5m0 3v.5m-2-2.5h.5m3.5 0h.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 3h12L9.5 8.5V12l-3 1.5V8.5L2 3z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function GroupByIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2.5" width="12" height="3" rx="0.8" stroke="currentColor" strokeWidth="1.1"/>
      <rect x="4" y="7.5" width="10" height="3" rx="0.8" stroke="currentColor" strokeWidth="1.1"/>
      <rect x="4" y="12.5" width="10" height="1" rx="0.5" fill="currentColor" opacity="0.4"/>
    </svg>
  );
}

function SortIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h4.5M3 8h3M3 12h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M11.5 3v10m0 0l2-2.5m-2 2.5l-2-2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function RowHeightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M5 3h9M5 6.5h9M5 10h9M5 13.5h9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
      <path d="M2 5l-1-1.5h2L2 5zm0 6l-1 1.5h2L2 12.5z" fill="currentColor"/>
      <path d="M2 4.5v7" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  );
}

function ConditionalColorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M9.66 1.29a1 1 0 011.41 0l8.13 8.13a2.5 2.5 0 010 3.54l-7.42 7.42a2.5 2.5 0 01-3.54 0l-5.66-5.65a2.5 2.5 0 010-3.54l8.13-8.13-.35-.35a1 1 0 010-1.42zm8.13 9.55l-6.36-6.36-7.49 7.49 14.06-.01c.17-.37.1-.82-.21-1.12zM3.29 14.02l5.66 5.66a1 1 0 001.41 0l5.72-5.72H3.24l.05.06z" fill="currentColor"/>
      <path d="M22.36 20.75a2.67 2.67 0 11-5.33 0c0-1.32.87-2.35 1.65-3.27.4-.48.79-.94 1.02-1.4.23.46.61.92 1.02 1.4.78.92 1.64 1.95 1.64 3.27z" fill="currentColor"/>
    </svg>
  );
}

function FilterConfigIcon() {
  return (
    <svg width="12" height="12" viewBox="361 81 11 12" fill="none">
      <path d="M367.286 86.3232L369.681 84.5293C369.821 84.4245 369.905 84.2531 369.905 84.0703V82.1207C369.905 81.5017 369.436 81 368.857 81H362.048C361.469 81 361 81.5017 361 82.1207V84.0703C361 84.2531 361.083 84.4245 361.223 84.5293L363.619 86.3232V90.3471C363.619 90.7954 363.869 91.2006 364.254 91.3772L366.556 92.4324C366.901 92.5908 367.286 92.3196 367.286 91.9173V86.3232ZM364.667 85.7397L362.048 83.7785V82.1207H368.857V83.7785L366.238 85.7397V91.0675L364.667 90.3471V85.7397Z" fill="currentColor"/>
      <path d="M368.333 87.7241C368.333 87.4146 368.568 87.1637 368.857 87.1637H371.476C371.765 87.1637 372 87.4146 372 87.7241C372 88.0335 371.765 88.2844 371.476 88.2844H368.857C368.568 88.2844 368.333 88.0335 368.333 87.7241Z" fill="currentColor"/>
      <path d="M368.857 89.4051C368.568 89.4051 368.333 89.6559 368.333 89.9654C368.333 90.2749 368.568 90.5257 368.857 90.5257H370.429C370.718 90.5257 370.952 90.2749 370.952 89.9654C370.952 89.6559 370.718 89.4051 370.429 89.4051H368.857Z" fill="currentColor"/>
    </svg>
  );
}
