/**
 * requireWorkspaceAccess — 全局中间件，拦截任何带 `workspaceId` 的请求
 * （URL 参数 / body / query 三处都扫），校验登录用户对该 workspace 是否
 * 有访问权。没登录返回 401，有登录但不属于该 workspace 返回 403。
 *
 * 这是 Phase 2 最薄的一层兜底。更细粒度的 artifact-level 访问控制
 * （通过 tableId/ideaId/... 间接定位 workspace）需要在各 route 里逐个
 * 审计，暂不在这里覆盖。
 */

import type { Request, Response, NextFunction } from "express";
import { currentUser, userCanAccessWorkspace } from "../services/authService.js";
import { mcpLoopbackSecret } from "../services/mcpSecret.js";

/**
 * 路径前缀白名单 —— 有些端点不需要登录（比如 /api/auth/*、/share/*、
 * 静态资源）。在这些前缀上完全跳过检查。
 */
const PUBLIC_PREFIXES = [
  "/api/auth/",
  "/share/",
];

/**
 * MCP loopback 信任：agent 内部工具调用（habit / agency 等 headless 场景）
 * 没有用户 cookie，但请求来自同进程的 MCP server（X-Client-Id: mcp-agent）。
 * 这些请求已经经过 agent 权限体系审计，直接放行。
 *
 * 安全：仅检查 X-Client-Id 不够（外部可伪造），同时要求携带进程内生成的
 * 一次性 secret（X-MCP-Secret），该 secret 不会暴露给外部客户端。
 */
function isTrustedMcpLoopback(req: Request): boolean {
  return (
    req.headers["x-client-id"] === "mcp-agent" &&
    req.headers["x-mcp-secret"] === mcpLoopbackSecret
  );
}

export async function requireWorkspaceAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // 关键: 这里的中间件挂在 `app.use("/api", ...)` 上, Express 会把
  // `/api` 这段从 req.path 里剥掉(所以 req.path 是 "/tables/xxx" 不是
  // "/api/tables/xxx")。要拿到完整路径必须用 req.originalUrl,否则下面
  // 所有以 "/api/" 起头的正则全部不匹配 → 安全检查变成 no-op。这是
  // 2026-04-30 修复的跨用户数据泄漏的根因 —— 之前 prefix 错配导致 路径
  // 匹配统统失败, requireArtifactAccess 也 silently 放过了所有 artifact
  // 级请求。 originalUrl 包含 query string, 我们只想匹配 path 部分,
  // 用 split("?") 切一刀。
  const fullPath = req.originalUrl.split("?")[0];

  // 豁免：公共路径不做检查
  if (PUBLIC_PREFIXES.some((p) => fullPath.startsWith(p))) {
    next();
    return;
  }

  // 豁免：MCP 内部 loopback 请求（habit / agency headless 场景无 cookie）
  if (isTrustedMcpLoopback(req)) {
    next();
    return;
  }

  // 在 app.use("/api", ...) 阶段 req.params 是空的（路由匹配前），所以
  // workspaceId 要直接从 URL 路径用正则抽。涉及的两条路径模式：
  //   /api/sync/workspaces/:workspaceId/events
  //   /api/workspaces/:workspaceId/mentions/search
  let urlWorkspaceId: string | undefined;
  const m = fullPath.match(
    /^\/api\/(?:sync\/)?workspaces\/([^/]+)/,
  );
  if (m) urlWorkspaceId = m[1];

  const wsId =
    urlWorkspaceId ||
    (typeof (req.body as any)?.workspaceId === "string"
      ? (req.body as any).workspaceId
      : undefined) ||
    (typeof req.query.workspaceId === "string"
      ? (req.query.workspaceId as string)
      : undefined);

  // 不带 workspaceId 的请求走原逻辑（artifact 级别的路由 —— 未来再单独审计）
  if (!wsId) {
    next();
    return;
  }

  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" });
    return;
  }

  try {
    const ok = await userCanAccessWorkspace(user.id, wsId);
    if (!ok) {
      res.status(403).json({
        error: "You don't have access to this workspace",
        code: "WORKSPACE_DENIED",
      });
      return;
    }
  } catch (err) {
    console.error("[auth:workspace-access]", err);
    res.status(500).json({ error: "access check failed", code: "SERVER_ERROR" });
    return;
  }

  next();
}
