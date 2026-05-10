import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { useToast } from "../Toast/index";
import type { AdminUser } from "../../api";
import { patchAdminUser } from "../../api";

interface Props {
  users: AdminUser[];
  onUserUpdated: (id: string, patch: Partial<AdminUser>) => void;
}

function formatDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function formatTokenCount(n: number): string {
  if (n < 1000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

/* ─── Sort logic (compound) ─────────────────────────────────────────── */
type SortDir = "desc" | "asc";
type SortableKey = "related" | "createdAt" | "lastLogin" | "lastMessage" | "conversations" | "activities" | "tokens" | "workspaces" | "artifacts" | "workends";

interface SortEntry { key: SortableKey; dir: SortDir }

const SORTABLE_KEYS = new Set<SortableKey>([
  "related", "createdAt", "lastLogin", "lastMessage", "conversations", "activities",
  "tokens", "workspaces", "artifacts", "workends",
]);

function getSortValue(user: AdminUser, key: SortableKey): number | string {
  switch (key) {
    case "related": return user.related ? 1 : 0;
    case "createdAt": return user.createdAt || "";
    case "lastLogin": return user.lastLoginAt || "";
    case "lastMessage": return user.lastMessageAt || "";
    case "conversations": return user.conversationCount;
    case "activities": return user.activityCount;
    case "tokens": return user.totalTokens;
    case "workspaces": return user.workspaceCount;
    case "artifacts": return user.artifactCount;
    case "workends": return user.workendCount;
  }
}

function compareSortValues(va: number | string, vb: number | string, dir: SortDir): number {
  let cmp: number;
  if (typeof va === "number" && typeof vb === "number") {
    cmp = va - vb;
  } else {
    cmp = String(va).localeCompare(String(vb));
  }
  return dir === "asc" ? cmp : -cmp;
}

function SortIndicator({ dir, order }: { dir: SortDir | null; order: number | null }) {
  return (
    <span className={`adb-sort-btn${dir ? " active" : ""}`}>
      <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
        <path d="M5 1L8.5 5H1.5L5 1Z" fill="currentColor" opacity={dir === "asc" ? 1 : 0.3}/>
        <path d="M5 13L1.5 9H8.5L5 13Z" fill="currentColor" opacity={dir === "desc" ? 1 : 0.3}/>
      </svg>
      {order !== null && order > 0 && (
        <span className="adb-sort-order">{order + 1}</span>
      )}
    </span>
  );
}

export default function UserTable({ users, onUserUpdated }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [sortStack, setSortStack] = useState<SortEntry[]>(() => {
    try {
      const saved = localStorage.getItem("admin_sort");
      if (saved) return JSON.parse(saved) as SortEntry[];
    } catch { /* ignore */ }
    return [];
  });

  const handleSort = (key: SortableKey) => {
    setSortStack((prev) => {
      const idx = prev.findIndex((s) => s.key === key);
      let next: SortEntry[];
      if (idx === -1) {
        next = [...prev, { key, dir: "desc" }];
      } else if (prev[idx].dir === "desc") {
        next = [...prev];
        next[idx] = { key, dir: "asc" };
      } else {
        next = prev.filter((_, i) => i !== idx);
      }
      try { localStorage.setItem("admin_sort", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const sortedUsers = useMemo(() => {
    if (sortStack.length === 0) return users;
    return [...users].sort((a, b) => {
      for (const { key, dir } of sortStack) {
        const va = getSortValue(a, key);
        const vb = getSortValue(b, key);
        const cmp = compareSortValues(va, vb, dir);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }, [users, sortStack]);

  const handleToggleRelated = useCallback(async (user: AdminUser) => {
    const newValue = !user.related;
    setLoadingIds((prev) => new Set(prev).add(user.id));
    try {
      await patchAdminUser(user.id, { related: newValue });
      onUserUpdated(user.id, { related: newValue });
      toast.success(t("admin.toast.userUpdated"));
    } catch {
      toast.error(t("admin.toast.updateFailed"));
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(user.id);
        return next;
      });
    }
  }, [onUserUpdated, toast, t]);

  if (users.length === 0) {
    return <div className="adb-empty">{t("admin.noUsers")}</div>;
  }

  const th = (label: string, key?: SortableKey) => {
    if (!key || !SORTABLE_KEYS.has(key)) {
      return <th>{label}</th>;
    }
    const idx = sortStack.findIndex((s) => s.key === key);
    const dir = idx >= 0 ? sortStack[idx].dir : null;
    const order = sortStack.length > 1 ? idx : null;
    return (
      <th className="adb-th-sortable" onClick={() => handleSort(key)}>
        <span className="adb-th-inner">
          <span>{label}</span>
          <SortIndicator dir={dir} order={order} />
        </span>
      </th>
    );
  };

  return (
    <div className="adb-table-wrap">
      <table className="adb-table">
        <thead>
          <tr>
            {th(t("admin.table.name"))}
            {th(t("admin.table.email"))}
            {th(t("admin.table.related"), "related")}
            {th(t("admin.table.models"))}
            {th(t("admin.table.createdAt"), "createdAt")}
            {th(t("admin.table.lastLogin"), "lastLogin")}
            {th(t("admin.table.agent"))}
            {th(t("admin.table.lastMessage"), "lastMessage")}
            {th(t("admin.table.conversations"), "conversations")}
            {th(t("admin.table.activities"), "activities")}
            {th(t("admin.table.tokens"), "tokens")}
            {th(t("admin.table.workspaces"), "workspaces")}
            {th(t("admin.table.artifacts"), "artifacts")}
            {th(t("admin.table.workends"), "workends")}
          </tr>
        </thead>
        <tbody>
          {sortedUsers.map((user) => (
            <tr key={user.id}>
              <td>
                <div className="adb-user-cell">
                  {user.avatarUrl ? (
                    <img className="adb-avatar" src={user.avatarUrl} alt="" />
                  ) : (
                    <span className="adb-avatar-fallback">
                      {(user.name || user.email).charAt(0).toUpperCase()}
                    </span>
                  )}
                  <span className="adb-user-name">{user.name || user.username || "-"}</span>
                </div>
              </td>
              <td>{user.email}</td>
              <td>
                <label className="adb-toggle">
                  <input
                    type="checkbox"
                    checked={user.related}
                    disabled={loadingIds.has(user.id)}
                    onChange={() => handleToggleRelated(user)}
                  />
                  <span className="adb-toggle-track" />
                </label>
              </td>
              <td>
                <span className={`adb-models-badge ${user.related ? "adb-models-badge--active" : ""}`}>
                  {user.related ? t("admin.models.all") : t("admin.models.default")}
                </span>
              </td>
              <td>{user.createdAt ? formatDateTime(user.createdAt) : "-"}</td>
              <td>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "-"}</td>
              <td>
                <div className="adb-user-cell">
                  <img
                    className="adb-avatar"
                    src={user.agentAvatarUrl || "/avatars/avatar_1.png"}
                    alt=""
                    onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/avatars/avatar_1.png"; }}
                  />
                  <span className="adb-user-name">{user.agentName || "-"}</span>
                </div>
              </td>
              <td>{user.lastMessageAt ? formatDateTime(user.lastMessageAt) : "-"}</td>
              <td>{user.conversationCount}</td>
              <td>{user.activityCount}</td>
              <td>{formatTokenCount(user.totalTokens)}</td>
              <td>{user.workspaceCount}</td>
              <td>{user.artifactCount}</td>
              <td>{user.workendCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
