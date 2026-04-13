import { RefObject } from "react";
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
}: Props) {
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button className="toolbar-add-record">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Add Record
          <svg className="toolbar-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 4l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <span className="toolbar-sep" />
        <ToolbarBtn
          icon={<CustomizeFieldIcon />}
          label="Customize Field"
          active={fieldConfigOpen}
          onClick={onCustomizeFieldClick}
          btnRef={customizeFieldBtnRef}
        />
        <ToolbarBtn icon={<ViewSettingsIcon />} label="View Settings" />
        <ToolbarBtn
          icon={<FilterIcon />}
          label={filterConditionCount > 0 ? `${filterConditionCount} Filter` : "Filter"}
          active={isFiltered || filterPanelOpen}
          onClick={onFilterClick}
          btnRef={filterBtnRef}
        />
        <ToolbarBtn icon={<GroupByIcon />} label="Group By" />
        <ToolbarBtn icon={<SortIcon />} label="Sort" />
        <ToolbarBtn icon={<RowHeightIcon />} label="Row Height" />
        <ToolbarBtn icon={<ConditionalColorIcon />} label="Conditional Coloring" />
      </div>
      <div className="toolbar-right" />
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
