/**
 * ModelsTab — displays all configured models as entity cards.
 * Shows "Current" badge on the agent's selected model.
 * Toolbar with "Add model" button opens a chat block with pre-filled prompt.
 */

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useCanvas } from "../../contexts/canvasContext";
import Tooltip from "../Tooltip";
import {
  listModels,
  getAgentModel,
  createConversation,
  type AgentModelSelection,
} from "../../api";
import { useTranslation } from "../../i18n";
import CardGrid from "./CardGrid";

interface ModelSummary {
  id: string;
  displayName: string;
  provider: string;
  group: string;
  available: boolean;
  capabilities?: { thinking?: boolean; toolUse?: boolean; contextWindow?: number };
  specialty?: string;
  strengths?: string[];
  costHint?: string;
}

function maskKey(provider: string): string {
  if (provider === "ark") return "sk-****…" + "vwdh7";
  return "sk-****…" + "nT4C";
}

function endpointUrl(provider: string): string {
  if (provider === "ark") return "https://ark.cn-beijing.volces.com/api/v3";
  return "https://oneapi.iline.work/v1";
}

const ADD_MODEL_PROMPT = `我想添加一个新的 AI 模型到我的模型列表。请引导我完成配置，我需要提供：
1. 模型显示名称
2. Provider 类型（OpenAI-compatible / Anthropic / 其他）
3. API Base URL
4. API Key
5. Provider 的 Model ID（实际请求时用的名称）
6. 模型能力（是否支持 thinking、tool use、上下文窗口大小）

请一步步引导我。`;

export default function ModelsTab() {
  const { t } = useTranslation();
  const { workspaceId, agentId } = useAuth();
  const { addBlock } = useCanvas();
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [selection, setSelection] = useState<AgentModelSelection | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      listModels(),
      agentId ? getAgentModel(agentId) : Promise.resolve(null),
    ])
      .then(([data, sel]) => {
        setModels(data.models);
        setSelection(sel);
      })
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, [agentId]);

  // Listen for model changes from chat blocks
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.agentId === agentId && detail?.selection) {
        setSelection(detail.selection);
      }
    };
    window.addEventListener("agent-model-changed", handler);
    return () => window.removeEventListener("agent-model-changed", handler);
  }, [agentId]);

  const handleAddModel = async () => {
    if (!workspaceId) return;
    try {
      const conv = await createConversation(workspaceId, agentId || undefined);
      addBlock("chat", { conversationId: conv.id, prefillMessage: ADD_MODEL_PROMPT } as any);
    } catch {
      // fallback: just open a chat block
      addBlock("chat");
    }
  };

  if (loading) return <div className="ab-loading">{t("agent.block.loading")}</div>;
  if (models.length === 0) return <div className="ab-empty">{t("agent.block.noModels")}</div>;

  const currentModelId = selection?.selected;

  return (
    <div>
      {/* Toolbar */}
      <div className="ab-toolbar">
        <button className="ab-toolbar-btn" onClick={handleAddModel}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {t("agent.models.addModel")}
        </button>
      </div>

      <CardGrid>
        {models.map((m) => (
          <div key={m.id} className={`ab-card${m.id === currentModelId ? " ab-card-current" : ""}`}>
            <div className="ab-card-head">
              <div className="ab-card-title-block">
                <div className="ab-card-title-row">
                  <h4 className="ab-card-title">{m.displayName}</h4>
                  {m.id === currentModelId && (
                    <span className="ab-card-state ab-card-state-primary">
                      <span className="ab-card-state-dot" />
                      Current
                    </span>
                  )}
                  <span className={`ab-card-state ${m.available ? "ab-card-state-success" : "ab-card-state-muted"}`}>
                    <span className="ab-card-state-dot" />
                    {m.available ? "Available" : "Offline"}
                  </span>
                </div>
                <Tooltip title={m.id}><p className="ab-card-desc">{m.id}</p></Tooltip>
              </div>
              <div className="ab-card-controls">
                <button className="ab-card-more" title="More">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                    <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
                  </svg>
                </button>
              </div>
            </div>
            <dl className="ab-card-kv ab-card-kv-2col">
              <div className="ab-card-kv-row">
                <dt>{t("agent.card.provider")}</dt>
                <dd>{m.provider === "ark" ? "Volcano ARK" : "OneAPI"}</dd>
              </div>
              <div className="ab-card-kv-row">
                <dt>Endpoint</dt>
                <Tooltip title={endpointUrl(m.provider)}><dd>{endpointUrl(m.provider)}</dd></Tooltip>
              </div>
              <div className="ab-card-kv-row">
                <dt>API Key</dt>
                <dd><code className="ab-key-mask">{maskKey(m.provider)}</code></dd>
              </div>
              {m.capabilities?.contextWindow && (
                <div className="ab-card-kv-row">
                  <dt>{t("agent.card.contextWindow")}</dt>
                  <dd>{(m.capabilities.contextWindow / 1000).toFixed(0)}K tokens</dd>
                </div>
              )}
              <div className="ab-card-kv-row">
                <dt>{t("agent.card.capabilities")}</dt>
                <dd>{[m.capabilities?.thinking && "Thinking", m.capabilities?.toolUse && "Tool Use"].filter(Boolean).join(", ") || "—"}</dd>
              </div>
              {m.specialty && (
                <div className="ab-card-kv-row">
                  <dt>{t("agent.card.specialty")}</dt>
                  <dd>{m.specialty}</dd>
                </div>
              )}
              {m.strengths && m.strengths.length > 0 && (
                <div className="ab-card-kv-row">
                  <dt>Strengths</dt>
                  <Tooltip title={m.strengths.join(", ")}><dd>{m.strengths.join(", ")}</dd></Tooltip>
                </div>
              )}
            </dl>
          </div>
        ))}
      </CardGrid>
    </div>
  );
}
