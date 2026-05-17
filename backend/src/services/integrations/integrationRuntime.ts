import crypto from "crypto";
import { runCliCommand, runCliIntegrationTool } from "./cliRuntime.js";
import {
  resolveIntegrationRuntimeEnv,
  withIntegrationMutex,
} from "./integrationRuntimeEnv.js";
import { callMcpIntegrationTool, listMcpTools } from "./mcpRuntime.js";
import {
  getAgentIntegration,
  markIntegrationHealth,
  markIntegrationUsed,
} from "./integrationStore.js";
import { startIntegrationAuth } from "./integrationAuthRuntime.js";
import { getGithubAuthStatus } from "./githubAuthRuntime.js";
import { getGithubCliGuide } from "./githubCliGuide.js";
import { getLarkAuthStatus } from "./larkAuthRuntime.js";
import { getLarkCliGuide } from "./larkCliGuide.js";
import type { AgentIntegrationRow, IntegrationToolManifest } from "./types.js";
import {
  extractToolOutputError,
  normalizeError,
  summarizeForLog,
  writeErrorLog,
} from "../errorLogService.js";

export async function callIntegrationTool(
  integrationId: string,
  toolName: string,
  args: Record<string, any>,
  opts?: { requireAgentId?: string },
): Promise<unknown> {
  const startedAt = Date.now();
  const integration = await getAgentIntegration(integrationId, {
    requireAgentId: opts?.requireAgentId,
  });
  if (!integration) {
    const err = new Error(`integration not found: ${integrationId}`);
    logIntegrationToolError("integration_tool_config_error", {
      integrationId,
      toolName,
      args,
      durationMs: Date.now() - startedAt,
      error: err,
      agentId: opts?.requireAgentId,
    });
    throw err;
  }
  if (!integration.enabled) {
    const err = new Error(`integration is disabled: ${integration.displayName}`);
    logIntegrationToolError("integration_tool_config_error", {
      integration,
      toolName,
      args,
      durationMs: Date.now() - startedAt,
      error: err,
      agentId: opts?.requireAgentId,
    });
    throw err;
  }
  const manifest = integration.toolManifest.find((t) => t.name === toolName);
  if (!manifest) {
    const err = new Error(`unknown integration tool: ${toolName}`);
    logIntegrationToolError("integration_tool_unknown", {
      integration,
      toolName,
      args,
      durationMs: Date.now() - startedAt,
      error: err,
      agentId: opts?.requireAgentId,
    });
    throw err;
  }
  let result: unknown;
  try {
    result = await dispatch(integration, manifest, args);
  } catch (err) {
    const message = errorMessage(err);
    const missingScopes = integration.providerKey === "lark" && integration.transport === "cli"
      ? parseLarkMissingScopes(message)
      : [];
    if (missingScopes.length) {
      await markIntegrationUsed(integration.id).catch(() => {});
      const response = larkMissingScopeResponse(integration, manifest.name, message, missingScopes);
      logIntegrationToolResultError("integration_tool_result_error", {
        integration,
        manifest,
        args,
        durationMs: Date.now() - startedAt,
        message: String(response.message ?? "Missing Lark OAuth scope(s)"),
        result: response,
        agentId: opts?.requireAgentId,
      });
      return response;
    }
    const githubMissingScopes = integration.providerKey === "github" && integration.transport === "cli"
      ? parseGithubMissingScopes(message)
      : [];
    if (githubMissingScopes.length) {
      await markIntegrationUsed(integration.id).catch(() => {});
      const response = githubMissingScopeResponse(integration, manifest.name, message, githubMissingScopes);
      logIntegrationToolResultError("integration_tool_result_error", {
        integration,
        manifest,
        args,
        durationMs: Date.now() - startedAt,
        message: String(response.message ?? "Missing GitHub OAuth scope(s)"),
        result: response,
        agentId: opts?.requireAgentId,
      });
      return response;
    }
    if (
      integration.providerKey === "github" &&
      integration.transport === "cli" &&
      parseGithubAuthFailure(message)
    ) {
      await markIntegrationUsed(integration.id).catch(() => {});
      return startIntegrationAuth(integration.id, {
        requireAgentId: opts?.requireAgentId,
      });
    }
    logIntegrationToolError("integration_tool_error", {
      integration,
      manifest,
      args,
      durationMs: Date.now() - startedAt,
      error: err,
      agentId: opts?.requireAgentId,
    });
    throw err;
  }
  const larkAuthFailure = integration.providerKey === "lark" && integration.transport === "cli"
    ? parseLarkAuthFailureResult(result)
    : null;
  if (larkAuthFailure) {
    await markIntegrationUsed(integration.id).catch(() => {});
    const response = await startIntegrationAuth(integration.id, {
      requireAgentId: opts?.requireAgentId,
      scope: larkAuthFailure.missingScopes.length ? larkAuthFailure.missingScopes.join(" ") : undefined,
      recommend: larkAuthFailure.missingScopes.length ? false : undefined,
    });
    logIntegrationToolResultError("integration_tool_result_error", {
      integration,
      manifest,
      args,
      durationMs: Date.now() - startedAt,
      message: larkAuthFailure.missingScopes.length
        ? `missing Lark OAuth scope(s): ${larkAuthFailure.missingScopes.join(" ")}`
        : "Lark auth required",
      result,
      agentId: opts?.requireAgentId,
    });
    return response;
  }
  await markIntegrationUsed(integration.id).catch(() => {});
  const reportedError = extractToolOutputError(result);
  if (reportedError) {
    logIntegrationToolResultError("integration_tool_result_error", {
      integration,
      manifest,
      args,
      durationMs: Date.now() - startedAt,
      message: reportedError,
      result,
      agentId: opts?.requireAgentId,
    });
  }
  return result;
}

function logIntegrationToolError(
  kind: string,
  params: {
    integration?: AgentIntegrationRow;
    manifest?: IntegrationToolManifest;
    integrationId?: string;
    toolName?: string;
    args: unknown;
    durationMs: number;
    error: unknown;
    agentId?: string;
  },
): void {
  writeErrorLog({
    scope: "integration",
    kind,
    level: "error",
    message: params.error instanceof Error ? params.error.message : String(params.error),
    agentId: params.agentId,
    durationMs: params.durationMs,
    integration: integrationLogMeta(params.integration, params.integrationId),
    tool: {
      name: params.manifest?.name ?? params.toolName,
      mode: params.manifest?.mode,
      args: summarizeForLog(params.args),
    },
    error: normalizeError(params.error),
  });
}

function logIntegrationToolResultError(
  kind: string,
  params: {
    integration: AgentIntegrationRow;
    manifest: IntegrationToolManifest;
    args: unknown;
    durationMs: number;
    message: string;
    result: unknown;
    agentId?: string;
  },
): void {
  writeErrorLog({
    scope: "integration",
    kind,
    level: "warning",
    message: params.message,
    agentId: params.agentId,
    durationMs: params.durationMs,
    integration: integrationLogMeta(params.integration),
    tool: {
      name: params.manifest.name,
      mode: params.manifest.mode,
      args: summarizeForLog(params.args),
    },
    result: summarizeForLog(params.result),
  });
}

function integrationLogMeta(integration?: AgentIntegrationRow, fallbackId?: string): Record<string, unknown> {
  if (!integration) return { id: fallbackId };
  return {
    id: integration.id,
    agentId: integration.agentId,
    providerKey: integration.providerKey,
    transport: integration.transport,
    displayName: integration.displayName,
  };
}

export async function testIntegration(integrationId: string, opts?: { requireAgentId?: string }): Promise<{
  ok: boolean;
  transport: string;
  detail: unknown;
  needsConfig?: boolean;
  needsAuth?: boolean;
}> {
  const startedAt = Date.now();
  const integration = await getAgentIntegration(integrationId, {
    requireAgentId: opts?.requireAgentId,
  });
  if (!integration) throw new Error(`integration not found: ${integrationId}`);
  try {
    if (integration.providerKey === "lark" && integration.transport === "cli") {
      const status = await getLarkAuthStatus(integration);
      return {
        ok: status.ok,
        transport: integration.transport,
        detail: status.detail,
        needsConfig: !status.configured,
        needsAuth: status.configured && !status.authorized,
      };
    }
    if (integration.providerKey === "github" && integration.transport === "cli") {
      const status = await getGithubAuthStatus(integration);
      return {
        ok: status.ok,
        transport: integration.transport,
        detail: status.detail,
        needsAuth: !status.authorized,
      };
    }
    if (integration.providerKey === "figma") {
      const restDetail = await testFigmaRest(integration);
      if (restDetail) {
        await markIntegrationHealth(integration.id, "healthy", null);
        return { ok: true, transport: integration.transport, detail: restDetail };
      }
    }
    let detail: unknown;
    if (integration.transport === "cli") {
      const tool = getCliHealthCheckTool(integration)
        ?? integration.toolManifest.find((t) => t.mode === "cli" && t.readOnly !== false)
        ?? integration.toolManifest.find((t) => t.mode === "cli");
      if (!tool) throw new Error("No CLI tool declared in manifest");
      detail = await runCliIntegrationTool(integration, tool, {});
    } else {
      detail = await listMcpTools(integration);
    }
    await markIntegrationHealth(integration.id, "healthy", null);
    return { ok: true, transport: integration.transport, detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeErrorLog({
      scope: "integration",
      kind: "integration_test_error",
      level: "error",
      message,
      agentId: opts?.requireAgentId,
      durationMs: Date.now() - startedAt,
      integration: integrationLogMeta(integration),
      error: normalizeError(err),
    });
    await markIntegrationHealth(integration.id, "error", message).catch(() => {});
    return { ok: false, transport: integration.transport, detail: { error: message } };
  }
}

function getCliHealthCheckTool(integration: AgentIntegrationRow): IntegrationToolManifest | null {
  if (integration.providerKey === "github") {
    return {
      name: "gh_auth_status",
      description: "Check GitHub CLI authentication status.",
      mode: "cli",
      readOnly: true,
      output: "text",
      args: ["auth", "status", "--hostname", "github.com"],
      inputSchema: { type: "object", properties: {} },
    };
  }
  return null;
}

function larkMissingScopeResponse(
  integration: AgentIntegrationRow,
  toolName: string,
  detail: string,
  missingScopes: string[],
): Record<string, unknown> {
  const scope = missingScopes.join(" ");
  return {
    ok: false,
    errorType: "missing_scope",
    message: `Missing Lark OAuth scope(s): ${scope}`,
    detail,
    missingScopes,
    nextAction: {
      tool: "start_integration_auth",
      arguments: {
        integrationId: integration.id,
        scope,
        recommend: false,
      },
      legacyTool: "start_lark_auth",
    },
    retry: {
      tool: toolName,
      after: "poll_integration_auth returns authorized=true",
    },
    instructions:
      "Call start_integration_auth with nextAction.arguments, send the returned verificationUrl to the user unchanged, poll_integration_auth after the user completes authorization, then retry the original Lark tool.",
  };
}

function githubMissingScopeResponse(
  integration: AgentIntegrationRow,
  toolName: string,
  detail: string,
  missingScopes: string[],
): Record<string, unknown> {
  const scope = missingScopes.join(",");
  return {
    ok: false,
    errorType: "missing_scope",
    providerKey: "github",
    message: `Missing GitHub OAuth scope(s): ${scope}`,
    detail,
    missingScopes,
    nextAction: {
      tool: "start_integration_auth",
      arguments: {
        integrationId: integration.id,
        scope,
      },
    },
    retry: {
      tool: toolName,
      after: "poll_integration_auth returns authorized=true",
    },
    instructions:
      "Call start_integration_auth with nextAction.arguments, send the returned GitHub verificationUrl and userCode to the user unchanged, poll_integration_auth after the user completes authorization, then retry the original GitHub tool.",
  };
}

function parseLarkMissingScopes(message: string): string[] {
  const scopes = new Set<string>();
  const parsed = parseEmbeddedJson(message);
  const error = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, any>).error
    : null;
  if (error && typeof error === "object" && (error as Record<string, any>).type === "missing_scope") {
    collectScopes(scopes, String((error as Record<string, any>).message ?? ""));
    collectScopes(scopes, String((error as Record<string, any>).hint ?? ""));
  }
  const lower = message.toLowerCase();
  if (!scopes.size && (lower.includes("missing_scope") || lower.includes("missing required scope"))) {
    collectScopes(scopes, message);
  }
  return [...scopes];
}

function parseLarkAuthFailureResult(result: unknown): null | { missingScopes: string[] } {
  const parsed = parseJsonLike(result);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, any>;
  if (record.ok !== false && !isNonZeroApiCode(record.code ?? record.errcode ?? record.error_code)) return null;
  const error = record.error;
  const errorType = typeof error?.type === "string" ? error.type : "";
  const message = [
    errorType,
    typeof error?.message === "string" ? error.message : "",
    typeof error?.hint === "string" ? error.hint : "",
    typeof record.message === "string" ? record.message : "",
    typeof record.msg === "string" ? record.msg : "",
    typeof record.reason === "string" ? record.reason : "",
  ].filter(Boolean).join("\n");
  const lower = message.toLowerCase();
  if (errorType === "missing_scope" || lower.includes("missing_scope") || lower.includes("missing required scope")) {
    return { missingScopes: parseLarkMissingScopes(message) };
  }
  if (
    lower.includes("not authorized") ||
    lower.includes("not logged") ||
    lower.includes("login") ||
    lower.includes("access token") ||
    lower.includes("authorization expired") ||
    lower.includes("auth expired")
  ) {
    return { missingScopes: [] };
  }
  return null;
}

function isNonZeroApiCode(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return Boolean(trimmed && trimmed !== "0");
  }
  return false;
}

function parseGithubAuthFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("not logged into any github hosts") ||
    lower.includes("to get started with github cli") ||
    lower.includes("gh auth login") ||
    lower.includes("authentication required") ||
    lower.includes("requires authentication") ||
    lower.includes("bad credentials") ||
    lower.includes("http 401") ||
    lower.includes("must authenticate") ||
    lower.includes("no authentication token");
}

function parseGithubMissingScopes(message: string): string[] {
  const scopes = new Set<string>();
  const lower = message.toLowerCase();
  if (
    !lower.includes("scope") &&
    !lower.includes("resource not accessible by personal access token") &&
    !lower.includes("insufficient oauth")
  ) {
    return [];
  }
  const patterns = [
    /requires?\s+(?:the\s+)?["'`]?([a-zA-Z0-9_:.-]+)["'`]?\s+scope/gi,
    /missing\s+(?:the\s+)?["'`]?([a-zA-Z0-9_:.-]+)["'`]?\s+scope/gi,
    /scope\s+["'`]?([a-zA-Z0-9_:.-]+)["'`]?/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(message))) {
      const scope = match[1]?.trim();
      if (scope && /^[a-zA-Z0-9_:.-]+$/.test(scope)) scopes.add(scope);
    }
  }
  if (!scopes.size && lower.includes("workflow")) scopes.add("workflow");
  if (!scopes.size && lower.includes("repo")) scopes.add("repo");
  return [...scopes];
}

function parseJsonLike(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseEmbeddedJson(message: string): unknown | null {
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(message.slice(start, end + 1));
  } catch {
    return null;
  }
}

function collectScopes(scopes: Set<string>, text: string): void {
  const fromFlag = /--scope\s+["']([^"']+)["']/.exec(text);
  if (fromFlag) addScopeList(scopes, fromFlag[1]);
  const fromMessage = /missing required scope\(s\):\s*([^\n"`]+)/i.exec(text);
  if (fromMessage) addScopeList(scopes, fromMessage[1]);
}

function addScopeList(scopes: Set<string>, raw: string): void {
  for (const item of raw.replace(/[，;]/g, ",").split(/[\s,]+/)) {
    const scope = item.trim().replace(/^["']|["']$/g, "");
    if (/^[a-zA-Z0-9_.:-]+$/.test(scope)) scopes.add(scope);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function dispatch(
  integration: AgentIntegrationRow,
  manifest: IntegrationToolManifest,
  args: Record<string, any>,
): Promise<unknown> {
  if (
    integration.providerKey === "lark" &&
    integration.transport === "cli" &&
    manifest.name === "lark_cli_guide"
  ) {
    return getLarkCliGuide(args);
  }
  if (
    integration.providerKey === "github" &&
    integration.transport === "cli" &&
    manifest.name === "github_cli_guide"
  ) {
    return getGithubCliGuide(args);
  }
  if (
    integration.providerKey === "github" &&
    integration.transport === "cli" &&
    manifest.name === "gh_auth_status"
  ) {
    return getGithubAuthStatus(integration);
  }
  if (
    integration.providerKey === "github" &&
    integration.transport === "cli" &&
    manifest.name === "github_api_get"
  ) {
    return callGithubApi(integration, "GET", args);
  }
  if (
    integration.providerKey === "github" &&
    integration.transport === "cli" &&
    manifest.name === "github_api_post"
  ) {
    return callGithubApi(integration, normalizeGithubWriteMethod(args.method), args);
  }
  if (
    integration.providerKey === "lark" &&
    integration.transport === "cli" &&
    manifest.name === "lark_api_post"
  ) {
    return callLarkApi(integration, normalizeLarkWriteMethod(args.method), args);
  }
  if (integration.providerKey === "figma" && isFigmaRestTool(manifest.name)) {
    return callFigmaRestTool(integration, manifest.name, args);
  }
  if (
    integration.providerKey === "lark" &&
    integration.transport === "cli" &&
    manifest.name === "lark_calendar_create_event"
  ) {
    return createLarkCalendarEvent(integration, args);
  }
  if (
    integration.providerKey === "lark" &&
    integration.transport === "cli" &&
    manifest.name === "lark_calendar_update_event"
  ) {
    return updateLarkCalendarEvent(integration, args);
  }
  if (
    integration.providerKey === "lark" &&
    integration.transport === "cli" &&
    manifest.name === "lark_calendar_delete_event"
  ) {
    return deleteLarkCalendarEvent(integration, args);
  }
  if (manifest.mode === "cli") {
    const effectiveArgs = integration.providerKey === "lark" &&
      integration.transport === "cli" &&
      manifest.name === "lark_cli"
      ? normalizeLarkCliArgs(args)
      : args;
    return runCliIntegrationTool(integration, manifest, effectiveArgs);
  }
  const remoteName =
    manifest.remoteName ||
    (typeof args.tool === "string" ? args.tool : "") ||
    manifest.name;
  if (!remoteName) throw new Error("Remote MCP tool name is required");
  const remoteArgs =
    args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
      ? args.arguments
      : args;
  return callMcpIntegrationTool(integration, remoteName, remoteArgs);
}

async function testFigmaRest(integration: AgentIntegrationRow): Promise<Record<string, unknown> | null> {
  if (!(await hasFigmaToken(integration))) return null;
  const me = await callFigmaRest(integration, "/me", {});
  return { mode: "rest", me };
}

async function hasFigmaToken(integration: AgentIntegrationRow): Promise<boolean> {
  const runtime = await resolveIntegrationRuntimeEnv(integration);
  return Boolean(figmaToken(runtime));
}

function isFigmaRestTool(name: string): boolean {
  return name === "figma_me" ||
    name === "figma_file" ||
    name === "figma_file_nodes" ||
    name === "figma_images";
}

async function callFigmaRestTool(
  integration: AgentIntegrationRow,
  toolName: string,
  args: Record<string, any>,
): Promise<unknown> {
  if (toolName === "figma_me") {
    return callFigmaRest(integration, "/me", {});
  }
  const ref = resolveFigmaRef(args);
  if (toolName === "figma_file") {
    const ids = cleanFigmaIds(args.ids) ?? (ref.nodeId ? [ref.nodeId] : undefined);
    return callFigmaRest(integration, `/files/${encodeURIComponent(ref.fileKey)}`, {
      version: cleanOptionalString(args.version),
      ids: ids?.join(","),
      depth: cleanPositiveInt(args.depth),
    });
  }
  if (toolName === "figma_file_nodes") {
    const ids = cleanFigmaIds(args.ids) ?? (ref.nodeId ? [ref.nodeId] : []);
    if (!ids.length) throw new Error("Figma node ids are required. Pass ids or a figmaUrl with node-id.");
    return callFigmaRest(integration, `/files/${encodeURIComponent(ref.fileKey)}/nodes`, {
      ids: ids.join(","),
      version: cleanOptionalString(args.version),
      depth: cleanPositiveInt(args.depth),
    });
  }
  if (toolName === "figma_images") {
    const ids = cleanFigmaIds(args.ids) ?? (ref.nodeId ? [ref.nodeId] : []);
    if (!ids.length) throw new Error("Figma node ids are required. Pass ids or a figmaUrl with node-id.");
    return callFigmaRest(integration, `/images/${encodeURIComponent(ref.fileKey)}`, {
      ids: ids.join(","),
      format: cleanFigmaImageFormat(args.format),
      scale: cleanFigmaScale(args.scale),
    });
  }
  throw new Error(`unknown Figma REST tool: ${toolName}`);
}

async function callFigmaRest(
  integration: AgentIntegrationRow,
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<unknown> {
  const runtime = await resolveIntegrationRuntimeEnv(integration);
  const token = figmaToken(runtime);
  if (!token) {
    throw new Error(
      "Figma token is missing. Save FIGMA_TOKEN for hosted REST access, or configure a backend-reachable MCP endpoint.",
    );
  }
  const apiBase = typeof integration.config.apiBaseUrl === "string" && integration.config.apiBaseUrl.trim()
    ? integration.config.apiBaseUrl.trim()
    : "https://api.figma.com/v1";
  const url = new URL(path.replace(/^\/+/, ""), apiBase.endsWith("/") ? apiBase : `${apiBase}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    headers: {
      "X-Figma-Token": token,
      "Accept": "application/json",
    },
  });
  const text = await res.text();
  const body = parseJsonOrText(text);
  if (!res.ok) {
    const message = typeof body === "object" && body && "err" in body
      ? String((body as any).err)
      : typeof body === "object" && body && "message" in body
        ? String((body as any).message)
        : text.slice(0, 300);
    throw new Error(`Figma REST ${res.status}: ${message || res.statusText}`);
  }
  return body;
}

function figmaToken(runtime: Awaited<ReturnType<typeof resolveIntegrationRuntimeEnv>>): string {
  const fromHeader = runtime.headers["X-Figma-Token"];
  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
  const fromCredential = runtime.credentials.FIGMA_TOKEN;
  return typeof fromCredential === "string" ? fromCredential.trim() : "";
}

function parseJsonOrText(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function resolveFigmaRef(args: Record<string, any>): { fileKey: string; nodeId?: string } {
  const fromUrl = parseFigmaUrl(args.figmaUrl ?? args.url);
  const fileKey = cleanFigmaFileKey(args.fileKey) ?? fromUrl?.fileKey;
  if (!fileKey) throw new Error("Figma fileKey is required. Pass fileKey or figmaUrl.");
  return { fileKey, nodeId: fromUrl?.nodeId };
}

function parseFigmaUrl(value: unknown): { fileKey: string; nodeId?: string } | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!/(\.|^)figma\.com$/i.test(url.hostname)) return null;
  const [, fileKey] = url.pathname.match(/\/(?:file|design|proto|board)\/([a-zA-Z0-9_-]+)/) ?? [];
  if (!fileKey) return null;
  const rawNodeId = url.searchParams.get("node-id") ?? undefined;
  const nodeId = rawNodeId ? normalizeFigmaNodeId(rawNodeId) : undefined;
  return { fileKey, nodeId };
}

function cleanFigmaFileKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  if (!key) return undefined;
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error("Figma fileKey has invalid characters.");
  return key;
}

function cleanFigmaIds(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map(normalizeFigmaNodeId).filter(Boolean);
  }
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map(normalizeFigmaNodeId);
  return ids.length ? ids : undefined;
}

function normalizeFigmaNodeId(value: string): string {
  const id = decodeURIComponent(value).trim().replace(/-/g, ":");
  if (!/^[A-Za-z0-9]+:[A-Za-z0-9]+(?:;[A-Za-z0-9]+:[A-Za-z0-9]+)*$/.test(id)) {
    throw new Error(`Invalid Figma node id: ${value}`);
  }
  return id;
}

function cleanPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Expected a positive number.");
  return Math.floor(n);
}

function cleanFigmaImageFormat(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = String(value).trim().toLowerCase();
  if (raw === "jpg" || raw === "png" || raw === "svg" || raw === "pdf") return raw;
  throw new Error("Figma image format must be jpg, png, svg, or pdf.");
}

function cleanFigmaScale(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 4) throw new Error("Figma image scale must be between 0 and 4.");
  return n;
}

async function callLarkApi(
  integration: AgentIntegrationRow,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  args: Record<string, any>,
): Promise<unknown> {
  const path = cleanLarkApiPath(args.path);
  const params = normalizeRecord(args.params);
  const data = normalizeRecord(args.data);
  if (isCalendarCreatePath(path) && method === "POST") {
    guardLarkCalendarPost({ path, data });
  }

  const runtime = await resolveIntegrationRuntimeEnv(integration);
  const argv = ["api", method, path, "--format", "json"];
  const identity = normalizeLarkIdentity(args.as);
  if (identity) argv.push("--as", identity);
  if (Object.keys(params).length) argv.push("--params", JSON.stringify(params));
  if (method !== "DELETE" && Object.keys(data).length) {
    argv.push("--data", JSON.stringify(data));
  }

  const result = await withIntegrationMutex(runtime.mutexKey, () =>
    runCliCommand(larkCommand(integration), argv, {
      env: runtime.env,
      cwd: runtime.cwd,
      timeoutMs: 60_000,
    })
  );
  const stdout = result.stdout.trim();
  if (!stdout) return { ok: true };
  return parseJsonOrText(stdout);
}

function normalizeLarkWriteMethod(value: unknown): "POST" | "PATCH" | "PUT" | "DELETE" {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "POST";
  if (raw === "PATCH" || raw === "PUT" || raw === "DELETE") return raw;
  return "POST";
}

function cleanLarkApiPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Lark OpenAPI path is required");
  }
  const path = value.trim();
  if (/^https?:\/\//i.test(path)) {
    throw new Error("Lark OpenAPI path must be a path, not a full URL");
  }
  if (path.includes("\u0000") || /[\r\n]/.test(path)) {
    throw new Error("Lark OpenAPI path may not contain control characters");
  }
  return path.startsWith("/") ? path : `/${path}`;
}

function larkCommand(integration: AgentIntegrationRow): string {
  const command = String(integration.config.command || "lark-cli").trim();
  if (!command || /[;&|`$<>]/.test(command)) {
    throw new Error("lark-cli command must be a binary/path, not a shell expression");
  }
  return command;
}

function normalizeLarkIdentity(value: unknown): "user" | "bot" | undefined {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "user" || raw === "bot") return raw;
  return undefined;
}

function isCalendarCreatePath(path: string): boolean {
  return /\/open-apis\/calendar\/v4\/calendars\/[^/]+\/events\/?$/.test(path);
}

async function callGithubApi(
  integration: AgentIntegrationRow,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  args: Record<string, any>,
): Promise<unknown> {
  const path = cleanGithubApiPath(args.path);
  const runtime = await resolveIntegrationRuntimeEnv(integration);
  const argv = [
    "api",
    path,
    "--hostname",
    githubHostname(integration),
    "--method",
    method,
    "--header",
    "Accept: application/vnd.github+json",
  ];
  if (args.paginate === true && method === "GET") {
    argv.push("--paginate", "--slurp");
  }
  appendGithubFields(argv, normalizeRecord(args.params));
  const data = normalizeRecord(args.data);
  let stdin: string | undefined;
  if (method !== "GET" && Object.keys(data).length) {
    argv.push("--input", "-");
    stdin = JSON.stringify(data);
  }
  const result = await withIntegrationMutex(runtime.mutexKey, () =>
    runCliCommand(githubCommand(integration), argv, {
      env: runtime.env,
      cwd: runtime.cwd,
      stdin,
      timeoutMs: 60_000,
    })
  );
  const stdout = result.stdout.trim();
  if (!stdout) return { ok: true };
  try {
    return JSON.parse(stdout);
  } catch {
    return { raw: stdout, note: "GitHub API output was not valid JSON; returned raw text." };
  }
}

function normalizeGithubWriteMethod(value: unknown): "POST" | "PATCH" | "PUT" | "DELETE" {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "POST";
  if (raw === "PATCH" || raw === "PUT" || raw === "DELETE") return raw;
  return "POST";
}

function cleanGithubApiPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("GitHub API path is required");
  }
  const path = value.trim();
  if (/^https?:\/\//i.test(path)) {
    throw new Error("GitHub API path must be a REST path or graphql, not a full URL");
  }
  if (path.includes("\u0000") || /[\r\n]/.test(path)) {
    throw new Error("GitHub API path may not contain control characters");
  }
  if (path === "graphql") return path;
  return path.startsWith("/") ? path : `/${path}`;
}

function appendGithubFields(argv: string[], record: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    appendGithubField(argv, key, value);
  }
}

function appendGithubField(argv: string[], key: string, value: unknown): void {
  const cleanKey = key.trim();
  if (!cleanKey || cleanKey.includes("\u0000")) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      appendGithubField(argv, `${cleanKey}[]`, item);
    }
    if (!value.length) argv.push("-F", `${cleanKey}[]`);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      appendGithubField(argv, `${cleanKey}[${childKey}]`, childValue);
    }
    return;
  }
  if (value === undefined) return;
  argv.push("-F", `${cleanKey}=${String(value)}`);
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function githubCommand(integration: AgentIntegrationRow): string {
  const command = String(integration.config.command || "gh").trim();
  if (!command || /[;&|`$<>]/.test(command)) {
    throw new Error("gh command must be a binary/path, not a shell expression");
  }
  return command;
}

function githubHostname(integration: AgentIntegrationRow): string {
  const hostname = String(integration.config.hostname || "github.com").trim();
  if (!hostname || /[\s/\\]/.test(hostname)) {
    throw new Error("GitHub hostname must be a host name, not a URL");
  }
  return hostname;
}

function normalizeLarkCliArgs(args: Record<string, any>): Record<string, any> {
  if (!Array.isArray(args.argv)) return args;
  const argv = args.argv.map(String);
  const normalized = normalizeLarkSearchArgv(argv);
  if (normalized === argv) return args;
  return { ...args, argv: normalized };
}

function normalizeLarkSearchArgv(argv: string[]): string[] {
  if (argv.length < 2) return argv;
  const domain = argv[0];
  const command = argv[1];
  const isDriveSearch = domain === "drive" && command === "+search";
  const isDocsSearch = domain === "docs" && command === "+search";
  if (!isDriveSearch && !isDocsSearch) return argv;
  if (isDocsSearch && hasFlag(argv, "--filter")) return argv;

  let changed = false;
  const next = [...argv];
  if (isDocsSearch) {
    next[0] = "drive";
    changed = true;
  }

  for (let i = 2; i < next.length; i += 1) {
    const arg = next[i];
    if (arg === "--type") {
      next[i] = "--doc-types";
      if (i + 1 < next.length) next[i + 1] = normalizeLarkDocTypes(next[i + 1]);
      changed = true;
      continue;
    }
    if (arg.startsWith("--type=")) {
      next[i] = `--doc-types=${normalizeLarkDocTypes(arg.slice("--type=".length))}`;
      changed = true;
      continue;
    }
    if (arg === "--doc-types" && i + 1 < next.length) {
      const value = normalizeLarkDocTypes(next[i + 1]);
      if (value !== next[i + 1]) {
        next[i + 1] = value;
        changed = true;
      }
      continue;
    }
    if (arg.startsWith("--doc-types=")) {
      const value = normalizeLarkDocTypes(arg.slice("--doc-types=".length));
      const normalized = `--doc-types=${value}`;
      if (normalized !== arg) {
        next[i] = normalized;
        changed = true;
      }
    }
  }
  return changed ? next : argv;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function normalizeLarkDocTypes(value: string): string {
  const aliases: Record<string, string> = {
    base: "bitable",
    bitable: "bitable",
    wiki: "wiki",
    docx: "docx",
    doc: "doc",
    sheet: "sheet",
    sheets: "sheet",
    spreadsheet: "sheet",
    file: "file",
    folder: "folder",
    catalog: "catalog",
    slides: "slides",
    slide: "slides",
    shortcut: "shortcut",
    mindnote: "mindnote",
  };
  return value
    .split(",")
    .map((item) => {
      const key = item.trim().toLowerCase();
      return aliases[key] ?? key;
    })
    .filter(Boolean)
    .join(",");
}

function guardLarkCalendarPost(args: Record<string, any>): void {
  const path = cleanOptionalString(args.path);
  if (!path || !/\/open-apis\/calendar\/v4\/calendars\/[^/]+\/events\/?$/.test(path)) return;
  const data = args.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const timestamp = readPath(data, ["start_time", "timestamp"]);
  if (typeof timestamp !== "string" && typeof timestamp !== "number") return;
  const startMs = Number(timestamp) * 1000;
  if (!Number.isFinite(startMs)) return;
  if (startMs < Date.now() - 5 * 60_000) {
    throw new Error(
      `Refusing to create a Lark calendar event in the past from raw timestamp ${timestamp}. ` +
      "Use lark_calendar_create_event with ISO-8601 startTime/endTime so the backend converts time safely.",
    );
  }
}

async function createLarkCalendarEvent(
  integration: AgentIntegrationRow,
  args: Record<string, any>,
): Promise<unknown> {
  const summary = cleanString(args.summary, "summary");
  const timezone = cleanTimeZone(args.timezone);
  const start = parseDateTime(args.startTime, "startTime", timezone);
  const durationMinutes = normalizeDurationMinutes(args.durationMinutes);
  const end = args.endTime === undefined || args.endTime === null || args.endTime === ""
    ? new Date(start.getTime() + durationMinutes * 60_000)
    : parseDateTime(args.endTime, "endTime", timezone);
  if (end.getTime() <= start.getTime()) {
    throw new Error("endTime must be after startTime");
  }
  if (args.allowPast !== true && start.getTime() < Date.now() - 5 * 60_000) {
      throw new Error(
      `Refusing to create a calendar event in the past: ${formatInTimeZone(start, timezone)}. ` +
      "Recompute the intended future date from the current date and call the tool again, " +
      "or pass allowPast=true only when the user explicitly asks for a past event.",
    );
  }

  const calendarId = cleanOptionalString(args.calendarId) || await getLarkPrimaryCalendarId(integration);
  const data: Record<string, unknown> = {
    summary,
    start_time: {
      timestamp: String(Math.floor(start.getTime() / 1000)),
      timezone,
    },
    end_time: {
      timestamp: String(Math.floor(end.getTime() / 1000)),
      timezone,
    },
  };
  const description = cleanOptionalString(args.description);
  if (description) data.description = description;
  const location = normalizeLocation(args.location);
  if (location) data.location = location;
  const reminderMinutes = normalizeReminderMinutes(args.reminderMinutes);
  if (reminderMinutes !== null) data.reminders = [{ minutes: reminderMinutes }];
  if (args.videoMeeting === false) data.vchat = { vc_type: "no_meeting" };

  const idempotencyKey = cleanOptionalString(args.idempotencyKey) ||
    crypto.createHash("sha256")
      .update([integration.id, calendarId, summary, start.toISOString(), end.toISOString()].join("|"))
      .digest("hex")
      .slice(0, 32);

  const result = await runCliIntegrationTool(
    integration,
    {
      name: "lark_calendar_create_event",
      description: "Create a Lark calendar event with server-side time conversion.",
      mode: "cli",
      readOnly: false,
      danger: true,
      output: "json",
      args: ["api", "POST", "{{path}}", "--params", "{{params}}", "--data", "{{data}}", "--format", "json"],
      inputSchema: { type: "object", properties: {} },
    },
    {
      path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`,
      params: { idempotency_key: idempotencyKey },
      data,
    },
  );
  return {
    ...normalizeLarkApiResult(result),
    normalized: {
      calendarId,
      summary,
      startTime: formatInTimeZone(start, timezone),
      endTime: formatInTimeZone(end, timezone),
      timezone,
      idempotencyKey,
    },
  };
}

async function updateLarkCalendarEvent(
  integration: AgentIntegrationRow,
  args: Record<string, any>,
): Promise<unknown> {
  const eventId = cleanLarkEventId(args.eventId);
  const timezone = cleanTimeZone(args.timezone);
  const calendarId = cleanOptionalString(args.calendarId) || await getLarkPrimaryCalendarId(integration);
  const data: Record<string, unknown> = {};

  const summary = cleanOptionalString(args.summary);
  if (summary) data.summary = summary;
  const description = cleanOptionalString(args.description);
  if (description !== undefined) data.description = description;
  if (args.location !== undefined) {
    const location = normalizeLocation(args.location);
    if (location) data.location = location;
  }
  if (args.reminderMinutes !== undefined && args.reminderMinutes !== null && args.reminderMinutes !== "") {
    data.reminders = [{ minutes: normalizeReminderMinutes(args.reminderMinutes) }];
  }
  if (args.videoMeeting === false) data.vchat = { vc_type: "no_meeting" };
  if (args.videoMeeting === true) data.vchat = { vc_type: "vc" };

  const hasStart = args.startTime !== undefined && args.startTime !== null && args.startTime !== "";
  const hasEnd = args.endTime !== undefined && args.endTime !== null && args.endTime !== "";
  if (hasEnd && !hasStart) {
    throw new Error("startTime is required when updating endTime; Lark requires start_time and end_time together.");
  }
  if (hasStart) {
    const start = parseDateTime(args.startTime, "startTime", timezone);
    if (!hasEnd && (args.durationMinutes === undefined || args.durationMinutes === null || args.durationMinutes === "")) {
      throw new Error("durationMinutes or endTime is required when updating startTime.");
    }
    const end = hasEnd
      ? parseDateTime(args.endTime, "endTime", timezone)
      : new Date(start.getTime() + normalizeDurationMinutes(args.durationMinutes) * 60_000);
    if (end.getTime() <= start.getTime()) {
      throw new Error("endTime must be after startTime");
    }
    if (args.allowPast !== true && start.getTime() < Date.now() - 5 * 60_000) {
      throw new Error(
        `Refusing to move a calendar event into the past: ${formatInTimeZone(start, timezone)}. ` +
        "Recompute the intended future date from the current date and call the tool again, " +
        "or pass allowPast=true only when the user explicitly asks for a past event.",
      );
    }
    data.start_time = {
      timestamp: String(Math.floor(start.getTime() / 1000)),
      timezone,
    };
    data.end_time = {
      timestamp: String(Math.floor(end.getTime() / 1000)),
      timezone,
    };
  }

  if (!Object.keys(data).length) {
    throw new Error("No calendar event update fields were provided.");
  }

  const result = await callLarkApi(integration, "PATCH", {
    path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    params: larkNotificationParams(args.needNotification),
    data,
  });
  return {
    ...normalizeLarkApiResult(result),
    normalized: {
      calendarId,
      eventId,
      updatedFields: Object.keys(data),
      timezone,
      startTime: hasStart && data.start_time ? formatInTimeZone(startFromLarkTime(data.start_time), timezone) : undefined,
      endTime: hasStart && data.end_time ? formatInTimeZone(startFromLarkTime(data.end_time), timezone) : undefined,
    },
  };
}

async function deleteLarkCalendarEvent(
  integration: AgentIntegrationRow,
  args: Record<string, any>,
): Promise<unknown> {
  const eventId = cleanLarkEventId(args.eventId);
  const calendarId = cleanOptionalString(args.calendarId) || await getLarkPrimaryCalendarId(integration);
  const result = await callLarkApi(integration, "DELETE", {
    path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    params: larkNotificationParams(args.needNotification),
  });
  return {
    ...normalizeLarkApiResult(result),
    normalized: {
      calendarId,
      eventId,
      deleted: true,
    },
  };
}

async function getLarkPrimaryCalendarId(integration: AgentIntegrationRow): Promise<string> {
  const result = await runCliIntegrationTool(
    integration,
    {
      name: "lark_api_get",
      description: "Read Lark primary calendar.",
      mode: "cli",
      readOnly: true,
      output: "json",
      args: ["api", "GET", "{{path}}", "--params", "{{params}}", "--format", "json"],
      inputSchema: { type: "object", properties: {} },
    },
    { path: "/open-apis/calendar/v4/calendars/primary", params: {} },
  );
  const normalized = normalizeLarkApiResult(result);
  const calendarId = readPath(normalized, ["data", "calendar_id"]);
  if (typeof calendarId !== "string" || !calendarId.trim()) {
    throw new Error("Unable to resolve Lark primary calendar_id");
  }
  return calendarId.trim();
}

function normalizeLarkApiResult(result: unknown): Record<string, any> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, any>;
  }
  return { raw: result };
}

function cleanLarkEventId(value: unknown): string {
  const eventId = cleanString(value, "eventId");
  if (eventId.includes("\u0000") || /[\r\n/]/.test(eventId)) {
    throw new Error("eventId may not contain slashes or control characters.");
  }
  return eventId;
}

function larkNotificationParams(value: unknown): Record<string, string> {
  if (value === undefined || value === null || value === "") return {};
  return { need_notification: value === false ? "false" : "true" };
}

function parseDateTime(value: unknown, field: string, timezone: string): Date {
  const raw = cleanString(value, field).replace(" ", "T");
  const bareLocal = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(raw);
  if (bareLocal) {
    return parseLocalDateTimeInTimeZone(raw, timezone);
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`${field} must be an ISO-8601 datetime, for example 2026-05-18T17:00:00+08:00`);
  }
  return new Date(ms);
}

function cleanTimeZone(value: unknown): string {
  const timezone = cleanOptionalString(value) || "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

function parseLocalDateTimeInTimeZone(value: string, timezone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error(`Invalid local datetime: ${value}`);
  const [, year, month, day, hour, minute, second = "00"] = match;
  const localUtcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  let candidateMs = localUtcMs - offsetMsForTimeZone(new Date(localUtcMs), timezone);
  for (let i = 0; i < 3; i += 1) {
    const next = localUtcMs - offsetMsForTimeZone(new Date(candidateMs), timezone);
    if (Math.abs(next - candidateMs) < 1000) break;
    candidateMs = next;
  }
  const candidate = new Date(candidateMs);
  const rendered = formatLocalParts(candidate, timezone);
  if (rendered !== `${year}-${month}-${day}T${hour}:${minute}:${second}`) {
    throw new Error(`Local datetime ${value} does not exist in timezone ${timezone}. Include an explicit offset.`);
  }
  return candidate;
}

function normalizeDurationMinutes(value: unknown): number {
  if (value === undefined || value === null || value === "") return 60;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) {
    throw new Error("durationMinutes must be a positive number no larger than 1440");
  }
  return Math.round(n);
}

function normalizeReminderMinutes(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < -20_160 || n > 20_160) {
    throw new Error("reminderMinutes must be between -20160 and 20160");
  }
  return Math.round(n);
}

function normalizeLocation(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return { name: value };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("location must be a string or object");
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ["name", "address"]) {
    const item = cleanOptionalString(record[key]);
    if (item) out[key] = item;
  }
  return Object.keys(out).length ? out : null;
}

function cleanString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function formatInTimeZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return `${parts.replace(" ", "T")}${formatOffsetForTimeZone(date, timezone)}`;
}

function formatLocalParts(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return parts.replace(" ", "T");
}

function formatOffsetForTimeZone(date: Date, timezone: string): string {
  const offsetMs = offsetMsForTimeZone(date, timezone);
  const sign = offsetMs < 0 ? "-" : "+";
  const abs = Math.abs(offsetMs);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function offsetMsForTimeZone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  if (value === "GMT" || value === "UTC") return 0;
  const match = value.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) throw new Error(`Unable to resolve timezone offset for ${timezone}`);
  const [, sign, hours, minutes = "00"] = match;
  const ms = (Number(hours) * 60 + Number(minutes)) * 60_000;
  return sign === "-" ? -ms : ms;
}

function startFromLarkTime(value: unknown): Date {
  const timestamp = readPath(value, ["timestamp"]);
  if (typeof timestamp !== "string" && typeof timestamp !== "number") {
    throw new Error("Lark time payload is missing timestamp");
  }
  const ms = Number(timestamp) * 1000;
  if (!Number.isFinite(ms)) throw new Error("Lark time timestamp is invalid");
  return new Date(ms);
}
