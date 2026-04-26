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
import SidebarExpandButton from "./SidebarExpandButton";
import BlockCloseButton from "./BlockCloseButton";
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
  /** V2.9 #5: 记录计数,放在 Add Record 左侧。undefined 不渲染。 */
  recordCount?: number;
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
  recordCount,
}: Props) {
  const { t } = useTranslation();
  const [editingName, setEditingName] = useState(false);

  return (
    <div className="table-topbar">
      {/* Left: sidebar 展开按钮（仅 collapsed 时）+ 表名 + filter apply pill */}
      <div className="table-topbar-left">
        <SidebarExpandButton />
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
        {/* V2.9.1: record 计数紧贴 Add Record 左侧,小字灰色 */}
        {typeof recordCount === "number" && (
          <span className="table-topbar-record-count" title={t("table.records")}>
            {recordCount} {t("table.records")}
          </span>
        )}
        <button className="table-topbar-add-record" onClick={onAddRecord} title={t("toolbar.addRecord")}>
          <AddIcon />
          {t("toolbar.addRecord")}
          <svg className="table-topbar-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 4l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <ToolbarBtn
          icon={<CustomizeFieldIcon />}
          label={t("toolbar.customizeField")}
          active={fieldConfigOpen}
          onClick={onCustomizeFieldClick}
          btnRef={customizeFieldBtnRef}
        />
        <ToolbarBtn
          icon={<FilterIcon />}
          label={filterConditionCount > 0 ? t("toolbar.filterCount", { count: filterConditionCount }) : t("toolbar.filter")}
          active={isFiltered || filterPanelOpen}
          onClick={onFilterClick}
          btnRef={filterBtnRef}
        />
        <ToolbarBtn icon={<SortIcon />} label={t("toolbar.sort")} />
        {/* V2.9 #9: 去掉竖分隔线;V2.9 #10: 8px gap 由 .table-topbar-actions 统一控制 */}
        {/* Undo —— 与其它动作一致用 icon + 文字（"Undo" / "撤销"）,disabled
            状态走 ToolbarBtn 的内置态.  */}
        <ToolbarBtn
          icon={<UndoIcon />}
          label={t("toolbar.undo")}
          onClick={() => canUndo && onUndo?.()}
          disabled={!canUndo}
        />
        {/* Magic Canvas 关闭 block 按钮 —— BlockShell 不在时自动 noop */}
        <BlockCloseButton />
      </div>
    </div>
  );
}

interface ToolbarBtnProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  btnRef?: RefObject<HTMLButtonElement | null>;
}

function ToolbarBtn({ icon, label, active, disabled, onClick, btnRef }: ToolbarBtnProps) {
  return (
    <button
      ref={btnRef as RefObject<HTMLButtonElement>}
      className={`table-topbar-btn${active ? " active" : ""}${disabled ? " disabled" : ""}`}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
    >
      {icon}
      <span className="table-topbar-btn-label">{label}</span>
    </button>
  );
}

/* ─── Icons ─────────────────────────────────────────────────────────── */

/* V2.9 #11: 4 个新 icon 来自 Figma icon-system (icon_*_outlined.svg)。
   strokeWidth / fill 均改为 currentColor,以便随 ToolbarBtn 的 hover/active 取色。 */

function CustomizeFieldIcon() {
  // icon_setting_outlined — 16×16 cog
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2.88557 13.1558L2.67815 12.9299C1.95199 12.1389 1.40718 11.1955 1.08778 10.1652L0.997742 9.87475L2.36311 8.00002L0.997742 6.12529L1.08778 5.83484C1.40718 4.80455 1.95199 3.86115 2.67815 3.07019L2.88557 2.84426L5.18011 3.09506L6.11209 0.970504L6.41093 0.903226C6.92877 0.786644 7.46076 0.727295 8 0.727295C8.53924 0.727295 9.07123 0.786644 9.58906 0.903226L9.88791 0.970504L10.8199 3.09506L13.1144 2.84426L13.3218 3.07019C14.048 3.86115 14.5928 4.80455 14.9122 5.83484L15.0023 6.12529L13.6369 8.00002L15.0023 9.87475L14.9122 10.1652C14.5928 11.1955 14.048 12.1389 13.3218 12.9299L13.1144 13.1558L10.8199 12.905L9.88791 15.0295L9.58906 15.0968C9.07123 15.2134 8.53924 15.2728 8 15.2728C7.46076 15.2728 6.92877 15.2134 6.41093 15.0968L6.11209 15.0295L5.18011 12.905L2.88557 13.1558ZM5.20896 11.6825C5.63971 11.6354 6.05118 11.8733 6.22525 12.2701L6.97221 13.9729C7.30911 14.0311 7.65252 14.0606 8 14.0606C8.34748 14.0606 8.69089 14.0311 9.02779 13.9729L9.77475 12.2701C9.94882 11.8733 10.3603 11.6354 10.791 11.6825L12.6272 11.8831C13.0706 11.3494 13.4203 10.7428 13.659 10.0892L12.5627 8.58403C12.3092 8.23593 12.3092 7.76404 12.5627 7.41594L13.659 5.91073C13.4203 5.25712 13.0706 4.6506 12.6272 4.11682L10.791 4.31752C10.3603 4.3646 9.94882 4.12667 9.77475 3.72986L9.02779 2.02707C8.69089 1.96889 8.34748 1.93938 8 1.93938C7.65252 1.93938 7.30911 1.96889 6.97221 2.02707L6.22525 3.72986C6.05118 4.12667 5.63971 4.3646 5.20896 4.31752L3.37282 4.11682C2.92936 4.6506 2.57971 5.25712 2.34102 5.91073L3.43727 7.41594C3.69079 7.76404 3.69079 8.23593 3.43727 8.58403L2.34102 10.0892C2.57971 10.7428 2.92936 11.3494 3.37282 11.8831L5.20896 11.6825ZM8 11.0303C6.33214 11.0303 4.98124 9.67296 4.98124 8.00002C4.98124 6.32707 6.33214 4.96971 8 4.96971C9.66786 4.96971 11.0188 6.32707 11.0188 8.00002C11.0188 9.67296 9.66786 11.0303 8 11.0303ZM8 9.81824C8.99713 9.81824 9.80664 9.00486 9.80664 8.00006C9.80664 6.99526 8.99713 6.18188 8 6.18188C7.00287 6.18188 6.19336 6.99526 6.19336 8.00006C6.19336 9.00486 7.00287 9.81824 8 9.81824Z" fill="currentColor"/>
    </svg>
  );
}

function FilterIcon() {
  // icon_jira-filter_outlined
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8.66669 7.66671L11.7157 5.53243C11.8939 5.40767 12 5.20381 12 4.98627V2.66671C12 1.93033 11.4031 1.33337 10.6667 1.33337H2.00002C1.26364 1.33337 0.666687 1.93033 0.666687 2.66671V4.98627C0.666687 5.20381 0.772828 5.40767 0.951046 5.53243L4.00002 7.66671V12.4542C4.00002 12.9876 4.31788 13.4696 4.80813 13.6797L7.73741 14.9351C8.17732 15.1236 8.66669 14.801 8.66669 14.3223V7.66671ZM5.33335 6.9725L2.00002 4.63917V2.66671H10.6667V4.63917L7.33335 6.9725V13.3113L5.33335 12.4542V6.9725Z" fill="currentColor"/>
      <path d="M10 9.33337C10 8.96518 10.2985 8.66671 10.6667 8.66671H14C14.3682 8.66671 14.6667 8.96518 14.6667 9.33337C14.6667 9.70156 14.3682 10 14 10H10.6667C10.2985 10 10 9.70156 10 9.33337Z" fill="currentColor"/>
      <path d="M10.6667 11.3334C10.2985 11.3334 10 11.6319 10 12C10 12.3682 10.2985 12.6667 10.6667 12.6667H12.6667C13.0349 12.6667 13.3334 12.3682 13.3334 12C13.3334 11.6319 13.0349 11.3334 12.6667 11.3334H10.6667Z" fill="currentColor"/>
    </svg>
  );
}

function SortIcon() {
  // icon_sor-a-to-z_outlined
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M11.3336 0.888916H10.1311C10.1311 0.888916 9.85196 0.979833 9.79938 1.11749L7.35669 7.51619C7.26783 7.74895 7.43972 7.99855 7.68886 7.99855H8.34057C8.48912 7.99855 8.62201 7.90621 8.67381 7.76699L9.11661 6.57693H12.3443L12.7863 7.76795C12.838 7.90733 12.9709 7.99982 13.1196 7.99982H13.7771C14.0263 7.99982 14.1982 7.75019 14.1093 7.51742L11.6654 1.11749C11.6128 0.979833 11.4808 0.888916 11.3336 0.888916ZM11.8169 5.15495H9.64086L10.7106 2.27772H10.7441L11.8169 5.15495Z" fill="currentColor"/>
      <path d="M7.69961 9.42225C7.69961 9.22588 7.8588 9.06669 8.05517 9.06669H13.7369C13.9332 9.06669 14.0924 9.22588 14.0924 9.42225V9.89143C14.0924 9.9941 14.0481 10.0917 13.9707 10.1593L9.92512 13.6914H13.7369C13.9332 13.6914 14.0924 13.8506 14.0924 14.047V14.7556C14.0924 14.952 13.9332 15.1111 13.7369 15.1111H8.05517C7.8588 15.1111 7.69961 14.952 7.69961 14.7556V14.1066C7.69961 14.0039 7.74404 13.9062 7.82144 13.8386L11.6635 10.4871H8.05517C7.8588 10.4871 7.69961 10.3279 7.69961 10.1316V9.42225Z" fill="currentColor"/>
      <path d="M1.75113 11.1112H3.55441V2.13341C3.55441 1.93705 3.7136 1.77786 3.90997 1.77786H4.53219C4.72856 1.77786 4.88775 1.93705 4.88775 2.13341V14.9067C4.88775 15.251 4.44718 15.3943 4.24464 15.1158L1.5786 11.45C1.47605 11.309 1.57677 11.1112 1.75113 11.1112Z" fill="currentColor"/>
    </svg>
  );
}

function AddIcon() {
  // icon_add_outlined
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7.00006 1.16663C6.67789 1.16663 6.41672 1.4278 6.41672 1.74996V6.41666H1.75002C1.42786 6.41666 1.16669 6.67783 1.16669 7C1.16669 7.32217 1.42786 7.58334 1.75002 7.58334H6.41672V12.25C6.41672 12.5722 6.67789 12.8334 7.00006 12.8334C7.32223 12.8334 7.5834 12.5722 7.5834 12.25V7.58334H12.2501C12.5723 7.58334 12.8334 7.32217 12.8334 7C12.8334 6.67783 12.5723 6.41666 12.2501 6.41666H7.5834V1.74996C7.5834 1.4278 7.32223 1.16663 7.00006 1.16663Z" fill="currentColor"/>
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 26 26" fill="none">
      <path d="M10.8047 6.52876C11.065 6.78911 11.065 7.21122 10.8047 7.47157L8.60939 9.66683H14.6666C17.428 9.66683 19.6666 11.9054 19.6666 14.6668C19.6666 17.4283 17.428 19.6668 14.6666 19.6668H12.3333C11.9651 19.6668 11.6666 19.3684 11.6666 19.0002C11.6666 18.632 11.9651 18.3335 12.3333 18.3335H14.6666C16.6916 18.3335 18.3333 16.6919 18.3333 14.6668C18.3333 12.6418 16.6916 11.0002 14.6666 11.0002H8.60939L10.8047 13.1954C11.065 13.4558 11.065 13.8779 10.8047 14.1382C10.5443 14.3986 10.1222 14.3986 9.86185 14.1382L6.52851 10.8049C6.26816 10.5446 6.26816 10.1224 6.52851 9.86209L9.86185 6.52876C10.1222 6.26841 10.5443 6.26841 10.8047 6.52876Z" fill="currentColor"/>
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
