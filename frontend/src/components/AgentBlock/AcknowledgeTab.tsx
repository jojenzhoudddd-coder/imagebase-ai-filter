/**
 * AcknowledgeTab — Agent knowledge base display.
 * Aligned with NatureTab: toolbar + vertical card list with expandable content.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useCanvas } from "../../contexts/canvasContext";
import { createConversation, listKnowledgeEntries, getKnowledgeEntry, type KnowledgeEntrySummary } from "../../api";
import { useTranslation } from "../../i18n";

interface Props {
  agentId: string;
}

const ADD_KNOWLEDGE_PROMPT = `我想让你学习新知识并保存到知识库。`;

export default function AcknowledgeTab({ agentId }: Props) {
  const { t } = useTranslation();
  const { workspaceId } = useAuth();
  const { addBlock } = useCanvas();
  const [entries, setEntries] = useState<KnowledgeEntrySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fullContent, setFullContent] = useState<Record<string, string>>({});

  useEffect(() => {
    listKnowledgeEntries(agentId, { limit: 100 })
      .then((data) => setEntries(data.entries))
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

  const handleToggleExpand = useCallback(async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    // Fetch full content if not cached
    if (!fullContent[id]) {
      try {
        const entry = await getKnowledgeEntry(agentId, id);
        setFullContent((prev) => ({ ...prev, [id]: entry.content }));
      } catch {
        // fallback to truncated content
      }
    }
  }, [expandedId, fullContent, agentId]);

  if (loading) return <div className="ab-loading">{t("agent.block.loading")}</div>;

  return (
    <div className="ab-nature">
      {/* Toolbar — same pattern as NatureTab */}
      <div className="ab-toolbar">
        <button className="ab-toolbar-btn" onClick={handleAddByChat}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {t("agent.acknowledge.addByChat")}
        </button>
      </div>

      {/* Content — vertical card list like Nature's memory sub-tab */}
      {entries.length === 0 ? (
        <div className="ab-empty">{t("agent.block.noKnowledge")}</div>
      ) : (
        <div className="ab-memory-group">
          {entries.map((e) => (
            <div key={e.id} className="ab-memory-card">
              <div
                className="ab-memory-card-title"
                style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                onClick={() => handleToggleExpand(e.id)}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, opacity: 0.6 }}>
                  <path d="M3 1.5h5l3 3v8a1 1 0 01-1 1H3a1 1 0 01-1-1v-10a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  <path d="M8 1.5v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span style={{ flex: 1 }}>{e.title}</span>
                <svg
                  width="12" height="12" viewBox="0 0 12 12" fill="none"
                  style={{ flexShrink: 0, opacity: 0.5, transform: expandedId === e.id ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.15s" }}
                >
                  <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="ab-memory-card-meta">
                <span>{new Date(e.createdAt).toLocaleString()}</span>
                {e.sourceType === "web" && <span className="ab-memory-tag">web</span>}
                {e.sourceUrl && (
                  <a
                    href={e.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ab-memory-tag"
                    style={{ color: "var(--primary)", textDecoration: "none" }}
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    source
                  </a>
                )}
                {e.tags.map((tag) => (
                  <span key={tag} className="ab-memory-tag">{tag}</span>
                ))}
              </div>
              {expandedId === e.id && (
                <pre className="ab-code-block ab-code-block-sm"><code>{fullContent[e.id] || e.content}</code></pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
