import fsp from "fs/promises";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
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
const secretServiceLocks = new Map<string, Promise<void>>();
const secretServiceWarnings = new Set<string>();

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
  const xdgRuntimeDir = path.join(sandboxRoot, ".xdg", "runtime");
  const runtimeEnv: Record<string, string> = {
    PATH: process.env.PATH || DEFAULT_PATH,
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || process.env.LANG || "C.UTF-8",
    HOME: sandboxRoot,
    XDG_CONFIG_HOME: path.join(sandboxRoot, ".config"),
    XDG_DATA_HOME: path.join(sandboxRoot, ".local", "share"),
    XDG_CACHE_HOME: path.join(sandboxRoot, ".cache"),
    XDG_RUNTIME_DIR: xdgRuntimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(xdgRuntimeDir, "bus")}`,
    GNOME_KEYRING_CONTROL: path.join(xdgRuntimeDir, "keyring"),
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
  if (needsSecretService(integration)) {
    await ensureSecretService(sandboxRoot, runtimeEnv);
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
    fsp.mkdir(path.join(sandboxRoot, ".local", "share", "keyrings"), { recursive: true, mode: 0o700 }),
    fsp.mkdir(path.join(sandboxRoot, ".cache"), { recursive: true, mode: 0o700 }),
    fsp.mkdir(path.join(sandboxRoot, ".xdg", "runtime"), { recursive: true, mode: 0o700 }),
    fsp.mkdir(path.join(sandboxRoot, "tmp"), { recursive: true, mode: 0o700 }),
  ]);
  await fsp.chmod(sandboxRoot, 0o700).catch(() => {});
  return sandboxRoot;
}

function safeSegment(value: string): string {
  const out = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return out || "unknown";
}

function needsSecretService(integration: AgentIntegrationRow): boolean {
  return integration.providerKey === "lark" || integration.config.enableSecretService === true;
}

async function ensureSecretService(
  sandboxRoot: string,
  runtimeEnv: Record<string, string>,
): Promise<void> {
  const existing = secretServiceLocks.get(sandboxRoot);
  if (existing) return existing;
  const lock = doEnsureSecretService(sandboxRoot, runtimeEnv)
    .catch((err) => {
      warnSecretServiceOnce(
        sandboxRoot,
        `[integrationRuntimeEnv] Secret Service init failed for ${sandboxRoot}: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      if (secretServiceLocks.get(sandboxRoot) === lock) secretServiceLocks.delete(sandboxRoot);
    });
  secretServiceLocks.set(sandboxRoot, lock);
  return lock;
}

async function doEnsureSecretService(
  sandboxRoot: string,
  runtimeEnv: Record<string, string>,
): Promise<void> {
  const runtimeDir = runtimeEnv.XDG_RUNTIME_DIR;
  const keyringDir = runtimeEnv.GNOME_KEYRING_CONTROL;
  if (!runtimeDir || !keyringDir) return;

  await Promise.all([
    fsp.mkdir(runtimeDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(keyringDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(path.join(sandboxRoot, ".local", "share", "keyrings"), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    fsp.chmod(runtimeDir, 0o700).catch(() => {}),
    fsp.chmod(keyringDir, 0o700).catch(() => {}),
  ]);

  const missing = ["dbus-daemon", "gdbus", "gnome-keyring-daemon"]
    .filter((command) => !commandAvailable(command, runtimeEnv));
  if (missing.length) {
    warnSecretServiceOnce(
      sandboxRoot,
      `[integrationRuntimeEnv] Secret Service unavailable for ${sandboxRoot}; missing ${missing.join(", ")}. Lark CLI auth tokens may not persist.`,
    );
    return;
  }

  if (probeSecretService(runtimeEnv)) return;

  const busPath = path.join(runtimeDir, "bus");
  if (!probeSessionBus(runtimeEnv)) {
    await fsp.unlink(busPath).catch(() => {});
    spawnSync("dbus-daemon", [
      "--session",
      `--address=unix:path=${busPath}`,
      "--fork",
    ], {
      env: runtimeEnv,
      stdio: "ignore",
      timeout: 5_000,
    });
  }

  if (probeSecretService(runtimeEnv)) return;

  await ensureLoginKeyringFile(sandboxRoot);
  const started = spawnSync("gnome-keyring-daemon", [
    "--start",
    "--daemonize",
    "--components=secrets",
    `--control-directory=${keyringDir}`,
  ], {
    env: runtimeEnv,
    encoding: "utf8",
    timeout: 5_000,
  });
  applyExportedEnv(runtimeEnv, started.stdout);
  applyExportedEnv(runtimeEnv, started.stderr);

  for (let i = 0; i < 50; i += 1) {
    if (probeSecretService(runtimeEnv)) break;
    await sleep(100);
  }
  if (!probeSecretService(runtimeEnv)) {
    warnSecretServiceOnce(
      sandboxRoot,
      `[integrationRuntimeEnv] Secret Service did not become ready for ${sandboxRoot}. Lark CLI auth tokens may not persist.`,
    );
    return;
  }

  createLoginCollection(runtimeEnv);
}

async function ensureLoginKeyringFile(sandboxRoot: string): Promise<void> {
  const file = path.join(sandboxRoot, ".local", "share", "keyrings", "login.keyring");
  const exists = await fsp.stat(file).then(() => true, () => false);
  if (exists) return;
  const now = Math.floor(Date.now() / 1000);
  await fsp.writeFile(
    file,
    [
      "[keyring]",
      "display-name=Login",
      `ctime=${now}`,
      `mtime=${now}`,
      "lock-on-idle=false",
      "lock-after=false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function commandAvailable(command: string, env: Record<string, string>): boolean {
  const result = spawnSync("which", [command], {
    env,
    stdio: "ignore",
    timeout: 2_000,
  });
  return !result.error && result.status === 0;
}

function probeSessionBus(env: Record<string, string>): boolean {
  const result = spawnSync("gdbus", [
    "introspect",
    "--session",
    "--dest",
    "org.freedesktop.DBus",
    "--object-path",
    "/org/freedesktop/DBus",
  ], {
    env,
    stdio: "ignore",
    timeout: 3_000,
  });
  return !result.error && result.status === 0;
}

function probeSecretService(env: Record<string, string>): boolean {
  const result = spawnSync("gdbus", [
    "introspect",
    "--session",
    "--dest",
    "org.freedesktop.secrets",
    "--object-path",
    "/org/freedesktop/secrets",
  ], {
    env,
    stdio: "ignore",
    timeout: 3_000,
  });
  return !result.error && result.status === 0;
}

function createLoginCollection(env: Record<string, string>): void {
  spawnSync("gdbus", [
    "call",
    "--session",
    "--dest",
    "org.freedesktop.secrets",
    "--object-path",
    "/org/freedesktop/secrets",
    "--method",
    "org.freedesktop.secrets.Service.CreateCollection",
    "{'org.freedesktop.Secret.Collection.Label': <'login'>}",
    "login",
  ], {
    env,
    input: "",
    stdio: "ignore",
    timeout: 5_000,
  });
  spawnSync("gdbus", [
    "call",
    "--session",
    "--dest",
    "org.freedesktop.secrets",
    "--object-path",
    "/org/freedesktop/secrets",
    "--method",
    "org.freedesktop.secrets.Service.SetAlias",
    "login",
    "/org/freedesktop/secrets/collection/login",
  ], {
    env,
    stdio: "ignore",
    timeout: 5_000,
  });
}

function applyExportedEnv(env: Record<string, string>, text?: string | Buffer | null): void {
  if (!text) return;
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    if (match[1] === "GNOME_KEYRING_CONTROL" || match[1] === "GNOME_KEYRING_PID") {
      env[match[1]] = match[2];
    }
  }
}

function warnSecretServiceOnce(key: string, message: string): void {
  if (secretServiceWarnings.has(key)) return;
  secretServiceWarnings.add(key);
  console.warn(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
