import fsp from "fs/promises";
import os from "os";
import path from "path";
import type { AgentIntegrationRow } from "./types.js";
import { loadCredentialValues } from "./integrationStore.js";

export interface IntegrationRuntimeEnv {
  sandboxRoot: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  credentials: Record<string, string>;
  cwd: string;
  mutexKey: string;
}

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const queues = new Map<string, Promise<unknown>>();

export async function resolveIntegrationRuntimeEnv(
  integration: AgentIntegrationRow,
  opts?: {
    credentials?: Record<string, string>;
    includeProcessEnv?: boolean;
  },
): Promise<IntegrationRuntimeEnv> {
  const credentials = opts?.credentials ?? (
    integration.id === "__inspect__" ? {} : await loadCredentialValues(integration.id)
  );
  const sandboxRoot = await ensureSandboxRoot(integration);
  const runtimeEnv: Record<string, string> = {
    PATH: process.env.PATH || DEFAULT_PATH,
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || process.env.LANG || "C.UTF-8",
    HOME: sandboxRoot,
    XDG_CONFIG_HOME: path.join(sandboxRoot, ".config"),
    XDG_DATA_HOME: path.join(sandboxRoot, ".local", "share"),
    XDG_CACHE_HOME: path.join(sandboxRoot, ".cache"),
    TMPDIR: path.join(sandboxRoot, "tmp"),
    AGENT_ID: integration.agentId,
    INTEGRATION_ID: integration.id,
    INTEGRATION_PROVIDER: integration.providerKey,
    ...credentials,
    ...resolveEnvMap(integration.config.envMap, credentials),
  };
  if (opts?.includeProcessEnv) {
    Object.assign(runtimeEnv, toStringMap(process.env), runtimeEnv);
  }
  return {
    sandboxRoot,
    cwd: sandboxRoot,
    env: runtimeEnv,
    headers: resolveHeaders(
      integration.config.headers,
      integration.config.headersFromCredentials,
      credentials,
    ),
    credentials,
    mutexKey: `${integration.providerKey}:${integration.agentId}:${integration.id}`,
  };
}

export async function withIntegrationMutex<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const released = next.catch(() => undefined);
  queues.set(key, released);
  released.finally(() => {
    if (queues.get(key) === released) queues.delete(key);
  });
  return next;
}

export function resolveEnvMap(
  envMap: unknown,
  credentials: Record<string, string>,
): Record<string, string> {
  if (!envMap || typeof envMap !== "object" || Array.isArray(envMap)) return {};
  const out: Record<string, string> = {};
  for (const [envName, credentialName] of Object.entries(envMap as Record<string, unknown>)) {
    if (typeof credentialName !== "string") continue;
    if (credentials[credentialName] !== undefined) out[envName] = credentials[credentialName];
  }
  return out;
}

export function resolveHeaders(
  rawHeaders: unknown,
  headersFromCredentials: unknown,
  credentials: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  if (
    headersFromCredentials &&
    typeof headersFromCredentials === "object" &&
    !Array.isArray(headersFromCredentials)
  ) {
    for (const [headerName, credentialName] of Object.entries(headersFromCredentials as Record<string, unknown>)) {
      if (typeof credentialName !== "string") continue;
      if (credentials[credentialName] !== undefined) headers[headerName] = credentials[credentialName];
    }
  }
  return headers;
}

export function toStringMap(input: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

async function ensureSandboxRoot(integration: AgentIntegrationRow): Promise<string> {
  const root = process.env.INTEGRATION_SANDBOX_ROOT ||
    path.join(os.homedir(), ".imagebase", "integration-sandboxes");
  const sandboxRoot = path.join(
    root,
    safeSegment(integration.providerKey),
    safeSegment(integration.agentId),
    safeSegment(integration.id),
  );
  await Promise.all([
    fsp.mkdir(path.join(sandboxRoot, ".config"), { recursive: true, mode: 0o700 }),
    fsp.mkdir(path.join(sandboxRoot, ".local", "share"), { recursive: true, mode: 0o700 }),
    fsp.mkdir(path.join(sandboxRoot, ".cache"), { recursive: true, mode: 0o700 }),
    fsp.mkdir(path.join(sandboxRoot, "tmp"), { recursive: true, mode: 0o700 }),
  ]);
  await fsp.chmod(sandboxRoot, 0o700).catch(() => {});
  return sandboxRoot;
}

function safeSegment(value: string): string {
  const out = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return out || "unknown";
}
