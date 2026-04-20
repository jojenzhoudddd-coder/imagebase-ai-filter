/**
 * agentService — Agent identity filesystem I/O + Prisma CRUD.
 *
 * Every Agent owns a directory at `~/.imagebase/agents/<agentId>/` that
 * holds its human-readable identity (soul.md / profile.md / config.json)
 * plus scaffolding for memory / skills / mcp-servers / plugins / state.
 *
 * DB (Prisma `Agent` row) only stores metadata (name, avatarUrl, ownership).
 * The filesystem is the canonical store for identity content — this keeps
 * things greppable for humans and also lines up with the plan's goal of
 * "Agent can self-edit soul.md via a meta-tool".
 *
 * Override the root path with `AGENT_HOME` env var (used by tests).
 */

import fs from "fs/promises";
import path from "path";
import os from "os";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

// ─── Filesystem helpers ───

/** Size cap per identity doc (bytes). 64 KiB per file is plenty for prompts. */
const MAX_IDENTITY_BYTES = 64 * 1024;

function agentHomeRoot(): string {
  const override = process.env.AGENT_HOME;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), ".imagebase", "agents");
}

export function agentDir(agentId: string): string {
  // Defensive: agentId is a cuid() — no slashes — but guard anyway.
  if (!agentId || /[/\\]/.test(agentId)) {
    throw new Error(`invalid agentId: ${agentId}`);
  }
  return path.join(agentHomeRoot(), agentId);
}

const DEFAULT_SOUL = `# 我是谁

我是一位 OpenClaw-style 的长期 Agent。我属于用户本人，不绑定任何单个
工作空间；我的记忆、偏好、风格会随着你和我的每一次协作持续演进。

## 风格

- 直接、简洁
- 中文优先（除非你在用英文）
- 遇到不确定的事情先问清楚，不要猜
- 长程任务主动拆步骤，每步告诉你正在做什么
- 每一次调用工具前，先用一句自然语言说明我要做什么
`;

const DEFAULT_PROFILE = `# 用户画像

_尚未收集到稳定的用户信息。等我们多聊几轮后，我会把你的偏好、习惯、
常用工作空间写到这里。_
`;

const DEFAULT_CONFIG = {
  model: "seed2.0-pro",
  temperature: 0.1,
  maxOutputTokens: 4096,
  enabledSkills: [] as string[],
};

/** Create the agent's filesystem skeleton if it doesn't exist. Idempotent. */
export async function ensureAgentFiles(agentId: string): Promise<void> {
  const root = agentDir(agentId);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, "memory", "episodic"), { recursive: true });
  await fs.mkdir(path.join(root, "memory", "semantic"), { recursive: true });
  await fs.mkdir(path.join(root, "skills"), { recursive: true });
  await fs.mkdir(path.join(root, "mcp-servers"), { recursive: true });
  await fs.mkdir(path.join(root, "plugins"), { recursive: true });
  await fs.mkdir(path.join(root, "state"), { recursive: true });

  const soulPath = path.join(root, "soul.md");
  const profilePath = path.join(root, "profile.md");
  const configPath = path.join(root, "config.json");
  const workingPath = path.join(root, "memory", "working.jsonl");

  if (!(await fileExists(soulPath))) await fs.writeFile(soulPath, DEFAULT_SOUL, "utf8");
  if (!(await fileExists(profilePath))) await fs.writeFile(profilePath, DEFAULT_PROFILE, "utf8");
  if (!(await fileExists(configPath)))
    await fs.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
  if (!(await fileExists(workingPath))) await fs.writeFile(workingPath, "", "utf8");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function assertSize(content: string, label: string) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_IDENTITY_BYTES) {
    throw new Error(`${label} 超过大小上限 (${bytes} > ${MAX_IDENTITY_BYTES} bytes)`);
  }
}

// ─── Identity read/write ───

export async function readSoul(agentId: string): Promise<string> {
  await ensureAgentFiles(agentId);
  return fs.readFile(path.join(agentDir(agentId), "soul.md"), "utf8");
}

export async function writeSoul(agentId: string, content: string): Promise<void> {
  await ensureAgentFiles(agentId);
  assertSize(content, "soul.md");
  await fs.writeFile(path.join(agentDir(agentId), "soul.md"), content, "utf8");
}

export async function readProfile(agentId: string): Promise<string> {
  await ensureAgentFiles(agentId);
  return fs.readFile(path.join(agentDir(agentId), "profile.md"), "utf8");
}

export async function writeProfile(agentId: string, content: string): Promise<void> {
  await ensureAgentFiles(agentId);
  assertSize(content, "profile.md");
  await fs.writeFile(path.join(agentDir(agentId), "profile.md"), content, "utf8");
}

export interface AgentConfig {
  model: string;
  temperature: number;
  maxOutputTokens: number;
  enabledSkills: string[];
  [k: string]: unknown;
}

export async function readConfig(agentId: string): Promise<AgentConfig> {
  await ensureAgentFiles(agentId);
  const raw = await fs.readFile(path.join(agentDir(agentId), "config.json"), "utf8");
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Shallow-merge patch into config.json. Unknown keys preserved. */
export async function writeConfig(agentId: string, patch: Partial<AgentConfig>): Promise<AgentConfig> {
  const current = await readConfig(agentId);
  const next = { ...current, ...patch };
  const serialized = JSON.stringify(next, null, 2);
  assertSize(serialized, "config.json");
  await fs.writeFile(path.join(agentDir(agentId), "config.json"), serialized, "utf8");
  return next;
}

// ─── Episodic memory (write-only in Phase 1) ───

export interface EpisodicMemoryInput {
  title: string;
  body: string;
  tags?: string[];
}

/** Append a markdown episode to memory/episodic/. Filename: YYYY-MM-DD_slug.md */
export async function appendEpisodicMemory(
  agentId: string,
  mem: EpisodicMemoryInput
): Promise<{ path: string; filename: string }> {
  await ensureAgentFiles(agentId);
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = mem.title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "episode";
  const rand = Math.random().toString(36).slice(2, 6);
  const filename = `${stamp}_${slug}_${rand}.md`;
  const full = path.join(agentDir(agentId), "memory", "episodic", filename);
  const body = [
    `# ${mem.title}`,
    "",
    mem.tags && mem.tags.length ? `Tags: ${mem.tags.map((t) => `#${t}`).join(" ")}` : null,
    `Timestamp: ${new Date().toISOString()}`,
    "",
    mem.body.trim(),
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
  assertSize(body, `memory/episodic/${filename}`);
  await fs.writeFile(full, body, "utf8");
  return { path: full, filename };
}

// ─── Episodic memory (read) ───

export interface EpisodicMemorySummary {
  filename: string;
  title: string;
  timestamp: string | null; // ISO-ish string from the `Timestamp:` line, or null
  tags: string[];
  preview: string; // first ~200 chars of body, for listing
  bytes: number;
}

export interface EpisodicMemoryFull extends EpisodicMemorySummary {
  body: string; // full body excluding the header metadata
}

/**
 * Parse a single episodic markdown file into structured metadata + body.
 * Matches the format written by `appendEpisodicMemory`:
 *   # <title>
 *   Tags: #tag1 #tag2          (optional)
 *   Timestamp: 2026-04-20T...
 *
 *   <body...>
 */
function parseEpisodicMemory(filename: string, raw: string): EpisodicMemoryFull {
  const lines = raw.split(/\r?\n/);
  let title = filename.replace(/\.md$/, "");
  let timestamp: string | null = null;
  const tags: string[] = [];

  // Header region: "# title" line, then 0+ blank/metadata lines (Tags:, Timestamp:),
  // then a blank separator, then body. We consume any prefix that looks like
  // header metadata and treat everything after as body. Metadata lines can
  // appear in any order; blank lines between them are tolerated.
  let i = 0;
  if (lines[0]?.startsWith("# ")) {
    title = lines[0].slice(2).trim();
    i = 1;
  }
  const HEADER_MAX = 12;
  let lastHeaderIdx = i - 1;
  for (; i < Math.min(lines.length, HEADER_MAX); i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // blank gap inside header
    const tagMatch = line.match(/^Tags:\s*(.+)$/);
    if (tagMatch) {
      tagMatch[1]
        .split(/\s+/)
        .map((t) => t.replace(/^#/, "").trim())
        .filter(Boolean)
        .forEach((t) => tags.push(t));
      lastHeaderIdx = i;
      continue;
    }
    const tsMatch = line.match(/^Timestamp:\s*(.+)$/);
    if (tsMatch) {
      timestamp = tsMatch[1].trim();
      lastHeaderIdx = i;
      continue;
    }
    // First non-blank non-metadata line → start of body.
    break;
  }
  // Skip one blank separator line between header and body if present.
  let bodyStart = lastHeaderIdx + 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") bodyStart++;

  const body = lines.slice(bodyStart).join("\n").trim();
  const preview = body.slice(0, 200).replace(/\s+/g, " ").trim();
  return {
    filename,
    title,
    timestamp,
    tags,
    preview,
    bytes: Buffer.byteLength(raw, "utf8"),
    body,
  };
}

/**
 * List episodic memory summaries, newest first (by file mtime).
 * Returns previews only — for the full body, use `readEpisodicMemory`.
 */
export async function listEpisodicMemories(
  agentId: string,
  opts?: { limit?: number; tag?: string }
): Promise<EpisodicMemorySummary[]> {
  await ensureAgentFiles(agentId);
  const dir = path.join(agentDir(agentId), "memory", "episodic");
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const mdFiles = files.filter((f) => f.endsWith(".md"));

  // Sort by mtime desc — filename prefix is a date but not precise enough
  // when multiple episodes land on the same day.
  const withStat = await Promise.all(
    mdFiles.map(async (f) => {
      const full = path.join(dir, f);
      const stat = await fs.stat(full);
      return { filename: f, mtimeMs: stat.mtimeMs };
    })
  );
  withStat.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const limit = Math.max(1, Math.min(opts?.limit ?? 20, 100));
  const picked = withStat.slice(0, limit);

  const summaries: EpisodicMemorySummary[] = [];
  for (const { filename } of picked) {
    try {
      const raw = await fs.readFile(path.join(dir, filename), "utf8");
      const parsed = parseEpisodicMemory(filename, raw);
      if (opts?.tag && !parsed.tags.includes(opts.tag.toLowerCase())) continue;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { body: _body, ...summary } = parsed;
      summaries.push(summary);
    } catch {
      // Skip unreadable files; they shouldn't block the whole list.
    }
  }
  return summaries;
}

/** Load one episodic memory file by filename. Returns null if not found. */
export async function readEpisodicMemory(
  agentId: string,
  filename: string
): Promise<EpisodicMemoryFull | null> {
  // Guard against path traversal.
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new Error(`invalid filename: ${filename}`);
  }
  if (!filename.endsWith(".md")) {
    throw new Error(`expected .md filename: ${filename}`);
  }
  await ensureAgentFiles(agentId);
  const full = path.join(agentDir(agentId), "memory", "episodic", filename);
  try {
    const raw = await fs.readFile(full, "utf8");
    return parseEpisodicMemory(filename, raw);
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

// ─── Prisma CRUD ───

export interface AgentMeta {
  id: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listAgents(userId: string): Promise<AgentMeta[]> {
  return prisma.agent.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
}

export async function getAgent(agentId: string): Promise<AgentMeta | null> {
  return prisma.agent.findUnique({ where: { id: agentId } });
}

export async function createAgent(input: {
  userId: string;
  name?: string;
  avatarUrl?: string | null;
  id?: string;
}): Promise<AgentMeta> {
  const agent = await prisma.agent.create({
    data: {
      id: input.id, // allow fixed-id seeding (agent_default)
      userId: input.userId,
      name: input.name?.trim() || "Agent",
      avatarUrl: input.avatarUrl ?? null,
    },
  });
  await ensureAgentFiles(agent.id);
  return agent;
}

export async function updateAgent(
  agentId: string,
  patch: { name?: string; avatarUrl?: string | null }
): Promise<AgentMeta | null> {
  const existing = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!existing) return null;
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name.trim() || "Agent";
  if (patch.avatarUrl !== undefined) data.avatarUrl = patch.avatarUrl;
  return prisma.agent.update({ where: { id: agentId }, data });
}

/** Delete the DB row only. Filesystem is preserved as a safety measure
 *  (identity + memory loss is irreversible, so we never auto-delete). */
export async function deleteAgentRow(agentId: string): Promise<boolean> {
  const existing = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!existing) return false;
  await prisma.agent.delete({ where: { id: agentId } });
  return true;
}

// ─── Default agent ───

const DEFAULT_USER_ID = "user_default";
const DEFAULT_AGENT_ID = "agent_default";

export async function ensureDefaultAgent(): Promise<AgentMeta> {
  const existing = await prisma.agent.findUnique({ where: { id: DEFAULT_AGENT_ID } });
  if (existing) {
    // Make sure the filesystem is in sync even if DB row existed without it.
    await ensureAgentFiles(existing.id);
    return existing;
  }
  return createAgent({
    id: DEFAULT_AGENT_ID,
    userId: DEFAULT_USER_ID,
    name: "Claw",
  });
}
