import { useState, useRef, useEffect, useCallback, type ChangeEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAuth, type AuthWorkspace } from "../../auth/AuthContext";
import { useTranslation } from "../../i18n/index";
import { useToast } from "../Toast/index";
import AvatarCropDialog from "../../auth/AvatarCropDialog";
import SwipeDelete from "../SwipeDelete/index";
import "./WorkspaceDock.css";

interface Props {
  open: boolean;
  currentWorkspaceId: string;
  onSelectWorkspace: (wsId: string) => void;
}

export default function WorkspaceDock({
  open,
  currentWorkspaceId,
  onSelectWorkspace,
}: Props) {
  const { workspaces, refresh } = useAuth();
  const { t, locale } = useTranslation();
  const toast = useToast();

  // ── Context menu ──
  const [ctxMenu, setCtxMenu] = useState<{ wsId: string; x: number; y: number } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ctxMenu]);

  // ── Avatar crop dialog (reuse user avatar pattern) ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarTargetWsId = useRef<string | null>(null);
  const [cropSource, setCropSource] = useState<string | null>(null);

  const handleChangeAvatar = (wsId: string) => {
    avatarTargetWsId.current = wsId;
    setCtxMenu(null);
    fileInputRef.current?.click();
  };

  const onAvatarFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
      toast.error(t("dock.avatarFormatError"));
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error(t("dock.avatarTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setCropSource(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleCroppedAvatar = async (croppedDataUrl: string) => {
    setCropSource(null);
    if (!avatarTargetWsId.current) return;
    try {
      const res = await fetch(`/api/workspaces/${avatarTargetWsId.current}/avatar`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ avatarUrl: croppedDataUrl }),
      });
      if (!res.ok) throw new Error("Upload failed");
      await refresh();
      toast.success(t("dock.avatarUpdated"));
    } catch {
      toast.error(t("dock.avatarUploadFailed"));
    }
  };

  // ── Create workspace (backend handles name dedup) ──
  const [creating, setCreating] = useState(false);
  const handleCreateWorkspace = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ locale }),
      });
      if (!res.ok) throw new Error("Create failed");
      const data = await res.json();
      await refresh();
      onSelectWorkspace(data.workspace.id);
    } catch {
      toast.error(t("dock.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  // ── Delete workspace ──
  const handleDeleteWorkspace = async (wsId: string) => {
    setCtxMenu(null);
    if (workspaces.length <= 1) {
      toast.error(t("dock.cannotDeleteLast"));
      return;
    }
    try {
      const res = await fetch(`/api/workspaces/${wsId}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Delete failed");
      }
      await refresh();
      if (wsId === currentWorkspaceId) {
        const remaining = workspaces.filter((w) => w.id !== wsId);
        if (remaining.length > 0) onSelectWorkspace(remaining[0].id);
      }
      toast.success(t("dock.workspaceDeleted"));
    } catch (err: any) {
      toast.error(err?.message || t("dock.deleteFailed"));
    }
  };

  return (
    <div className={`workspace-dock ${open ? "workspace-dock--open" : ""}`}>
      <div className="dock-glass">
        {/* ─── Work section ─── */}
        <div className="dock-section">
          <span className="dock-section-label">{t("dock.sectionWork")}</span>
          <div className="dock-items">
            {workspaces.map((ws) => (
              <WorkspaceTile
                key={ws.id}
                workspace={ws}
                active={ws.id === currentWorkspaceId}
                onClick={() => onSelectWorkspace(ws.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setCtxMenu({ wsId: ws.id, x: rect.right + 4, y: rect.top });
                }}
              />
            ))}
            <DockTip label={t("dock.addWorkspace")}>
              <button
                className="dock-tile dock-tile--add"
                onClick={handleCreateWorkspace}
              >
                <PlusIcon />
              </button>
            </DockTip>
          </div>
        </div>

        <div className="dock-divider" />

        {/* ─── Home section ─── */}
        <div className="dock-section">
          <span className="dock-section-label">{t("dock.sectionHome")}</span>
          <div className="dock-items">
            <DockTip label={t("dock.comingSoon")}>
              <button className="dock-tile dock-tile--add" disabled>
                <PlusIcon />
              </button>
            </DockTip>
          </div>
        </div>

        <div className="dock-divider" />

        {/* ─── Muse section ─── */}
        <div className="dock-section">
          <span className="dock-section-label">{t("dock.sectionMuse")}</span>
          <div className="dock-items">
            <DockTip label={t("dock.comingSoon")}>
              <button className="dock-tile dock-tile--add" disabled>
                <PlusIcon />
              </button>
            </DockTip>
          </div>
        </div>
      </div>

      {/* Hidden file input for avatar upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        style={{ display: "none" }}
        onChange={onAvatarFilePicked}
      />

      {/* Avatar crop dialog (reuses user avatar crop component) */}
      {cropSource && (
        <AvatarCropDialog
          sourceDataUrl={cropSource}
          onConfirm={handleCroppedAvatar}
          onCancel={() => setCropSource(null)}
        />
      )}

      {/* Context menu — uses field-context-menu system styles + SwipeDelete */}
      {ctxMenu && (
        <div
          ref={ctxRef}
          className="field-context-menu"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
        >
          <button className="field-context-menu-item" onClick={() => handleChangeAvatar(ctxMenu.wsId)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M7 4.5L7.55334 3.12635C7.70579 2.74789 8.07289 2.5 8.48091 2.5H15.4811C15.8806 2.5 16.2418 2.73779 16.3997 3.10478L17 4.5H21C22.1 4.5 23 5.4 23 6.5V19.5C23 20.6 22.1 21.5 21 21.5H3C1.9 21.5 1 20.6 1 19.5V6.5C1 5.4 1.9 4.5 3 4.5H7ZM3 6.5V19.5H21V6.5H3ZM12 16C13.6569 16 15 14.6569 15 13C15 11.3431 13.6569 10 12 10C10.3431 10 9 11.3431 9 13C9 14.6569 10.3431 16 12 16ZM12 18C9.23858 18 7 15.7614 7 13C7 10.2386 9.23858 8 12 8C14.7614 8 17 10.2386 17 13C17 15.7614 14.7614 18 12 18Z" fill="currentColor"/></svg>
            {t("dock.changeAvatar")}
          </button>
          <div className="field-context-menu-divider" />
          <SwipeDelete
            label={t("dock.deleteWorkspace")}
            onDelete={() => handleDeleteWorkspace(ctxMenu.wsId)}
            disabled={workspaces.length <= 1}
          />
        </div>
      )}
    </div>
  );
}

/* ─── Sub-components ─── */

function WorkspaceTile({
  workspace,
  active,
  onClick,
  onContextMenu,
}: {
  workspace: AuthWorkspace;
  active: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const initials = getInitials(workspace.name);
  const gradient = getGradientForId(workspace.id);

  return (
    <DockTip label={workspace.name}>
      <div className="dock-tile-wrap">
        {active && <div className="dock-tile-indicator" />}
        <button
          className={`dock-tile ${active ? "dock-tile--active" : ""}`}
          onClick={onClick}
          onContextMenu={onContextMenu}
        >
          {workspace.avatarUrl ? (
            <div className="dock-tile-inner dock-tile-inner--img">
              <img src={workspace.avatarUrl} alt={workspace.name} className="dock-tile-img" />
            </div>
          ) : (
            <div className="dock-tile-inner" style={{ background: gradient }}>
              <span className="dock-tile-initials">{initials}</span>
            </div>
          )}
        </button>
      </div>
    </DockTip>
  );
}

/** Minimal tooltip portaled to document.body — always right of trigger, vertically centered. */
function DockTip({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const show = useCallback(() => {
    if (ref.current) setRect(ref.current.getBoundingClientRect());
  }, []);
  const hide = useCallback(() => setRect(null), []);

  return (
    <div ref={ref} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {rect && createPortal(
        <div
          className="dock-tooltip-portal"
          style={{ top: rect.top + rect.height / 2, left: rect.right + 9, transform: "translateY(-50%)" }}
        >
          <div className="dock-tooltip-arrow" />
          <div className="dock-tooltip-body">{label}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/* ─── Helpers ─── */

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Gradients derived from the system design tokens:
 *  primary #1456F0, taste #7B4BDC, idea #F5A623, demo #34A853, danger #F54A45.
 *  Each gradient pairs a token color with a lighter or complementary shift. */
const TILE_GRADIENTS = [
  "linear-gradient(135deg, #1456F0 0%, #4A82FF 100%)",   /* primary blue */
  "linear-gradient(135deg, #7B4BDC 0%, #A87EF0 100%)",   /* taste purple */
  "linear-gradient(135deg, #34A853 0%, #5BC076 100%)",    /* demo green */
  "linear-gradient(135deg, #F5A623 0%, #FFCB5C 100%)",    /* idea amber */
  "linear-gradient(135deg, #1456F0 0%, #7B4BDC 100%)",    /* blue → purple */
  "linear-gradient(135deg, #F54A45 0%, #FF7B76 100%)",    /* danger red */
  "linear-gradient(135deg, #7B4BDC 0%, #1456F0 100%)",    /* purple → blue */
  "linear-gradient(135deg, #34A853 0%, #1456F0 100%)",    /* green → blue */
  "linear-gradient(135deg, #F5A623 0%, #F54A45 100%)",    /* amber → red */
  "linear-gradient(135deg, #1456F0 0%, #34A853 100%)",    /* blue → green */
];

function getGradientForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return TILE_GRADIENTS[Math.abs(hash) % TILE_GRADIENTS.length];
}
