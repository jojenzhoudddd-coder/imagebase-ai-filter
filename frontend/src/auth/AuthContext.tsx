/**
 * AuthContext — session state + login/register/logout actions.
 *
 * The backend holds the JWT in an httpOnly cookie; the FE never sees the
 * raw token. We check auth status by hitting `/api/auth/me` on mount (and
 * after login/logout mutations). `user === null && !loading` means
 * "definitively logged out" — routes key their redirects off that.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface AuthUser {
  id: string;
  email: string;
  username: string | null;
  name: string;
  avatarUrl: string | null;
}

export interface AuthWorkspace {
  id: string;
  name: string;
  orgId: string;
}

interface MeResponse {
  user: AuthUser;
  workspaces: AuthWorkspace[];
  workspaceId: string | null;
}

/**
 * 后端用来驱动 i18n toast 的错误代码。前端 map 到 `auth.toast.*` key。
 * 未知 code 时显示通用 "network/server error" 文案。
 */
export interface AuthError extends Error {
  code?: string;
  status?: number;
}

interface AuthContextValue {
  user: AuthUser | null;
  workspaces: AuthWorkspace[];
  /** Primary workspace the app should render. Typically user's personal one. */
  workspaceId: string | null;
  /** True while the initial session check is in flight. Routes should show
   * a loading state rather than the login page while this is true. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string; password: string; username: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-pull /me. Call after profile edits. */
  refresh: () => Promise<void>;
  /** Merge partial updates (e.g. after PATCH /profile) without a round-trip. */
  patchUser: (patch: Partial<AuthUser>) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaces, setWorkspaces] = useState<AuthWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (res.ok) {
        const data = (await res.json()) as MeResponse;
        setUser(data.user);
        setWorkspaces(data.workspaces ?? []);
        setWorkspaceId(data.workspaceId);
      } else {
        setUser(null);
        setWorkspaces([]);
        setWorkspaceId(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const throwAuthError = (body: any, status: number, fallbackMsg: string): never => {
    const e: AuthError = new Error(body?.error || fallbackMsg);
    e.code = body?.code;
    e.status = status;
    throw e;
  };

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throwAuthError(err, res.status, `login failed (${res.status})`);
    }
    const data = await res.json();
    setUser(data.user);
    setWorkspaces(data.workspaces ?? []);
    setWorkspaceId(data.workspaceId);
  }, []);

  const register = useCallback(async (input: {
    email: string; password: string; username: string;
  }) => {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throwAuthError(err, res.status, `register failed (${res.status})`);
    }
    const data = await res.json();
    setUser(data.user);
    setWorkspaces(data.workspaces ?? []);
    setWorkspaceId(data.workspaceId);
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    setUser(null);
    setWorkspaces([]);
    setWorkspaceId(null);
  }, []);

  const patchUser = useCallback((patch: Partial<AuthUser>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, workspaces, workspaceId, loading, login, register, logout, refresh, patchUser }),
    [user, workspaces, workspaceId, loading, login, register, logout, refresh, patchUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
