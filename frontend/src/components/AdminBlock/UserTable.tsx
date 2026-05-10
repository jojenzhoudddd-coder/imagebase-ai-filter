import { useCallback, useState } from "react";
import { useTranslation } from "../../i18n";
import { useToast } from "../Toast/index";
import type { AdminUser } from "../../api";
import { patchAdminUser } from "../../api";

/** Column definition for the admin user table. */
export interface AdminColumn {
  key: string;
  i18nKey: string;
  type: "text" | "number" | "boolean" | "date";
  alwaysVisible?: boolean;
}

export const ADMIN_COLUMNS: AdminColumn[] = [
  { key: "name", i18nKey: "admin.table.name", type: "text", alwaysVisible: true },
  { key: "email", i18nKey: "admin.table.email", type: "text", alwaysVisible: true },
  { key: "related", i18nKey: "admin.table.related", type: "boolean" },
  { key: "models", i18nKey: "admin.table.models", type: "text" },
  { key: "lastLogin", i18nKey: "admin.table.lastLogin", type: "date" },
  { key: "agent", i18nKey: "admin.table.agent", type: "text" },
  { key: "lastMessage", i18nKey: "admin.table.lastMessage", type: "date" },
  { key: "conversations", i18nKey: "admin.table.conversations", type: "number" },
  { key: "activities", i18nKey: "admin.table.activities", type: "number" },
  { key: "tokens", i18nKey: "admin.table.tokens", type: "number" },
  { key: "workspaces", i18nKey: "admin.table.workspaces", type: "number" },
  { key: "artifacts", i18nKey: "admin.table.artifacts", type: "number" },
  { key: "workends", i18nKey: "admin.table.workends", type: "number" },
];

interface Props {
  users: AdminUser[];
  hiddenColumns: Set<string>;
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

export default function UserTable({ users, hiddenColumns, onUserUpdated }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());

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

  const isVisible = (key: string) => !hiddenColumns.has(key);

  if (users.length === 0) {
    return <div className="adb-empty">{t("admin.noUsers")}</div>;
  }

  const renderCell = (user: AdminUser, key: string) => {
    switch (key) {
      case "name":
        return (
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
        );
      case "email":
        return <>{user.email}</>;
      case "related":
        return (
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
        );
      case "models":
        return (
          <span className={`adb-models-badge ${user.related ? "adb-models-badge--active" : ""}`}>
            {user.related ? t("admin.models.all") : t("admin.models.default")}
          </span>
        );
      case "lastLogin":
        return <>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "-"}</>;
      case "agent":
        return (
          <div className="adb-user-cell">
            <img
              className="adb-avatar"
              src={user.agentAvatarUrl || "/avatars/avatar_1.png"}
              alt=""
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/avatars/avatar_1.png"; }}
            />
            <span className="adb-user-name">{user.agentName || "-"}</span>
          </div>
        );
      case "lastMessage":
        return <>{user.lastMessageAt ? formatDateTime(user.lastMessageAt) : "-"}</>;
      case "conversations":
        return <>{user.conversationCount}</>;
      case "activities":
        return <>{user.activityCount}</>;
      case "tokens":
        return <>{formatTokenCount(user.totalTokens)}</>;
      case "workspaces":
        return <>{user.workspaceCount}</>;
      case "artifacts":
        return <>{user.artifactCount}</>;
      case "workends":
        return <>{user.workendCount}</>;
      default:
        return <>-</>;
    }
  };

  const visibleColumns = ADMIN_COLUMNS.filter((col) => isVisible(col.key));

  return (
    <div className="adb-table-wrap">
      <table className="adb-table">
        <thead>
          <tr>
            {visibleColumns.map((col) => (
              <th key={col.key}>{t(col.i18nKey)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              {visibleColumns.map((col) => (
                <td key={col.key}>{renderCell(user, col.key)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
