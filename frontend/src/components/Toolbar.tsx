import { RefObject } from "react";
import { useTranslation } from "../i18n/index";
import "./Toolbar.css";

interface Props {
  isFiltered: boolean;
  filterConditionCount: number;
  filterPanelOpen: boolean;
  onFilterClick: () => void;
  onClearFilter: () => void;
  filterBtnRef: RefObject<HTMLButtonElement | null>;
  fieldConfigOpen: boolean;
  onCustomizeFieldClick: () => void;
  customizeFieldBtnRef: RefObject<HTMLButtonElement | null>;
  canUndo?: boolean;
  onUndo?: () => void;
}

export default function Toolbar({
  isFiltered,
  filterConditionCount,
  filterPanelOpen,
  onFilterClick,
  onClearFilter,
  filterBtnRef,
  fieldConfigOpen,
  onCustomizeFieldClick,
  customizeFieldBtnRef,
  canUndo,
  onUndo,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button className="toolbar-add-record">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          {t("toolbar.addRecord")}
          <svg className="toolbar-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 4l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <span className="toolbar-sep" />
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
      </div>
      <div className="toolbar-right">
        <button
          className={`toolbar-undo-btn${canUndo ? "" : " disabled"}`}
          title={t("toolbar.undo")}
          onClick={() => canUndo && onUndo?.()}
        >
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
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
  badge?: number;
  onClick?: () => void;
  btnRef?: RefObject<HTMLButtonElement | null>;
}

function ToolbarBtn({ icon, label, active, badge, onClick, btnRef }: ToolbarBtnProps) {
  return (
    <button
      ref={btnRef as RefObject<HTMLButtonElement>}
      className={`toolbar-btn ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {icon}
      {badge !== undefined && <span className="toolbar-badge">{badge}</span>}
      {label}
    </button>
  );
}

interface ToolbarIconBtnProps {
  icon: React.ReactNode;
  title: string;
}

function ToolbarIconBtn({ icon, title }: ToolbarIconBtnProps) {
  return (
    <button className="toolbar-icon-btn" title={title}>
      {icon}
    </button>
  );
}

/* --- Icons matching real Lark Base toolbar --- */

function CustomizeFieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2"/>
      <path d="M8 2v2.5M8 11.5V14M2 8h2.5M11.5 8H14M3.8 3.8l1.8 1.8M10.4 10.4l1.8 1.8M12.2 3.8l-1.8 1.8M5.6 10.4l-1.8 1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}

function ViewSettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.2"/>
      <path d="M2 5.5h12M6 5.5V14" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2.5 3.5h11l-4 5v3.5l-3 1.5V8.5l-4-5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
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
      <path d="M4 3v10M4 13l-2-2M4 13l2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M9 5h5M9 8h3.5M9 11h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}

function RowHeightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10M3 7h10M3 10h10M3 13h10" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
      <path d="M13.5 5.5v5M13.5 5.5l-1 1M13.5 5.5l1 1M13.5 10.5l-1-1M13.5 10.5l1-1" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function ConditionalColorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="6" cy="7" r="3.5" stroke="currentColor" strokeWidth="1.1"/>
      <circle cx="10" cy="7" r="3.5" stroke="currentColor" strokeWidth="1.1"/>
      <path d="M8 4.5v5" stroke="currentColor" strokeWidth="0.8" opacity="0.3"/>
    </svg>
  );
}

function DiamondIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 2l6 6-6 6-6-6 6-6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M13 8A5 5 0 103.5 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <path d="M13 4v4h-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M4 10v3a1 1 0 001 1h6a1 1 0 001-1v-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <path d="M8 2v8M5 5l3-3 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M4 6h6a3 3 0 110 6H7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <path d="M6 4L4 6l2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M12 6H6a3 3 0 100 6h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <path d="M10 4l2 2-2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function ApiIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M4 5l-3 3 3 3M12 5l3 3-3 3M9 3l-2 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M10 2h4v4M6 14H2v-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M14 2L9 7M2 14l5-5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}
