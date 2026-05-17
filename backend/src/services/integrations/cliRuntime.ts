import { spawn } from "child_process";
import type { AgentIntegrationRow, IntegrationToolManifest } from "./types.js";
import {
  resolveIntegrationRuntimeEnv,
  withIntegrationMutex,
} from "./integrationRuntimeEnv.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 512 * 1024;

export interface CliCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

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
  const runtime = await resolveIntegrationRuntimeEnv(integration);
  const result = await withIntegrationMutex(runtime.mutexKey, () =>
    runCliCommand(command, argv, {
      env: runtime.env,
      cwd: runtime.cwd,
      timeoutMs: tool.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
  );
  const stdout = result.stdout.trim();
  if (tool.output === "json") {
    try {
      return JSON.parse(stdout);
    } catch {
      return { raw: stdout, note: "CLI output was not valid JSON; returned raw text." };
    }
  }
  return stdout;
}

export function resolveCliArgTemplates(templates: string[], args: Record<string, any>): string[] {
  return resolveArgTemplates(templates, args);
}

export function runCliCommand(
  command: string,
  args: string[],
  opts: {
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    cwd?: string;
    stdin?: string;
    outputLimit?: number;
  },
): Promise<CliCommandResult> {
  return spawnCapture(command, args, {
    env: opts.env,
    cwd: opts.cwd,
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputLimit: opts.outputLimit ?? OUTPUT_LIMIT,
  });
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

function spawnCapture(
  command: string,
  args: string[],
  opts: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    cwd?: string;
    stdin?: string;
    outputLimit: number;
  },
): Promise<CliCommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const child = spawn(command, args, {
      env: opts.env,
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`CLI tool timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs).unref();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > opts.outputLimit) {
        child.kill("SIGTERM");
        finish(() => reject(new Error(`CLI output exceeded ${opts.outputLimit} chars`)));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
    child.on("error", (err) => {
      finish(() => reject(err));
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(() => resolve({ stdout, stderr, code: code ?? 0 }));
        return;
      }
      const detail = (stderr.trim() || stdout.trim()).slice(0, 2000);
      finish(() => reject(new Error(`CLI exited with ${code}: ${detail}`)));
    });
  });
}
