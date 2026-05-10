/**
 * AdminBlock — System admin dashboard block in Magic Canvas.
 *
 * Guard: only renders for users with `admin === true`.
 * Layout: header → scrollable body (MetricCards + UserTable).
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useBlockShell } from "../../contexts/blockShellContext";
import { useTranslation } from "../../i18n";
import type { AdminStats, AdminUser } from "../../api";
import { fetchAdminStats, fetchAdminUsers } from "../../api";
import MetricCards from "./MetricCards";
import UserTable from "./UserTable";
import "./AdminBlock.css";

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

  useEffect(() => {
    if (!user?.admin) return;
    let cancelled = false;
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

    return () => { cancelled = true; };
  }, [user?.admin]);

  const handleUserUpdated = useCallback((id: string, patch: Partial<AdminUser>) => {
    setUsers((prev) =>
      prev.map((u) => (u.id === id ? { ...u, ...patch } : u)),
    );
  }, []);

  // Guard: non-admin users see access denied
  if (!user?.admin) {
    return (
      <div className="adb-root">
        <div className="adb-access-denied">{t("admin.accessDenied")}</div>
      </div>
    );
  }

  return (
    <div className="adb-root">
      <div className="adb-header">
        <span className="adb-header-title">{t("admin.title")}</span>
        <div style={{ flex: 1 }} />
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
            <UserTable users={users} onUserUpdated={handleUserUpdated} />
          </>
        )}
      </div>
    </div>
  );
}
