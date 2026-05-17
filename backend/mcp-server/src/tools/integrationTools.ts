/**
 * Integration management tools — install and operate MCP/CLI bridges.
 *
 * Runtime tools generated from enabled integrations live in dynamic
 * SkillDefinitions (`loadIntegrationSkills`). These tools are the scaffold
 * and management layer the Agent can always reach after activating
 * `integration-skill`.
 */

import {
  createAgentIntegration,
  deleteAgentIntegration,
  ensureSystemIntegrations,
  listAgentIntegrations,
  updateAgentIntegration,
  IntegrationNotFoundError,
  IntegrationValidationError,
} from "../../../src/services/integrations/integrationStore.js";
import { callIntegrationTool, testIntegration } from "../../../src/services/integrations/integrationRuntime.js";
import { pollLarkAuth, startLarkAuth } from "../../../src/services/integrations/larkAuthRuntime.js";
import { listIntegrationPresets } from "../../../src/services/integrations/providerCatalog.js";
import { confirmationRequired } from "../dataStoreClient.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

const DEFAULT_AGENT_ID = "agent_default";

function resolveAgentId(args: Record<string, any>, ctx?: ToolContext): string {
  if (typeof args.agentId === "string" && args.agentId.trim()) return args.agentId.trim();
  return ctx?.agentId || DEFAULT_AGENT_ID;
}

function errJson(err: unknown): string {
  if (err instanceof IntegrationValidationError) {
    return JSON.stringify({ ok: false, code: "VALIDATION", field: err.field, error: err.message });
  }
  if (err instanceof IntegrationNotFoundError) {
    return JSON.stringify({ ok: false, code: "NOT_FOUND", error: err.message });
  }
  return JSON.stringify({
    ok: false,
    code: "INTERNAL",
    error: err instanceof Error ? err.message : String(err),
  });
}

export const integrationTools: ToolDefinition[] = [
  {
    name: "list_integration_presets",
    description:
      "列出内置 Integration preset：GitHub、Lark/飞书、Figma、自定义 CLI。用于引导用户选择 MCP 或 CLI 接入方式。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => JSON.stringify({ ok: true, presets: listIntegrationPresets() }),
  },
  {
    name: "list_integrations",
    description:
      "列出当前 Agent 已安装的第三方集成，包含 provider、transport、enabled、status、工具摘要和已保存 credential 名称（不返回密钥明文）。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；默认当前 Agent" },
      },
    },
    handler: async (args, ctx) => {
      try {
        const agentId = resolveAgentId(args, ctx);
        await ensureSystemIntegrations(agentId);
        const integrations = await listAgentIntegrations(agentId);
        return JSON.stringify({ ok: true, integrations });
      } catch (err) {
        return errJson(err);
      }
    },
  },
  {
    name: "create_integration",
    description:
      "安装一个新的第三方 Integration。支持 providerKey=github/lark/figma/custom-cli，transport=mcp-stdio/mcp-http/cli。可传 config、toolManifest 和 credentials。credentials 会加密存储且不会回显。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；默认当前 Agent" },
        providerKey: { type: "string", description: "github | lark | figma | custom-cli" },
        displayName: { type: "string" },
        transport: { type: "string", enum: ["mcp-stdio", "mcp-http", "cli"] },
        enabled: { type: "boolean" },
        config: { type: "object", description: "transport 配置，如 command/args/endpoint/envMap" },
        toolManifest: { type: "array", items: { type: "object" }, description: "显式工具白名单 manifest" },
        scopes: { type: "array", items: { type: "string" } },
        credentials: { type: "object", description: "密钥键值，如 GITHUB_TOKEN/LARK_APP_SECRET/FIGMA_TOKEN" },
      },
      required: ["providerKey"],
    },
    handler: async (args, ctx) => {
      try {
        const integration = await createAgentIntegration({
          agentId: resolveAgentId(args, ctx),
          providerKey: String(args.providerKey ?? ""),
          displayName: typeof args.displayName === "string" ? args.displayName : undefined,
          transport: args.transport as any,
          enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
          config: args.config as any,
          toolManifest: args.toolManifest as any,
          scopes: args.scopes as any,
          credentials: args.credentials as any,
        });
        return JSON.stringify({
          ok: true,
          integration,
          note: `已安装。可 activate_skill("${`integration-${integration.id}`}") 立即调用该集成工具。`,
        });
      } catch (err) {
        return errJson(err);
      }
    },
  },
  {
    name: "update_integration",
    description:
      "更新一个已安装 Integration 的配置、工具 manifest、credential、enabled 状态或展示名。只传需要修改的字段。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；权限校验用" },
        integrationId: { type: "string" },
        displayName: { type: "string" },
        transport: { type: "string", enum: ["mcp-stdio", "mcp-http", "cli"] },
        enabled: { type: "boolean" },
        config: { type: "object" },
        toolManifest: { type: "array", items: { type: "object" } },
        scopes: { type: "array", items: { type: "string" } },
        credentials: { type: "object" },
      },
      required: ["integrationId"],
    },
    handler: async (args, ctx) => {
      try {
        const integrationId = String(args.integrationId ?? "");
        const patch: Record<string, unknown> = {};
        for (const key of ["displayName", "transport", "enabled", "config", "toolManifest", "scopes", "credentials"]) {
          if (key in args) patch[key] = args[key];
        }
        const integration = await updateAgentIntegration(integrationId, patch as any, {
          requireAgentId: resolveAgentId(args, ctx),
        });
        return JSON.stringify({ ok: true, integration });
      } catch (err) {
        return errJson(err);
      }
    },
  },
  {
    name: "delete_integration",
    danger: true,
    description:
      "⚠️ 删除一个 Integration 及其加密凭据。不可撤销。只是临时停用时请用 update_integration({enabled:false})。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；权限校验用" },
        integrationId: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["integrationId"],
    },
    handler: async (args, ctx) => {
      const integrationId = String(args.integrationId ?? "");
      if (!args.confirmed) {
        return confirmationRequired(
          "delete_integration",
          { integrationId, agentId: args.agentId },
          `即将删除第三方集成 ${integrationId} 及其加密凭据，此操作不可撤销。`,
        );
      }
      try {
        const ok = await deleteAgentIntegration(integrationId, {
          requireAgentId: resolveAgentId(args, ctx),
        });
        return JSON.stringify({ ok, deletedIntegrationId: integrationId });
      } catch (err) {
        return errJson(err);
      }
    },
  },
  {
    name: "test_integration",
    description:
      "测试 Integration 连通性。MCP transport 会 listTools；CLI transport 会运行健康检查。Lark CLI 会返回 needsConfig/needsAuth，用于触发授权流程。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；权限校验用" },
        integrationId: { type: "string" },
      },
      required: ["integrationId"],
    },
    handler: async (args, ctx) => {
      try {
        const result = await testIntegration(String(args.integrationId ?? ""), {
          requireAgentId: resolveAgentId(args, ctx),
        });
        return JSON.stringify(result);
      } catch (err) {
        return errJson(err);
      }
    },
  },
  {
    name: "start_lark_auth",
    description:
      "为 Lark CLI integration 启动用户授权流程。返回 verificationUrl/userCode/authSessionId；Agent 必须把 URL/code 发给用户，再等待用户完成授权。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；权限校验用" },
        integrationId: { type: "string" },
        recommend: {
          type: "boolean",
          description: "是否使用 lark-cli --recommend 推荐权限；默认 true",
        },
        domains: {
          type: "array",
          items: { type: "string" },
          description: "可选；传给 lark-cli auth login --domain 的 domain 列表",
        },
        scope: {
          type: "string",
          description: "可选；显式 OAuth scope，留空时依赖 recommend/domains",
        },
      },
      required: ["integrationId"],
    },
    handler: async (args, ctx) => {
      try {
        const result = await startLarkAuth(String(args.integrationId ?? ""), {
          requireAgentId: resolveAgentId(args, ctx),
          recommend: typeof args.recommend === "boolean" ? args.recommend : undefined,
          domains: Array.isArray(args.domains) ? args.domains.map(String) : undefined,
          scope: typeof args.scope === "string" && args.scope.trim() ? args.scope.trim() : undefined,
        });
        return JSON.stringify(result);
      } catch (err) {
        return errJson(err);
      }
    },
  },
  {
    name: "poll_lark_auth",
    description:
      "用户完成 Lark 授权后，用 authSessionId 轮询并落盘 lark-cli 登录状态。成功后 integration health 会变为 healthy。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；权限校验用" },
        authSessionId: { type: "string" },
      },
      required: ["authSessionId"],
    },
    handler: async (args, ctx) => {
      try {
        const result = await pollLarkAuth(String(args.authSessionId ?? ""), {
          requireAgentId: resolveAgentId(args, ctx),
        });
        return JSON.stringify(result);
      } catch (err) {
        return errJson(err);
      }
    },
  },
  {
    name: "call_integration_tool",
    description:
      "通过 integrationId + toolName 调用一个已安装 Integration 的工具。更推荐使用激活 integration skill 后出现的具名工具；本工具用于调试或动态路由。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；权限校验用" },
        integrationId: { type: "string" },
        toolName: { type: "string", description: "Integration manifest 中的 tool.name" },
        arguments: { type: "object", description: "传给工具的参数" },
      },
      required: ["integrationId", "toolName"],
    },
    handler: async (args, ctx) => {
      try {
        const result = await callIntegrationTool(
          String(args.integrationId ?? ""),
          String(args.toolName ?? ""),
          (args.arguments && typeof args.arguments === "object" ? args.arguments : {}) as any,
          { requireAgentId: resolveAgentId(args, ctx) },
        );
        return JSON.stringify({ ok: true, result });
      } catch (err) {
        return errJson(err);
      }
    },
  },
  {
    name: "inspect_cli_help",
    danger: true,
    description:
      "⚠️ 为创建 custom-cli 集成读取某个本地 CLI 的 help 输出。只用 execFile 直接执行二进制，不走 shell；仍需用户确认，因为它会运行本机命令。",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "CLI 二进制名或绝对路径，例如 gh / linear / lark" },
        args: { type: "array", items: { type: "string" }, description: "默认 ['--help']" },
        confirmed: { type: "boolean" },
      },
      required: ["command"],
    },
    handler: async (args) => {
      if (!args.confirmed) {
        return confirmationRequired(
          "inspect_cli_help",
          { command: args.command, args: args.args },
          `即将运行本机 CLI "${String(args.command)}" 读取帮助信息。`,
        );
      }
      try {
        const { runCliIntegrationTool } = await import("../../../src/services/integrations/cliRuntime.js");
        const output = await runCliIntegrationTool(
          {
            id: "__inspect__",
            agentId: DEFAULT_AGENT_ID,
            providerKey: "custom-cli",
            displayName: String(args.command),
            transport: "cli",
            enabled: true,
            status: "healthy",
            lastError: null,
            config: { command: String(args.command) },
            toolManifest: [],
            scopes: [],
            lastHealthAt: null,
            lastUsedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            credentials: [],
          },
          {
            name: "help",
            description: "inspect help",
            mode: "cli",
            readOnly: true,
            output: "text",
            args: Array.isArray(args.args) ? args.args.map(String) : ["--help"],
          },
          {},
        );
        return JSON.stringify({ ok: true, output });
      } catch (err) {
        return errJson(err);
      }
    },
  },
];
