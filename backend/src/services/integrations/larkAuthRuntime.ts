import crypto from "crypto";
import {
  getAgentIntegration,
  markIntegrationHealth,
} from "./integrationStore.js";
import {
  runCliCommand,
  type CliCommandResult,
} from "./cliRuntime.js";
import {
  resolveIntegrationRuntimeEnv,
  withIntegrationMutex,
} from "./integrationRuntimeEnv.js";
import type { AgentIntegrationRow } from "./types.js";

interface LarkAuthSession {
  id: string;
  integrationId: string;
  agentId: string;
  deviceCode: string;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: number;
}

const sessions = new Map<string, LarkAuthSession>();

export async function getLarkAuthStatus(
  integration: AgentIntegrationRow,
): Promise<{
  ok: boolean;
  configured: boolean;
  authorized: boolean;
  detail: unknown;
}> {
  assertLarkCliIntegration(integration);
  const config = await ensureLarkCliConfigured(integration);
  if (!config.configured) {
    await markIntegrationHealth(integration.id, "not_configured", config.message).catch(() => {});
    return {
      ok: false,
      configured: false,
      authorized: false,
      detail: {
        needsConfig: true,
        message: config.message,
      },
    };
  }
  try {
    const result = await runLarkCli(integration, ["auth", "status"], { timeoutMs: 30_000 });
    await markIntegrationHealth(integration.id, "healthy", null).catch(() => {});
    return {
      ok: true,
      configured: true,
      authorized: true,
      detail: parseMaybeJson(result.stdout),
    };
  } catch (err) {
    const message = errorMessage(err);
    const needsAuth = classifyLarkAuthMessage(message) === "needs_auth";
    await markIntegrationHealth(
      integration.id,
      needsAuth ? "not_configured" : "error",
      message,
    ).catch(() => {});
    return {
      ok: false,
      configured: true,
      authorized: false,
      detail: {
        needsAuth,
        error: message,
      },
    };
  }
}

export async function startLarkAuth(
  integrationId: string,
  opts?: {
    requireAgentId?: string;
    recommend?: boolean;
    domains?: string[];
    scope?: string;
  },
): Promise<unknown> {
  cleanupExpiredSessions();
  const integration = await loadLarkCliIntegration(integrationId, opts?.requireAgentId);
  const config = await ensureLarkCliConfigured(integration);
  if (!config.configured) {
    return {
      ok: false,
      needsConfig: true,
      message: config.message,
    };
  }

  const argv = ["auth", "login", "--no-wait", "--json"];
  if (opts?.recommend !== false) argv.push("--recommend");
  if (opts?.scope) argv.push("--scope", opts.scope);
  for (const domain of opts?.domains ?? []) {
    if (typeof domain === "string" && domain.trim()) argv.push("--domain", domain.trim());
  }

  const result = await runLarkCli(integration, argv, { timeoutMs: 30_000 });
  const raw = parseMaybeJson(result.stdout);
  const normalized = normalizeDeviceAuth(raw);
  if (!normalized.deviceCode) {
    throw new Error("lark-cli auth login did not return a device code");
  }
  const id = `las_${crypto.randomBytes(9).toString("base64url")}`;
  const expiresAt = Date.now() + normalized.expiresIn * 1000;
  sessions.set(id, {
    id,
    integrationId: integration.id,
    agentId: integration.agentId,
    deviceCode: normalized.deviceCode,
    verificationUrl: normalized.verificationUrl,
    userCode: normalized.userCode,
    expiresAt,
  });
  return {
    ok: true,
    status: "pending",
    authSessionId: id,
    integrationId: integration.id,
    verificationUrl: normalized.verificationUrl,
    userCode: normalized.userCode,
    expiresAt: new Date(expiresAt).toISOString(),
    instructions:
      "请把 verificationUrl / userCode 发给用户。用户完成 Lark 授权后，调用 poll_lark_auth(authSessionId) 完成登录。",
    raw: redactDeviceCode(raw),
  };
}

export async function pollLarkAuth(
  authSessionId: string,
  opts?: { requireAgentId?: string },
): Promise<unknown> {
  cleanupExpiredSessions();
  const session = sessions.get(authSessionId);
  if (!session) {
    return { ok: false, status: "missing", error: "auth session not found or server restarted" };
  }
  if (opts?.requireAgentId && session.agentId !== opts.requireAgentId) {
    return { ok: false, status: "missing", error: "auth session not found" };
  }
  if (Date.now() > session.expiresAt) {
    sessions.delete(authSessionId);
    return { ok: false, status: "expired", error: "Lark authorization session expired" };
  }
  const integration = await loadLarkCliIntegration(session.integrationId, session.agentId);
  try {
    const result = await runLarkCli(
      integration,
      ["auth", "login", "--device-code", session.deviceCode, "--json"],
      { timeoutMs: 30_000 },
    );
    sessions.delete(authSessionId);
    await markIntegrationHealth(integration.id, "healthy", null).catch(() => {});
    return {
      ok: true,
      status: "authorized",
      integrationId: integration.id,
      detail: parseMaybeJson(result.stdout),
    };
  } catch (err) {
    const message = errorMessage(err);
    if (isAuthPending(message)) {
      return {
        ok: false,
        status: "pending",
        integrationId: integration.id,
        expiresAt: new Date(session.expiresAt).toISOString(),
        error: message,
      };
    }
    await markIntegrationHealth(integration.id, "error", message).catch(() => {});
    return {
      ok: false,
      status: "error",
      integrationId: integration.id,
      error: message,
    };
  }
}

async function ensureLarkCliConfigured(
  integration: AgentIntegrationRow,
): Promise<{ configured: true } | { configured: false; message: string }> {
  try {
    await runLarkCli(integration, ["auth", "status"], { timeoutMs: 15_000 });
    return { configured: true };
  } catch (err) {
    if (classifyLarkAuthMessage(errorMessage(err)) !== "needs_config") {
      return { configured: true };
    }
  }

  const runtime = await resolveIntegrationRuntimeEnv(integration);
  const appId = runtime.credentials.LARK_APP_ID || process.env.LARK_APP_ID;
  const appSecret = runtime.credentials.LARK_APP_SECRET || process.env.LARK_APP_SECRET;
  const brand = runtime.credentials.LARK_BRAND || process.env.LARK_BRAND || integration.config.brand || "feishu";
  const profile = integration.config.profile || "default";
  if (!appId || !appSecret) {
    return {
      configured: false,
      message:
        "lark-cli is not configured. Provide LARK_APP_ID and LARK_APP_SECRET as integration credentials or server env, then retry start_lark_auth.",
    };
  }
  await withIntegrationMutex(runtime.mutexKey, () =>
    runCliCommand(larkCommand(integration), [
      "config",
      "init",
      "--app-id",
      appId,
      "--app-secret-stdin",
      "--brand",
      String(brand),
      "--name",
      String(profile),
    ], {
      env: runtime.env,
      cwd: runtime.cwd,
      stdin: `${appSecret}\n`,
      timeoutMs: 30_000,
    }).then(() => undefined)
  );
  return { configured: true };
}

async function runLarkCli(
  integration: AgentIntegrationRow,
  argv: string[],
  opts?: { timeoutMs?: number },
): Promise<CliCommandResult> {
  const runtime = await resolveIntegrationRuntimeEnv(integration);
  return withIntegrationMutex(runtime.mutexKey, () =>
    runCliCommand(larkCommand(integration), argv, {
      env: runtime.env,
      cwd: runtime.cwd,
      timeoutMs: opts?.timeoutMs ?? 60_000,
    })
  );
}

async function loadLarkCliIntegration(
  integrationId: string,
  requireAgentId?: string,
): Promise<AgentIntegrationRow> {
  const integration = await getAgentIntegration(integrationId, { requireAgentId });
  if (!integration) throw new Error(`integration not found: ${integrationId}`);
  assertLarkCliIntegration(integration);
  return integration;
}

function assertLarkCliIntegration(integration: AgentIntegrationRow): void {
  if (integration.providerKey !== "lark" || integration.transport !== "cli") {
    throw new Error("Lark auth tools require a lark integration using cli transport");
  }
}

function larkCommand(integration: AgentIntegrationRow): string {
  const command = String(integration.config.command || "lark-cli").trim();
  if (!command || /[;&|`$<>]/.test(command)) {
    throw new Error("lark-cli command must be a binary/path, not a shell expression");
  }
  return command;
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function normalizeDeviceAuth(raw: unknown): {
  deviceCode: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  expiresIn: number;
} {
  const deviceCode = findString(raw, ["device_code", "deviceCode", "device"]);
  const verificationUrl = findString(raw, [
    "verification_uri_complete",
    "verificationUriComplete",
    "verification_url",
    "verificationUrl",
    "verification_uri",
    "verificationUri",
    "url",
  ]);
  const userCode = findString(raw, ["user_code", "userCode", "code"]);
  const expiresIn = findNumber(raw, ["expires_in", "expiresIn"]) ?? 600;
  return { deviceCode, verificationUrl, userCode, expiresIn };
}

function findString(raw: unknown, keys: string[]): string | null {
  if (!raw || typeof raw !== "object") return null;
  const queue = [raw as Record<string, unknown>];
  while (queue.length) {
    const item = queue.shift()!;
    for (const key of keys) {
      const value = item[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    for (const value of Object.values(item)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        queue.push(value as Record<string, unknown>);
      }
    }
  }
  return null;
}

function findNumber(raw: unknown, keys: string[]): number | null {
  if (!raw || typeof raw !== "object") return null;
  const queue = [raw as Record<string, unknown>];
  while (queue.length) {
    const item = queue.shift()!;
    for (const key of keys) {
      const value = item[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
    }
    for (const value of Object.values(item)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        queue.push(value as Record<string, unknown>);
      }
    }
  }
  return null;
}

function redactDeviceCode(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const copy = JSON.parse(JSON.stringify(raw));
  redactKeys(copy, new Set(["device_code", "deviceCode", "device"]));
  return copy;
}

function redactKeys(value: unknown, keys: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) redactKeys(item, keys);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (keys.has(key) && typeof child === "string") {
      record[key] = "[redacted]";
    } else {
      redactKeys(child, keys);
    }
  }
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

function classifyLarkAuthMessage(message: string): "needs_config" | "needs_auth" | "other" {
  const lower = message.toLowerCase();
  if (lower.includes("not configured") || lower.includes("config init")) return "needs_config";
  if (
    lower.includes("not authorized") ||
    lower.includes("not logged") ||
    lower.includes("login") ||
    lower.includes("access token")
  ) return "needs_auth";
  return "other";
}

function isAuthPending(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("authorization_pending") ||
    lower.includes("pending") ||
    lower.includes("slow_down") ||
    lower.includes("not complete") ||
    lower.includes("not completed");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
