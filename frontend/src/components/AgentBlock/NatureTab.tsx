/**
 * NatureTab — renders soul.md, profile.md, and all memories
 * via a secondary tab bar (soul / profile / memory).
 */

import { useEffect, useState } from "react";
import {
  type AgentIdentity,
  type AgentEpisodicMemory,
  type AgentWorkingMemory,
  getAgentIdentity,
  listAgentMemories,
  createConversation,
} from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { useCanvas } from "../../contexts/canvasContext";
import { useTranslation } from "../../i18n";

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
  const { workspaceId } = useAuth();
  const { addBlock } = useCanvas();
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [episodic, setEpisodic] = useState<AgentEpisodicMemory[]>([]);
  const [working, setWorking] = useState<AgentWorkingMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [subTab, setSubTab] = useState<SubTab>("soul");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getAgentIdentity(agentId),
      listAgentMemories(agentId).catch(() => ({ episodic: [], working: [] })),
    ]).then(([id, mem]) => {
      if (cancelled) return;
      setIdentity(id);
      setEpisodic(mem.episodic ?? []);
      setWorking(mem.working ?? []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [agentId]);

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
            <path d="M17.5702 7.24391L17.5636 7.23764L17.9332 6.86799C18.323 6.47819 18.3238 5.84645 17.9351 5.45563L14.5009 2.00337L14.499 2.00151C14.1085 1.61099 13.4753 1.61099 13.0848 2.00151L12.3796 2.70676L12.3894 2.71666L2 13.186V17C2 17.5523 2.44772 18 3 18H6.81402L17.5702 7.24391ZM14.2971 7.63289L12.2824 5.61824L13.7686 4.10307L15.7917 6.13685L14.2971 7.63289ZM10.8819 7.04617L12.8836 9.04781L5.97053 15.9675H5.96748L4.03252 14.0326V14.0295L10.8819 7.04617Z" fill="currentColor"/><path d="M3 20C2.44772 20 2 20.4477 2 21C2 21.5523 2.44772 22 3 22H21C21.5523 22 22 21.5523 22 21C22 20.4477 21.5523 20 21 20H3Z" fill="currentColor"/>
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
