import crypto from "crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
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

interface GithubAuthSession {
  id: string;
  integrationId: string;
  agentId: string;
  displayName: string;
  hostname: string;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: number;
  child: ChildProcessWithoutNullStreams;
  output: string;
  error: string | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

const sessions = new Map<string, GithubAuthSession>();

export async function getGithubAuthStatus(
  integration: AgentIntegrationRow,
): Promise<{
  ok: boolean;
  authorized: boolean;
  detail: unknown;
}> {
  assertGithubCliIntegration(integration);
  try {
    const result = await runGithubCli(integration, [
      "auth",
      "status",
      "--hostname",
      githubHostname(integration),
    ], { timeoutMs: 30_000 });
    const detail = parseMaybeJson(result.stdout.trim() || result.stderr.trim());
    await markIntegrationHealth(integration.id, "healthy", null).catch(() => {});
    return {
      ok: true,
      authorized: true,
      detail: detail || { stdout: result.stdout.trim(), stderr: result.stderr.trim() },
    };
  } catch (err) {
    const message = errorMessage(err);
    await markIntegrationHealth(integration.id, "not_configured", message).catch(() => {});
    return {
      ok: false,
      authorized: false,
      detail: {
        needsAuth: true,
        error: message,
        message:
          "GitHub CLI is not authenticated in this integration sandbox. Call start_integration_auth to start a GitHub device login, or configure GH_TOKEN/GITHUB_TOKEN credentials.",
      },
    };
  }
}

export async function startGithubAuth(
  integrationId: string,
  opts?: { requireAgentId?: string; scope?: string },
): Promise<unknown> {
  cleanupExpiredSessions();
  const integration = await loadGithubCliIntegration(integrationId, opts?.requireAgentId);
  const current = await getGithubAuthStatus(integration).catch(() => null);
  if (current?.ok) {
    return {
      ok: true,
      status: "authorized",
      phase: "auth",
      integrationId: integration.id,
      providerKey: "github",
      displayName: integration.displayName,
      detail: current.detail,
      note: "GitHub CLI is already authenticated in this integration sandbox.",
    };
  }

  const existing = findSession(integration.id);
  if (existing) return githubAuthPendingResponse(existing);

  const runtime = await resolveIntegrationRuntimeEnv(integration);
  const id = `gas_${crypto.randomBytes(9).toString("base64url")}`;
  const hostname = githubHostname(integration);
  const argv = [
    "auth",
    "login",
    "--hostname",
    hostname,
    "--web",
    "--git-protocol",
    "https",
    "--skip-ssh-key",
  ];
  const scopes = normalizeScopes(opts?.scope);
  if (scopes.length) {
    argv.push("--scopes", scopes.join(","));
  }
  const child = spawn(githubCommand(integration), argv, {
    env: {
      ...runtime.env,
      GH_BROWSER: "echo",
      GH_PROMPT_DISABLED: "1",
    },
    cwd: runtime.cwd,
    shell: false,
    windowsHide: true,
  });
  const session: GithubAuthSession = {
    id,
    integrationId: integration.id,
    agentId: integration.agentId,
    displayName: integration.displayName,
    hostname,
    verificationUrl: null,
    userCode: null,
    expiresAt: Date.now() + 15 * 60_000,
    child,
    output: "",
    error: null,
    exitCode: null,
    exitSignal: null,
  };
  const appendOutput = (chunk: Buffer) => {
    session.output = clampText(session.output + chunk.toString("utf8"), 12_000);
    const info = extractGithubDeviceInfo(session.output);
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
      session.error = (session.output.trim() || `gh auth login exited with ${code}${signal ? ` (${signal})` : ""}`).slice(0, 2000);
    }
  });
  sessions.set(id, session);
  await waitForAuthUrlOrExit(session, 8_000);
  if (session.exitCode !== null && session.exitCode !== 0) {
    sessions.delete(id);
    throw new Error(session.error || "gh auth login failed");
  }
  return githubAuthPendingResponse(session);
}

export async function pollGithubAuth(
  authSessionId: string,
  opts?: { requireAgentId?: string; integrationId?: string },
): Promise<unknown> {
  cleanupExpiredSessions();
  let session = sessions.get(authSessionId);
  if (!session && opts?.integrationId) {
    const integration = await loadGithubCliIntegration(opts.integrationId, opts.requireAgentId);
    const status = await getGithubAuthStatus(integration);
    if (status.ok) {
      return {
        ok: true,
        status: "authorized",
        phase: "auth",
        integrationId: integration.id,
        providerKey: "github",
        detail: status.detail,
        note: "auth session was not found, but gh auth status is healthy",
      };
    }
  }
  if (!session) {
    return { ok: false, status: "missing", authSessionId, error: "GitHub auth session not found or server restarted" };
  }
  if (opts?.requireAgentId && session.agentId !== opts.requireAgentId) {
    return { ok: false, status: "missing", authSessionId, error: "GitHub auth session not found" };
  }
  if (Date.now() > session.expiresAt && session.exitCode === null) {
    session.error = "GitHub authorization session expired";
    session.child.kill("SIGTERM");
  }
  const integration = await loadGithubCliIntegration(session.integrationId, session.agentId);
  if (session.exitCode === null && !session.error) {
    return githubAuthPendingResponse(session);
  }
  const status = await getGithubAuthStatus(integration).catch(() => null);
  if (status?.ok) {
    sessions.delete(session.id);
    await markIntegrationHealth(integration.id, "healthy", null).catch(() => {});
    return {
      ok: true,
      status: "authorized",
      phase: "auth",
      integrationId: integration.id,
      providerKey: "github",
      detail: status.detail,
    };
  }
  const message = session.error || "gh auth login failed";
  sessions.delete(session.id);
  await markIntegrationHealth(integration.id, isExpired(message) ? "not_configured" : "error", message).catch(() => {});
  return {
    ok: false,
    status: isExpired(message) ? "expired" : "error",
    phase: "auth",
    integrationId: integration.id,
    providerKey: "github",
    error: message,
    output: session.output,
  };
}

function githubAuthPendingResponse(session: GithubAuthSession): unknown {
  return {
    ok: true,
    status: "pending",
    phase: "auth",
    authSessionId: session.id,
    integrationId: session.integrationId,
    providerKey: "github",
    displayName: session.displayName,
    pollTool: "poll_integration_auth",
    verificationUrl: session.verificationUrl || `https://${session.hostname}/login/device`,
    userCode: session.userCode,
    expiresAt: new Date(session.expiresAt).toISOString(),
    qrCodeText: session.verificationUrl || `https://${session.hostname}/login/device`,
    instructions:
      "请把 verificationUrl 和 userCode 原样发给用户。用户在浏览器打开 verificationUrl 并输入 one-time code 完成 GitHub 授权后，调用 poll_integration_auth(authSessionId)。pending 时等待用户完成，不要重复 start_integration_auth。",
  };
}

async function runGithubCli(
  integration: AgentIntegrationRow,
  argv: string[],
  opts?: { timeoutMs?: number },
): Promise<CliCommandResult> {
  const runtime = await resolveIntegrationRuntimeEnv(integration);
  return withIntegrationMutex(runtime.mutexKey, () =>
    runCliCommand(githubCommand(integration), argv, {
      env: {
        ...runtime.env,
        GH_PROMPT_DISABLED: "1",
      },
      cwd: runtime.cwd,
      timeoutMs: opts?.timeoutMs ?? 60_000,
    })
  );
}

async function loadGithubCliIntegration(
  integrationId: string,
  requireAgentId?: string,
): Promise<AgentIntegrationRow> {
  const integration = await getAgentIntegration(integrationId, { requireAgentId });
  if (!integration) throw new Error(`integration not found: ${integrationId}`);
  assertGithubCliIntegration(integration);
  return integration;
}

function assertGithubCliIntegration(integration: AgentIntegrationRow): void {
  if (integration.providerKey !== "github" || integration.transport !== "cli") {
    throw new Error("GitHub auth tools require a github integration using cli transport");
  }
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

function extractGithubDeviceInfo(output: string): { verificationUrl: string | null; userCode: string | null } {
  const url = /(https?:\/\/[^\s]+)/i.exec(output)?.[1] ??
    /Open this URL[^\n:]*:\s*(\S+)/i.exec(output)?.[1] ??
    null;
  const userCode = /one-time code:\s*([A-Z0-9-]+)/i.exec(output)?.[1] ??
    /code:\s*([A-Z0-9-]{4,})/i.exec(output)?.[1] ??
    null;
  return {
    verificationUrl: url ? url.trim().replace(/[),.。]+$/g, "") : null,
    userCode: userCode ? userCode.trim() : null,
  };
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

function normalizeScopes(scope: unknown): string[] {
  if (typeof scope !== "string" || !scope.trim()) return [];
  return scope
    .replace(/[，;]/g, ",")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => /^[a-zA-Z0-9_:.-]+$/.test(item));
}

async function waitForAuthUrlOrExit(session: GithubAuthSession, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.verificationUrl || session.userCode || session.exitCode !== null || session.error) return;
    await sleep(100);
  }
}

function findSession(integrationId: string): GithubAuthSession | null {
  for (const session of sessions.values()) {
    if (session.integrationId === integrationId && Date.now() < session.expiresAt) {
      return session;
    }
  }
  return null;
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now && session.exitCode === null) {
      session.error = "GitHub authorization session expired";
      session.child.kill("SIGTERM");
    }
    if (session.expiresAt + 30 * 60_000 <= now) {
      sessions.delete(id);
    }
  }
}

function isExpired(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("expired") || lower.includes("expire") || lower.includes("timeout");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clampText(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
