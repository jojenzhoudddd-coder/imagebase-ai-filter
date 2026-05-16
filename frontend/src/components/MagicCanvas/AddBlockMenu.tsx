/**
 * AddBlockMenu —— TopBar `+` 按钮点击后的下拉菜单。
 * 选项:Chat / Artifact / System(disabled)。
 */

import { useEffect, useRef, useState } from "react";
import { useCanvas, MAX_BLOCKS } from "../../contexts/canvasContext";
import { useAuth } from "../../auth/AuthContext";
import { createConversation } from "../../api";
import { useTranslation } from "../../i18n";

export default function AddBlockMenu({ anchorRef }: { anchorRef: React.RefObject<HTMLElement | null> }) {
  const { addBlock, visibleBlockIds } = useCanvas();
  const { workspaceId, agentId, user } = useAuth();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, anchorRef]);

  const reachedMax = visibleBlockIds.length >= MAX_BLOCKS;

  // 暴露 toggle 给父组件 —— 通过 imperative handle 太重,改成 anchor 上挂事件
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const onClick = () => setOpen((v) => !v);
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [anchorRef]);

  if (!open) return null;

  const anchor = anchorRef.current;
  const rect = anchor?.getBoundingClientRect();
  const MENU_WIDTH = 180;
  const top = rect ? rect.bottom + 4 : 60;
  // 菜单右边 = + 按钮 hover 热区右边 (rect.right)
  const left = rect ? Math.max(8, rect.right - MENU_WIDTH) : 60;

  return (
    <div
      ref={popRef}
      className="mc-add-block-menu"
      style={{ position: "fixed", top, left }}
    >
      <button
        className="mc-add-block-item"
        disabled={reachedMax}
        onClick={async () => {
          // V3.0.2 修复:先 await POST /conversations 拿到 convId,再 addBlock
          // 时把 conversationId 一起注入 initialState。避免之前"先 addBlock 后
          // patchBlockState"的 race —— 新 ChatSidebar 在 patch 前已挂载读到
          // null 走 fallback 路径挑别的 conv,导致用户看到的不是新对话。
          setOpen(false);
          if (!workspaceId) {
            addBlock("chat");
            return;
          }
          let conv: { id: string } | null = null;
          try {
            conv = await createConversation(workspaceId, agentId || undefined);
          } catch (err) {
            console.warn("[AddBlockMenu] create conversation failed:", err);
          }
          addBlock("chat", conv ? ({ conversationId: conv.id } as any) : undefined);
        }}
      >
        <SparkleIcon />
        <span>{t("addBlock.chat")}</span>
      </button>
      <button
        className="mc-add-block-item"
        disabled={reachedMax}
        onClick={() => {
          addBlock("artifact");
          setOpen(false);
        }}
      >
        <ArtifactIcon />
        <span>{t("addBlock.artifact")}</span>
      </button>
      <button
        className="mc-add-block-item"
        disabled={reachedMax}
        onClick={() => {
          addBlock("system", { activeTab: "nature" } as any);
          setOpen(false);
        }}
      >
        <SystemIcon />
        <span>{t("addBlock.brain")}</span>
      </button>
      {user?.admin && (
        <button
          className="mc-add-block-item"
          disabled={reachedMax}
          onClick={() => {
            addBlock("system", { view: "admin" } as any);
            setOpen(false);
          }}
        >
          <AdminIcon />
          <span>{t("addBlock.admin")}</span>
        </button>
      )}
      {reachedMax && (
        <div className="mc-add-block-foot">{t("addBlock.maxBlocks").replace("{max}", String(MAX_BLOCKS))}</div>
      )}
    </div>
  );
}

function SparkleIcon() {
  // icon_chat_outlined — 描边气泡 + 两条横线
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M12 3C7.038 3 3 7.038 3 12c0 1.66.45 3.216 1.235 4.553l.156.27-1.196 4.372 4.372-1.196.27.156A8.96 8.96 0 0012 21c4.962 0 9-4.038 9-9s-4.038-9-9-9zM1 12C1 5.925 5.925 1 12 1s11 4.925 11 11-4.925 11-11 11a10.96 10.96 0 01-5.244-1.332L1.1 22.9l2.232-5.656A10.96 10.96 0 011 12z" fill="currentColor"/>
      <path d="M8 10h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M8 14h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}
function ArtifactIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 6h12M6 2v12" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
function SystemIcon() {
  // icon_robot_outlined
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M9 12C9.82834 12.0001 10.5 12.6716 10.5 13.5C10.5 14.3284 9.82834 14.9999 9 15C8.17157 15 7.5 14.3284 7.5 13.5C7.5 12.6716 8.17157 12 9 12Z" fill="currentColor"/>
      <path d="M15 12C15.8283 12.0001 16.5 12.6716 16.5 13.5C16.5 14.3284 15.8283 14.9999 15 15C14.1716 15 13.5 14.3284 13.5 13.5C13.5 12.6716 14.1716 12 15 12Z" fill="currentColor"/>
      <path d="M13 0C13.8284 3.22128e-08 14.5 0.671573 14.5 1.5C14.5 2.27666 13.9097 2.91539 13.1533 2.99219L13 3V5.5H19C20.1045 5.5001 21 6.39549 21 7.5V20C21 21.1045 20.1045 21.9999 19 22H5C3.89543 22 3 21.1046 3 20V7.5C3 6.39543 3.89543 5.5 5 5.5H11V3L10.8467 2.99219C10.0903 2.91539 9.5 2.27666 9.5 1.5C9.5 0.671573 10.1716 3.22128e-08 11 0H13ZM5 20H19V7.5H5V20Z" fill="currentColor"/>
      <path d="M1 10.5C1.55228 10.5 2 10.9477 2 11.5V15.5C2 16.0523 1.55228 16.5 1 16.5C0.447715 16.5 0 16.0523 0 15.5V11.5C0 10.9477 0.447715 10.5 1 10.5Z" fill="currentColor"/>
      <path d="M23 10.5C23.5523 10.5 24 10.9477 24 11.5V15.5C24 16.0523 23.5523 16.5 23 16.5C22.4477 16.5 22 16.0523 22 15.5V11.5C22 10.9477 22.4477 10.5 23 10.5Z" fill="currentColor"/>
    </svg>
  );
}
function AdminIcon() {
  // icon_admin_outlined
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M18.874 7C18.4299 8.72523 16.8638 10 15 10C13.1362 10 11.5701 8.72523 11.126 7H3C2.44772 7 2 6.55228 2 6C2 5.44772 2.44772 5 3 5H11.126C11.5701 3.27477 13.1362 2 15 2C16.8638 2 18.4299 3.27477 18.874 5H21C21.5523 5 22 5.44772 22 6C22 6.55228 21.5523 7 21 7H18.874ZM15 8C16.1046 8 17 7.10457 17 6C17 4.89543 16.1046 4 15 4C13.8954 4 13 4.89543 13 6C13 7.10457 13.8954 8 15 8Z" fill="currentColor"/>
      <path d="M12.874 19C12.4299 20.7252 10.8638 22 9 22C7.13616 22 5.57006 20.7252 5.12602 19H3C2.44772 19 2 18.5523 2 18C2 17.4477 2.44772 17 3 17H5.12602C5.57006 15.2748 7.13616 14 9 14C10.8638 14 12.4299 15.2748 12.874 17H21C21.5523 17 22 17.4477 22 18C22 18.5523 21.5523 19 21 19H12.874ZM9 20C10.1046 20 11 19.1046 11 18C11 16.8954 10.1046 16 9 16C7.89543 16 7 16.8954 7 18C7 19.1046 7.89543 20 9 20Z" fill="currentColor"/>
    </svg>
  );
}
