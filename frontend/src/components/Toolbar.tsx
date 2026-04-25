/**
 * Toolbar —— 实际是 Table artifact 的"顶部条"，对齐 IdeaEditor 和 SvgCanvas
 * 的 topbar 结构（44px 高，左 name 右 actions），不再是底部一长排功能键。
 *
 * 左侧：
 *   · 表名（InlineEdit，可双击改名）
 *   · 当 filter 有未保存修改时（isFilterDirty）紧跟一个 apply pill：
 *     筛选条件描述 + Clear / Save 按钮（之前在 ViewTabs 里，移过来了）
 *
 * 右侧只保留 5 个动作：
 *   · Add record（带下拉箭头）
 *   · Customize field
 *   · Filter
 *   · Sort
 *   · Undo
 *
 * 已移除：ViewSettings / GroupBy / RowHeight / ConditionalColoring（保留组件
 * 内的 icon 函数留给后续再启用）。
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
      {/* Left: 表名 + filter apply pill */}
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
          <span className="table-topbar-apply-pill" onClick={(e) => e.stopPropagation()}>
            <FilterConfigIcon />
            <span className="table-topbar-apply-text">{t("viewTabs.filterConfigured")}</span>
            <button
              className="table-topbar-apply-btn"
              onClick={(e) => { e.stopPropagation(); onClearFilter?.(); }}
            >
              {t("viewTabs.clear")}
            </button>
            <button
              className="table-topbar-apply-btn primary"
              onClick={(e) => { e.stopPropagation(); onSaveView?.(); }}
            >
              {t("viewTabs.save")}
            </button>
          </span>
        )}
      </div>

      {/* Right: 5 个核心动作 */}
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
        <ToolbarIconBtn
          icon={<CustomizeFieldIcon />}
          title={t("toolbar.customizeField")}
          active={fieldConfigOpen}
          onClick={onCustomizeFieldClick}
          btnRef={customizeFieldBtnRef}
        />
        <ToolbarIconBtn
          icon={<FilterIcon />}
          title={filterConditionCount > 0 ? t("toolbar.filterCount", { count: filterConditionCount }) : t("toolbar.filter")}
          active={isFiltered || filterPanelOpen}
          onClick={onFilterClick}
          btnRef={filterBtnRef}
          badge={filterConditionCount > 0 ? filterConditionCount : undefined}
        />
        <ToolbarIconBtn icon={<SortIcon />} title={t("toolbar.sort")} />
        <ToolbarIconBtn
          icon={<UndoIcon />}
          title={t("toolbar.undo")}
          disabled={!canUndo}
          onClick={() => canUndo && onUndo?.()}
        />
      </div>
    </div>
  );
}

interface ToolbarIconBtnProps {
  icon: React.ReactNode;
  title: string;
  active?: boolean;
  disabled?: boolean;
  badge?: number;
  onClick?: () => void;
  btnRef?: RefObject<HTMLButtonElement | null>;
}

function ToolbarIconBtn({ icon, title, active, disabled, badge, onClick, btnRef }: ToolbarIconBtnProps) {
  return (
    <button
      ref={btnRef as RefObject<HTMLButtonElement>}
      className={`table-topbar-icon-btn${active ? " active" : ""}${disabled ? " disabled" : ""}`}
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
    >
      {icon}
      {badge !== undefined && <span className="table-topbar-badge">{badge}</span>}
    </button>
  );
}

/* ─── Icons (保留实际用到的，未用的 export 保留供未来启用) ─────────── */

function CustomizeFieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M6.86 2h2.28l.3 1.62c.46.16.89.39 1.27.68l1.52-.63 1.14 1.97-1.22.99c.09.44.09.9 0 1.34l1.22.99-1.14 1.97-1.52-.63c-.38.29-.81.52-1.27.68L9.14 14H6.86l-.3-1.62a4.7 4.7 0 01-1.27-.68l-1.52.63-1.14-1.97 1.22-.99a4.7 4.7 0 010-1.34l-1.22-.99 1.14-1.97 1.52.63c.38-.29.81-.52 1.27-.68L6.86 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2"/>
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

function SortIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h4.5M3 8h3M3 12h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M11.5 3v10m0 0l2-2.5m-2 2.5l-2-2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function UndoIcon() {
  /* 之前在 right cluster 用的圆形箭头大图标，这里换成与其它 icon 一致的尺寸 */
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M5.5 4l-2.5 2.5 2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M3 6.5h7a3 3 0 010 6h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
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
