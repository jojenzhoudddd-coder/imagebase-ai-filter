import { spawn } from "child_process";
import type { AgentIntegrationRow, IntegrationToolManifest } from "./types.js";
import { loadCredentialValues } from "./integrationStore.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 512 * 1024;

export async function runCliIntegrationTool(
  integration: AgentIntegrationRow,
  tool: IntegrationToolManifest,
  args: Record<string, any>,
): Promise<unknown> {
  const command = String(tool.command || integration.config.command || "").trim();
  if (!command) {
    throw new Error(`Integration ${integration.displayName} has no CLI command configured`);
  }
  if (/[;&|`$<>]/.test(command)) {
    throw new Error("CLI command must be a binary/path, not a shell expression");
  }
  const argv = resolveArgTemplates(tool.args ?? [], args);
  const credentials = integration.id === "__inspect__"
    ? {}
    : await loadCredentialValues(integration.id);
  const env = {
    ...process.env,
    ...credentials,
    ...resolveEnvMap(integration.config.envMap, credentials),
  };
  const stdout = await spawnCapture(command, argv, {
    env,
    timeoutMs: tool.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (tool.output === "json") {
    try {
      return JSON.parse(stdout);
    } catch {
      return { raw: stdout, note: "CLI output was not valid JSON; returned raw text." };
    }
  }
  return stdout;
}

function resolveArgTemplates(templates: string[], args: Record<string, any>): string[] {
  const argv: string[] = [];
  for (const template of templates) {
    const exact = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/.exec(template);
    if (exact) {
      const v = readPath(args, exact[1]);
      if (Array.isArray(v)) {
        for (const item of v) argv.push(sanitizeArgValue(item));
        continue;
      }
    }
    argv.push(resolveArgTemplate(template, args));
  }
  return argv;
}

function resolveArgTemplate(template: string, args: Record<string, any>): string {
  const value = template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key: string) => {
    const v = readPath(args, key);
    if (v === undefined || v === null || v === "") {
      if (key === "limit") return "20";
      if (key === "params" || key === "data" || key === "filter") return "{}";
      return "";
    }
    return stringifyArgValue(v);
  });
  if (value.includes("\u0000")) {
    throw new Error("CLI arguments may not contain NUL bytes");
  }
  return value;
}

function sanitizeArgValue(value: unknown): string {
  const out = stringifyArgValue(value);
  if (out.includes("\u0000")) {
    throw new Error("CLI arguments may not contain NUL bytes");
  }
  return out;
}

function stringifyArgValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function readPath(obj: Record<string, any>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object") return undefined;
    return (acc as any)[key];
  }, obj);
}

function resolveEnvMap(
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

function spawnCapture(
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: opts.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI tool timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs).unref();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > OUTPUT_LIMIT) {
        child.kill("SIGTERM");
        reject(new Error(`CLI output exceeded ${OUTPUT_LIMIT} chars`));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const detail = (stderr.trim() || stdout.trim()).slice(0, 2000);
      reject(new Error(`CLI exited with ${code}: ${detail}`));
    });
  });
}
