import { useState, useRef } from "react";
import { View } from "../types";
import { useTranslation } from "../i18n/index";
import InlineEdit from "./InlineEdit";
import DropdownMenu from "./DropdownMenu";
import "./ViewTabs.css";

interface Props {
  views: View[];
  activeViewId: string;
  onSelect: (id: string) => void;
  isFiltered: boolean;
  isFilterDirty: boolean;
  onSaveView?: () => void;
  onClearFilter?: () => void;
  onRenameView?: (viewId: string, newName: string) => void;
}

/* Figma: Grid/Table icon — line 42 of 主框架.svg */
function GridIcon() {
  return (
    <svg className="view-tab-icon" width="14" height="14" viewBox="265 79 14 14" fill="none">
      <path d="M265.333 80.6668C265.333 79.9305 265.93 79.3335 266.667 79.3335H277.333C278.07 79.3335 278.667 79.9304 278.667 80.6668V91.3335C278.667 92.0699 278.07 92.6668 277.333 92.6668H266.667C265.93 92.6668 265.333 92.0699 265.333 91.3335V80.6668ZM270.333 80.6668V83.3335L277.333 83.3335V80.6668H270.333ZM270.333 84.6668V87.3335L277.333 87.3335V84.6668L270.333 84.6668ZM269 87.3335V84.6668L266.667 84.6668V87.3335H269ZM266.667 88.6668V91.3335H269V88.6668H266.667ZM270.333 88.6668V91.3335H277.333V88.6668L270.333 88.6668ZM269 80.6668H266.667V83.3335L269 83.3335V80.6668Z" fill="currentColor"/>
    </svg>
  );
}

/* Figma: Filter-configure icon — lines 52-54 of 追加筛选生成成功，自动 Apply.svg */
function FilterConfigIcon() {
  return (
    <svg width="12" height="12" viewBox="361 81 11 12" fill="none">
      <path d="M367.286 86.3232L369.681 84.5293C369.821 84.4245 369.905 84.2531 369.905 84.0703V82.1207C369.905 81.5017 369.436 81 368.857 81H362.048C361.469 81 361 81.5017 361 82.1207V84.0703C361 84.2531 361.083 84.4245 361.223 84.5293L363.619 86.3232V90.3471C363.619 90.7954 363.869 91.2006 364.254 91.3772L366.556 92.4324C366.901 92.5908 367.286 92.3196 367.286 91.9173V86.3232ZM364.667 85.7397L362.048 83.7785V82.1207H368.857V83.7785L366.238 85.7397V91.0675L364.667 90.3471V85.7397Z" fill="currentColor"/>
      <path d="M368.333 87.7241C368.333 87.4146 368.568 87.1637 368.857 87.1637H371.476C371.765 87.1637 372 87.4146 372 87.7241C372 88.0335 371.765 88.2844 371.476 88.2844H368.857C368.568 88.2844 368.333 88.0335 368.333 87.7241Z" fill="currentColor"/>
      <path d="M368.857 89.4051C368.568 89.4051 368.333 89.6559 368.333 89.9654C368.333 90.2749 368.568 90.5257 368.857 90.5257H370.429C370.718 90.5257 370.952 90.2749 370.952 89.9654C370.952 89.6559 370.718 89.4051 370.429 89.4051H368.857Z" fill="currentColor"/>
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

const VIEW_ICONS: Record<string, React.ReactNode> = {
  view_all: <GridIcon />,
};

export default function ViewTabs({ views, activeViewId, onSelect, isFiltered, isFilterDirty, onSaveView, onClearFilter, onRenameView }: Props) {
  const { t } = useTranslation();
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [menuViewId, setMenuViewId] = useState<string | null>(null);
  const moreRefs = useRef<Map<string, HTMLSpanElement>>(new Map());

  const menuItems = [
    { key: "rename", label: t("contextMenu.rename"), icon: <RenameIcon /> },
  ];

  return (
    <div className="view-tabs">
      <div className="view-tabs-list">
        {views.map((v, i) => {
          const isActive = v.id === activeViewId;
          const prevActive = i > 0 && views[i - 1].id === activeViewId;
          const showDivider = i > 0 && !isActive && !prevActive;

          return (
            <div key={v.id} style={{ display: "flex", alignItems: "center" }}>
              {showDivider && <span className="view-tab-divider" />}
              <div
                className={`view-tab ${isActive ? "active" : ""}`}
                onClick={() => onSelect(v.id)}
              >
                {VIEW_ICONS[v.id] ?? <GridIcon />}
                <InlineEdit
                  value={v.name === "Grid" ? t("view.defaultGrid") : v.name}
                  isEditing={editingViewId === v.id}
                  onStartEdit={() => setEditingViewId(v.id)}
                  onSave={(name) => {
                    setEditingViewId(null);
                    onRenameView?.(v.id, name);
                  }}
                  onCancelEdit={() => setEditingViewId(null)}
                  className="view-tab-edit"
                />
                {isActive && !isFilterDirty && editingViewId !== v.id && (
                  <span
                    className="view-tab-menu"
                    role="button"
                    ref={(el) => { if (el) moreRefs.current.set(v.id, el); }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuViewId(menuViewId === v.id ? null : v.id);
                    }}
                    title={t("viewTabs.more")}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <circle cx="6" cy="2.5" r="1" fill="currentColor"/>
                      <circle cx="6" cy="6" r="1" fill="currentColor"/>
                      <circle cx="6" cy="9.5" r="1" fill="currentColor"/>
                    </svg>
                  </span>
                )}
                {isActive && isFilterDirty && (
                  <span className="view-tab-apply-pill" onClick={(e) => e.stopPropagation()}>
                    <FilterConfigIcon />
                    <span className="view-tab-apply-text">{t("viewTabs.filterConfigured")}</span>
                    <button className="view-tab-apply-btn" onClick={(e) => { e.stopPropagation(); onClearFilter?.(); }}>{t("viewTabs.clear")}</button>
                    <button className="view-tab-apply-btn" onClick={(e) => { e.stopPropagation(); onSaveView?.(); }}>{t("viewTabs.save")}</button>
                  </span>
                )}
                {menuViewId === v.id && moreRefs.current.get(v.id) && (
                  <DropdownMenu
                    items={menuItems}
                    anchorEl={moreRefs.current.get(v.id)!}
                    onSelect={(key) => {
                      if (key === "rename") setEditingViewId(v.id);
                    }}
                    onClose={() => setMenuViewId(null)}
                  />
                )}
              </div>
            </div>
          );
        })}
        <button className="view-tab-add" title={t("viewTabs.addView")}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="view-tab-add-label">{t("viewTabs.addView")}</span>
        </button>
      </div>
    </div>
  );
}
