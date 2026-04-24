/**
 * /api/auth/* — email-only login + 3-field register (email / password / username).
 *
 * Cookie-based session. On login we sign a JWT and drop it into an
 * httpOnly cookie (see authService.setAuthCookie); the cookie travels
 * automatically on subsequent /api/* requests and `attachUser`
 * middleware populates `req.user`. No CSRF token because SameSite=Lax
 * covers the vectors we care about (no cross-site POST cookie sending).
 *
 * Error responses always carry a stable `code` field so the frontend can
 * map it to an i18n key for toasts. `error` is the dev-facing message.
 */

import { Router, type Request, type Response } from "express";
import path from "path";
import fsp from "fs/promises";
import crypto from "crypto";
import { fileURLToPath } from "url";

// ESM shim —— 此文件 package.json type=module，没有内置 __dirname。
// 必须手动从 import.meta.url 推出来。之前直接用 __dirname 会触发
// ReferenceError / 让头像写盘路径失效。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  COOKIE_NAME,
  clearAuthCookie,
  createUserWithWorkspace,
  currentUser,
  findUserByEmail,
  listUserWorkspaces,
  requireAuth,
  setAuthCookie,
  signAuthToken,
  updateUserProfile,
  verifyPassword,
} from "../services/authService.js";
import { listAgents } from "../services/agentService.js";

/**
 * 取某个用户的"主" agent id —— 目前每个用户只有一个 agent（注册时创建）。
 * 如果以后允许多 agent，这里可以改为读 user.config 里的 "lastAgentId"。
 * legacy `user_default` 用户的 agent 是 `agent_default`（Phase 1 seed）。
 */
async function primaryAgentIdFor(userId: string): Promise<string | null> {
  const agents = await listAgents(userId);
  return agents[0]?.id ?? null;
}

const router = Router();

// Rules — also enforced client-side for immediate feedback
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;
const PASSWORD_MIN = 6;

// ─── POST /api/auth/register ────────────────────────────────────────────
// Body: { email, password, username }
// Note: no `name` — `name` is derived server-side from `username`.
router.post("/register", async (req: Request, res: Response) => {
  const { email, password, username } = req.body ?? {};

  if (!email || typeof email !== "string" || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "invalid email", code: "EMAIL_INVALID" });
    return;
  }
  if (!password || typeof password !== "string" || password.length < PASSWORD_MIN) {
    res.status(400).json({ error: "password too short", code: "PASSWORD_TOO_SHORT" });
    return;
  }
  if (!username || typeof username !== "string" || !USERNAME_RE.test(username)) {
    res.status(400).json({ error: "invalid username", code: "USERNAME_INVALID" });
    return;
  }

  try {
    const { userId, workspaceId, agentId, name, avatarUrl } = await createUserWithWorkspace({
      email: email.trim().toLowerCase(),
      username: username.trim(),
      password,
    });
    const token = signAuthToken({ sub: userId, login: email });
    setAuthCookie(res, token);
    res.json({
      ok: true,
      user: {
        id: userId,
        email: email.trim().toLowerCase(),
        username: username.trim(),
        name,
        avatarUrl,
      },
      workspaceId,
      agentId,
    });
  } catch (err: any) {
    // Prisma unique constraint — the only unique column we care about
    // here is `email` (username is intentionally non-unique).
    if (err?.code === "P2002") {
      res.status(409).json({ error: "Email already registered", code: "EMAIL_TAKEN" });
      return;
    }
    console.error("[auth:register]", err);
    res.status(500).json({
      error: "register failed",
      code: "SERVER_ERROR",
      detail: err?.message || String(err),
    });
  }
});

// ─── POST /api/auth/login ───────────────────────────────────────────────
// Body: { email, password }  — email-only login, no username fallback.
router.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!email || typeof email !== "string" || !password) {
    res.status(400).json({ error: "email + password required", code: "MISSING_FIELDS" });
    return;
  }
  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ error: "invalid email", code: "EMAIL_INVALID" });
    return;
  }

  const u = await findUserByEmail(email.trim().toLowerCase());
  if (!u) {
    res.status(401).json({ error: "Invalid credentials", code: "INVALID_CREDENTIALS" });
    return;
  }
  const ok = await verifyPassword(String(password), u.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Invalid credentials", code: "INVALID_CREDENTIALS" });
    return;
  }

  const token = signAuthToken({ sub: u.id, login: u.email });
  setAuthCookie(res, token);
  const [workspaces, agentId] = await Promise.all([
    listUserWorkspaces(u.id),
    primaryAgentIdFor(u.id),
  ]);
  res.json({
    ok: true,
    user: {
      id: u.id,
      email: u.email,
      username: u.username,
      name: u.name,
      avatarUrl: u.avatarUrl,
    },
    workspaces,
    workspaceId: workspaces[0]?.id ?? null,
    agentId,
  });
});

// ─── POST /api/auth/logout ──────────────────────────────────────────────
router.post("/logout", (_req: Request, res: Response) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ─── GET /api/auth/me ───────────────────────────────────────────────────
router.get("/me", async (req: Request, res: Response) => {
  const u = currentUser(req);
  if (!u) {
    res.status(401).json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" });
    return;
  }
  const [workspaces, agentId] = await Promise.all([
    listUserWorkspaces(u.id),
    primaryAgentIdFor(u.id),
  ]);
  res.json({
    user: u,
    workspaces,
    workspaceId: workspaces[0]?.id ?? null,
    agentId,
  });
});

// ─── PATCH /api/auth/profile ────────────────────────────────────────────
// Body: { name?, username? }
router.patch("/profile", requireAuth, async (req: Request, res: Response) => {
  const u = currentUser(req)!;
  const { name, username } = req.body ?? {};
  const patch: { name?: string; username?: string } = {};
  if (typeof name === "string") {
    const trimmed = name.trim();
    if (!trimmed) {
      res.status(400).json({ error: "name can't be empty", code: "NAME_INVALID" });
      return;
    }
    patch.name = trimmed;
  }
  if (username !== undefined) {
    if (username && !USERNAME_RE.test(String(username))) {
      res.status(400).json({ error: "invalid username", code: "USERNAME_INVALID" });
      return;
    }
    patch.username = username || undefined;
  }
  if (!Object.keys(patch).length) {
    res.json({ user: u });
    return;
  }
  try {
    const updated = await updateUserProfile(u.id, patch);
    res.json({ user: updated });
  } catch (err: any) {
    console.error("[auth:profile]", err);
    res.status(500).json({ error: "profile update failed", code: "SERVER_ERROR" });
  }
});

// ─── POST /api/auth/avatar ──────────────────────────────────────────────
router.post("/avatar", requireAuth, async (req: Request, res: Response) => {
  const u = currentUser(req)!;
  const { dataUrl } = req.body ?? {};
  if (typeof dataUrl !== "string") {
    res.status(400).json({ error: "dataUrl required", code: "MISSING_FIELDS" });
    return;
  }
  const m = /^data:(image\/(png|jpe?g|gif|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) {
    res.status(400).json({ error: "unsupported image format", code: "AVATAR_INVALID" });
    return;
  }
  const mediaType = m[1];
  const ext = m[2] === "jpeg" ? "jpg" : m[2];
  const bytes = Buffer.from(m[3], "base64");
  if (bytes.length > 2 * 1024 * 1024) {
    res.status(413).json({ error: "avatar too large (max 2MB)", code: "AVATAR_TOO_LARGE" });
    return;
  }

  // 与 index.ts 里 `app.use("/uploads", express.static(...))` 的路径保持一致
  // (<projectRoot>/uploads/avatars)。之前用 process.cwd() 会写到
  // backend/uploads/avatars，而静态服务指向 project_root/uploads —— 结果
  // 文件确实落盘了，但 URL 是 404，用户看到的就是"fallback 回默认头像"。
  const dir = path.resolve(__dirname, "../../../uploads/avatars");
  await fsp.mkdir(dir, { recursive: true });
  const hash = crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 12);
  const fileName = `${u.id}_${hash}.${ext}`;
  const abs = path.join(dir, fileName);
  await fsp.writeFile(abs, bytes);
  const avatarUrl = `/uploads/avatars/${fileName}`;
  const updated = await updateUserProfile(u.id, { avatarUrl });
  res.json({ user: updated, mediaType });
});

export default router;
