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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M9.92945 4.2726C11.6305 3.8168 13.4344 3.93503 15.0615 4.60897C16.5052 5.20697 17.738 6.21286 18.6127 7.49746L15.5025 7.49746C14.9503 7.49746 14.5025 7.94518 14.5025 8.49746C14.5025 9.04975 14.9503 9.49746 15.5025 9.49746L20.999 9.49746C21.3393 9.49746 21.6409 9.32746 21.8216 9.06775C21.9341 8.90599 22 8.70943 22 8.49746V3C22 2.44772 21.5523 2 21 2C20.4477 2 20 2.44772 20 3V5.99999C18.9288 4.5717 17.4897 3.45 15.8268 2.76121C13.7931 1.91879 11.5381 1.771 9.41181 2.34075C7.28547 2.9105 5.40656 4.16595 4.06647 5.91239C2.72637 7.65883 2 9.79866 2 12C2 14.2013 2.72638 16.3412 4.06647 18.0876C5.40656 19.8341 7.28548 21.0895 9.41181 21.6593C11.5381 22.229 13.7931 22.0812 15.8268 21.2388C17.8606 20.3964 19.5596 18.9064 20.6603 17C20.9364 16.5217 20.7725 15.9101 20.2942 15.634C19.8159 15.3578 19.2043 15.5217 18.9282 16C18.0477 17.5251 16.6885 18.7171 15.0615 19.391C13.4344 20.065 11.6305 20.1832 9.92945 19.7274C8.22838 19.2716 6.72525 18.2673 5.65317 16.8701C4.5811 15.4729 4 13.7611 4 12C4 10.2389 4.5811 8.52707 5.65317 7.12991C6.72525 5.73276 8.22838 4.7284 9.92945 4.2726Z" fill="currentColor"/>
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
