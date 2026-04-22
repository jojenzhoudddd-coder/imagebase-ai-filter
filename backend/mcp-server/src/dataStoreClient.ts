/**
 * HTTP client that proxies MCP tool invocations to the main backend API.
 *
 * Rationale (see docs/chat-sidebar-plan.md Phase 1.3):
 *  - Going through HTTP ensures eventBus.emitChange() is triggered, so other
 *    connected clients sync automatically.
 *  - It also keeps MCP tools as thin schema-mapping layers — any business
 *    logic lives only in the Express route handlers.
 */

const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || "http://localhost:3001";
// MCP actions come from the chat agent on behalf of the user. We tag them with
// a stable clientId so the agent-originated events are distinguishable in logs
// and (optionally) filterable in the SSE stream.
const MCP_CLIENT_ID = process.env.MCP_CLIENT_ID || "mcp-agent";

export interface HttpOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  clientId?: string;
}

export async function apiRequest<T = unknown>(path: string, opts: HttpOptions = {}): Promise<T> {
  const method = opts.method || "GET";
  const url = `${BACKEND_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "X-Client-Id": opts.clientId || MCP_CLIENT_ID,
  };
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
