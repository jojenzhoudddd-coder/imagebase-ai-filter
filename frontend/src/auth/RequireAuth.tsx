/**
 * RequireAuth — route guard. Shows a short loading state while the initial
 * /me check is in flight; redirects to /login when the check says
 * "definitively logged out". Downstream the main App consumes useAuth()
 * to get the user + workspaceId.
 */

import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";
import "./AuthPage.css";

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="auth-loading">正在恢复会话…</div>;
  if (!user) {
    // Preserve the attempted URL so we can bounce the user back after login.
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}
