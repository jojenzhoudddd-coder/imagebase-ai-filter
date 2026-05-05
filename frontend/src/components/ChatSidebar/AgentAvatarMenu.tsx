/**
 * AgentAvatarMenu — circular avatar at the left of the chat sidebar header.
 *
 *   · Click → popover anchored below the avatar (mirrors TopBar's user menu
 *     for header / avatar shape, but the menu item rows below use the
 *     `.dropdown-menu-item` visuals so they match the artifact sidebar
 *     right-click menu — same 32px row, same 14px font, same gap).
 *   · Header: 48px avatar + agent name + current model name.
 *   · Items (7 placeholder buttons): nature / models / activities / skills /
 *     acknowledge / habits / integrations. Wired to no-op for now; each
 *     gets its own real screen later.
 *   · Hovering the avatar shows the camera-overlay; clicking → file picker
 *     via the transparent `<input type="file">` on top of the popover
 *     avatar. Picking a file → `AvatarCropDialog` → POST cropped data URL
 *     to `/api/agents/:id/avatar` → updates local `agent` state.
 *   · `key={avatarUrl}` on the <img> elements forces React to unmount and
 *     remount the DOM node when the URL changes, guaranteeing the browser
 *     re-fetches even if React's diff would otherwise skip the src update
 *     (defence in depth — the cache-busted URL plus key together ensure
 *     "upload success → toast → instant visual update" works regardless of
 *     reconciliation quirks).
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

/** Append `?v=<ts>` so React sees a different src after upload, forcing
 *  the <img> to refetch even when the served path is identical. Used
 *  together with `key={avatarUrl}` for belt-and-braces. */
function withCacheBust(url: string | null): string | null {
  if (!url) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${Date.now()}`;
}

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
      // Cache-bust + setAgent —— React will see a new avatarUrl string
      // (different ?v=<ts>) and (with key={avatarUrl} on the imgs) the DOM
      // <img> elements get fully remounted, forcing a fresh fetch.
      setAgent({ ...updated, avatarUrl: withCacheBust(updated.avatarUrl) });
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
          key={avatarUrl}
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
                key={avatarUrl}
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

          {/* Menu items —— 视觉对齐 artifact sidebar 右键菜单(`.dropdown-menu-item`):
              32px 行高、14px 字号、8px gap、12px L/R padding。topbar-profile-section
              的 4px wrapper padding 提供分组留白. */}
          <div className="topbar-profile-section chat-agent-menu-section">
            {MENU_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                className="dropdown-menu-item"
                onClick={() => {
                  setPopoverOpen(false);
                  // eslint-disable-next-line no-console
                  console.info(`[agent-menu] ${item.key} (not wired yet)`);
                }}
              >
                <span className="dropdown-menu-item-label">{t(item.i18nKey)}</span>
              </button>
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
