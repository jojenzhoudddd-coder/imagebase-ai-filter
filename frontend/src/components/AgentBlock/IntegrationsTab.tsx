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

请优先使用官方 preset；Lark/飞书走官方 lark-cli，Figma 可走本地 MCP，GitHub 默认走 gh CLI。涉及写操作或危险命令时需要显式确认。`;

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

function TestConnectionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M6 2C6.55223 2.00007 7 2.44776 7 3C7 3.55224 6.55223 3.99993 6 4H4.09082C4.04064 4 4.00005 4.04065 4 4.09082V9C4 11.7614 6.23858 14 9 14C11.7614 13.9999 14 11.7614 14 9V4.09082C14 4.04072 13.9593 4.00011 13.9092 4H12C11.4477 4 11 3.55228 11 3C11 2.44772 11.4477 2 12 2H13.9092C15.0638 2.00011 16 2.93615 16 4.09082V9C16 12.5273 13.3906 15.4455 9.99707 15.9297C9.99869 15.9529 10 15.9764 10 16C10 18.4037 11.564 19.9998 13.0996 20H13.6582C15.0843 20 16.4642 18.9018 17.0479 17.0791C17.2165 16.5535 17.7789 16.2643 18.3047 16.4326C18.8306 16.601 19.1206 17.1635 18.9521 17.6895C18.1804 20.0993 16.1828 22 13.6582 22H13.0996C10.1067 21.9998 8 19.1189 8 16C8 15.9764 8.00034 15.9529 8.00195 15.9297C4.60863 15.4454 2 12.5272 2 9V4.09082C2.00005 2.93608 2.93607 2 4.09082 2H6Z" fill="currentColor"/>
      <path d="M20 8C20.1105 8 20.1994 8.08989 20.2051 8.2002C20.3057 10.1395 21.8605 11.6943 23.7998 11.7949C23.9101 11.8006 24 11.8895 24 12C24 12.1105 23.9101 12.1994 23.7998 12.2051C21.8605 12.3057 20.3057 13.8605 20.2051 15.7998C20.1994 15.9101 20.1105 16 20 16C19.8895 16 19.8006 15.9101 19.7949 15.7998C19.6943 13.8605 18.1395 12.3057 16.2002 12.2051C16.0899 12.1994 16 12.1105 16 12C16 11.8895 16.0899 11.8006 16.2002 11.7949C18.1395 11.6943 19.6943 10.1395 19.7949 8.2002C19.8006 8.08989 19.8895 8 20 8Z" fill="currentColor"/>
    </svg>
  );
}

function ConfigureIntegrationIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M3.6 1.5C2.4402 1.5 1.5 2.4402 1.5 3.6V20.4C1.5 21.5598 2.4402 22.5 3.6 22.5H12V20.4H3.6V3.6H20.4V12H22.5V3.6C22.5 2.4402 21.5598 1.5 20.4 1.5H3.6Z" fill="currentColor"/>
      <path d="M7.25037 10.0299C7.25037 10.5822 7.69809 11.0299 8.25037 11.0299C8.80266 11.0299 9.25037 10.5822 9.25037 10.0299V9.23013H10.0302C10.5825 9.23013 11.0302 8.78241 11.0302 8.23013C11.0302 7.67784 10.5825 7.23013 10.0302 7.23013H9.25037V6.42993C9.25037 5.87765 8.80266 5.42993 8.25037 5.42993C7.69809 5.42993 7.25037 5.87765 7.25037 6.42993V7.23013H6.43018C5.87789 7.23013 5.43018 7.67784 5.43018 8.23013C5.43018 8.78241 5.87789 9.23013 6.43018 9.23013H7.25037V10.0299Z" fill="currentColor"/>
      <path d="M10.3637 15.0472C10.7542 14.6567 10.7542 14.0235 10.3637 13.633C9.97313 13.2425 9.33997 13.2425 8.94945 13.633L8.24228 14.3401L7.53527 13.6331C7.14474 13.2426 6.51158 13.2426 6.12105 13.6331C5.73053 14.0237 5.73053 14.6568 6.12105 15.0473L6.82807 15.7544L6.12102 16.4614C5.73049 16.8519 5.73049 17.4851 6.12102 17.8756C6.51154 18.2661 7.14471 18.2661 7.53523 17.8756L8.24228 17.1686L8.94948 17.8758C9.34 18.2663 9.97317 18.2663 10.3637 17.8758C10.7542 17.4852 10.7542 16.8521 10.3637 16.4616L9.65649 15.7544L10.3637 15.0472Z" fill="currentColor"/>
      <path d="M14 7.22998C13.4477 7.22998 13 7.6777 13 8.22998C13 8.78227 13.4477 9.22998 14 9.22998H17.57C18.1223 9.22998 18.57 8.78227 18.57 8.22998C18.57 7.6777 18.1223 7.22998 17.57 7.22998H14Z" fill="currentColor"/>
      <path d="M14.7024 20.4599C14.8194 20.6177 15.0147 20.693 15.21 20.6716L15.9374 20.592C16.1411 20.5697 16.3468 20.613 16.5242 20.7156C16.7017 20.8183 16.8418 20.9749 16.924 21.1627L17.2675 21.9459C17.343 22.118 17.4954 22.2466 17.681 22.2762C18.1154 22.3455 18.5575 22.3522 18.9937 22.296C19.1861 22.2713 19.3455 22.1404 19.4233 21.9627L19.7738 21.1627C19.8561 20.9749 19.9961 20.8183 20.1736 20.7156C20.3511 20.613 20.5567 20.5697 20.7605 20.592L21.5917 20.6829C21.7863 20.7042 21.981 20.6295 22.0981 20.4726C22.3694 20.109 22.5864 19.7078 22.7421 19.2816C22.8054 19.1085 22.7702 18.9166 22.6618 18.7676L22.1787 18.1036C22.0589 17.939 21.9944 17.7407 21.9944 17.5371C21.9944 17.3336 22.0589 17.1352 22.1787 16.9707L22.5956 16.3975C22.709 16.2416 22.7418 16.0393 22.6678 15.8613C22.4755 15.3989 22.2101 14.9703 21.8817 14.5921C21.7627 14.455 21.5814 14.3924 21.4009 14.4122L20.7609 14.4822C20.5571 14.5046 20.3515 14.4613 20.174 14.3586C19.9966 14.256 19.8565 14.0993 19.7742 13.9116L19.5446 13.3878C19.469 13.2155 19.3165 13.0868 19.1307 13.0573C18.8942 13.0197 18.6518 13 18.4049 13C18.1151 12.9999 17.8262 13.0272 17.542 13.0814C17.3631 13.1156 17.2178 13.2419 17.1447 13.4088L16.9245 13.9116C16.8422 14.0993 16.7021 14.256 16.5247 14.3586C16.3472 14.4613 16.1416 14.5046 15.9378 14.4822L15.3994 14.4234C15.2183 14.4036 15.0363 14.4667 14.9174 14.6047C14.5676 15.0103 14.2902 15.4731 14.0973 15.9727C14.0296 16.148 14.0639 16.3443 14.1745 16.4962L14.5196 16.9702C14.7654 17.308 14.7654 17.7658 14.5196 18.1036L14.1116 18.6642C14.0062 18.8091 13.9698 18.9947 14.0268 19.1645C14.1827 19.6292 14.4107 20.0663 14.7024 20.4599ZM19.9454 17.6667C19.9454 18.5258 19.2556 19.2222 18.4049 19.2222C17.5542 19.2222 16.8645 18.5258 16.8645 17.6667C16.8645 16.8076 17.5542 16.1111 18.4049 16.1111C19.256 16.1111 19.9454 16.8076 19.9454 17.6667Z" fill="currentColor"/>
    </svg>
  );
}

export default function IntegrationsTab({ agentId, blockId }: Props) {
  const { t } = useTranslation();
  const { workspaceId, preferences } = useAuth();
  const timezone = preferences.timezone ?? "Asia/Shanghai";
  const { addBlock, patchBlockState } = useCanvas();
  const toast = useToast();

  const [integrations, setIntegrations] = useState<AgentIntegrationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const integrationData = await listAgentIntegrations(agentId);
    setIntegrations(integrationData.integrations);
    setLoadError(false);
  }, [agentId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    setIntegrations([]);
    listAgentIntegrations(agentId)
      .then((integrationData) => {
        if (!active) return;
        setIntegrations(integrationData.integrations);
        setLoadError(false);
      })
      .catch(() => {
        if (!active) return;
        setIntegrations([]);
        setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  const refreshIntegrations = useCallback(() => {
    void reload().catch(() => setLoadError(true));
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

      {loadError && integrations.length === 0 ? (
        <div className="ab-empty">{t("agent.block.integrationsLoadFailed")}</div>
      ) : integrations.length === 0 ? (
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
                    actions={[
                      {
                        key: "test",
                        label: testingId === integration.id ? t("agent.integrations.testing") : t("agent.integrations.test"),
                        icon: <TestConnectionIcon />,
                        disabled: testingId === integration.id,
                        onSelect: () => handleTest(integration),
                      },
                      {
                        key: "configure",
                        label: t("agent.integrations.configureByChat"),
                        icon: <ConfigureIntegrationIcon />,
                        onSelect: () => openChat(configurePrompt(integration)),
                      },
                    ]}
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
            </div>
            );
          })}
        </CardGrid>
      )}
    </div>
  );
}
