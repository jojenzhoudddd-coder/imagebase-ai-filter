/**
 * AdminBlock — System admin dashboard block in Magic Canvas.
 *
 * Guard: only renders for users with `admin === true`.
 * Layout: header → scrollable body (MetricCards + UserTable).
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
  const cancelRef = useRef<() => void>();

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
            <UserTable users={users} onUserUpdated={handleUserUpdated} />
          </>
        )}
      </div>
    </div>
  );
}
