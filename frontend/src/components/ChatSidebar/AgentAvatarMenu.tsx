/**
 * AgentAvatarMenu — circular avatar at the left of the chat sidebar header.
 *
 *   · Click → popover anchored below the avatar (mirrors TopBar's user menu).
 *     Popover header: avatar (48px) + agent name + current model;
 *     Popover body: "Rename" + "Delete" — same items as the artifact sidebar
 *     right-click menu (`contextMenu.rename` / `contextMenu.delete`), so the
 *     interaction surface stays consistent across the app.
 *   · Hovering the avatar shows the camera-overlay; click → file picker via
 *     the transparent `<input type="file">` on top of the popover avatar.
 *     Picking a file → `AvatarCropDialog` → POST cropped data URL to
 *     `/api/agents/:id/avatar` → updates local `agent` state with a
 *     cache-bust query string so the topbar avatar img re-fetches even when
 *     the URL path is identical to a previously cached one.
 *   · "Rename" → calls `onRenameRequest()` so the parent (ChatSidebar) can
 *     trigger AgentNamePill's edit mode. (We don't touch AgentNamePill state
 *     directly; lifting state through the parent keeps the components decoupled.)
 *   · "Delete" — placeholder; deleting the default agent is unsafe, so this
 *     just toasts a hint. Wired through here so the menu structure matches
 *     TreeView's right-click semantically.
 *
 * Reuses the `topbar-profile-popover` / `topbar-profile-header` /
 * `topbar-profile-avatar-wrap` CSS classes from `TopBar.css` so the visual
 * matches the user popover exactly.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import {
  type AgentMeta,
  type AgentModelSelection,
  getAgent,
  getAgentModel,
  uploadAgentAvatar,
} from "../../api";
import AvatarCropDialog from "../../auth/AvatarCropDialog";
import { useTranslation } from "../../i18n";
import { useToast } from "../Toast/index";

interface Props {
  agentId: string;
  /** True while the sidebar is visible — gates the initial fetch. */
  open: boolean;
  /** Bumped after each turn ends so we re-fetch the agent in case
   *  `update_agent_name` was invoked mid-turn. */
  refreshToken?: number;
  /** Parent-supplied callback to enter rename mode on AgentNamePill. */
  onRenameRequest?: () => void;
}

const FALLBACK_AVATAR = "/avatars/avatar_1.png";

/** Append a `?v=<ts>` query string so React's diff sees a different src
 *  after upload, guaranteeing the <img> re-fetches even when the served
 *  path is the same (different file content normally produces a new
 *  hash-based filename, but defence in depth doesn't hurt). */
function withCacheBust(url: string | null): string | null {
  if (!url) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${Date.now()}`;
}

function RenameIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function DeleteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M6 2a1 1 0 00-1 1h6a1 1 0 00-1-1H6zM4 4h8v9a1 1 0 01-1 1H5a1 1 0 01-1-1V4zM3 4h10V3H3v1zM6.5 6v5M9.5 6v5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export default function AgentAvatarMenu({ agentId, open, refreshToken, onRenameRequest }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [agent, setAgent] = useState<AgentMeta | null>(null);
  const [modelSel, setModelSel] = useState<AgentModelSelection | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const [cropSource, setCropSource] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const avatarBtnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, m] = await Promise.all([
        getAgent(agentId),
        getAgentModel(agentId).catch(() => null),
      ]);
      setAgent(a);
      setModelSel(m);
    } catch {
      // non-fatal — next refresh will retry
    }
  }, [agentId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open || refreshToken === undefined) return;
    void refresh();
  }, [open, refreshToken, refresh]);

  // Close popover on outside click / Esc
  useEffect(() => {
    if (!popoverOpen) return;
    const onDoc = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (popoverRef.current?.contains(tgt)) return;
      if (avatarBtnRef.current?.contains(tgt)) return;
      setPopoverOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopoverOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [popoverOpen]);

  const handleAvatarClick = useCallback(() => {
    if (popoverOpen) {
      setPopoverOpen(false);
      return;
    }
    const rect = avatarBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPopoverPos({ top: rect.bottom + 6, left: rect.left });
    setPopoverOpen(true);
  }, [popoverOpen]);

  const onFilePicked = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同图重选时仍能触发 change
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
      toast.error(t("topbar.avatarUnsupported"));
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error(t("topbar.avatarTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setCropSource(reader.result as string);
    reader.readAsDataURL(file);
  }, [t, toast]);

  const handleCropped = useCallback(async (croppedDataUrl: string) => {
    setCropSource(null);
    setUploading(true);
    try {
      const updated = await uploadAgentAvatar(agentId, croppedDataUrl);
      // Cache-bust the avatarUrl —— even if the path is identical (same
      // hash for repeated upload of same image), the v=<ts> suffix forces
      // React to render a new src so the <img> re-fetches.
      setAgent({ ...updated, avatarUrl: withCacheBust(updated.avatarUrl) });
      toast.success(t("topbar.avatarSaved"));
    } catch (err: any) {
      toast.error(err?.message || "upload failed");
    } finally {
      setUploading(false);
    }
  }, [agentId, t, toast]);

  const handleRename = useCallback(() => {
    setPopoverOpen(false);
    onRenameRequest?.();
  }, [onRenameRequest]);

  const handleDelete = useCallback(() => {
    setPopoverOpen(false);
    // 默认 agent 不可删除 —— 先 toast 提示,后续支持多 agent 时再接 DELETE
    toast.info(t("chat.agent.deleteUnsupported"));
  }, [toast, t]);

  const avatarUrl = agent?.avatarUrl || FALLBACK_AVATAR;
  const modelLabel = modelSel?.resolved.displayName ?? "";

  return (
    <>
      <button
        ref={avatarBtnRef}
        type="button"
        className="chat-agent-avatar-btn"
        onClick={handleAvatarClick}
        aria-haspopup="menu"
        aria-expanded={popoverOpen}
        title={agent?.name || ""}
      >
        <img
          className="chat-agent-avatar-img"
          src={avatarUrl}
          alt={agent?.name || "agent"}
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_AVATAR; }}
        />
      </button>

      {popoverOpen && popoverPos && createPortal(
        <div
          ref={popoverRef}
          className="topbar-menu topbar-profile-popover chat-agent-popover"
          style={{ position: "fixed", top: popoverPos.top, left: popoverPos.left }}
        >
          <div className="topbar-profile-header">
            <div className="topbar-profile-avatar-wrap" title={t("topbar.changeAvatar")}>
              <img
                className="topbar-profile-avatar"
                src={avatarUrl}
                alt=""
                onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_AVATAR; }}
              />
              <div className="topbar-profile-avatar-overlay">
                {uploading ? (
                  <span className="topbar-profile-uploading-dot">…</span>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="12" cy="13" r="3.5" stroke="#fff" strokeWidth="1.6" />
                  </svg>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                title=""
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="topbar-profile-avatar-input"
                onChange={onFilePicked}
              />
            </div>
            <div className="topbar-profile-info">
              <div className="topbar-profile-name-wrap">
                <span className="topbar-profile-username">{agent?.name || "…"}</span>
              </div>
              {modelLabel && (
                <div className="topbar-profile-tenant">
                  <span className="topbar-profile-email">{modelLabel}</span>
                </div>
              )}
            </div>
          </div>

          <div className="topbar-menu-divider topbar-profile-divider-top" />

          <div className="topbar-profile-section">
            <div
              className="topbar-menu-item"
              onClick={handleRename}
              role="menuitem"
            >
              <span className="topbar-menu-icon" aria-hidden="true"><RenameIcon /></span>
              <span className="topbar-menu-label">{t("contextMenu.rename")}</span>
            </div>
            <div
              className="topbar-menu-item"
              onClick={handleDelete}
              role="menuitem"
            >
              <span className="topbar-menu-icon" aria-hidden="true"><DeleteIcon /></span>
              <span className="topbar-menu-label">{t("contextMenu.delete")}</span>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {cropSource && (
        <AvatarCropDialog
          sourceDataUrl={cropSource}
          onConfirm={handleCropped}
          onCancel={() => setCropSource(null)}
        />
      )}
    </>
  );
}
