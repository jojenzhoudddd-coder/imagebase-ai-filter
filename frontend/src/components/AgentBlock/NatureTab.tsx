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
        <button className="ab-toolbar-btn" onClick={handleEditByChat}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M10 2l2 2-7 7H3v-2l7-7z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
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
                  {working.map((w, i) => (
                    <div key={`w-${i}`} className="ab-memory-card">
                      <div className="ab-memory-card-title">
                        {w.userMessage.length > 60 ? w.userMessage.slice(0, 60) + "…" : w.userMessage}
                      </div>
                      <div className="ab-memory-card-meta">
                        <span>{new Date(w.timestamp).toLocaleString()}</span>
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
                        <span>{m.timestamp ? new Date(m.timestamp).toLocaleString() : "—"}</span>
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
