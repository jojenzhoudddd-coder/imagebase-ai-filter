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

/**
 * 路径前缀白名单 —— 有些端点不需要登录（比如 /api/auth/*、/share/*、
 * 静态资源）。在这些前缀上完全跳过检查。
 */
const PUBLIC_PREFIXES = [
  "/api/auth/",
  "/share/",
];

export async function requireWorkspaceAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // 豁免：公共路径不做检查
  if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }

  const wsId =
    (req.params as any)?.workspaceId ||
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
