/**
 * /api/auth/* — user registration, login, logout, profile read/write.
 *
 * Cookie-based session. On login we sign a JWT and drop it into an
 * httpOnly cookie (see authService.setAuthCookie); the cookie travels
 * automatically on subsequent /api/* requests and `attachUser`
 * middleware populates `req.user`. No CSRF token because SameSite=Lax
 * covers the vectors we care about (no cross-site POST cookie sending).
 */

import { Router, type Request, type Response } from "express";
import path from "path";
import fsp from "fs/promises";
import crypto from "crypto";
import {
  COOKIE_NAME,
  clearAuthCookie,
  createUserWithWorkspace,
  currentUser,
  findUserForLogin,
  listUserWorkspaces,
  requireAuth,
  setAuthCookie,
  signAuthToken,
  updateUserProfile,
  verifyPassword,
} from "../services/authService.js";

const router = Router();

// ─── POST /api/auth/register ────────────────────────────────────────────
// Body: { email, username?, name, password }
router.post("/register", async (req: Request, res: Response) => {
  const { email, username, name, password } = req.body ?? {};
  if (!email || typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email)) {
    res.status(400).json({ error: "invalid email" }); return;
  }
  if (!password || typeof password !== "string" || password.length < 6) {
    res.status(400).json({ error: "password must be at least 6 chars" }); return;
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name required" }); return;
  }
  if (username && !/^[a-zA-Z0-9_-]{2,32}$/.test(username)) {
    res.status(400).json({ error: "username must be 2-32 chars, [A-Za-z0-9_-]" }); return;
  }
  try {
    const { userId, workspaceId } = await createUserWithWorkspace({
      email, username, name: name.trim(), password,
    });
    const token = signAuthToken({ sub: userId, login: username || email });
    setAuthCookie(res, token);
    res.json({
      ok: true,
      user: { id: userId, email, username: username || null, name: name.trim(), avatarUrl: null },
      workspaceId,
    });
  } catch (err: any) {
    // Likely unique-constraint violation on email / username
    const msg = err?.message || String(err);
    if (msg.includes("Unique constraint") || err?.code === "P2002") {
      res.status(409).json({ error: "Email or username already in use" }); return;
    }
    console.error("[auth:register]", err);
    res.status(500).json({ error: "register failed", detail: msg });
  }
});

// ─── POST /api/auth/login ───────────────────────────────────────────────
// Body: { handle, password }  — handle is email or username
router.post("/login", async (req: Request, res: Response) => {
  const { handle, password } = req.body ?? {};
  if (!handle || !password) {
    res.status(400).json({ error: "handle + password required" }); return;
  }
  const u = await findUserForLogin(String(handle));
  if (!u) { res.status(401).json({ error: "Invalid credentials" }); return; }
  const ok = await verifyPassword(String(password), u.passwordHash);
  if (!ok) { res.status(401).json({ error: "Invalid credentials" }); return; }

  const token = signAuthToken({ sub: u.id, login: u.username || u.email });
  setAuthCookie(res, token);
  const workspaces = await listUserWorkspaces(u.id);
  res.json({
    ok: true,
    user: {
      id: u.id, email: u.email, username: u.username,
      name: u.name, avatarUrl: u.avatarUrl,
    },
    workspaces,
    // Convenience: the FE uses whichever the user was last on, or falls
    // back to the first workspace if none stored. workspaceId here is the
    // deterministic "default" (first by createdAt).
    workspaceId: workspaces[0]?.id ?? null,
  });
});

// ─── POST /api/auth/logout ──────────────────────────────────────────────
router.post("/logout", (_req: Request, res: Response) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ─── GET /api/auth/me ───────────────────────────────────────────────────
// Returns the current user + their accessible workspaces. Also the primary
// means the FE checks "am I logged in?"
router.get("/me", async (req: Request, res: Response) => {
  const u = currentUser(req);
  if (!u) { res.status(401).json({ error: "Not authenticated" }); return; }
  const workspaces = await listUserWorkspaces(u.id);
  res.json({
    user: u,
    workspaces,
    workspaceId: workspaces[0]?.id ?? null,
  });
});

// ─── PATCH /api/auth/profile ────────────────────────────────────────────
// Body: { name?, username? }  (avatar goes through /avatar upload endpoint)
router.patch("/profile", requireAuth, async (req: Request, res: Response) => {
  const u = currentUser(req)!;
  const { name, username } = req.body ?? {};
  const patch: { name?: string; username?: string } = {};
  if (typeof name === "string") {
    const trimmed = name.trim();
    if (!trimmed) { res.status(400).json({ error: "name can't be empty" }); return; }
    patch.name = trimmed;
  }
  if (username !== undefined) {
    if (username && !/^[a-zA-Z0-9_-]{2,32}$/.test(String(username))) {
      res.status(400).json({ error: "username must be 2-32 chars, [A-Za-z0-9_-]" }); return;
    }
    patch.username = username || undefined;
  }
  if (!Object.keys(patch).length) { res.json({ user: u }); return; }
  try {
    const updated = await updateUserProfile(u.id, patch);
    res.json({ user: updated });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ error: "Username already in use" }); return;
    }
    console.error("[auth:profile]", err);
    res.status(500).json({ error: "profile update failed" });
  }
});

// ─── POST /api/auth/avatar ──────────────────────────────────────────────
// Body: { dataUrl: "data:image/png;base64,..." } — tiny v1 inline-upload
// path. Decodes the data URL, writes to uploads/avatars/<userId>.<ext>,
// and updates the User.avatarUrl. Big enough for profile avatars; for
// real image management we'll wire multer later.
router.post("/avatar", requireAuth, async (req: Request, res: Response) => {
  const u = currentUser(req)!;
  const { dataUrl } = req.body ?? {};
  if (typeof dataUrl !== "string") {
    res.status(400).json({ error: "dataUrl required" }); return;
  }
  const m = /^data:(image\/(png|jpe?g|gif|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) { res.status(400).json({ error: "unsupported image format" }); return; }
  const mediaType = m[1];
  const ext = m[2] === "jpeg" ? "jpg" : m[2];
  const bytes = Buffer.from(m[3], "base64");
  // Cap at 2MB — anything larger should use a proper upload UI first.
  if (bytes.length > 2 * 1024 * 1024) {
    res.status(413).json({ error: "avatar too large (max 2MB)" }); return;
  }

  const dir = path.resolve(process.cwd(), "uploads/avatars");
  await fsp.mkdir(dir, { recursive: true });
  // Hash content into filename so browser caches cleanly on update.
  const hash = crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 12);
  const fileName = `${u.id}_${hash}.${ext}`;
  const abs = path.join(dir, fileName);
  await fsp.writeFile(abs, bytes);
  const avatarUrl = `/uploads/avatars/${fileName}`;
  const updated = await updateUserProfile(u.id, { avatarUrl });
  res.json({ user: updated, mediaType });
});

export default router;
