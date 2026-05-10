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
        <div style={{ flex: 1 }} />
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

            {/* Toolbar */}
            <div className="adb-toolbar">
              <button
                ref={fieldsBtnRef}
                className={`adb-toolbar-btn${hiddenColumns.size > 0 ? " active" : ""}`}
                onClick={() => { setFieldsOpen((v) => !v); setFilterOpen(false); }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M8 3C4.5 3 1.7 5.1 0.5 8c1.2 2.9 4 5 7.5 5s6.3-2.1 7.5-5c-1.2-2.9-4-5-7.5-5zm0 8.3A3.3 3.3 0 1 1 8 4.7a3.3 3.3 0 0 1 0 6.6zm0-5.3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" fill="currentColor"/>
                </svg>
                {t("admin.toolbar.fields")}
              </button>
              <button
                ref={filterBtnRef}
                className={`adb-toolbar-btn${activeFilterCount > 0 ? " active" : ""}`}
                onClick={() => { setFilterOpen((v) => !v); setFieldsOpen(false); }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M1 2h14l-5.5 6.5V14l-3-2V8.5L1 2z" fill="currentColor"/>
                </svg>
                {activeFilterCount > 0
                  ? t("admin.toolbar.filterCount").replace("{count}", String(activeFilterCount))
                  : t("admin.toolbar.filter")}
              </button>
            </div>

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
