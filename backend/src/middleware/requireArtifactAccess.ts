/**
 * requireArtifactAccess — 对每个带 *artifact id*（tableId / ideaId / designId
 * / demoId / recordId / tasteId / conversationId / folderId / agentId）但
 * **没有显式 workspaceId** 的请求做归属检查。
 *
 * 实现方式：在 app.use("/api", ...) 阶段（路由匹配前）从 req.path 用正则
 * 抽取 artifact id 段，然后通过 Prisma 反查 workspace 归属。这样可以在一
 * 处把所有 artifact 路由都覆盖，不用在每个 router 上单独挂中间件。
 *
 * 设计权衡：
 *   · agentId 是 user-scoped（不是 workspace-scoped），单独走 user 校验
 *   · sessionId / jobId / msgId 是 transient state，不查 DB
 *   · fieldId / viewId 嵌在 Table JSON 里，路由必带 tableId 一起走，由 tableId 校验
 *   · 找不到 artifact → 不阻断（让下游 handler 自己 404，避免泄漏 "id 不存在 vs 没权限"）
 *
 * 配套：requireWorkspaceAccess 管 "显式 workspaceId 的请求"，本中间件管
 * "只有 artifact id 的请求"。两者覆盖整个 /api/* 表面。
 */

import type { Request, Response, NextFunction } from "express";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { currentUser, userCanAccessWorkspace } from "../services/authService.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/** 每种 artifact id → 反查 workspaceId 的查询函数 */
const ARTIFACT_RESOLVERS: Record<string, (id: string) => Promise<string | null>> = {
  tableId: async (id) =>
    (await prisma.table.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  ideaId: async (id) =>
    (await prisma.idea.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  designId: async (id) =>
    (await prisma.design.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  demoId: async (id) =>
    (await prisma.demo.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  folderId: async (id) =>
    (await prisma.folder.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  conversationId: async (id) =>
    (await prisma.conversation.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  recordId: async (id) => {
    const r = await prisma.record.findUnique({
      where: { id },
      select: { table: { select: { workspaceId: true } } },
    });
    return r?.table?.workspaceId ?? null;
  },
  tasteId: async (id) => {
    const t = await prisma.taste.findUnique({
      where: { id },
      select: { design: { select: { workspaceId: true } } },
    });
    return t?.design?.workspaceId ?? null;
  },
};

/**
 * 路径解析规则：第一段是资源类型，第二段是 id。
 * 例如：
 *   /api/tables/cmo5z9awo000g11oj93lc6t8v/records  →  ("table", "cmo5z9...")
 *   /api/ideas/cmo9.../write                       →  ("idea", "cmo9...")
 *   /api/chat/conversations/cmo5.../messages       →  ("conversation", "cmo5...")
 *   /api/agents/agent_default/inbox                →  ("agent", "agent_default")
 *
 * 路径不在表里的（如 /api/auth/me，/api/_schemas）→ 不抽取。
 */
const PATH_RULES: Array<{ pattern: RegExp; param: keyof typeof ARTIFACT_RESOLVERS | "agentId" }> = [
  { pattern: /^\/api\/tables\/([^/]+)/, param: "tableId" },
  { pattern: /^\/api\/ideas\/([^/]+)/, param: "ideaId" },
  { pattern: /^\/api\/designs\/([^/]+)/, param: "designId" },
  { pattern: /^\/api\/demos\/([^/]+)/, param: "demoId" },
  { pattern: /^\/api\/demo-runtime\/([^/]+)/, param: "demoId" },
  { pattern: /^\/api\/folders\/([^/]+)/, param: "folderId" },
  { pattern: /^\/api\/chat\/conversations\/([^/]+)/, param: "conversationId" },
  { pattern: /^\/api\/agents\/([^/]+)/, param: "agentId" },
  // /api/sync/<tableId>/events  和  /api/sync/ideas/<ideaId>/events
  // 后者要先匹配，否则 /sync/ideas/xxx 会被当成 tableId="ideas"
  { pattern: /^\/api\/sync\/ideas\/([^/]+)/, param: "ideaId" },
  { pattern: /^\/api\/sync\/designs\/([^/]+)/, param: "designId" },
  // /api/sync/<tableId>/events —— 注意排除 workspaces/ideas/designs 前缀
  { pattern: /^\/api\/sync\/(?!workspaces|ideas|designs)([^/]+)/, param: "tableId" },
];

/** 公共路径白名单 */
const PUBLIC_PREFIXES = [
  "/api/auth/",
  "/share/",
  // 以下是 list / create 操作的根路径，没有 artifact id，免检
  // （它们要么有 workspaceId 走 requireWorkspaceAccess，要么是 user-scoped）
  "/api/_schemas",
  "/api/health",
];

export async function requireArtifactAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // 豁免公共路径
  if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }

  // 抽取路径中的 artifact id
  let paramName: string | null = null;
  let artifactId: string | null = null;
  for (const rule of PATH_RULES) {
    const m = req.path.match(rule.pattern);
    if (m) {
      paramName = rule.param;
      artifactId = m[1];
      break;
    }
  }

  if (!paramName || !artifactId) {
    next();
    return;
  }

  // ── Agent: user-scoped ──
  if (paramName === "agentId") {
    const user = currentUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" });
      return;
    }
    try {
      const a = await prisma.agent.findUnique({
        where: { id: artifactId },
        select: { userId: true },
      });
      if (!a) {
        next(); // 不存在的 agent → 让 handler 404
        return;
      }
      if (a.userId !== user.id) {
        res.status(403).json({
          error: "You don't own this agent",
          code: "AGENT_ACCESS_DENIED",
        });
        return;
      }
    } catch (err) {
      console.error("[artifact-access] agent lookup failed:", err);
      next();
      return;
    }
    next();
    return;
  }

  // ── Artifact: workspace-scoped ──
  const resolver = ARTIFACT_RESOLVERS[paramName];
  if (!resolver) {
    next();
    return;
  }

  let workspaceId: string | null = null;
  try {
    workspaceId = await resolver(artifactId);
  } catch (err) {
    console.error(`[artifact-access] resolve ${paramName}=${artifactId} failed:`, err);
    next(); // 让 handler 自己 404
    return;
  }

  if (workspaceId === null) {
    next(); // artifact 不存在
    return;
  }

  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" });
    return;
  }

  try {
    const ok = await userCanAccessWorkspace(user.id, workspaceId);
    if (!ok) {
      res.status(403).json({
        error: "You don't have access to this resource",
        code: "ARTIFACT_ACCESS_DENIED",
      });
      return;
    }
  } catch (err) {
    console.error("[artifact-access] workspace check failed:", err);
    res.status(500).json({ error: "access check failed", code: "SERVER_ERROR" });
    return;
  }

  next();
}
