import crypto from "crypto";
import { runCliIntegrationTool } from "./cliRuntime.js";
import { callMcpIntegrationTool, listMcpTools } from "./mcpRuntime.js";
import {
  getAgentIntegration,
  markIntegrationHealth,
  markIntegrationUsed,
} from "./integrationStore.js";
import { startIntegrationAuth } from "./integrationAuthRuntime.js";
import { getLarkAuthStatus } from "./larkAuthRuntime.js";
import { getLarkCliGuide } from "./larkCliGuide.js";
import type { AgentIntegrationRow, IntegrationToolManifest } from "./types.js";

export async function callIntegrationTool(
  integrationId: string,
  toolName: string,
  args: Record<string, any>,
  opts?: { requireAgentId?: string },
): Promise<unknown> {
  const integration = await getAgentIntegration(integrationId, {
    requireAgentId: opts?.requireAgentId,
  });
  if (!integration) throw new Error(`integration not found: ${integrationId}`);
  if (!integration.enabled) throw new Error(`integration is disabled: ${integration.displayName}`);
  const manifest = integration.toolManifest.find((t) => t.name === toolName);
  if (!manifest) throw new Error(`unknown integration tool: ${toolName}`);
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
      return larkMissingScopeResponse(integration, manifest.name, message, missingScopes);
    }
    throw err;
  }
  const larkAuthFailure = integration.providerKey === "lark" && integration.transport === "cli"
    ? parseLarkAuthFailureResult(result)
    : null;
  if (larkAuthFailure) {
    await markIntegrationUsed(integration.id).catch(() => {});
    return startIntegrationAuth(integration.id, {
      requireAgentId: opts?.requireAgentId,
      scope: larkAuthFailure.missingScopes.length ? larkAuthFailure.missingScopes.join(" ") : undefined,
      recommend: larkAuthFailure.missingScopes.length ? false : undefined,
    });
  }
  await markIntegrationUsed(integration.id).catch(() => {});
  return result;
}

export async function testIntegration(integrationId: string, opts?: { requireAgentId?: string }): Promise<{
  ok: boolean;
  transport: string;
  detail: unknown;
  needsConfig?: boolean;
  needsAuth?: boolean;
}> {
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
  if (record.ok !== false) return null;
  const error = record.error;
  const errorType = typeof error?.type === "string" ? error.type : "";
  const message = [
    errorType,
    typeof error?.message === "string" ? error.message : "",
    typeof error?.hint === "string" ? error.hint : "",
    typeof record.message === "string" ? record.message : "",
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
    integration.providerKey === "lark" &&
    integration.transport === "cli" &&
    manifest.name === "lark_calendar_create_event"
  ) {
    return createLarkCalendarEvent(integration, args);
  }
  if (manifest.mode === "cli") {
    if (
      integration.providerKey === "lark" &&
      integration.transport === "cli" &&
      manifest.name === "lark_api_post"
    ) {
      guardLarkCalendarPost(args);
    }
    return runCliIntegrationTool(integration, manifest, args);
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
  const timezone = cleanOptionalString(args.timezone) || "Asia/Shanghai";
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
      `Refusing to create a calendar event in the past: ${formatShanghai(start)}. ` +
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
      startTime: formatShanghai(start),
      endTime: formatShanghai(end),
      timezone,
      idempotencyKey,
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

function parseDateTime(value: unknown, field: string, timezone: string): Date {
  const raw = cleanString(value, field).replace(" ", "T");
  let normalized = raw;
  const bareLocal = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(raw);
  if (bareLocal) {
    if (timezone !== "Asia/Shanghai" && timezone !== "UTC+08:00") {
      throw new Error(`${field} must include a timezone offset, for example 2026-05-18T17:00:00+08:00`);
    }
    normalized = `${raw.length === 16 ? `${raw}:00` : raw}+08:00`;
  }
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) {
    throw new Error(`${field} must be an ISO-8601 datetime, for example 2026-05-18T17:00:00+08:00`);
  }
  return new Date(ms);
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

function cleanOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function formatShanghai(date: Date): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return `${parts.replace(" ", "T")}+08:00`;
}
