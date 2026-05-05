/**
 * AgentAvatarMenu — circular avatar at the left of the chat sidebar header.
 *
 * UX:
 *   · Hover the 28×28 avatar → semi-transparent dark overlay with camera
 *     icon (visual hint that clicking will change the avatar).
 *   · Click the avatar → file picker opens directly (transparent
 *     `<input type="file">` overlays the wrap; the browser dispatches its
 *     native click on the input). No popover step in between.
 *   · After file pick → AvatarCropDialog → POST cropped data URL to
 *     `/api/agents/:id/avatar` → setAgent with cache-busted URL.
 *
 *   `key={avatarUrl}` on the <img> forces React to remount the DOM node
 *   when the URL changes, guaranteeing the browser fetches the new image
 *   even if React's diff would otherwise skip the src attribute update.
 *
 * Naming: the file is still called AgentAvatarMenu for git-history
 * continuity even though the popover is gone — the 7-placeholder menu may
 * come back behind a different trigger later.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  type AgentMeta,
  getAgent,
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
  const [cropSource, setCropSource] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const a = await getAgent(agentId);
      setAgent(a);
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
      setAgent({ ...updated, avatarUrl: withCacheBust(updated.avatarUrl) });
      toast.success(t("topbar.avatarSaved"));
    } catch (err: any) {
      toast.error(err?.message || "upload failed");
    } finally {
      setUploading(false);
    }
  }, [agentId, t, toast]);

  const avatarUrl = agent?.avatarUrl || FALLBACK_AVATAR;

  return (
    <>
      <div className="chat-agent-avatar-wrap" title={t("topbar.changeAvatar")}>
        <img
          key={avatarUrl}
          className="chat-agent-avatar-img"
          src={avatarUrl}
          alt={agent?.name || "agent"}
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_AVATAR; }}
        />
        <div className="chat-agent-avatar-overlay">
          {uploading ? (
            <span className="chat-agent-avatar-uploading">…</span>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
          className="chat-agent-avatar-input"
          onChange={onFilePicked}
        />
      </div>

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
