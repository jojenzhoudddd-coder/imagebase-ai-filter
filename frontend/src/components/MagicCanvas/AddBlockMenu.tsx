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
  const { workspaceId, agentId } = useAuth();
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
      {reachedMax && (
        <div className="mc-add-block-foot">{t("addBlock.maxBlocks").replace("{max}", String(MAX_BLOCKS))}</div>
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
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M12.9995 5.00293C13.1096 5.00319 13.1987 5.09316 13.2046 5.20312C13.3053 7.1422 14.8602 8.69699 16.7993 8.79785C16.9094 8.80368 16.9993 8.89274 16.9995 9.00293C16.9994 9.11319 16.9094 9.20218 16.7993 9.20801C14.8603 9.30885 13.3054 10.8637 13.2046 12.8027C13.1987 12.9128 13.1096 13.0027 12.9995 13.0029C12.8894 13.0026 12.7993 12.9127 12.7934 12.8027C12.6926 10.8635 11.138 9.30854 9.19871 9.20801C9.08891 9.20185 8.99962 9.11297 8.99949 9.00293C8.9997 8.89296 9.08895 8.804 9.19871 8.79785C11.1381 8.69731 12.6926 7.1424 12.7934 5.20312C12.7993 5.09321 12.8895 5.00328 12.9995 5.00293Z" fill="currentColor"/>
      <path d="M12.9643 1C17.6782 1.00028 21.5002 4.76222 21.5005 9.40234C21.5005 12.2555 20.0538 14.7752 17.8452 16.2939V21.3203C17.8452 21.9076 17.844 22.2022 17.728 22.4268C17.6258 22.6241 17.4617 22.7841 17.2612 22.8848C17.0331 22.9991 16.7342 23 16.1372 23H10.8569C10.2601 23 9.96099 22.9991 9.73289 22.8848C9.53249 22.7841 9.36927 22.6241 9.26707 22.4268C9.15092 22.2022 9.15086 21.9078 9.15086 21.3203V19.5H6.13621C5.53893 19.5 5.23941 19.4991 5.01121 19.3848C4.81076 19.2841 4.64764 19.1241 4.54539 18.9268C4.42924 18.7022 4.4282 18.4079 4.4282 17.8203V14.666L2.37449 14.3291C1.98664 14.2655 1.79232 14.2336 1.67722 14.1328C1.5765 14.0445 1.51399 13.9213 1.50144 13.7891C1.48738 13.6381 1.57641 13.465 1.75437 13.1201L5.23094 5.84473C6.59207 2.98343 9.54258 1.00003 12.9643 1ZM12.9643 3C10.3309 3.00003 8.07343 4.52456 7.0366 6.7041L7.03562 6.70703L4.21726 12.6045L6.4282 12.9678V17.5H11.1509V21H15.8452V15.2422L16.7124 14.6455C18.3036 13.5511 19.3618 11.7962 19.4878 9.80371L19.5005 9.40234C19.5003 6.00605 16.7817 3.18221 13.3032 3.00879L12.9643 3Z" fill="currentColor"/>
    </svg>
  );
}
