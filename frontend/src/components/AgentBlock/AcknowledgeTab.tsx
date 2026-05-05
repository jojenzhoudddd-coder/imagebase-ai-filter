/**
 * AcknowledgeTab — mini file-system view of Agent's knowledge base.
 * Left: file list (titles). Right/below: selected entry content in code block.
 * Similar to NatureTab's sub-tab pattern but with a document list.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useCanvas } from "../../contexts/canvasContext";
import { createConversation, listKnowledgeEntries, type KnowledgeEntrySummary } from "../../api";
import { useTranslation } from "../../i18n";

interface Props {
  agentId: string;
}

const ADD_KNOWLEDGE_PROMPT = `我想让你学习一些新知识。请问：
1. 你想让我学习什么主题或领域？
2. 有没有具体的 URL 让我去读？
3. 或者你想让我自己去搜索相关内容？

告诉我后我会去学习并存储到知识库。`;

export default function AcknowledgeTab({ agentId }: Props) {
  const { t } = useTranslation();
  const { workspaceId } = useAuth();
  const { addBlock } = useCanvas();
  const [entries, setEntries] = useState<KnowledgeEntrySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    listKnowledgeEntries(agentId, { limit: 100 })
      .then((data) => {
        setEntries(data.entries);
        if (data.entries.length > 0 && !selectedId) {
          setSelectedId(data.entries[0].id);
        }
      })
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [agentId]);

  const handleAddByChat = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const conv = await createConversation(workspaceId, agentId || undefined);
      addBlock("chat", { conversationId: conv.id, prefillMessage: ADD_KNOWLEDGE_PROMPT } as any);
    } catch {
      addBlock("chat");
    }
  }, [workspaceId, agentId, addBlock]);

  if (loading) return <div className="ab-loading">{t("agent.block.loading")}</div>;

  const selected = entries.find((e) => e.id === selectedId);

  return (
    <div className="ab-acknowledge">
      {/* Toolbar */}
      <div className="ab-toolbar">
        <button className="ab-toolbar-btn" onClick={handleAddByChat}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {t("agent.acknowledge.addByChat")}
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="ab-empty">{t("agent.block.noKnowledge")}</div>
      ) : (
        <div className="ab-acknowledge-layout">
          {/* File list */}
          <div className="ab-acknowledge-list">
            {entries.map((e) => (
              <button
                key={e.id}
                className={`ab-acknowledge-item${e.id === selectedId ? " active" : ""}`}
                onClick={() => setSelectedId(e.id)}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="ab-acknowledge-item-icon">
                  <path d="M3 1.5h5l3 3v8a1 1 0 01-1 1H3a1 1 0 01-1-1v-10a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  <path d="M8 1.5v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="ab-acknowledge-item-title">{e.title}</span>
                {e.sourceType === "web" && (
                  <span className="ab-acknowledge-item-badge">web</span>
                )}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="ab-acknowledge-content">
            {selected ? (
              <>
                <div className="ab-acknowledge-meta">
                  <span className="ab-acknowledge-meta-title">{selected.title}</span>
                  {selected.sourceUrl && (
                    <a className="ab-acknowledge-meta-url" href={selected.sourceUrl} target="_blank" rel="noopener noreferrer">
                      {selected.sourceUrl}
                    </a>
                  )}
                  {selected.tags.length > 0 && (
                    <div className="ab-acknowledge-meta-tags">
                      {selected.tags.map((tag) => (
                        <span key={tag} className="ab-memory-tag">{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
                <pre className="ab-code-block"><code>{selected.content}</code></pre>
              </>
            ) : (
              <div className="ab-empty">{t("agent.acknowledge.selectDoc")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
