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
import type { Request, Response, NextFunction } from "express";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

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

/** Accept login by email OR username. Returns null if nothing matches. */
export async function findUserForLogin(loginHandle: string) {
  const h = loginHandle.trim();
  if (!h) return null;
  // Email lookup first (preferred; usually unambiguous)
  const byEmail = await prisma.user.findUnique({ where: { email: h } });
  if (byEmail) return byEmail;
  // Username fallback
  return prisma.user.findUnique({ where: { username: h } });
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

export async function setUserPassword(id: string, plain: string) {
  const hash = await hashPassword(plain);
  await prisma.user.update({ where: { id }, data: { passwordHash: hash } });
}

/**
 * Create a fresh user + their personal org + default workspace. Everything
 * wired in one transaction so a partial failure rolls back. Returns the
 * user + the id of the newly-created default workspace (FE stashes that
 * as its currentWorkspace).
 */
export async function createUserWithWorkspace(input: {
  email: string;
  username?: string;
  name: string;
  password: string;
}): Promise<{ userId: string; workspaceId: string }> {
  const passwordHash = await hashPassword(input.password);
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        username: input.username || null,
        name: input.name,
        passwordHash,
      },
    });
    const org = await tx.org.create({
      data: { name: `${input.name} 的空间` },
    });
    await tx.orgMember.create({
      data: { orgId: org.id, userId: user.id, role: "owner" },
    });
    const ws = await tx.workspace.create({
      data: {
        orgId: org.id,
        createdById: user.id,
        name: `${input.name} 的第一个工作空间`,
      },
    });
    return { userId: user.id, workspaceId: ws.id };
  });
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
