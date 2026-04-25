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
import { setThemeGlobal } from "../theme";

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

/** Per-user UI 偏好，后端 user.preferences JSONB 字段映射。空对象表示
 * "走 localStorage / 系统默认"。 */
export interface UserPreferences {
  theme?: "light" | "dark" | "system";
  locale?: "zh" | "en";
  deleteProtection?: boolean;
}

interface MeResponse {
  user: AuthUser;
  workspaces: AuthWorkspace[];
  workspaceId: string | null;
  /** 当前用户的"主" agent id —— chatbot / inbox / cron 都用它。 */
  agentId: string | null;
  /** 用户级偏好（DB 持久化）。FE 三层 fallback：preferences > localStorage > 系统默认 */
  preferences: UserPreferences;
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
  /** Primary agent id — 每个用户注册时后端会创建一个。旧 user_default 的是 agent_default。 */
  agentId: string | null;
  /** 用户级偏好（DB 持久化）。FE 在显示态时仍走"三层 fallback"：
   *  preferences (此值) > localStorage > 系统默认。 */
  preferences: UserPreferences;
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
  /** 写 preferences 到后端 + 本地 state。失败回滚到原值并 throw。 */
  patchPreferences: (patch: Partial<UserPreferences>) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaces, setWorkspaces] = useState<AuthWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (res.ok) {
        const data = (await res.json()) as MeResponse;
        setUser(data.user);
        setWorkspaces(data.workspaces ?? []);
        setWorkspaceId(data.workspaceId);
        setAgentId(data.agentId);
        setPreferences(data.preferences ?? {});
      } else {
        setUser(null);
        setWorkspaces([]);
        setWorkspaceId(null);
        setAgentId(null);
        setPreferences({});
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** 接到 preferences（来自 /me / login / register）后同步到本地：
   *   · theme：通过 setThemeGlobal 写 localStorage + 应用 data-theme + 广播
   *   · locale：写 localStorage（i18n 模块下次刷新会读到；不强制 reload）
   *   · deleteProtection：写 localStorage（App.tsx 下次 mount 会读到）
   *
   * 这样跨设备登录就能自动用上 user 偏好；同设备保留 localStorage 当
   * 首屏 fallback。 */
  useEffect(() => {
    if (preferences.theme) setThemeGlobal(preferences.theme);
    if (preferences.locale) {
      try { localStorage.setItem("app_lang", preferences.locale); } catch { /* ignore */ }
    }
    if (preferences.deleteProtection !== undefined) {
      try {
        localStorage.setItem("doc_delete_protection", preferences.deleteProtection ? "1" : "0");
      } catch { /* ignore */ }
    }
  }, [preferences.theme, preferences.locale, preferences.deleteProtection]);

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
    setAgentId(data.agentId ?? null);
    setPreferences(data.preferences ?? {});
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
    setAgentId(data.agentId ?? null);
    setPreferences(data.preferences ?? {});
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    setUser(null);
    setWorkspaces([]);
    setWorkspaceId(null);
    setAgentId(null);
    setPreferences({});
    // 清掉本地 prefs 副本，避免下个登录用户在同浏览器里"继承"上一个用户的偏好
    try {
      localStorage.removeItem("theme_preference_v1");
      localStorage.removeItem("app_lang");
      localStorage.removeItem("doc_delete_protection");
    } catch { /* ignore */ }
  }, []);

  /** 写后端 + 同步本地副本。乐观更新 + 失败回滚。 */
  const patchPreferences = useCallback(async (patch: Partial<UserPreferences>) => {
    const before = preferences;
    const next: UserPreferences = { ...before, ...patch };
    // 删除显式 undefined / null 字段（语义：恢复默认）
    for (const k of Object.keys(patch) as (keyof UserPreferences)[]) {
      if (patch[k] === undefined || patch[k] === null) delete (next as any)[k];
    }
    setPreferences(next);
    try {
      const res = await fetch("/api/auth/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `preferences update failed (${res.status})`);
      }
      const data = await res.json();
      if (data.preferences) setPreferences(data.preferences);
    } catch (err) {
      setPreferences(before); // 回滚
      throw err;
    }
  }, [preferences]);

  const patchUser = useCallback((patch: Partial<AuthUser>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, workspaces, workspaceId, agentId, preferences, loading, login, register, logout, refresh, patchUser, patchPreferences }),
    [user, workspaces, workspaceId, agentId, preferences, loading, login, register, logout, refresh, patchUser, patchPreferences],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
