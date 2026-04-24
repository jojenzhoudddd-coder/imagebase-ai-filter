/**
 * ProfileDialog — edit display name + username + avatar. Avatar upload
 * posts a data URL to /api/auth/avatar which the backend decodes and
 * writes to uploads/avatars/. Changes are reflected in AuthContext
 * immediately via patchUser so the topbar avatar updates without a
 * refetch.
 */

import { useCallback, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useAuth } from "./AuthContext";
import "./ProfileDialog.css";

interface Props { onClose: () => void }

export default function ProfileDialog({ onClose }: Props) {
  const { user, patchUser } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [username, setUsername] = useState(user?.username ?? "");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(user?.avatarUrl ?? null);
  const [pendingAvatarDataUrl, setPendingAvatarDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pickAvatar = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
      setError("仅支持 PNG / JPG / GIF / WebP");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("头像大小不能超过 2MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setAvatarPreview(dataUrl);
      setPendingAvatarDataUrl(dataUrl);
      setError(null);
    };
    reader.readAsDataURL(file);
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      // Upload avatar first (if changed) so we don't overwrite a later
      // profile edit with stale avatarUrl.
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
      // Patch name / username
      if (name !== user?.name || username !== (user?.username ?? "")) {
        const res = await fetch("/api/auth/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            name: name.trim(),
            username: username.trim() || null,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "保存失败");
        }
        const data = await res.json();
        patchUser({ name: data.user.name, username: data.user.username });
      }
      onClose();
    } catch (err: any) {
      setError(err?.message || "保存失败");
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
              src={avatarPreview || "/avatars/me.jpg"}
              alt="avatar"
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/avatars/me.jpg"; }}
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
            <label htmlFor="p-name">显示名</label>
            <input
              id="p-name"
              className="profile-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              disabled={saving}
            />
          </div>
          <div className="profile-field">
            <label htmlFor="p-username">用户名</label>
            <input
              id="p-username"
              className="profile-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="可选，2-32 字符 a-z A-Z 0-9 _ -"
              disabled={saving}
            />
          </div>
          <div className="profile-field">
            <label>邮箱</label>
            <div className="profile-input profile-input-readonly">
              {user?.email}
            </div>
          </div>
          {error && <div className="profile-error">{error}</div>}
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
