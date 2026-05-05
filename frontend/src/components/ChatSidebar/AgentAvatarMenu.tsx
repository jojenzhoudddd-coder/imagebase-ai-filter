/**
 * AgentAvatarMenu — circular avatar at the left of the chat sidebar header.
 *
 *   · Click → popover anchored below the avatar (mirrors TopBar's user menu).
 *     Popover shows: agent avatar (48px) + name + current model, plus 7
 *     placeholder menu items: nature / models / activities / skills /
 *     acknowledge / habits / integrations.  The menu items are noop'd until
 *     each gets its own real screen — the user explicitly asked for the
 *     button slots first, behaviour later.
 *   · Hovering the avatar shows the camera-overlay; clicking again with the
 *     popover open opens the file picker via the transparent `<input
 *     type="file">` on top of the popover avatar.  Picking a file → routes
 *     through the existing `AvatarCropDialog` → POSTs cropped data URL to
 *     `/api/agents/:id/avatar` → updates the local `agent` state.
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
}

const FALLBACK_AVATAR = "/avatars/avatar_1.png";

const MENU_ITEMS: ReadonlyArray<{ key: string; i18nKey: string }> = [
  { key: "nature", i18nKey: "chat.agent.menu.nature" },
  { key: "models", i18nKey: "chat.agent.menu.models" },
  { key: "activities", i18nKey: "chat.agent.menu.activities" },
  { key: "skills", i18nKey: "chat.agent.menu.skills" },
  { key: "acknowledge", i18nKey: "chat.agent.menu.acknowledge" },
  { key: "habits", i18nKey: "chat.agent.menu.habits" },
  { key: "integrations", i18nKey: "chat.agent.menu.integrations" },
];

export default function AgentAvatarMenu({ agentId, open, refreshToken }: Props) {
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
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (avatarBtnRef.current?.contains(t)) return;
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
    // Anchor below + flush-left of the avatar; same pattern as the user
    // popover (drops below the trigger, 6px breathing room).
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
      setAgent(updated);
      toast.success(t("topbar.avatarSaved"));
    } catch (err: any) {
      toast.error(err?.message || "upload failed");
    } finally {
      setUploading(false);
    }
  }, [agentId, t, toast]);

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
            {MENU_ITEMS.map((item) => (
              <div
                key={item.key}
                className="topbar-menu-item"
                onClick={() => {
                  // 占位 —— 后续 PR 接各自页面
                  setPopoverOpen(false);
                  // eslint-disable-next-line no-console
                  console.info(`[agent-menu] ${item.key} (not wired yet)`);
                }}
              >
                <span className="topbar-menu-label">{t(item.i18nKey)}</span>
              </div>
            ))}
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
