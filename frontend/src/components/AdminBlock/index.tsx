/**
 * AdminBlock — System admin dashboard block in Magic Canvas.
 *
 * Guard: only renders for users with `admin === true`.
 * Layout: header → scrollable body (MetricCards + Toolbar + UserTable).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useBlockShell } from "../../contexts/blockShellContext";
import { useTranslation } from "../../i18n";
import type { AdminStats, AdminUser } from "../../api";
import { fetchAdminStats, fetchAdminUsers } from "../../api";
import MetricCards from "./MetricCards";
import UserTable, { ADMIN_COLUMNS } from "./UserTable";
import type { AdminColumn } from "./UserTable";
import "./AdminBlock.css";

/* ─── Filter types ───────────────────────────────────────────────────── */
interface FilterCondition {
  id: string;
  field: string;
  operator: string;
  value: string;
}

type FieldType = AdminColumn["type"];

const OPERATORS_BY_TYPE: Record<FieldType, string[]> = {
  text: ["contains", "eq", "neq", "isEmpty", "isNotEmpty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte"],
  boolean: ["eq"],
  date: ["isEmpty", "isNotEmpty"],
};

const VALUE_LESS_OPS = new Set(["isEmpty", "isNotEmpty"]);

/* ─── Filter engine ──────────────────────────────────────────────────── */
function getCellValue(user: AdminUser, field: string): string | number | boolean | null {
  switch (field) {
    case "name": return user.name || user.username || "";
    case "email": return user.email;
    case "related": return user.related;
    case "models": return user.related ? "all" : "default";
    case "lastLogin": return user.lastLoginAt || "";
    case "agent": return user.agentName || "";
    case "lastMessage": return user.lastMessageAt || "";
    case "conversations": return user.conversationCount;
    case "activities": return user.activityCount;
    case "tokens": return user.totalTokens;
    case "workspaces": return user.workspaceCount;
    case "artifacts": return user.artifactCount;
    case "workends": return user.workendCount;
    default: return null;
  }
}

function matchesCondition(user: AdminUser, cond: FilterCondition): boolean {
  const raw = getCellValue(user, cond.field);
  const col = ADMIN_COLUMNS.find((c) => c.key === cond.field);
  if (!col) return true;

  if (cond.operator === "isEmpty") {
    return raw === "" || raw === null || raw === undefined;
  }
  if (cond.operator === "isNotEmpty") {
    return raw !== "" && raw !== null && raw !== undefined;
  }

  if (col.type === "boolean") {
    const boolVal = cond.value === "true";
    return raw === boolVal;
  }

  if (col.type === "number") {
    const numVal = Number(cond.value);
    const numRaw = Number(raw);
    if (isNaN(numVal)) return true;
    switch (cond.operator) {
      case "eq": return numRaw === numVal;
      case "neq": return numRaw !== numVal;
      case "gt": return numRaw > numVal;
      case "gte": return numRaw >= numVal;
      case "lt": return numRaw < numVal;
      case "lte": return numRaw <= numVal;
      default: return true;
    }
  }

  // text / date string comparison
  const strVal = String(raw ?? "").toLowerCase();
  const target = cond.value.toLowerCase();
  switch (cond.operator) {
    case "contains": return strVal.includes(target);
    case "eq": return strVal === target;
    case "neq": return strVal !== target;
    default: return true;
  }
}

/* ─── Unique ID helper ───────────────────────────────────────────────── */
let _filterId = 0;
function nextFilterId(): string {
  return `f_${++_filterId}`;
}

/* ═══════════════════════════════════════════════════════════════════════ */

interface Props {
  blockId: string;
}

export default function AdminBlock({ blockId: _blockId }: Props) {
  const { user } = useAuth();
  const shell = useBlockShell();
  const { t } = useTranslation();

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const cancelRef = useRef<() => void>();

  // Toolbar state
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>([]);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  // Button refs for panel positioning
  const fieldsBtnRef = useRef<HTMLButtonElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);

  // Panel refs for click-outside
  const fieldsPanelRef = useRef<HTMLDivElement>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(() => {
    if (!user?.admin) return;
    cancelRef.current?.();
    let cancelled = false;
    cancelRef.current = () => { cancelled = true; };
    setLoading(true);

    Promise.all([fetchAdminStats(), fetchAdminUsers()])
      .then(([s, u]) => {
        if (cancelled) return;
        setStats(s);
        setUsers(u.users);
      })
      .catch((err) => {
        console.error("[AdminBlock] failed to load:", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
  }, [user?.admin]);

  useEffect(() => {
    loadData();
    return () => { cancelRef.current?.(); };
  }, [loadData]);

  // Click outside to close panels
  useEffect(() => {
    if (!fieldsOpen && !filterOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (fieldsOpen && fieldsPanelRef.current && !fieldsPanelRef.current.contains(target) && !fieldsBtnRef.current?.contains(target)) {
        setFieldsOpen(false);
      }
      if (filterOpen && filterPanelRef.current && !filterPanelRef.current.contains(target) && !filterBtnRef.current?.contains(target)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [fieldsOpen, filterOpen]);

  const handleUserUpdated = useCallback((id: string, patch: Partial<AdminUser>) => {
    setUsers((prev) =>
      prev.map((u) => (u.id === id ? { ...u, ...patch } : u)),
    );
  }, []);

  // Filtered users
  const filteredUsers = useMemo(() => {
    if (filterConditions.length === 0) return users;
    return users.filter((u) =>
      filterConditions.every((cond) => {
        if (!cond.field) return true;
        if (!VALUE_LESS_OPS.has(cond.operator) && !cond.value) return true;
        return matchesCondition(u, cond);
      }),
    );
  }, [users, filterConditions]);

  // Panel position helpers
  const getPanelPos = (btnRef: React.RefObject<HTMLButtonElement | null>) => {
    if (!btnRef.current) return { top: 0, left: 0 };
    const rect = btnRef.current.getBoundingClientRect();
    return { top: rect.bottom + 4, left: rect.left };
  };

  // Column toggle
  const toggleColumn = (key: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Filter CRUD
  const addCondition = () => {
    setFilterConditions((prev) => [
      ...prev,
      { id: nextFilterId(), field: ADMIN_COLUMNS[0].key, operator: OPERATORS_BY_TYPE[ADMIN_COLUMNS[0].type][0], value: "" },
    ]);
  };

  const removeCondition = (id: string) => {
    setFilterConditions((prev) => prev.filter((c) => c.id !== id));
  };

  const updateCondition = (id: string, patch: Partial<FilterCondition>) => {
    setFilterConditions((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const updated = { ...c, ...patch };
        // If field changed, reset operator and value
        if (patch.field && patch.field !== c.field) {
          const col = ADMIN_COLUMNS.find((col) => col.key === patch.field);
          const ops = OPERATORS_BY_TYPE[col?.type ?? "text"];
          updated.operator = ops[0];
          updated.value = "";
        }
        return updated;
      }),
    );
  };

  // Guard: non-admin users see access denied
  if (!user?.admin) {
    return (
      <div className="adb-root">
        <div className="adb-access-denied">{t("admin.accessDenied")}</div>
      </div>
    );
  }

  const activeFilterCount = filterConditions.filter((c) => c.field && (VALUE_LESS_OPS.has(c.operator) || c.value)).length;

  return (
    <div className="adb-root">
      <div className="adb-header">
        <span className="adb-header-title">{t("admin.title")}</span>
        <div className="adb-header-actions">
          <button
            ref={fieldsBtnRef}
            className={`table-topbar-btn${hiddenColumns.size > 0 ? " active" : ""}`}
            onClick={() => { setFieldsOpen((v) => !v); setFilterOpen(false); }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2.88557 13.1558L2.67815 12.9299C1.95199 12.1389 1.40718 11.1955 1.08778 10.1652L0.997742 9.87475L2.36311 8.00002L0.997742 6.12529L1.08778 5.83484C1.40718 4.80455 1.95199 3.86115 2.67815 3.07019L2.88557 2.84426L5.18011 3.09506L6.11209 0.970504L6.41093 0.903226C6.92877 0.786644 7.46076 0.727295 8 0.727295C8.53924 0.727295 9.07123 0.786644 9.58906 0.903226L9.88791 0.970504L10.8199 3.09506L13.1144 2.84426L13.3218 3.07019C14.048 3.86115 14.5928 4.80455 14.9122 5.83484L15.0023 6.12529L13.6369 8.00002L15.0023 9.87475L14.9122 10.1652C14.5928 11.1955 14.048 12.1389 13.3218 12.9299L13.1144 13.1558L10.8199 12.905L9.88791 15.0295L9.58906 15.0968C9.07123 15.2134 8.53924 15.2728 8 15.2728C7.46076 15.2728 6.92877 15.2134 6.41093 15.0968L6.11209 15.0295L5.18011 12.905L2.88557 13.1558ZM5.20896 11.6825C5.63971 11.6354 6.05118 11.8733 6.22525 12.2701L6.97221 13.9729C7.30911 14.0311 7.65252 14.0606 8 14.0606C8.34748 14.0606 8.69089 14.0311 9.02779 13.9729L9.77475 12.2701C9.94882 11.8733 10.3603 11.6354 10.791 11.6825L12.6272 11.8831C13.0706 11.3494 13.4203 10.7428 13.659 10.0892L12.5627 8.58403C12.3092 8.23593 12.3092 7.76404 12.5627 7.41594L13.659 5.91073C13.4203 5.25712 13.0706 4.6506 12.6272 4.11682L10.791 4.31752C10.3603 4.3646 9.94882 4.12667 9.77475 3.72986L9.02779 2.02707C8.69089 1.96889 8.34748 1.93938 8 1.93938C7.65252 1.93938 7.30911 1.96889 6.97221 2.02707L6.22525 3.72986C6.05118 4.12667 5.63971 4.3646 5.20896 4.31752L3.37282 4.11682C2.92936 4.6506 2.57971 5.25712 2.34102 5.91073L3.43727 7.41594C3.69079 7.76404 3.69079 8.23593 3.43727 8.58403L2.34102 10.0892C2.57971 10.7428 2.92936 11.3494 3.37282 11.8831L5.20896 11.6825ZM8 11.0303C6.33214 11.0303 4.98124 9.67296 4.98124 8.00002C4.98124 6.32707 6.33214 4.96971 8 4.96971C9.66786 4.96971 11.0188 6.32707 11.0188 8.00002C11.0188 9.67296 9.66786 11.0303 8 11.0303ZM8 9.81824C8.99713 9.81824 9.80664 9.00486 9.80664 8.00006C9.80664 6.99526 8.99713 6.18188 8 6.18188C7.00287 6.18188 6.19336 6.99526 6.19336 8.00006C6.19336 9.00486 7.00287 9.81824 8 9.81824Z" fill="currentColor"/>
            </svg>
            <span className="table-topbar-btn-label">{t("admin.toolbar.fields")}</span>
          </button>
          <button
            ref={filterBtnRef}
            className={`table-topbar-btn${activeFilterCount > 0 ? " active" : ""}`}
            onClick={() => { setFilterOpen((v) => !v); setFieldsOpen(false); }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8.66669 7.66671L11.7157 5.53243C11.8939 5.40767 12 5.20381 12 4.98627V2.66671C12 1.93033 11.4031 1.33337 10.6667 1.33337H2.00002C1.26364 1.33337 0.666687 1.93033 0.666687 2.66671V4.98627C0.666687 5.20381 0.772828 5.40767 0.951046 5.53243L4.00002 7.66671V12.4542C4.00002 12.9876 4.31788 13.4696 4.80813 13.6797L7.73741 14.9351C8.17732 15.1236 8.66669 14.801 8.66669 14.3223V7.66671ZM5.33335 6.9725L2.00002 4.63917V2.66671H10.6667V4.63917L7.33335 6.9725V13.3113L5.33335 12.4542V6.9725Z" fill="currentColor"/>
              <path d="M10 9.33337C10 8.96518 10.2985 8.66671 10.6667 8.66671H14C14.3682 8.66671 14.6667 8.96518 14.6667 9.33337C14.6667 9.70156 14.3682 10 14 10H10.6667C10.2985 10 10 9.70156 10 9.33337Z" fill="currentColor"/>
              <path d="M10.6667 11.3334C10.2985 11.3334 10 11.6319 10 12C10 12.3682 10.2985 12.6667 10.6667 12.6667H12.6667C13.0349 12.6667 13.3334 12.3682 13.3334 12C13.3334 11.6319 13.0349 11.3334 12.6667 11.3334H10.6667Z" fill="currentColor"/>
            </svg>
            <span className="table-topbar-btn-label">
              {activeFilterCount > 0
                ? t("admin.toolbar.filterCount").replace("{count}", String(activeFilterCount))
                : t("admin.toolbar.filter")}
            </span>
          </button>
        </div>
        <button className="adb-header-btn" onClick={loadData} title={t("admin.refresh")}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M13.65 2.35A7.96 7.96 0 008 0C3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 018 14 6 6 0 012 8a6 6 0 016-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z" fill="currentColor" />
          </svg>
        </button>
        {shell?.canClose && (
          <button className="adb-header-close" onClick={shell.onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <div className="adb-body">
        {loading ? null : (
          <>
            <MetricCards stats={stats} />

            {/* Fields Panel */}
            {fieldsOpen && (
              <div
                ref={fieldsPanelRef}
                className="adb-fields-panel"
                style={getPanelPos(fieldsBtnRef)}
              >
                {ADMIN_COLUMNS.map((col) => (
                  <div key={col.key} className="adb-fields-item">
                    <span className="adb-fields-label">{t(col.i18nKey)}</span>
                    {col.alwaysVisible ? (
                      <span className="adb-fields-lock">
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                          <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                          <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                      </span>
                    ) : (
                      <button
                        className={`adb-fields-eye${hiddenColumns.has(col.key) ? " hidden" : ""}`}
                        onClick={() => toggleColumn(col.key)}
                      >
                        {hiddenColumns.has(col.key) ? (
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                            <path d="M2 2l12 12M4.5 5.8A5.8 5.8 0 0 0 .5 8c1.2 2.9 4 5 7.5 5 1.2 0 2.4-.3 3.4-.7M9.8 6.2a2 2 0 0 1-3.6 3.6M13.5 8c-.4.9-1 1.8-1.7 2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                          </svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                            <path d="M8 3C4.5 3 1.7 5.1 0.5 8c1.2 2.9 4 5 7.5 5s6.3-2.1 7.5-5c-1.2-2.9-4-5-7.5-5zm0 8.3A3.3 3.3 0 1 1 8 4.7a3.3 3.3 0 0 1 0 6.6zm0-5.3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" fill="currentColor"/>
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Filter Panel */}
            {filterOpen && (
              <div
                ref={filterPanelRef}
                className="adb-filter-panel"
                style={getPanelPos(filterBtnRef)}
              >
                <div className="adb-filter-title">{t("admin.filter.title")}</div>
                {filterConditions.map((cond) => {
                  const col = ADMIN_COLUMNS.find((c) => c.key === cond.field);
                  const colType = col?.type ?? "text";
                  const ops = OPERATORS_BY_TYPE[colType];
                  const needsValue = !VALUE_LESS_OPS.has(cond.operator);
                  return (
                    <div key={cond.id} className="adb-filter-row">
                      <select
                        className="adb-filter-select"
                        value={cond.field}
                        onChange={(e) => updateCondition(cond.id, { field: e.target.value })}
                      >
                        {ADMIN_COLUMNS.map((c) => (
                          <option key={c.key} value={c.key}>{t(c.i18nKey)}</option>
                        ))}
                      </select>
                      <select
                        className="adb-filter-select"
                        value={cond.operator}
                        onChange={(e) => updateCondition(cond.id, { operator: e.target.value })}
                      >
                        {ops.map((op) => (
                          <option key={op} value={op}>{t(`admin.filter.${op}`)}</option>
                        ))}
                      </select>
                      {needsValue && colType === "boolean" ? (
                        <select
                          className="adb-filter-select"
                          value={cond.value || "true"}
                          onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                        >
                          <option value="true">{t("admin.filter.isTrue")}</option>
                          <option value="false">{t("admin.filter.isFalse")}</option>
                        </select>
                      ) : needsValue ? (
                        <input
                          className="adb-filter-input"
                          type={colType === "number" ? "number" : "text"}
                          value={cond.value}
                          onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                        />
                      ) : null}
                      <button className="adb-filter-delete" onClick={() => removeCondition(cond.id)}>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                      </button>
                    </div>
                  );
                })}
                <button className="adb-filter-add" onClick={addCondition}>
                  + {t("admin.filter.addCondition")}
                </button>
              </div>
            )}

            <UserTable users={filteredUsers} hiddenColumns={hiddenColumns} onUserUpdated={handleUserUpdated} />
          </>
        )}
      </div>
    </div>
  );
}
