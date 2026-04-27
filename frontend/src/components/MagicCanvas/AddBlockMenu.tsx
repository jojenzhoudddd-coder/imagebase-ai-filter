/**
 * AddBlockMenu —— TopBar `+` 按钮点击后的下拉菜单。
 * 选项:Chat / Artifact / System(disabled)。
 */

import { useEffect, useRef, useState } from "react";
import { useCanvas, MAX_BLOCKS } from "../../contexts/canvasContext";
import { useAuth } from "../../auth/AuthContext";
import { createConversation } from "../../api";

export default function AddBlockMenu({ anchorRef }: { anchorRef: React.RefObject<HTMLElement | null> }) {
  const { addBlock, patchBlockState, visibleBlockIds } = useCanvas();
  const { workspaceId, agentId } = useAuth();
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
          // V3.0.1 新增 chat block 时同步走 New Chat 链路:
          // 1) addBlock 拿到 blockId
          // 2) POST /conversations 起新对话
          // 3) patchBlockState 把 conversationId 写进 BlockState (canvas 自动持久化)
          const newBlockId = addBlock("chat");
          setOpen(false);
          if (!newBlockId || !workspaceId) return;
          try {
            const conv = await createConversation(workspaceId, agentId || undefined);
            patchBlockState(newBlockId, { conversationId: conv.id });
          } catch (err) {
            console.warn("[AddBlockMenu] create conversation failed:", err);
            // block 已加,只是没绑定 conv —— ChatSidebar fallback 会自己挑/建一个
          }
        }}
      >
        <SparkleIcon />
        <span>Chat</span>
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
        <span>Artifact</span>
      </button>
      <button className="mc-add-block-item mc-add-block-item-disabled" disabled title="敬请期待">
        <SystemIcon />
        <span>System</span>
        <span className="mc-add-block-item-soon">soon</span>
      </button>
      {reachedMax && (
        <div className="mc-add-block-foot">已达上限 {MAX_BLOCKS} 个 block</div>
      )}
    </div>
  );
}

function SparkleIcon() {
  // 四芒星 —— 与 TopBar 的 AI Agent 按钮同一路径,统一视觉
  return (
    <svg width="14" height="14" viewBox="1332 22 20 20" fill="none">
      <path d="M1342 27.3108C1341.02 29.321 1339.43 30.97 1337.46 31.9998C1339.43 33.0294 1341.02 34.678 1342 36.688C1342.98 34.678 1344.57 33.0294 1346.54 31.9998C1344.57 30.97 1342.98 29.321 1342 27.3108ZM1350.62 31.9998C1350.62 32.2031 1350.47 32.3714 1350.27 32.3945L1350.18 32.4062C1349.52 32.4895 1348.89 32.6447 1348.28 32.8647L1347.55 33.1702C1345.67 34.0603 1344.14 35.6041 1343.27 37.5142L1342.96 38.2532C1342.75 38.8585 1342.6 39.4945 1342.51 40.1523L1342.49 40.2483C1342.43 40.4649 1342.23 40.6226 1342 40.6226L1341.9 40.613C1341.72 40.5762 1341.56 40.4341 1341.51 40.2483L1341.49 40.1523C1341.4 39.4945 1341.25 38.8585 1341.04 38.2532L1340.73 37.5142C1339.86 35.6041 1338.33 34.0603 1336.45 33.1702L1335.72 32.8647C1335.16 32.6631 1334.59 32.5156 1333.99 32.4282L1333.73 32.3945C1333.53 32.3714 1333.38 32.2031 1333.38 31.9998C1333.38 31.7964 1333.53 31.6281 1333.73 31.605C1334.33 31.535 1334.92 31.4037 1335.48 31.2175L1335.72 31.1348L1336.45 30.8293C1338.33 29.9392 1339.86 28.3954 1340.73 26.4854L1341.04 25.7463C1341.25 25.141 1341.4 24.505 1341.49 23.8472C1341.52 23.5828 1341.74 23.377 1342 23.377C1342.26 23.377 1342.48 23.5828 1342.51 23.8472C1342.6 24.505 1342.75 25.141 1342.96 25.7463L1343.27 26.4854C1344.14 28.3954 1345.67 29.9392 1347.55 30.8293L1348.28 31.1348L1348.52 31.2175C1349.08 31.4037 1349.67 31.535 1350.27 31.605C1350.47 31.6281 1350.62 31.7964 1350.62 31.9998Z" fill="currentColor"/>
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
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M13 8a5 5 0 01-.1 1l1.3 1-1 1.7-1.5-.4a5 5 0 01-1.8 1L9.5 14h-3l-.4-1.7a5 5 0 01-1.8-1L2.8 11.7 1.8 10l1.3-1a5 5 0 01-.1-1 5 5 0 01.1-1L1.8 6 2.8 4.3l1.5.4a5 5 0 011.8-1L6.5 2h3l.4 1.7a5 5 0 011.8 1l1.5-.4 1 1.7-1.3 1a5 5 0 01.1 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
