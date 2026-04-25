/**
 * HTTP client that proxies MCP tool invocations to the main backend API.
 *
 * Rationale (see docs/chat-sidebar-plan.md Phase 1.3):
 *  - Going through HTTP ensures eventBus.emitChange() is triggered, so other
 *    connected clients sync automatically.
 *  - It also keeps MCP tools as thin schema-mapping layers — any business
 *    logic lives only in the Express route handlers.
 *
 * Auth propagation (security audit fix):
 *  - The agent loop captures the user's JWT cookie from the incoming request
 *    and stashes it in an AsyncLocalStorage. All MCP tool handlers that call
 *    apiRequest() automatically pick up the JWT from that context, so the
 *    backend's attachUser middleware sees req.user === <originating user>
 *    and the artifact-access guards work correctly.
 *  - Without this, MCP loopback requests would hit the backend with no cookie
 *    and bypass per-user ownership checks (CRITICAL leak before this fix).
 */

import { AsyncLocalStorage } from "async_hooks";

const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || "http://localhost:3001";
const MCP_CLIENT_ID = process.env.MCP_CLIENT_ID || "mcp-agent";
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "ibase_auth";

/** AsyncLocalStorage 单例：agent 一个 turn 包一层 run()，本 turn 内
 * 任何 apiRequest 调用都能拿到原始用户的 JWT。并发 turn 互相隔离。 */
interface AuthCtx {
  /** 原始 JWT cookie 值（不带 cookie name 前缀）。 */
  authToken?: string;
}
export const authStorage = new AsyncLocalStorage<AuthCtx>();

export interface HttpOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  clientId?: string;
  /** Per-call context forwarded to analyst routes so they can key DuckDB
   * sessions off the right conversation. Most tools leave this undefined. */
  conversationId?: string;
  workspaceId?: string;
  /** Override the AsyncLocalStorage-derived auth token. Rarely used. */
  authToken?: string;
}

export async function apiRequest<T = unknown>(path: string, opts: HttpOptions = {}): Promise<T> {
  const method = opts.method || "GET";
  const url = `${BACKEND_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "X-Client-Id": opts.clientId || MCP_CLIENT_ID,
  };
  if (opts.conversationId) headers["X-Conversation-Id"] = opts.conversationId;
  if (opts.workspaceId) headers["X-Workspace-Id"] = opts.workspaceId;

  // 自动从 AsyncLocalStorage 拿原 user JWT —— agent 调用 apiRequest 时
  // 后端 attachUser 中间件会读到 req.user，artifact-access 守卫正常工作。
  const authToken = opts.authToken ?? authStorage.getStore()?.authToken;
  if (authToken) {
    headers["Cookie"] = `${COOKIE_NAME}=${authToken}`;
  }

  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const errMsg =
      (data && typeof data === "object" && "error" in data && typeof (data as any).error === "string")
        ? (data as any).error
        : `HTTP ${res.status}`;
    throw new Error(`${method} ${path} failed: ${errMsg}`);
  }
  return data as T;
}

/** Format tool result back to the agent as a compact JSON string. */
export function toolResult(data: unknown, extra?: Record<string, unknown>): string {
  const payload = extra ? { ...extra, data } : data;
  return JSON.stringify(payload);
}

/** Return a consistent shape for "danger" tools that require user confirmation. */
export function confirmationRequired(
  tool: string,
  args: Record<string, unknown>,
  preview: string
): string {
  return JSON.stringify({
    requires_confirmation: true,
    tool,
    args,
    preview,
    note: "This is a destructive action. The agent must surface a confirmation UI before proceeding.",
  });
}
