import crypto from "crypto";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import {
  getAgentIntegration,
  listAgentIntegrations,
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

interface LarkAuthOptions {
  recommend?: boolean;
  domains?: string[];
  scope?: string;
}

interface LarkBaseAuthSession {
  id: string;
  integrationId: string;
  agentId: string;
  phase: "config" | "auth";
  verificationUrl: string | null;
  userCode: string | null;
  deviceCode: string;
  expiresAt: number;
}

interface LarkLoginSession extends LarkBaseAuthSession {
  phase: "auth";
  child: ChildProcessWithoutNullStreams;
  output: string;
  error: string | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  detail: unknown;
}

interface LarkConfigSession extends Omit<LarkBaseAuthSession, "phase" | "deviceCode"> {
  phase: "config";
  child: ChildProcessWithoutNullStreams;
  output: string;
  error: string | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  authOptions: LarkAuthOptions;
}

type LarkAuthSession = LarkLoginSession | LarkConfigSession;

interface StoredLarkLoginSession {
  version: 1;
  id: string;
  integrationId: string;
  agentId: string;
  phase: "auth";
  deviceCode: string;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: number;
  createdAt: number;
}

type LoginSessionRecovery =
  | { kind: "session"; session: LarkLoginSession }
  | { kind: "response"; response: unknown }
  | { kind: "missing" };

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
  const config = await getLarkConfigState(integration);
  if (!config.configured) {
    await markIntegrationHealth(integration.id, "not_configured", config.message).catch(() => {});
    return {
      ok: false,
      configured: false,
      authorized: false,
      detail: {
        needsConfig: true,
        message: `${config.message} Call start_lark_auth to start lark-cli config init and send the returned URL/QR code to the user.`,
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
  const authOptions = normalizeAuthOptions(opts);
  const config = await ensureLarkCliConfigured(integration, authOptions);
  if (!config.configured) {
    return startLarkConfigSession(integration, authOptions);
  }

  const argv = ["auth", "login", "--no-wait", "--json"];
  if (authOptions.scope) argv.push("--scope", authOptions.scope);
  if (!authOptions.scope && authOptions.recommend !== false) argv.push("--recommend");
  for (const domain of authOptions.domains ?? []) {
    if (typeof domain === "string" && domain.trim()) argv.push("--domain", domain.trim());
  }

  const result = await runLarkCli(integration, argv, { timeoutMs: 30_000 });
  const raw = parseMaybeJson(result.stdout);
  const normalized = normalizeDeviceAuth(raw);
  if (!normalized.deviceCode) {
    throw new Error("lark-cli auth login did not return a device code");
  }
  const expiresAt = Date.now() + normalized.expiresIn * 1000;
  const session = await spawnLarkLoginSession(integration, {
    id: `las_${crypto.randomBytes(9).toString("base64url")}`,
    deviceCode: normalized.deviceCode,
    verificationUrl: normalized.verificationUrl,
    userCode: normalized.userCode,
    expiresAt,
  });
  return {
    ok: true,
    status: "pending",
    phase: "auth",
    authSessionId: session.id,
    integrationId: integration.id,
    verificationUrl: normalized.verificationUrl,
    userCode: normalized.userCode,
    expiresAt: new Date(expiresAt).toISOString(),
    instructions:
      "请把 verificationUrl 原样发给用户，推荐使用只包含原始 URL 的代码块，不要改写、URL encode/decode、转成 Markdown 链接或附加标点。用户完成 Lark 授权后，只调用 poll_lark_auth(authSessionId)；pending 时等待用户完成，不要重新 start_lark_auth。",
    raw: redactDeviceCode(raw),
  };
}

export async function pollLarkAuth(
  authSessionId: string,
  opts?: { requireAgentId?: string; integrationId?: string },
): Promise<unknown> {
  cleanupExpiredSessions();
  let session = sessions.get(authSessionId);
  if (!session) {
    const recovered = await recoverStoredLoginSession(authSessionId, opts);
    if (recovered.kind === "response") return recovered.response;
    if (recovered.kind === "session") {
      session = recovered.session;
    } else if (opts?.integrationId) {
      const integration = await loadLarkCliIntegration(opts.integrationId, opts.requireAgentId);
      const status = await getLarkAuthStatus(integration);
      if (status.ok) {
        return {
          ok: true,
          status: "authorized",
          phase: "auth",
          integrationId: integration.id,
          detail: status.detail,
          note: "auth session was not found, but lark-cli auth status is healthy",
        };
      }
    } else if (opts?.requireAgentId) {
      const authorized = await findAuthorizedLarkIntegration(opts.requireAgentId);
      if (authorized) return authorized;
    }
  }
  if (!session) {
    return { ok: false, status: "missing", error: "auth session not found or server restarted" };
  }
  if (opts?.requireAgentId && session.agentId !== opts.requireAgentId) {
    return { ok: false, status: "missing", error: "auth session not found" };
  }
  if (Date.now() > session.expiresAt) {
    if (session.phase === "config") {
      session.child.kill("SIGTERM");
      sessions.delete(authSessionId);
      return { ok: false, status: "expired", error: "Lark authorization session expired" };
    }
    const integration = await loadLarkCliIntegration(session.integrationId, session.agentId);
    const status = await getLarkAuthStatus(integration);
    if (status.ok) {
      sessions.delete(authSessionId);
      void deleteStoredLoginSession(authSessionId);
      return {
        ok: true,
        status: "authorized",
        phase: "auth",
        integrationId: integration.id,
        detail: status.detail,
        note: "auth session expired after login completed; verified by lark-cli auth status",
      };
    }
    if (session.exitCode === null) {
      session.error = "Lark authorization session expired";
      session.child.kill("SIGTERM");
    }
  }
  if (session.phase === "config") {
    return pollLarkConfigSession(session);
  }
  return pollLarkLoginSession(session);
}

async function findAuthorizedLarkIntegration(agentId: string): Promise<unknown | null> {
  const integrations = await listAgentIntegrations(agentId).catch(() => []);
  for (const integration of integrations) {
    if (integration.providerKey !== "lark" || integration.transport !== "cli") continue;
    const status = await getLarkAuthStatus(integration).catch(() => null);
    if (!status?.ok) continue;
    await markIntegrationHealth(integration.id, "healthy", null).catch(() => {});
    return {
      ok: true,
      status: "authorized",
      phase: "auth",
      integrationId: integration.id,
      detail: status.detail,
      note: "auth session was not found, but an existing Lark CLI integration is already authorized",
    };
  }
  return null;
}

async function ensureLarkCliConfigured(
  integration: AgentIntegrationRow,
  authOptions?: LarkAuthOptions,
): Promise<{ configured: true } | { configured: false; message: string }> {
  const state = await getLarkConfigState(integration);
  if (state.configured) return state;
  const initialized = await initializeLarkConfigFromCredentials(integration);
  if (initialized) return { configured: true };
  return state;
}

async function getLarkConfigState(
  integration: AgentIntegrationRow,
): Promise<{ configured: true } | { configured: false; message: string }> {
  try {
    await runLarkCli(integration, ["auth", "status"], { timeoutMs: 15_000 });
    return { configured: true };
  } catch (err) {
    const message = errorMessage(err);
    if (classifyLarkAuthMessage(message) !== "needs_config") {
      return { configured: true };
    }
    return { configured: false, message };
  }
}

async function initializeLarkConfigFromCredentials(
  integration: AgentIntegrationRow,
): Promise<boolean> {
  const runtime = await resolveIntegrationRuntimeEnv(integration);
  const appId = runtime.credentials.LARK_APP_ID || process.env.LARK_APP_ID;
  const appSecret = runtime.credentials.LARK_APP_SECRET || process.env.LARK_APP_SECRET;
  const brand = runtime.credentials.LARK_BRAND || process.env.LARK_BRAND || integration.config.brand || "feishu";
  const profile = integration.config.profile || "default";
  if (!appId || !appSecret) {
    return false;
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
  return true;
}

async function startLarkConfigSession(
  integration: AgentIntegrationRow,
  authOptions: LarkAuthOptions,
): Promise<unknown> {
  const existing = findConfigSession(integration.id);
  if (existing) return larkConfigPendingResponse(existing);

  const runtime = await resolveIntegrationRuntimeEnv(integration);
  const id = `las_${crypto.randomBytes(9).toString("base64url")}`;
  const profile = String(integration.config.profile || "default");
  const lang = String(integration.config.lang || "zh");
  const argv = ["config", "init", "--new", "--lang", lang, "--name", profile];
  if (integration.config.forceInit === true) argv.push("--force-init");

  const child = spawn(larkCommand(integration), argv, {
    env: runtime.env,
    cwd: runtime.cwd,
    shell: false,
    windowsHide: true,
  });
  const session: LarkConfigSession = {
    id,
    integrationId: integration.id,
    agentId: integration.agentId,
    phase: "config",
    verificationUrl: null,
    userCode: null,
    expiresAt: Date.now() + 15 * 60_000,
    child,
    output: "",
    error: null,
    exitCode: null,
    exitSignal: null,
    authOptions,
  };
  const appendOutput = (chunk: Buffer) => {
    session.output = clampText(session.output + chunk.toString("utf8"), 12_000);
    const info = extractSetupInfo(session.output);
    session.verificationUrl = info.verificationUrl ?? session.verificationUrl;
    session.userCode = info.userCode ?? session.userCode;
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  child.on("error", (err) => {
    session.error = errorMessage(err);
  });
  child.on("close", (code, signal) => {
    session.exitCode = code;
    session.exitSignal = signal;
    if (code !== 0 && !session.error) {
      session.error = `lark-cli config init exited with ${code}${signal ? ` (${signal})` : ""}`;
    }
  });
  sessions.set(id, session);
  await waitForConfigUrlOrExit(session, 8_000);
  if (session.exitCode !== null && session.exitCode !== 0) {
    sessions.delete(id);
    throw new Error(session.error || "lark-cli config init failed");
  }
  return larkConfigPendingResponse(session);
}

async function pollLarkConfigSession(session: LarkConfigSession): Promise<unknown> {
  const integration = await loadLarkCliIntegration(session.integrationId, session.agentId);
  if (session.exitCode === null && !session.error) {
    return larkConfigPendingResponse(session);
  }
  sessions.delete(session.id);
  if (session.exitCode === 0) {
    await markIntegrationHealth(integration.id, "not_configured", "Lark CLI config initialized; user authorization required").catch(() => {});
    return startLarkAuth(integration.id, {
      requireAgentId: session.agentId,
      ...session.authOptions,
    });
  }
  const message = session.error || "lark-cli config init failed";
  await markIntegrationHealth(integration.id, "error", message).catch(() => {});
  return {
    ok: false,
    status: "error",
    phase: "config",
    integrationId: integration.id,
    error: message,
    output: session.output,
  };
}

async function pollLarkLoginSession(session: LarkLoginSession): Promise<unknown> {
  const integration = await loadLarkCliIntegration(session.integrationId, session.agentId);
  if (session.exitCode === null && !session.error) {
    return {
      ok: false,
      status: "pending",
      phase: "auth",
      integrationId: integration.id,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }
  if (session.exitCode === 0) {
    sessions.delete(session.id);
    void deleteStoredLoginSession(session.id);
    await markIntegrationHealth(integration.id, "healthy", null).catch(() => {});
    return {
      ok: true,
      status: "authorized",
      phase: "auth",
      integrationId: integration.id,
      detail: session.detail,
    };
  }

  const status = await getLarkAuthStatus(integration);
  if (status.ok) {
    sessions.delete(session.id);
    void deleteStoredLoginSession(session.id);
    return {
      ok: true,
      status: "authorized",
      phase: "auth",
      integrationId: integration.id,
      detail: status.detail,
      note: "auth session expired after login completed; verified by lark-cli auth status",
    };
  }

  const message = session.error || "lark-cli auth login failed";
  sessions.delete(session.id);
  void deleteStoredLoginSession(session.id);
  await markIntegrationHealth(integration.id, isAuthExpired(message) ? "not_configured" : "error", message).catch(() => {});
  return {
    ok: false,
    status: isAuthExpired(message) ? "expired" : "error",
    phase: "auth",
    integrationId: integration.id,
    error: message,
  };
}

async function spawnLarkLoginSession(
  integration: AgentIntegrationRow,
  input: {
    id: string;
    deviceCode: string;
    verificationUrl: string | null;
    userCode: string | null;
    expiresAt: number;
  },
): Promise<LarkLoginSession> {
  const runtime = await resolveIntegrationRuntimeEnv(integration);
  const child = spawn(larkCommand(integration), [
    "auth",
    "login",
    "--device-code",
    input.deviceCode,
    "--json",
  ], {
    env: runtime.env,
    cwd: runtime.cwd,
    shell: false,
    windowsHide: true,
  });
  const session: LarkLoginSession = {
    id: input.id,
    integrationId: integration.id,
    agentId: integration.agentId,
    phase: "auth",
    deviceCode: input.deviceCode,
    verificationUrl: input.verificationUrl,
    userCode: input.userCode,
    expiresAt: input.expiresAt,
    child,
    output: "",
    error: null,
    exitCode: null,
    exitSignal: null,
    detail: null,
  };
  const appendOutput = (chunk: Buffer) => {
    session.output = clampText(session.output + chunk.toString("utf8"), 12_000);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  child.on("error", (err) => {
    session.error = errorMessage(err);
  });
  child.on("close", (code, signal) => {
    session.exitCode = code;
    session.exitSignal = signal;
    session.detail = parseMaybeJson(session.output);
    if (code !== 0 && !session.error) {
      session.error = (session.output.trim() || `lark-cli auth login exited with ${code}${signal ? ` (${signal})` : ""}`).slice(0, 2000);
    }
  });
  sessions.set(input.id, session);
  await persistStoredLoginSession(session).catch(() => {});
  return session;
}

async function recoverStoredLoginSession(
  authSessionId: string,
  opts?: { requireAgentId?: string; integrationId?: string },
): Promise<LoginSessionRecovery> {
  const stored = await readStoredLoginSession(authSessionId);
  if (!stored) return { kind: "missing" };
  if (opts?.requireAgentId && stored.agentId !== opts.requireAgentId) {
    return { kind: "missing" };
  }
  if (opts?.integrationId && stored.integrationId !== opts.integrationId) {
    return { kind: "missing" };
  }

  let integration: AgentIntegrationRow;
  try {
    integration = await loadLarkCliIntegration(stored.integrationId, stored.agentId);
  } catch {
    await deleteStoredLoginSession(authSessionId).catch(() => {});
    return { kind: "missing" };
  }

  const status = await getLarkAuthStatus(integration).catch(() => null);
  if (status?.ok) {
    await deleteStoredLoginSession(authSessionId).catch(() => {});
    await markIntegrationHealth(integration.id, "healthy", null).catch(() => {});
    return {
      kind: "response",
      response: {
        ok: true,
        status: "authorized",
        phase: "auth",
        integrationId: integration.id,
        detail: status.detail,
        note: "auth session recovered after server restart and verified by lark-cli auth status",
      },
    };
  }

  if (Date.now() > stored.expiresAt) {
    await deleteStoredLoginSession(authSessionId).catch(() => {});
    return {
      kind: "response",
      response: {
        ok: false,
        status: "expired",
        phase: "auth",
        integrationId: integration.id,
        error: "Lark authorization session expired",
      },
    };
  }

  const session = await spawnLarkLoginSession(integration, stored);
  return { kind: "session", session };
}

function larkConfigPendingResponse(session: LarkConfigSession): unknown {
  return {
    ok: true,
    status: "pending",
    phase: "config",
    authSessionId: session.id,
    integrationId: session.integrationId,
    verificationUrl: session.verificationUrl,
    userCode: session.userCode,
    expiresAt: new Date(session.expiresAt).toISOString(),
    qrCodeText: session.output,
    instructions:
      "请把 verificationUrl 或 qrCodeText 发给用户。用户完成 Lark 应用配置后，调用 poll_lark_auth(authSessionId)；成功后会自动进入 auth login 阶段并返回下一步授权 URL/code。",
  };
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
  const deviceCode = findString(raw, ["device_code", "deviceCode", "device"]);
  const copy = JSON.parse(JSON.stringify(raw));
  redactKeys(copy, new Set(["device_code", "deviceCode", "device"]));
  if (deviceCode) redactText(copy, deviceCode);
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

function redactText(value: unknown, secret: string): void {
  if (!secret || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) redactText(item, secret);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === "string") {
      record[key] = child.split(secret).join("[redacted]");
    } else {
      redactText(child, secret);
    }
  }
}

async function persistStoredLoginSession(session: LarkLoginSession): Promise<void> {
  const stored: StoredLarkLoginSession = {
    version: 1,
    id: session.id,
    integrationId: session.integrationId,
    agentId: session.agentId,
    phase: "auth",
    deviceCode: session.deviceCode,
    verificationUrl: session.verificationUrl,
    userCode: session.userCode,
    expiresAt: session.expiresAt,
    createdAt: Date.now(),
  };
  const file = await storedLoginSessionPath(session.id);
  await fsp.writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
}

async function readStoredLoginSession(authSessionId: string): Promise<StoredLarkLoginSession | null> {
  const file = await storedLoginSessionPath(authSessionId);
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredLarkLoginSession>;
    if (
      parsed.version !== 1 ||
      parsed.phase !== "auth" ||
      parsed.id !== authSessionId ||
      typeof parsed.integrationId !== "string" ||
      typeof parsed.agentId !== "string" ||
      typeof parsed.deviceCode !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return {
      version: 1,
      id: parsed.id,
      integrationId: parsed.integrationId,
      agentId: parsed.agentId,
      phase: "auth",
      deviceCode: parsed.deviceCode,
      verificationUrl: typeof parsed.verificationUrl === "string" ? parsed.verificationUrl : null,
      userCode: typeof parsed.userCode === "string" ? parsed.userCode : null,
      expiresAt: parsed.expiresAt,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
    };
  } catch {
    return null;
  }
}

async function deleteStoredLoginSession(authSessionId: string): Promise<void> {
  const file = await storedLoginSessionPath(authSessionId);
  await fsp.unlink(file).catch(() => {});
}

async function storedLoginSessionPath(authSessionId: string): Promise<string> {
  const root = process.env.INTEGRATION_SANDBOX_ROOT ||
    path.join(os.homedir(), ".imagebase", "integration-sandboxes");
  const dir = path.join(root, "_runtime", "lark-auth-sessions");
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${safeSessionId(authSessionId)}.json`);
}

function safeSessionId(authSessionId: string): string {
  return authSessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "unknown";
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.phase === "auth") {
      if (session.expiresAt <= now && session.exitCode === null) {
        session.error = "Lark authorization session expired";
        session.child.kill("SIGTERM");
      }
      if (session.expiresAt + 30 * 60_000 <= now) {
        sessions.delete(id);
        void deleteStoredLoginSession(id);
      }
      continue;
    }
    if (session.expiresAt <= now) {
      if (session.phase === "config" && session.exitCode === null) session.child.kill("SIGTERM");
      sessions.delete(id);
    }
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

function isAuthExpired(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("expired") ||
    lower.includes("expire") ||
    lower.includes("authorization_expired") ||
    lower.includes("device code expired");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeAuthOptions(opts?: LarkAuthOptions): LarkAuthOptions {
  return {
    recommend: typeof opts?.recommend === "boolean" ? opts.recommend : undefined,
    domains: Array.isArray(opts?.domains) ? opts.domains.filter((v): v is string => typeof v === "string" && Boolean(v.trim())) : undefined,
    scope: typeof opts?.scope === "string" && opts.scope.trim() ? opts.scope.trim() : undefined,
  };
}

function findConfigSession(integrationId: string): LarkConfigSession | null {
  for (const session of sessions.values()) {
    if (session.phase === "config" && session.integrationId === integrationId && Date.now() < session.expiresAt) {
      return session;
    }
  }
  return null;
}

async function waitForConfigUrlOrExit(session: LarkConfigSession, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.verificationUrl || session.exitCode !== null || session.error) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function extractSetupInfo(output: string): {
  verificationUrl: string | null;
  userCode: string | null;
} {
  const url = output.match(/https?:\/\/[^\s]+/)?.[0] ?? null;
  let userCode: string | null = null;
  if (url) {
    try {
      userCode = new URL(url).searchParams.get("user_code");
    } catch {
      userCode = null;
    }
  }
  userCode = userCode || output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0] || null;
  return { verificationUrl: url, userCode };
}

function clampText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}
