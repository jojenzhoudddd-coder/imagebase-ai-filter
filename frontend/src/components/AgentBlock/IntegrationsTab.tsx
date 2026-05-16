/**
 * IntegrationsTab - manage Agent MCP/CLI integrations.
 *
 * The low-level manifest and credential editing is intentionally routed
 * through chat so the agent can scaffold provider-specific setup and use
 * the integration management MCP tools.
 */

import { useCallback, useEffect, useState } from "react";
import {
  type AgentIntegrationSummary,
  createConversation,
  deleteIntegration,
  listAgentIntegrations,
  testAgentIntegration,
  toggleIntegration,
} from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { useCanvas } from "../../contexts/canvasContext";
import type { SystemBlockState } from "../../canvas/types";
import { useTranslation } from "../../i18n";
import { useToast } from "../Toast/index";
import Tooltip from "../Tooltip";
import CardGrid from "./CardGrid";
import CardMoreMenu from "./CardMoreMenu";
import { useAgentHomeRefresh } from "./agentHomeEvents";

interface Props {
  agentId: string;
  blockId: string;
}

const ADD_INTEGRATION_PROMPT = `我想添加一个新的 agent integration。请先判断适合 MCP 还是 CLI，然后引导我完成配置，并用 integration 管理工具创建或更新集成。

我需要你收集：
1. 第三方平台或 CLI 名称
2. 传输方式：mcp-stdio / mcp-http / cli
3. 鉴权方式和环境变量名
4. 可暴露给 Agent 的工具清单、参数 schema、是否只读
5. 测试命令或 MCP list_tools / call_tool 验证方式

请优先使用 MCP；只有平台没有稳定 MCP 或本地 CLI 更合适时才用 CLI。涉及写操作或危险命令时需要显式确认。`;

function configurePrompt(integration: AgentIntegrationSummary): string {
  return `请帮我配置这个 agent integration：
- integrationId: ${integration.id}
- provider: ${integration.providerKey}
- displayName: ${integration.displayName}
- transport: ${integration.transport}

请检查它的 config、credentials 和 toolManifest 是否完整；如果缺少凭证或 CLI/MCP 启动参数，请向我提问。配置完成后调用 test_integration 验证，并避免在回复里明文展示 token 或 secret。`;
}

function formatDate(ts: string | null, timezone: string): string {
  if (!ts) return "-";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function isOfficialProvider(providerKey: string): boolean {
  return providerKey === "github" || providerKey === "lark" || providerKey === "figma";
}

function statusClass(status: AgentIntegrationSummary["status"]): string {
  if (status === "healthy") return "ab-card-state-success";
  if (status === "error") return "ab-card-state-danger";
  return "ab-card-state-current";
}

function providerStatusKey(status: AgentIntegrationSummary["status"]): string {
  return `agent.integrations.status.${status}`;
}

function toolNames(integration: AgentIntegrationSummary): string {
  if (integration.toolManifest.length === 0) return "-";
  return integration.toolManifest.map((tool) => tool.name).join(", ");
}

function credentialPreview(integration: AgentIntegrationSummary): string {
  if (integration.credentials.length === 0) return "-";
  return integration.credentials
    .map((credential) => `${credential.name}: ${credential.valuePreview || "***"}`)
    .join(", ");
}

export default function IntegrationsTab({ agentId, blockId }: Props) {
  const { t } = useTranslation();
  const { workspaceId, preferences } = useAuth();
  const timezone = preferences.timezone ?? "Asia/Shanghai";
  const { addBlock, patchBlockState } = useCanvas();
  const toast = useToast();

  const [integrations, setIntegrations] = useState<AgentIntegrationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const integrationData = await listAgentIntegrations(agentId);
    setIntegrations(integrationData.integrations);
  }, [agentId]);

  useEffect(() => {
    reload()
      .catch(() => {
        setIntegrations([]);
      })
      .finally(() => setLoading(false));
  }, [reload]);

  const refreshIntegrations = useCallback(() => {
    void reload().catch(() => setIntegrations([]));
  }, [reload]);

  useAgentHomeRefresh(agentId, refreshIntegrations);

  const openChat = useCallback(async (prompt: string) => {
    if (!workspaceId) return;
    try {
      const conv = await createConversation(workspaceId, agentId || undefined);
      addBlock("chat", { conversationId: conv.id, prefillMessage: prompt } as any);
    } catch {
      addBlock("chat", { prefillMessage: prompt } as any);
    }
  }, [addBlock, agentId, workspaceId]);

  const handleToggle = useCallback(async (integrationId: string, enabled: boolean) => {
    setIntegrations((prev) =>
      prev.map((integration) =>
        integration.id === integrationId
          ? {
              ...integration,
              enabled,
              status: integration.status === "disabled" ? "not_configured" : integration.status,
            }
          : integration,
      ),
    );
    try {
      const updated = await toggleIntegration(agentId, integrationId, enabled);
      setIntegrations((prev) =>
        prev.map((integration) => (integration.id === integrationId ? updated : integration)),
      );
      toast.success(enabled ? t("agent.toast.integrationEnabled") : t("agent.toast.integrationDisabled"));
    } catch {
      setIntegrations((prev) =>
        prev.map((integration) =>
          integration.id === integrationId ? { ...integration, enabled: !enabled } : integration,
        ),
      );
      toast.error(t("agent.toast.toggleFailed"));
    }
  }, [agentId, toast, t]);

  const handleDelete = useCallback(async (integrationId: string) => {
    const prev = integrations;
    setIntegrations((items) => items.filter((integration) => integration.id !== integrationId));
    try {
      await deleteIntegration(agentId, integrationId);
      toast.success(t("agent.toast.integrationDeleted"));
    } catch {
      setIntegrations(prev);
      toast.error(t("agent.toast.deleteFailed"));
    }
  }, [agentId, integrations, toast, t]);

  const handleTest = useCallback(async (integration: AgentIntegrationSummary) => {
    setTestingId(integration.id);
    try {
      const result = await testAgentIntegration(agentId, integration.id);
      setIntegrations((prev) =>
        prev.map((item) =>
          item.id === integration.id
            ? {
                ...item,
                status: result.ok ? "healthy" : "error",
                lastError: result.ok
                  ? null
                  : typeof (result.detail as any)?.error === "string"
                    ? (result.detail as any).error
                    : t("agent.integrations.testFailed"),
                lastHealthAt: new Date().toISOString(),
              }
            : item,
        ),
      );
      if (result.ok) {
        toast.success(t("agent.toast.integrationHealthy"));
      } else {
        toast.error(t("agent.toast.integrationTestFailed"));
      }
    } catch {
      toast.error(t("agent.toast.integrationTestFailed"));
    } finally {
      setTestingId(null);
    }
  }, [agentId, toast, t]);

  if (loading) return <div className="ab-loading">{t("agent.block.loading")}</div>;

  return (
    <div className="ab-integrations">
      <div className="ab-toolbar">
        <button className="ab-toolbar-btn" onClick={() => openChat(ADD_INTEGRATION_PROMPT)}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {t("agent.integrations.addByChat")}
        </button>
      </div>

      {integrations.length === 0 ? (
        <div className="ab-empty">{t("agent.block.noIntegrations")}</div>
      ) : (
        <CardGrid>
          {integrations.map((integration) => {
            const official = isOfficialProvider(integration.providerKey);
            const showError = integration.enabled && integration.status === "error" && Boolean(integration.lastError);
            return (
            <div key={integration.id} className="ab-card">
              <div className="ab-card-head">
                <div className="ab-card-title-block">
                  <div className="ab-card-title-row">
                    <Tooltip title={integration.displayName}>
                      <h4 className="ab-card-title">{integration.displayName}</h4>
                    </Tooltip>
                    <span className={`ab-card-state ${official ? "ab-card-state-primary" : "ab-card-state-muted"}`}>
                      {official ? t("agent.card.official") : t("agent.card.custom")}
                    </span>
                    {integration.enabled && integration.status !== "disabled" && (
                      <span className={`ab-card-state ${statusClass(integration.status)}`}>
                        {t(providerStatusKey(integration.status))}
                      </span>
                    )}
                  </div>
                  {showError ? (
                    <Tooltip title={integration.lastError ?? undefined}>
                      <p className="ab-card-desc">{integration.lastError}</p>
                    </Tooltip>
                  ) : (
                    <p className="ab-card-desc">{t("agent.integrations.manifestSummary", { count: integration.toolManifest.length })}</p>
                  )}
                </div>
                <div className="ab-card-controls">
                  <button
                    className={`ab-switch${integration.enabled ? " ab-switch-on" : ""}`}
                    onClick={() => handleToggle(integration.id, !integration.enabled)}
                    aria-label="Toggle"
                  >
                    <span className="ab-switch-knob" />
                  </button>
                  <CardMoreMenu
                    onViewActivities={() => patchBlockState(blockId, { activeTab: "activities", activitiesSearch: integration.id } as SystemBlockState)}
                    label={t("agent.activities.viewActivities")}
                    onDelete={integration.providerKey === "custom-cli" ? () => handleDelete(integration.id) : undefined}
                  />
                </div>
              </div>
              <dl className="ab-card-kv">
                <div className="ab-card-kv-row">
                  <dt>{t("agent.integrations.transport")}</dt>
                  <dd>{integration.transport}</dd>
                </div>
                <div className="ab-card-kv-row">
                  <dt>{t("agent.integrations.tools")}</dt>
                  <Tooltip title={toolNames(integration)}>
                    <dd>{toolNames(integration)}</dd>
                  </Tooltip>
                </div>
                <div className="ab-card-kv-row">
                  <dt>{t("agent.integrations.credentials")}</dt>
                  <Tooltip title={credentialPreview(integration)}>
                    <dd>{credentialPreview(integration)}</dd>
                  </Tooltip>
                </div>
                <div className="ab-card-kv-row">
                  <dt>{t("agent.card.lastUsed")}</dt>
                  <dd>{formatDate(integration.lastUsedAt, timezone)}</dd>
                </div>
              </dl>
              <div className="ab-card-actions">
                <button
                  className="ab-text-btn"
                  disabled={testingId === integration.id}
                  onClick={() => handleTest(integration)}
                >
                  {testingId === integration.id ? t("agent.integrations.testing") : t("agent.integrations.test")}
                </button>
                <button className="ab-text-btn" onClick={() => openChat(configurePrompt(integration))}>
                  {t("agent.integrations.configureByChat")}
                </button>
              </div>
            </div>
            );
          })}
        </CardGrid>
      )}
    </div>
  );
}
