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
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTokenCount(n: number): string {
  if (n < 1000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

/* ─── Sort logic ────────────────────────────────────────────────────── */
type SortDir = "desc" | "asc" | null;
type SortableKey = "related" | "lastLogin" | "lastMessage" | "conversations" | "activities" | "tokens" | "workspaces" | "artifacts" | "workends";

const SORTABLE_KEYS = new Set<SortableKey>([
  "related", "lastLogin", "lastMessage", "conversations", "activities",
  "tokens", "workspaces", "artifacts", "workends",
]);

function getSortValue(user: AdminUser, key: SortableKey): number | string {
  switch (key) {
    case "related": return user.related ? 1 : 0;
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

function SortIndicator({ dir }: { dir: SortDir }) {
  if (!dir) {
    // idle: faint up+down arrows
    return (
      <svg className="adb-sort-icon idle" width="10" height="14" viewBox="0 0 10 14" fill="none">
        <path d="M5 1L8.5 5H1.5L5 1Z" fill="currentColor" opacity="0.3"/>
        <path d="M5 13L1.5 9H8.5L5 13Z" fill="currentColor" opacity="0.3"/>
      </svg>
    );
  }
  return (
    <svg className="adb-sort-icon active" width="10" height="14" viewBox="0 0 10 14" fill="none">
      <path d="M5 1L8.5 5H1.5L5 1Z" fill="currentColor" opacity={dir === "asc" ? 1 : 0.2}/>
      <path d="M5 13L1.5 9H8.5L5 13Z" fill="currentColor" opacity={dir === "desc" ? 1 : 0.2}/>
    </svg>
  );
}

export default function UserTable({ users, onUserUpdated }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortableKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

  const handleSort = (key: SortableKey) => {
    if (sortKey !== key) {
      // activate new field: start with desc
      setSortKey(key);
      setSortDir("desc");
    } else if (sortDir === "desc") {
      setSortDir("asc");
    } else {
      // asc → reset
      setSortKey(null);
      setSortDir(null);
    }
  };

  const sortedUsers = useMemo(() => {
    if (!sortKey || !sortDir) return users;
    return [...users].sort((a, b) => {
      const va = getSortValue(a, sortKey);
      const vb = getSortValue(b, sortKey);
      let cmp: number;
      if (typeof va === "number" && typeof vb === "number") {
        cmp = va - vb;
      } else {
        cmp = String(va).localeCompare(String(vb));
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [users, sortKey, sortDir]);

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
    const dir = sortKey === key ? sortDir : null;
    return (
      <th className="adb-th-sortable" onClick={() => handleSort(key)}>
        <span className="adb-th-inner">
          <span>{label}</span>
          <SortIndicator dir={dir} />
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
                  <span className="adb-toggle-thumb" />
                </label>
              </td>
              <td>
                <span className={`adb-models-badge ${user.related ? "adb-models-badge--active" : ""}`}>
                  {user.related ? t("admin.models.all") : t("admin.models.default")}
                </span>
              </td>
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
