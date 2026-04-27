/**
 * authService — password hashing, JWT signing, login/register primitives.
 *
 * Cookies vs localStorage: we put the JWT in an httpOnly cookie so a XSS
 * in the SPA can't steal it. SameSite=Lax covers navigation-triggered
 * state without exposing to cross-site GET/POST attacks on a real
 * browser. JWT_SECRET must be set on the server; a dev-only fallback is
 * loud about being insecure.
 */

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { ensureAgentFiles } from "./agentService.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const BCRYPT_ROUNDS = 10;
export const COOKIE_NAME = "ibase_auth";
/** JWT lifetime. 30 days — matches the common "Remember for 30 days" UX. */
const JWT_EXPIRES_IN = "30d";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function getJwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET missing or < 32 chars; refuse to boot in production");
    }
    console.warn(
      "[auth] JWT_SECRET not set (dev fallback in use). Set a 32+ char secret in backend/.env before any serious use."
    );
    return "dev-insecure-jwt-secret-do-not-use-in-prod-pls-set-env-var-xxxxxx";
  }
  return s;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export interface AuthTokenPayload {
  /** User id. */
  sub: string;
  /** Login handle (username or email) — informational. */
  login?: string;
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as AuthTokenPayload;
    return decoded;
  } catch {
    return null;
  }
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/",
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

/**
 * Express middleware — reads the auth cookie, verifies the JWT, looks up
 * the user, and attaches `req.user` for downstream handlers. On failure
 * it passes through without attaching; the downstream `requireAuth`
 * middleware is the gate.
 */
export async function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = (req as any).cookies?.[COOKIE_NAME];
  if (!token) return next();
  const payload = verifyAuthToken(token);
  if (!payload) return next();
  try {
    const u = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        avatarUrl: true,
      },
    });
    if (u) (req as any).user = u;
  } catch {
    /* non-fatal — treat as unauthenticated */
  }
  next();
}

/** Gate middleware: 401 if no authenticated user on request. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!(req as any).user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

/** Typed accessor so call sites don't pepper `(req as any).user`. */
export function currentUser(req: Request): {
  id: string;
  email: string;
  username: string | null;
  name: string;
  avatarUrl: string | null;
} | null {
  return (req as any).user ?? null;
}

// ─── Lookup + mutation helpers ──────────────────────────────────────────

/**
 * Email-only login. Username is kept only for display (breadcrumb /
 * workspace / chatbot name) — it's no longer a login handle.
 */
export async function findUserByEmail(email: string) {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  return prisma.user.findUnique({ where: { email: e } });
}

/** @deprecated Kept as a thin alias for any residual call site. */
export async function findUserForLogin(loginHandle: string) {
  return findUserByEmail(loginHandle);
}

export async function findUserById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

export async function updateUserProfile(
  id: string,
  patch: { name?: string; avatarUrl?: string | null; username?: string },
) {
  return prisma.user.update({
    where: { id },
    data: patch,
    select: { id: true, email: true, username: true, name: true, avatarUrl: true },
  });
}

/** UI preferences shape —— 后续要扩字段（譬如 timezone / dateFormat）也加到这里。 */
export interface UserPreferences {
  theme?: "light" | "dark" | "system";
  locale?: "zh" | "en";
  deleteProtection?: boolean;
  /** Magic Canvas 布局快照(blocks + layout 树 + per-block state)。
   *  形状由 frontend canvas/types.ts CanvasState 决定;后端不解析,JSON 透传。 */
  canvasLayout?: unknown;
  /** 预留字段:Magic Canvas 布局预设(将来支持) */
  canvasPresets?: unknown;
}

export async function readUserPreferences(id: string): Promise<UserPreferences> {
  const u = await prisma.user.findUnique({
    where: { id },
    select: { preferences: true },
  });
  if (!u) return {};
  return (u.preferences as UserPreferences) || {};
}

/**
 * 增量合并 preferences —— PATCH 语义，不传的字段保持原值。传 null
 * 表示删除该字段（让前端走 localStorage / 系统默认 fallback）。
 */
export async function updateUserPreferences(
  id: string,
  patch: Partial<Record<keyof UserPreferences, UserPreferences[keyof UserPreferences] | null>>,
): Promise<UserPreferences> {
  const current = await readUserPreferences(id);
  const next: UserPreferences = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    const key = k as keyof UserPreferences;
    if (v === null || v === undefined) {
      delete next[key];
    } else {
      (next as any)[key] = v;
    }
  }
  await prisma.user.update({
    where: { id },
    data: { preferences: next as any },
  });
  return next;
}

export async function setUserPassword(id: string, plain: string) {
  const hash = await hashPassword(plain);
  await prisma.user.update({ where: { id }, data: { passwordHash: hash } });
}

/**
 * 随机给新用户挑一个头像（/public/avatars/avatar_1.png … avatar_22.png 任选其一），
 * 写入 user.avatarUrl，避免登录后出现"头像是别人的"这种错觉。
 * 之前 FE 会 fallback 到 `/avatars/me.jpg`（作者本人照片），属严重 bug。
 */
function pickDefaultAvatarUrl(): string {
  const n = Math.floor(Math.random() * 22) + 1; // 1..22
  return `/avatars/avatar_${n}.png`;
}

/**
 * Create a fresh user + their personal org + default workspace + bootstrap
 * agent + onboarding artifacts (1 empty table / design / idea)。Everything
 * wired in one transaction so a partial failure rolls back.
 *
 * `username` is the single identity field the user chooses — it drives the
 * breadcrumb label, the default workspace name, and the default agent name.
 * `name` (legacy column) is always set equal to `username`.
 */
export async function createUserWithWorkspace(input: {
  email: string;
  username: string;
  password: string;
}): Promise<{ userId: string; workspaceId: string; agentId: string; name: string; avatarUrl: string }> {
  const passwordHash = await hashPassword(input.password);
  const name = input.username.trim();
  const avatarUrl = pickDefaultAvatarUrl();
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        username: input.username.trim(),
        name,
        avatarUrl,
        passwordHash,
      },
    });
    const org = await tx.org.create({
      data: { name: `${name} 的空间` },
    });
    await tx.orgMember.create({
      data: { orgId: org.id, userId: user.id, role: "owner" },
    });
    const ws = await tx.workspace.create({
      data: {
        orgId: org.id,
        createdById: user.id,
        // 默认 workspace 名 = "<username>'s Workspace"。不直接用 username，
        // 否则面包屑 `username > username` 看起来很蠢。
        name: `${name}'s Workspace`,
      },
    });

    // ── 注册时的 onboarding 数据：1 张含默认字段+5 行空记录的表 + 1 个空 taste + 1 个空 idea
    // V2.9.9:
    //   1) 三种类型 order 分开 (Table=0, Design=1, Idea=2) → sidebar 混排时
    //      Table 稳定排第一,与 App init 选 first artifact 的逻辑配合,新用户
    //      登入默认看到的就是这张表。
    //   2) Table 不再是空表,默认带 1 个 Text 字段 + 5 行空记录,FE TableView
    //      不会空白一片,用户可立即开始编辑。
    const defaultFieldId = `fld_${randomBytes(8).toString("hex")}`;
    const defaultViewId = "view_all";
    const tableRow = await tx.table.create({
      data: {
        workspaceId: ws.id,
        name: "Table",
        fields: [
          { id: defaultFieldId, name: "Name", type: "text", config: {} },
        ] as any,
        views: [{
          id: defaultViewId,
          name: "全部",
          type: "grid",
          fieldOrder: [defaultFieldId],
          hiddenFields: [],
          filter: { logic: "and", conditions: [] },
        }] as any,
        order: 0,
      },
    });
    // 5 行空记录 — cells 留空,用户进来直接点击编辑即可
    // V2.9.10: Record 模型没有 order 列,排序靠 createdAt;5 条 createMany 在
    // 同一 tx 里写入,createdAt 同毫秒精度可能不稳定。用循环单条 create 保证
    // createdAt 单调递增,顺序与 sidebar 显示一致。
    for (let i = 0; i < 5; i++) {
      await tx.record.create({
        data: { tableId: tableRow.id, cells: {} as any },
      });
    }
    await tx.design.create({
      data: {
        workspaceId: ws.id,
        name: "Taste",
        order: 1,
      },
    });
    await tx.idea.create({
      data: {
        workspaceId: ws.id,
        name: "Idea",
        order: 2,
      },
    });

    // ── 创建这个用户自己的 Agent（不复用 agent_default —— 那是 user_default 的）
    const agent = await tx.agent.create({
      data: {
        userId: user.id,
        name: `${name}'s Agent`,
      },
    });

    return { userId: user.id, workspaceId: ws.id, agentId: agent.id, name, avatarUrl };
  });

  // Agent 的文件系统目录必须在事务外 / 事务成功后创建（写文件不可回滚）
  await ensureAgentFiles(result.agentId);
  // Fire-and-forget initial AI summary 生成 —— 注册成功后立刻给 TopBar 一段
  // 文字看，不用等到第二天 04:00 heartbeat。失败不影响注册流程。
  void (async () => {
    try {
      const { generateInitialSummary } = await import("./workspaceSummaryService.js");
      await generateInitialSummary(result.workspaceId);
    } catch (err) {
      console.warn("[authService] initial workspace summary failed:", err);
    }
  })();
  return result;
}

/**
 * Return the workspaces a user can access — their personal one + any
 * orgs they're a member of. Used by `GET /api/auth/me` so the FE can
 * populate the default workspace picker.
 */
export async function listUserWorkspaces(userId: string) {
  const rows = await prisma.workspace.findMany({
    where: {
      OR: [
        { createdById: userId },
        { org: { members: { some: { userId } } } },
      ],
    },
    select: { id: true, name: true, orgId: true },
    orderBy: { createdAt: "asc" },
  });
  return rows;
}

/**
 * Ownership check — does this user have access to this workspace? Used
 * by route middleware before any mutation. Cached per request lifetime
 * is cheap enough that we don't bother memoizing across requests.
 */
/**
 * One-shot boot step: make sure the legacy seed user (`user_default` /
 * `user_quan` in new installs) has a password set. Without this, existing
 * production data keeps working but nobody can actually log in as the
 * historical user. Idempotent — skips anything that already has a hash.
 *
 * Also promotes email/username if they're missing so the login form's
 * "type your email or username" path works for the seed account.
 */
export async function ensureSeedUserCredentials(input: {
  /** Stable id of the seed user (e.g. "user_default"). Null to skip. */
  userId?: string | null;
  defaultUsername: string;
  defaultPassword: string;
  defaultEmail?: string;
  defaultName?: string;
}): Promise<void> {
  if (!input.userId) return;
  try {
    const u = await prisma.user.findUnique({ where: { id: input.userId } });
    if (!u) return;
    const patch: Record<string, string> = {};
    if (!u.passwordHash) patch.passwordHash = await hashPassword(input.defaultPassword);
    if (!u.username) patch.username = input.defaultUsername;
    if (input.defaultEmail && !u.email) patch.email = input.defaultEmail;
    if (input.defaultName && !u.name) patch.name = input.defaultName;
    if (!Object.keys(patch).length) return;
    await prisma.user.update({ where: { id: input.userId }, data: patch });
    console.log(`[auth] seeded credentials on ${input.userId}`);
  } catch (err) {
    console.warn("[auth] ensureSeedUserCredentials failed (non-fatal):", err);
  }
}

export async function userCanAccessWorkspace(
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { createdById: true, org: { select: { members: { where: { userId }, select: { id: true } } } } },
  });
  if (!ws) return false;
  if (ws.createdById === userId) return true;
  if (ws.org?.members?.length) return true;
  return false;
}
