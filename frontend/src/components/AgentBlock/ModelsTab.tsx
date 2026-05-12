/**
 * ModelsTab — displays all configured models as entity cards.
 * Shows "Current" badge on the agent's selected model.
 * Toolbar with "Add model" button opens a chat block with pre-filled prompt.
 */

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useCanvas } from "../../contexts/canvasContext";
import type { SystemBlockState } from "../../canvas/types";
import Tooltip from "../Tooltip";
import CardMoreMenu from "./CardMoreMenu";
import {
  listModels,
  getAgentModel,
  createConversation,
  deleteCustomModel,
  type AgentModelSelection,
} from "../../api";
import { useTranslation } from "../../i18n";
import { useToast } from "../Toast/index";
import CardGrid from "./CardGrid";

interface ModelSummary {
  id: string;
  dbId?: string;
  displayName: string;
  provider: string;
  group: string;
  available: boolean;
  capabilities?: { thinking?: boolean; toolUse?: boolean; contextWindow?: number };
  specialty?: string;
  strengths?: string[];
  costHint?: string;
  type?: "builtin" | "custom";
}

function maskKey(provider: string): string {
  if (provider === "ark") return "sk-****…vwdh7";
  return "sk-****…nT4C";
}

function endpointUrl(provider: string): string {
  if (provider === "ark") return "https://ark.cn-beijing.volces.com/api/v3";
  return "https://oneapi.iline.work/v1";
}

function providerLabel(m: ModelSummary): string {
  if (m.type === "custom") return m.provider;
  if (m.provider === "ark") return "Volcano ARK";
  return "OneAPI";
}

const ADD_MODEL_PROMPT = `我想添加一个新的 AI 模型到我的模型列表。请引导我完成配置，我需要提供：
1. 模型显示名称
2. Provider 类型（OpenAI-compatible / Anthropic / 其他）
3. API Base URL
4. API Key
5. Provider 的 Model ID（实际请求时用的名称）
6. 模型能力（是否支持 thinking、tool use、上下文窗口大小）

请一步步引导我。`;

export default function ModelsTab({ blockId }: { blockId?: string }) {
  const { t } = useTranslation();
  const { workspaceId, agentId } = useAuth();
  const { addBlock, patchBlockState } = useCanvas();
  const toast = useToast();
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

  // Listen for model selection changes from chat blocks
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

  // Listen for custom model CRUD (add/remove via chat) and refetch list
  useEffect(() => {
    const handler = () => {
      listModels()
        .then((data) => setModels(data.models))
        .catch(() => {});
    };
    window.addEventListener("custom-models-changed", handler);
    return () => window.removeEventListener("custom-models-changed", handler);
  }, []);

  const handleDeleteModel = useCallback(async (modelId: string, dbId: string) => {
    const prev = models;
    setModels((m) => m.filter((x) => x.id !== modelId));
    try {
      await deleteCustomModel(dbId);
      toast.success(t("agent.toast.modelDeleted"));
      window.dispatchEvent(new CustomEvent("custom-models-changed"));
    } catch {
      setModels(prev);
      toast.error(t("agent.toast.deleteFailed"));
    }
  }, [models, toast, t]);

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
                    <span className="ab-card-state ab-card-state-current">
                      <span className="ab-card-state-dot" />
                      Current
                    </span>
                  )}
                  <span className={`ab-card-state ${m.available ? "ab-card-state-success" : "ab-card-state-muted"}`}>
                    <span className="ab-card-state-dot" />
                    {m.available ? "Available" : "Offline"}
                  </span>
                  <span className={`ab-card-state ${m.type === "custom" ? "ab-card-state-custom" : "ab-card-state-official"}`}>
                    {m.type === "custom" ? "Custom" : "Official"}
                  </span>
                </div>
                <Tooltip title={m.id}><p className="ab-card-desc">{m.id}</p></Tooltip>
              </div>
              <div className="ab-card-controls">
                {blockId && (
                  <CardMoreMenu
                    onViewActivities={() => patchBlockState(blockId, { activeTab: "activities", activitiesSearch: m.id } as SystemBlockState)}
                    label={t("agent.activities.viewActivities")}
                    onDelete={m.type === "custom" && m.dbId ? () => handleDeleteModel(m.id, m.dbId!) : undefined}
                  />
                )}
              </div>
            </div>
            <dl className="ab-card-kv ab-card-kv-2col">
              <div className="ab-card-kv-row">
                <dt>{t("agent.card.provider")}</dt>
                <dd>{providerLabel(m)}</dd>
              </div>
              <div className="ab-card-kv-row">
                <dt>Endpoint</dt>
                <Tooltip title={endpointUrl(m.provider)}><dd>{endpointUrl(m.provider)}</dd></Tooltip>
              </div>
              <div className="ab-card-kv-row">
                <dt>API Key</dt>
                <dd><code className="ab-key-mask">{maskKey(m.provider)}</code></dd>
              </div>
              <div className="ab-card-kv-row">
                <dt>{t("agent.card.contextWindow")}</dt>
                <dd>{m.capabilities?.contextWindow ? `${(m.capabilities.contextWindow / 1000).toFixed(0)}K tokens` : "—"}</dd>
              </div>
              <div className="ab-card-kv-row">
                <dt>{t("agent.card.capabilities")}</dt>
                <dd>{[m.capabilities?.thinking && "Thinking", m.capabilities?.toolUse && "Tool Use"].filter(Boolean).join(", ") || "—"}</dd>
              </div>
              <div className="ab-card-kv-row">
                <dt>{t("agent.card.specialty")}</dt>
                <dd>{m.specialty || "—"}</dd>
              </div>
              <div className="ab-card-kv-row">
                <dt>Strengths</dt>
                <dd>{m.strengths && m.strengths.length > 0 ? (
                  <Tooltip title={m.strengths.join(", ")}><span>{m.strengths.join(", ")}</span></Tooltip>
                ) : "—"}</dd>
              </div>
            </dl>
          </div>
        ))}
      </CardGrid>
    </div>
  );
}
