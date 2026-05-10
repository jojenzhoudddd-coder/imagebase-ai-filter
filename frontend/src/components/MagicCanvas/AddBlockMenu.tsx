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
  // icon_chat_outlined — 圆角气泡 + 两条横线
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 1.821.487 3.53 1.338 5.002L2.05 21.95l4.948-1.288A9.953 9.953 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zM8 10.5h8a.75.75 0 010 1.5H8a.75.75 0 010-1.5zm0 3h5a.75.75 0 010 1.5H8a.75.75 0 010-1.5z" fill="currentColor"/>
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
  // icon_member_outlined
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M15 6.5C15 4.84315 13.6569 3.5 12 3.5C10.3431 3.5 9 4.84315 9 6.5C9 8.15685 10.3431 9.5 12 9.5C13.6569 9.5 15 8.15685 15 6.5ZM17 6.5C17 9.26142 14.7614 11.5 12 11.5C9.23858 11.5 7 9.26142 7 6.5C7 3.73858 9.23858 1.5 12 1.5C14.7614 1.5 17 3.73858 17 6.5ZM4 19V21H20V19C20 16.7909 18.2091 15 16 15H8C5.79086 15 4 16.7909 4 19ZM2 19C2 15.6863 4.68629 13 8 13H16C19.3137 13 22 15.6863 22 19V21C22 22.1046 21.1046 23 20 23H4C2.89543 23 2 22.1046 2 21V19Z" fill="currentColor"/>
    </svg>
  );
}
