import { useCallback, useState } from "react";
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

export default function UserTable({ users, onUserUpdated }: Props) {
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

  if (users.length === 0) {
    return <div className="adb-empty">{t("admin.noUsers")}</div>;
  }

  return (
    <div className="adb-table-wrap">
      <table className="adb-table">
        <thead>
          <tr>
            <th>{t("admin.table.name")}</th>
            <th>{t("admin.table.email")}</th>
            <th>{t("admin.table.related")}</th>
            <th>{t("admin.table.models")}</th>
            <th>{t("admin.table.lastActive")}</th>
            <th>{t("admin.table.conversations")}</th>
            <th>{t("admin.table.activities")}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
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
              <td>{formatDateTime(user.updatedAt)}</td>
              <td>{user.conversationCount}</td>
              <td>{user.activityCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
