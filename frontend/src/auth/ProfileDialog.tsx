/**
 * ProfileDialog — edit username + avatar.
 *
 * "Display name" 已并入 username —— 同一个字段既是登录后展示用的昵称、
 * 面包屑首项，也是 workspace / 默认 chatbot 的底色。PATCH /api/auth/profile
 * 同步把 backend user.name 也写成 username，保持 legacy 列一致。
 *
 * Avatar upload: POST /api/auth/avatar（data URL），后端解码写到
 * uploads/avatars/ 并 update User.avatarUrl。改完走 patchUser 立即反馈到
 * 顶栏，不需要 refetch /me。
 */

import { useCallback, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useAuth } from "./AuthContext";
import { useToast } from "../components/Toast/index";
import { useTranslation } from "../i18n/index";
import { downscaleImage } from "./downscaleImage";
import "./ProfileDialog.css";

// 源图大小上限 —— 仅为 sanity check（防止用户选了 100MB 的 TIFF 导致浏览器卡死）。
// 实际上传给后端的是压缩后的 ~40KB JPEG，不会被后端 2MB 限制拦住。
const SOURCE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

interface Props { onClose: () => void }

export default function ProfileDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const { user, patchUser } = useAuth();
  const [username, setUsername] = useState(user?.username ?? "");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(user?.avatarUrl ?? null);
  const [pendingAvatarDataUrl, setPendingAvatarDataUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pickAvatar = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
      toast.error("仅支持 PNG / JPG / GIF / WebP");
      return;
    }
    if (file.size > SOURCE_MAX_BYTES) {
      toast.error("源图过大（超过 20MB），请换一张");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const originalDataUrl = reader.result as string;
      // 先用原图做即时预览，不等压缩 —— 用户视觉反馈更快
      setAvatarPreview(originalDataUrl);
      try {
        // 压缩：不管源图多大，统一缩到 256px / JPEG 0.85，上传体积 ~40KB
        const compressed = await downscaleImage(originalDataUrl, 256, 0.85);
        setAvatarPreview(compressed); // 预览也更新到压缩版（避免高分屏看到虚）
        setPendingAvatarDataUrl(compressed);
      } catch (err: any) {
        toast.error(err?.message || "图片处理失败");
        setAvatarPreview(user?.avatarUrl ?? null);
      }
    };
    reader.readAsDataURL(file);
  }, [toast, user?.avatarUrl]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedUsername = username.trim();
    // 校验 —— 规则与注册页一致
    if (!trimmedUsername) {
      toast.error(t("auth.toast.usernameRequired"));
      return;
    }
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(trimmedUsername)) {
      toast.error(t("auth.toast.usernameInvalid"));
      return;
    }

    setSaving(true);
    try {
      // 1. Avatar（如有）先上传，避免被后续 profile PATCH 覆盖
      if (pendingAvatarDataUrl) {
        const res = await fetch("/api/auth/avatar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ dataUrl: pendingAvatarDataUrl }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "头像上传失败");
        }
        const data = await res.json();
        patchUser({ avatarUrl: data.user.avatarUrl });
      }
      // 2. username 改动 —— 同步把 name 也改成一样的（保持 legacy 列一致）
      if (trimmedUsername !== (user?.username ?? "") || trimmedUsername !== user?.name) {
        const res = await fetch("/api/auth/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            name: trimmedUsername,
            username: trimmedUsername,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "保存失败");
        }
        const data = await res.json();
        patchUser({ name: data.user.name, username: data.user.username });
      }
      toast.success("已保存");
      onClose();
    } catch (err: any) {
      toast.error(err?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="profile-overlay" onMouseDown={onClose}>
      <div className="profile-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="profile-title">个人信息</div>
        <form className="profile-form" onSubmit={onSubmit}>
          <div className="profile-avatar-row">
            <img
              className="profile-avatar-preview"
              src={avatarPreview || "/avatars/avatar_1.png"}
              alt="avatar"
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/avatars/avatar_1.png"; }}
            />
            <button
              type="button"
              className="profile-avatar-btn"
              onClick={() => fileRef.current?.click()}
              disabled={saving}
            >
              更换头像
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              style={{ display: "none" }}
              onChange={pickAvatar}
            />
          </div>
          <div className="profile-field">
            <label htmlFor="p-username">用户名</label>
            <input
              id="p-username"
              className="profile-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="2-32 字符 a-z A-Z 0-9 _ -"
              disabled={saving}
              required
            />
          </div>
          <div className="profile-field">
            <label>邮箱</label>
            <div className="profile-input profile-input-readonly">
              {user?.email}
            </div>
          </div>
          <div className="profile-actions">
            <button type="button" className="profile-btn profile-btn-cancel" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button type="submit" className="profile-btn profile-btn-ok" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
