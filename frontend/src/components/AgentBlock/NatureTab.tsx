/**
 * NatureTab — renders soul.md, profile.md, and all memories
 * via a secondary tab bar (soul / profile / memory).
 */

import { useCallback, useEffect, useState } from "react";
import {
  type AgentIdentity,
  type AgentEpisodicMemory,
  type AgentWorkingMemory,
  getAgentIdentity,
  listAgentMemories,
  createConversation,
} from "../../api";
import { useCanvas } from "../../contexts/canvasContext";
import { useWorkspace } from "../../contexts/workspaceContext";
import { useTranslation } from "../../i18n";
import { useAgentHomeRefresh } from "./agentHomeEvents";

type SubTab = "soul" | "profile" | "memory";

/** "2026-05-06 21:22" 等宽日期格式,跟 Acknowledge 卡片 + chat turn meta 统一。 */
function formatCardDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Props {
  agentId: string;
}

const EDIT_PROMPTS: Record<SubTab, string> = {
  soul: "我想修改你的 Soul（灵魂/自我认知）。请先展示当前的 soul.md 内容，然后根据我的反馈帮我更新。",
  profile: "我想修改你的 User Profile（用户画像）。请先展示当前的 profile.md 内容，然后根据我的反馈帮我更新。",
  memory: "我想管理你的记忆。请列出当前的记忆条目，然后根据我的指示进行增删改。",
};

export default function NatureTab({ agentId }: Props) {
  const { t } = useTranslation();
  const { workspaceId } = useWorkspace();
  const { addBlock } = useCanvas();
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [episodic, setEpisodic] = useState<AgentEpisodicMemory[]>([]);
  const [working, setWorking] = useState<AgentWorkingMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [subTab, setSubTab] = useState<SubTab>("soul");

  const loadNature = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const [id, mem] = await Promise.all([
        getAgentIdentity(agentId),
        listAgentMemories(agentId, { workspaceId }).catch(() => ({ episodic: [], working: [] })),
      ]);
      setIdentity(id);
      setEpisodic(mem.episodic ?? []);
      setWorking(mem.working ?? []);
    } catch {
      setIdentity(null);
      setEpisodic([]);
      setWorking([]);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [agentId, workspaceId]);

  useEffect(() => {
    void loadNature(true);
  }, [loadNature]);

  const refreshNature = useCallback(() => {
    void loadNature(false);
  }, [loadNature]);

  useAgentHomeRefresh(agentId, refreshNature);

  if (loading) return <div className="ab-loading">{t("agent.block.loading")}</div>;

  const handleEditByChat = async () => {
    if (!workspaceId) return;
    try {
      const conv = await createConversation(workspaceId, agentId || undefined);
      addBlock("chat", { conversationId: conv.id, prefillMessage: EDIT_PROMPTS[subTab] } as any);
    } catch {
      addBlock("chat");
    }
  };

  const SUB_TABS: Array<{ key: SubTab; label: string }> = [
    { key: "soul", label: t("agent.nature.soul") },
    { key: "profile", label: t("agent.nature.profile") },
    { key: "memory", label: t("agent.nature.memory") },
  ];

  const hasMemories = episodic.length > 0 || working.length > 0;

  return (
    <div className="ab-nature">
      {/* Sub-tab bar */}
      <div className="ab-toolbar">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.key}
            className={`ab-toolbar-btn${subTab === tab.key ? " ab-toolbar-btn-active" : ""}`}
            onClick={() => setSubTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
        <div className="ab-toolbar-divider" />
        <button className="ab-toolbar-btn" onClick={handleEditByChat}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M21 19.002C21.5523 19.002 22 19.4497 22 20.002C22 20.5542 21.5523 21.0019 21 21.002H13.5C12.9477 21.002 12.5 20.5542 12.5 20.002C12.5 19.4497 12.9477 19.002 13.5 19.002H21Z" fill="currentColor"/><path d="M17.2949 2.00195C17.4263 2.00195 17.5564 2.02785 17.6777 2.07812C17.799 2.12837 17.9091 2.2021 18.002 2.29492L21.4385 5.74902C21.6251 5.93674 21.7299 6.19132 21.7295 6.45605C21.729 6.72055 21.6235 6.97406 21.4365 7.16113L7.61719 20.9814H3.80273C3.53766 20.9814 3.28319 20.8768 3.0957 20.6895C2.90817 20.5019 2.80273 20.2467 2.80273 19.9814V16.167L15.8857 3.00293L15.8828 3L16.5879 2.29492C16.6807 2.2021 16.7908 2.12838 16.9121 2.07812C17.0334 2.02785 17.1636 2.00196 17.2949 2.00195ZM4.83496 17.0117L6.77051 18.9492H6.77344L16.1611 9.55469L14.1602 7.55273L4.83496 17.0117ZM15.5605 6.125L17.5752 8.13965L19.2891 6.4248L17.2637 4.38867L15.5605 6.125Z" fill="currentColor"/><path d="M5 1.00195C5.11046 1.00195 5.19936 1.09184 5.20508 1.20215C5.30573 3.14148 6.86048 4.69622 8.7998 4.79688C8.91011 4.80259 9 4.8915 9 5.00195C9 5.11241 8.91011 5.20131 8.7998 5.20703C6.86048 5.30769 5.30573 6.86243 5.20508 8.80176C5.19936 8.91207 5.11046 9.00195 5 9.00195C4.88954 9.00195 4.80064 8.91207 4.79492 8.80176C4.69427 6.86243 3.13952 5.30769 1.2002 5.20703C1.08989 5.20131 1 5.11241 1 5.00195C1 4.8915 1.08989 4.80259 1.2002 4.79688C3.13952 4.69622 4.69427 3.14148 4.79492 1.20215C4.80064 1.09184 4.88954 1.00195 5 1.00195Z" fill="currentColor"/>
          </svg>
          {t("agent.nature.editByChat")}
        </button>
      </div>

      {/* Content */}
      {subTab === "soul" && (
        <pre className="ab-code-block"><code>{identity?.soul || "—"}</code></pre>
      )}

      {subTab === "profile" && (
        <pre className="ab-code-block"><code>{identity?.profile || "—"}</code></pre>
      )}

      {subTab === "memory" && (
        <>
          {!hasMemories ? (
            <div className="ab-empty">{t("agent.block.noMemories")}</div>
          ) : (
            <>
              {working.length > 0 && (
                <div className="ab-memory-group">
                  <div className="ab-memory-group-label">{t("agent.nature.workingMemory")}</div>
                  {/* 时间倒序展示:最新的 turn 排在最上面。后端 working.jsonl
                   *  是 append-only(老的在前),前端 reverse 一下让用户先看到
                   *  最近活动。slice() 先复制再 reverse,避免改变 state. */}
                  {[...working].reverse().map((w, i) => (
                    <div key={`w-${i}`} className="ab-memory-card">
                      <div className="ab-memory-card-title">
                        {w.userMessage.length > 60 ? w.userMessage.slice(0, 60) + "…" : w.userMessage}
                      </div>
                      <div className="ab-memory-card-meta">
                        <span>{formatCardDate(w.timestamp)}</span>
                        {w.toolCalls.length > 0 && (
                          <span className="ab-memory-tag">tools: {w.toolCalls.length}</span>
                        )}
                      </div>
                      <pre className="ab-code-block ab-code-block-sm"><code>{w.assistantMessage.slice(0, 300)}{w.assistantMessage.length > 300 ? "…" : ""}</code></pre>
                    </div>
                  ))}
                </div>
              )}

              {episodic.length > 0 && (
                <div className="ab-memory-group">
                  <div className="ab-memory-group-label">{t("agent.nature.episodicMemory")}</div>
                  {episodic.map((m) => (
                    <div key={m.filename} className="ab-memory-card">
                      <div className="ab-memory-card-title">{m.title}</div>
                      <div className="ab-memory-card-meta">
                        <span>{formatCardDate(m.timestamp)}</span>
                        {m.tags.map((tag) => (
                          <span key={tag} className="ab-memory-tag">{tag}</span>
                        ))}
                      </div>
                      {m.preview && (
                        <pre className="ab-code-block ab-code-block-sm"><code>{m.preview}</code></pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
