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

const DEFAULT_SOUL = `<!-- name: Agent -->
# 我是谁

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

// `model` is the stable app-side id from modelRegistry.MODELS[i].id.
// Day 2: both ark + oneapi adapters are registered, so we can default fresh
// agents to the user's preferred Claude Opus 4.7. If OneAPI is unreachable
// at call time, `resolveModelForCall` falls back to a same-group sibling
// (4.6) and ultimately to doubao-2.0, so there's no risk of a fresh agent
// getting wedged on an unavailable model. Existing agents keep whatever
// was in their config.json (legacy "seed2.0-pro" normalizes via
// getSelectedModel below).
const DEFAULT_CONFIG = {
  model: "claude-opus-4.7",
  temperature: 1.0,
  maxOutputTokens: 20000,
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

  // Phase 4 Day 1: runtime state files. All three are append-only or
  // JSON-patch, so we pre-create them empty to keep read paths simple
  // (no ENOENT branches in hot loops).
  const inboxPath = path.join(root, "state", "inbox.jsonl");
  const cronPath = path.join(root, "state", "cron.json");
  const heartbeatPath = path.join(root, "state", "heartbeat.log");
  if (!(await fileExists(inboxPath))) await fs.writeFile(inboxPath, "", "utf8");
  if (!(await fileExists(cronPath))) {
    await fs.writeFile(cronPath, JSON.stringify({ jobs: SYSTEM_HABITS_SEED }, null, 2), "utf8");
  } else {
    // Sync system habits: add missing + update existing.
    // User-controlled fields preserved: `enabled`, `lastFiredAt`, `schedule`
    // (schedule only preserved if user manually changed it from the seed value).
    try {
      const raw = await fs.readFile(cronPath, "utf8");
      const cronFile = JSON.parse(raw) as { jobs: any[] };
      let changed = false;
      for (const seed of SYSTEM_HABITS_SEED) {
        const existing = cronFile.jobs.find((j: any) => j.id === seed.id);
        if (!existing) {
          // New system habit — add with seedSchedule marker
          cronFile.jobs.push({ ...seed, seedSchedule: seed.schedule });
          changed = true;
        } else if (existing.type === "system") {
          // Update code-owned fields (prompt, displayName, description)
          const textFields: (keyof typeof seed)[] = ["prompt", "displayName", "description"];
          for (const key of textFields) {
            if (existing[key] !== seed[key]) {
              existing[key] = seed[key];
              changed = true;
            }
          }
          // Schedule: only update if user hasn't manually changed it.
          // We track the last seed value in `seedSchedule`. If the user's
          // current schedule still matches the old seed, it's safe to update.
          const userModifiedSchedule = existing.seedSchedule != null
            && existing.schedule !== existing.seedSchedule;
          if (!userModifiedSchedule && existing.schedule !== seed.schedule) {
            existing.schedule = seed.schedule;
            changed = true;
          }
          // Always record latest seed schedule for future comparisons
          if (existing.seedSchedule !== seed.schedule) {
            existing.seedSchedule = seed.schedule;
            changed = true;
          }
        }
      }
      // Remove system habits that are no longer in the seed
      const seedIds = new Set(SYSTEM_HABITS_SEED.map((s) => s.id));
      const before = cronFile.jobs.length;
      cronFile.jobs = cronFile.jobs.filter((j: any) => j.type !== "system" || seedIds.has(j.id));
      if (cronFile.jobs.length !== before) changed = true;

      if (changed) {
        await fs.writeFile(cronPath, JSON.stringify(cronFile, null, 2), "utf8");
      }
    } catch { /* ignore parse errors; file will be overwritten on next write */ }
  }
  if (!(await fileExists(heartbeatPath))) await fs.writeFile(heartbeatPath, "", "utf8");
}

/**
 * Habit prompts — 通用约束(写在每条 prompt 末尾):
 *  · 这是 cron 触发的自动任务,**没有用户在线**。绝不反问、绝不等用户输入,
 *    遇到不确定的地方直接根据 workspace 现有内容推理后执行。
 *  · "根据当前 workspace" 不是空话,必须遍历:list_tables / list_ideas /
 *    list_designs / list_demos + 必要时 get_idea / query_records 等读取细节。
 *  · 输出要落到具体载体(soul/profile / 知识库 / 推荐 prompt 等),不要只
 *    在对话里讲。
 */
const HABIT_COMMON_CONSTRAINTS = `

⚠️ 自动任务硬约束:
- 这是 cron 触发,没有用户在线 → **绝不反问 / 绝不等待 user input**,遇到不确定的地方直接根据 workspace 已有内容推理后执行。
- "当前 workspace" = 必须真的遍历 — 至少调用 list_tables / list_ideas / list_designs / list_demos / list_my_skills 看一遍现状,需要细节再 get_idea / query_records 等深挖。不能只看对话历史就猜。
- 任务必须落到**具体载体**(soul.md / profile.md / 知识库文档 / 推荐 prompt API 等),只在对话里讲不算完成。
- 完成后用一段简短自然语言总结做了什么、写到了哪里。`;

const SYSTEM_HABITS_SEED = [
  {
    id: "habit_system_evolve",
    schedule: "0 2 * * *",
    prompt:
      "遍历当前 workspace 的近期对话(用 list_tables / list_ideas / list_designs / list_demos 先扫一遍现状,然后看最近几条相关对话),提炼用户的偏好 / 工作节奏 / 表达习惯 / 关注点变化,更新 soul.md(我自己的认知)和 profile.md(用户画像)。只追加新发现,不重复已有内容,不删除老条目除非明确发现错误。" +
      HABIT_COMMON_CONSTRAINTS,
    type: "system",
    enabled: false,
    displayName: "自我进化",
    description: "每天 02:00 — 遍历 workspace 提炼新认知,更新 soul + user profile",
  },
  {
    id: "habit_system_suggest",
    schedule: "0 1 * * *",
    prompt:
      "刷新当前 workspace 的 Todo Suggestions。先遍历 workspace(list_tables / list_ideas / list_designs / list_demos / 最近对话),理解用户当下在做什么、卡在哪、下一步可能要什么,然后:" +
      "\n1) 为 Chat 欢迎页生成 3-5 条具体的、可点击就执行的推荐 prompt(不要泛泛'帮我分析数据',要带 workspace 里真实的 artifact 名字);" +
      "\n2) 为 High Agency 模式生成 3 个前沿级别的目标建议(跨多步、有可衡量产出)。" +
      HABIT_COMMON_CONSTRAINTS,
    type: "system",
    enabled: false,
    displayName: "Todo Suggestions",
    description: "每天 01:00 — 基于 workspace 现状刷新 Chat 推荐 + Agency 目标",
  },
  {
    id: "habit_system_learn",
    schedule: "0 3 * * *",
    prompt:
      "基于当前 workspace 的领域去互联网学习新知识。流程严格:" +
      "\n1) 遍历 workspace(list_tables / list_ideas / list_designs / list_demos)+ 读 soul.md / profile.md,识别 1-3 个核心领域 / 主题。" +
      "\n2) 对每个主题做深度调研:多次 web_search(不同角度 / 子话题)+ web_fetch(精读关键页面),收集近期(过去 1 周内优先)的实质性新内容。" +
      "\n3) **必须落到知识库**:用 list_knowledge / search_knowledge 查同主题是否已有文档 → 有则用 learn_from_text 追加更新(注意不要重复已收录的内容),没有则 learn_from_url / learn_from_text 创建新文档。整理成结构化长文(开头一段时间戳标记本次更新),不要短摘要。" +
      "\n4) 用 create_memory 写一条 episodic 记录本次学习的主题和文档 id,方便后续召回。" +
      HABIT_COMMON_CONSTRAINTS,
    type: "system",
    enabled: false,
    displayName: "知识学习",
    description: "每天 03:00 — 基于 workspace 领域上网深度学习,落到知识库(默认关闭)",
  },
  {
    id: "habit_system_workspace_news",
    schedule: "0 4 * * *",
    prompt:
      "搜索当前 workspace 相关的最新行业资讯,直接在对话中呈现给用户(**不要**写入知识库)。流程:" +
      "\n1) 遍历 workspace(list_tables / list_ideas / list_designs / list_demos)+ 读 profile.md,提炼用户关注的 1-3 个行业 / 公司 / 主题关键词。" +
      "\n2) 用 web_search(timeRange:'day' 或 'week')拉最新资讯,每个主题搜 2-3 个查询角度。重要新闻用 web_fetch 看全文。" +
      "\n3) **去重**:这个 habit 复用同一条对话(每天往同一对话里追加),回顾本对话最近几轮的内容,如果某条资讯在过去 7 天讲过(对比标题 / URL / 主旨)就跳过。绝不重复推送昨天讲过的事。" +
      "\n4) 把当天**真正新增**的资讯组织成一段结构化 Markdown 直接输出在对话里(格式:`# YYYY-MM-DD 资讯简报` + 按主题分章节列条目,每条带标题 / 出处 URL / 一两句要点)。如果没有任何新资讯,只回一句 '今日无新增资讯,跳过' 即可。" +
      "\n5) 用 create_memory 写一条 episodic 记录今日抓取的关键词 + 已推送的资讯标题 / URL,作为明天去重的依据。**不要**写入知识库 —— 资讯是时效性内容,不适合长期检索,知识库只放真正的常青知识。" +
      HABIT_COMMON_CONSTRAINTS,
    type: "system",
    enabled: false,
    displayName: "Workspace 资讯",
    description: "每天 04:00 — 抓 workspace 相关行业最新资讯,直接在对话呈现(不入知识库,默认关闭)",
  },
  {
    // 注意:这个 habit 不走 chat agent loop,inboxConsumer 会 special-case
    // 直接调用 workspaceSummaryService.generateForWorkspace —— 因为 slogan
    // 是写入 Workspace.aiSlogan(DB 字段)、TopBar 渲染的,不需要走对话 +
    // tool call,直接一次 LLM 调用更稳定 + 省 token。
    // prompt 字段只是给用户在 Habits tab 看的描述,不会被实际执行。
    id: "habit_system_slogan",
    schedule: "0 8 * * *",
    prompt:
      "刷新当前 workspace 的 AI Slogan(显示在 TopBar 顶部那行 ≤20 字的短句)。" +
      "流程:遍历 workspace 名称 / 描述 / 表 / 灵感 / 画布的标题 → 用 doubao-2.0 生成一句 ≤20 字的中文 slogan → 写回 Workspace.aiSlogan,前端 TopBar 即时刷新。" +
      "由 inboxConsumer 直接调用 workspaceSummaryService.generateForWorkspace,不走 chat agent loop。",
    type: "system",
    enabled: false,
    displayName: "Workspace Slogan",
    description: "每天 08:00 — 基于 workspace 内容刷新 TopBar 的 AI Slogan",
  },
];

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Boot-time migration: scan ALL agent directories and force system habits to disabled.
 * Returns the number of agents that were actually modified.
 */

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

// ─── Selected model (multi-model feature) ─────────────────────────────
//
// The `model` field in AgentConfig is the ModelEntry.id from
// backend/src/services/modelRegistry.ts. These two helpers centralize
// reads/writes so the rest of the codebase doesn't import `readConfig`
// just to get the model string. Legacy agents store the old sentinel
// "seed2.0-pro" (pre-registry); `getSelectedModel` transparently rewrites
// that to "doubao-2.0" on read without needing a migration step.

const LEGACY_MODEL_ALIASES: Record<string, string> = {
  "seed2.0-pro": "doubao-2.0",
  "seed-2.0-pro": "doubao-2.0",
  "seed2.0": "doubao-2.0",
  "doubao": "doubao-2.0",
};

/**
 * Return the agent's preferred model id. Normalizes legacy aliases. Does
 * NOT apply availability fallback — callers that need a runnable model
 * should pipe this id through `resolveModelForCall()` from modelRegistry.
 */
export async function getSelectedModel(agentId: string): Promise<string> {
  const cfg = await readConfig(agentId);
  const raw = (cfg.model || "").trim();
  return LEGACY_MODEL_ALIASES[raw] || raw || "doubao-2.0";
}

/**
 * Persist the agent's model preference. Caller is expected to have
 * validated the id against MODELS (REST handlers do this before calling).
 */
export async function setSelectedModel(agentId: string, modelId: string): Promise<void> {
  await writeConfig(agentId, { model: modelId });
}

// ─── V2.7 B18: per-agent model strength overrides ─────────────────────────
//
// Agent 个性化:registry 给每个模型一组默认 strengths (code-review /
// translation / data-analysis 等),但用户对自己的 agent 可能有独立认知 ——
// "我觉得 doubao-2.0 翻译比 claude 好用" / "我不要 gpt 写代码" 之类。
// 配置存在 agent config.json 的 modelStrengthOverrides 字段:
//   { "doubao-2.0": ["translation", "low-latency"], ... }
// 字段不存在 / 不在 override map 里 → 走 registry 默认。
// 这只影响 routing recommendations 的 hover 标签 / 推荐排序,不影响
// resolveModelForCall (那个仍只看 availability)。

export type ModelStrengthOverrides = Record<string, string[]>;

export async function getModelStrengthOverrides(agentId: string): Promise<ModelStrengthOverrides> {
  const cfg = await readConfig(agentId);
  const raw = cfg.modelStrengthOverrides;
  if (!raw || typeof raw !== "object") return {};
  const out: ModelStrengthOverrides = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      out[k] = v.filter((s) => typeof s === "string").map((s) => String(s));
    }
  }
  return out;
}

/**
 * Replace overrides for one model id. Pass empty array to clear that
 * model's override (then registry default applies).
 */
export async function setModelStrengthOverride(
  agentId: string,
  modelId: string,
  strengths: string[],
): Promise<ModelStrengthOverrides> {
  const current = await getModelStrengthOverrides(agentId);
  const next = { ...current };
  if (strengths.length === 0) {
    delete next[modelId];
  } else {
    next[modelId] = Array.from(new Set(strengths.map((s) => s.trim()).filter(Boolean)));
  }
  await writeConfig(agentId, { modelStrengthOverrides: next });
  return next;
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

// ─── Working memory (turn-by-turn log, gets compressed into episodic) ───

/**
 * One row in working.jsonl. Represents a completed user turn: the user's
 * message, the assistant's final textual reply, and the names of tools the
 * Agent called to fulfill it. Kept intentionally lean — the full tool
 * arguments and SSE chunks are not worth persisting here.
 */
export interface WorkingMemoryEntry {
  timestamp: string; // ISO
  conversationId: string;
  userMessage: string;
  assistantMessage: string;
  toolCalls: string[]; // tool names in invocation order, duplicates preserved
}

// V3.0 PR2: working memory 改为 per-conversation。
//   每个 conversation 一个文件 ~/.imagebase/agents/<id>/memory/working/<convId>.jsonl
//   compaction 也按 convId 跑(自然隔离)。
//
// Legacy 兼容:旧 ~/.imagebase/agents/<id>/memory/working.jsonl 仍可读;
//   一次性迁移由 migrateLegacyWorkingMemory(agentId) 完成,见下方。
function workingMemoryDir(agentId: string): string {
  return path.join(agentDir(agentId), "memory", "working");
}

function workingMemoryPath(agentId: string, convId?: string): string {
  // 兼容旧调用:不传 convId → 旧的扁平路径(只用于 legacy 读)
  if (!convId) return path.join(agentDir(agentId), "memory", "working.jsonl");
  // V3.0 per-conv 路径
  return path.join(workingMemoryDir(agentId), `${convId}.jsonl`);
}

async function ensureWorkingDir(agentId: string): Promise<void> {
  await fs.mkdir(workingMemoryDir(agentId), { recursive: true });
}

export async function appendWorkingMemory(
  agentId: string,
  entry: WorkingMemoryEntry
): Promise<void> {
  await ensureAgentFiles(agentId);
  await ensureWorkingDir(agentId);
  const line = JSON.stringify(entry) + "\n";
  // V3.0:从 entry.conversationId 路由到 per-conv 文件
  const target = workingMemoryPath(agentId, entry.conversationId);
  await fs.appendFile(target, line, "utf8");
}

/**
 * V3.0 PR2: 读 working memory。
 *   - 传 convId → 只读该 conversation 的 working
 *   - 不传 → 读全部 (跨 conv 合并,排序按 timestamp asc) — legacy 兼容
 */
export async function readWorkingMemory(
  agentId: string,
  convId?: string,
): Promise<WorkingMemoryEntry[]> {
  await ensureAgentFiles(agentId);
  if (convId) {
    return readJsonlSafe(workingMemoryPath(agentId, convId));
  }
  // No convId: legacy aggregated read — 把 per-conv 目录下所有文件 + 老的 flat
  // working.jsonl 都读出来按 timestamp 合并,主要给迁移 / 调试用。
  const flat = await readJsonlSafe(workingMemoryPath(agentId));
  let perConv: WorkingMemoryEntry[] = [];
  try {
    const dir = workingMemoryDir(agentId);
    const files = await fs.readdir(dir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      perConv = perConv.concat(await readJsonlSafe(path.join(dir, f)));
    }
  } catch { /* dir not yet created */ }
  return [...flat, ...perConv].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

async function readJsonlSafe(p: string): Promise<WorkingMemoryEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const out: WorkingMemoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }
  return out;
}

export async function clearWorkingMemory(agentId: string, convId?: string): Promise<void> {
  await ensureAgentFiles(agentId);
  if (convId) {
    await ensureWorkingDir(agentId);
    await fs.writeFile(workingMemoryPath(agentId, convId), "", "utf8");
  } else {
    // legacy:清空旧 flat 文件
    await fs.writeFile(workingMemoryPath(agentId), "", "utf8");
  }
}

/**
 * V3.0 PR2 迁移:把老的 ~/.imagebase/agents/<id>/memory/working.jsonl 按
 * entry.conversationId 拆到 working/<convId>.jsonl,重命名老文件成 .bak。
 * 幂等:已迁移过(老文件被改名 / per-conv dir 非空)就直接跳过。
 *
 * 部署时机:agent 第一次被使用 OR 由 scripts/migrate-working-memory-per-conv.ts
 * 一次性扫所有 agent 跑。这里实现成"延迟迁移":在每次 appendWorkingMemory 前
 * 触发一次 try/catch 包裹的 migrate(用 lock 文件防止并发重入)。
 */
export async function migrateLegacyWorkingMemory(agentId: string): Promise<{
  migrated: boolean; movedTurns: number; error?: string;
}> {
  const flatPath = workingMemoryPath(agentId);
  // 已迁移过 → 老文件已改 .bak,直接 skip
  try {
    await fs.access(flatPath);
  } catch {
    return { migrated: false, movedTurns: 0 };
  }
  const entries = await readJsonlSafe(flatPath);
  if (entries.length === 0) {
    // 空文件直接改名,后续 appendWorkingMemory 走 per-conv 即可
    await fs.rename(flatPath, flatPath + ".bak").catch(() => {});
    return { migrated: true, movedTurns: 0 };
  }
  await ensureWorkingDir(agentId);
  // 按 convId 分组
  const byConv = new Map<string, WorkingMemoryEntry[]>();
  for (const e of entries) {
    const convId = e.conversationId || "_legacy_unknown";
    if (!byConv.has(convId)) byConv.set(convId, []);
    byConv.get(convId)!.push(e);
  }
  // 逐 conv 写入 per-conv 文件 (append 模式,不覆盖已存在的内容)
  let total = 0;
  for (const [convId, es] of byConv) {
    const lines = es.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.appendFile(workingMemoryPath(agentId, convId), lines, "utf8");
    total += es.length;
  }
  // 重命名旧文件,留 30 天给运维心理踏实
  await fs.rename(flatPath, flatPath + ".bak").catch(() => {});
  return { migrated: true, movedTurns: total };
}

/**
 * Fold the working-memory log into one episodic markdown file, then truncate
 * the working log. Deterministic (no LLM call) for Phase 2 so tests are
 * hermetic; a Phase 3 variant can swap in an LLM synthesizer.
 *
 * Returns `{compressed: true, filename, turns}` on success, or
 * `{compressed: false, turns}` when the buffer had fewer than `minTurns`
 * and compression was skipped.
 */
export async function compressWorkingMemory(
  agentId: string,
  opts?: { minTurns?: number; conversationId?: string },
): Promise<
  | { compressed: true; filename: string; turns: number }
  | { compressed: false; turns: number }
> {
  const minTurns = Math.max(1, opts?.minTurns ?? 10);
  // V3.0 PR2: 优先按 convId compress;不传 convId 走 legacy aggregate (向后兼容)
  const convId = opts?.conversationId;
  const entries = await readWorkingMemory(agentId, convId);
  if (entries.length < minTurns) {
    return { compressed: false, turns: entries.length };
  }

  // ── Deterministic synthesis ─────────────────────────────────────────
  const firstTs = entries[0].timestamp;
  const lastTs = entries[entries.length - 1].timestamp;
  const dateRange =
    firstTs.slice(0, 10) === lastTs.slice(0, 10)
      ? firstTs.slice(0, 10)
      : `${firstTs.slice(0, 10)} → ${lastTs.slice(0, 10)}`;

  // Top keywords across user messages (token frequency, CJK + Latin).
  const freq = new Map<string, number>();
  for (const e of entries) {
    const toks = e.userMessage.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fa5]+/g) || [];
    for (const t of toks) {
      if (t.length < 2) continue; // drop single-char noise
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const topKeywords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);

  // Tool-call tally.
  const toolFreq = new Map<string, number>();
  for (const e of entries) {
    for (const name of e.toolCalls) {
      toolFreq.set(name, (toolFreq.get(name) ?? 0) + 1);
    }
  }
  const toolSummary = [...toolFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
    .join(", ");

  const title =
    `${dateRange} ` +
    (topKeywords.length
      ? `对话摘要（${topKeywords.slice(0, 3).join(" / ")}）`
      : `对话摘要（${entries.length} 轮）`);

  const bodyLines: string[] = [
    `共 ${entries.length} 轮，对话期 ${dateRange}。`,
    "",
    `## 涉及主题`,
    topKeywords.length ? `关键词：${topKeywords.join("、")}` : "（未识别稳定关键词）",
    "",
    `## 调用过的工具`,
    toolSummary || "（本段无工具调用）",
    "",
    `## 每轮要点`,
  ];
  for (const e of entries) {
    const user = e.userMessage.replace(/\s+/g, " ").slice(0, 120);
    const asst = e.assistantMessage.replace(/\s+/g, " ").slice(0, 160);
    const tools = e.toolCalls.length ? `  工具: ${e.toolCalls.join(", ")}\n` : "";
    bodyLines.push(
      `- **${e.timestamp.slice(11, 19)}** · conv ${e.conversationId.slice(-8)}`,
      `  用户: ${user || "(空)"}`,
      tools ? `  助理: ${asst || "(空)"}` : `  助理: ${asst || "(空)"}`
    );
    if (tools) bodyLines.push(tools.trimEnd());
  }

  const tags = ["working-memory-compaction", ...topKeywords.slice(0, 3)];
  // V3.0 PR2: 把 convId 也写入 episodic 元信息 (tag),方便日后 recall 按 conv 过滤
  if (convId) tags.push(`conv:${convId.slice(-12)}`);
  const { filename } = await appendEpisodicMemory(agentId, {
    title,
    body: bodyLines.join("\n"),
    tags,
  });

  // V3.0:只清掉本 conv 的 working;legacy 模式保留旧行为
  await clearWorkingMemory(agentId, convId);
  return { compressed: true, filename, turns: entries.length };
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

export interface RecallHit extends EpisodicMemorySummary {
  score: number;
  /** Debug: how the score was composed. Useful for tuning + for the Agent to know why a hit surfaced. */
  reasons: {
    keyword: number; // 0..1
    tag: number; // 0..1
    recency: number; // 0..1
    mtimeMs: number;
  };
}

function tokenize(q: string): string[] {
  // Latin words + CJK runs, lowercased.
  const matches = q.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fa5]+/g);
  return matches ? matches.filter((t) => t.length > 0) : [];
}

function countHits(haystack: string, tokens: string[]): number {
  if (!tokens.length) return 0;
  const hay = haystack.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (hay.includes(t)) hits++;
  }
  return hits;
}

/**
 * Rank episodic memories by keyword + tag + recency and return the top N.
 *
 * Scoring (deterministic, no LLM):
 *   score = 3·keywordScore + 2·tagScore + 1·recencyScore
 *   keywordScore = hits / tokens.length, where a "hit" is any query token
 *                  appearing in title, body, or tags (case-insensitive).
 *   tagScore     = matched / requested, where matched is tags that appear in
 *                  the memory's tag set (case-insensitive, exact).
 *   recencyScore = exp(-days_ago / 14), i.e. half-life ≈ 10 days.
 *
 * Hits with score ≤ 0 (no keyword hit AND no tag match AND no query given)
 * fall back to pure recency ranking so `recall_memory` without args still
 * does something reasonable.
 */
export async function recallMemories(
  agentId: string,
  query: string,
  opts?: { tags?: string[]; limit?: number }
): Promise<RecallHit[]> {
  await ensureAgentFiles(agentId);
  const dir = path.join(agentDir(agentId), "memory", "episodic");
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) return [];

  const tokens = tokenize(query || "");
  const requestedTags = (opts?.tags || []).map((t) => t.toLowerCase()).filter(Boolean);
  const now = Date.now();
  const limit = Math.max(1, Math.min(opts?.limit ?? 5, 20));

  const hits: RecallHit[] = [];
  for (const filename of mdFiles) {
    const full = path.join(dir, filename);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const parsed = parseEpisodicMemory(filename, raw);

    const kwHaystack = `${parsed.title}\n${parsed.body}\n${parsed.tags.join(" ")}`;
    const kwCount = countHits(kwHaystack, tokens);
    const keywordScore = tokens.length ? kwCount / tokens.length : 0;

    const tagHits = requestedTags.filter((t) => parsed.tags.includes(t)).length;
    const tagScore = requestedTags.length ? tagHits / requestedTags.length : 0;

    const daysAgo = Math.max(0, (now - stat.mtimeMs) / (1000 * 60 * 60 * 24));
    const recencyScore = Math.exp(-daysAgo / 14);

    const score =
      tokens.length || requestedTags.length
        ? 3 * keywordScore + 2 * tagScore + recencyScore
        : recencyScore; // pure recency when caller gives no signal

    // Drop entries that clearly don't match a non-empty query. Recency-only
    // queries keep everything.
    if ((tokens.length || requestedTags.length) && keywordScore === 0 && tagScore === 0) {
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { body: _b, ...summary } = parsed;
    hits.push({
      ...summary,
      score,
      reasons: {
        keyword: keywordScore,
        tag: tagScore,
        recency: recencyScore,
        mtimeMs: stat.mtimeMs,
      },
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
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
  const updated = await prisma.agent.update({ where: { id: agentId }, data });

  // Sync name into soul.md — keep a structured [Name] block at the top
  if (patch.name !== undefined) {
    try {
      const soul = await readSoul(agentId);
      const nameRegex = /^<!-- name: .* -->\n?/m;
      const nameTag = `<!-- name: ${patch.name.trim()} -->\n`;
      const newSoul = nameRegex.test(soul)
        ? soul.replace(nameRegex, nameTag)
        : nameTag + soul;
      await writeSoul(agentId, newSoul);
    } catch { /* non-fatal */ }
  }

  return updated;
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

/**
 * Owner name used to compose the default agent name.
 *
 * There is no auth in the project yet, so there's no "logged-in user" to pull
 * from — the single-tenant owner is configured via the `USER_NAME` env var
 * (defaults to "Quan"). Changing it does not rename an already-customized
 * agent: we only apply the template on fresh install or on the explicit
 * "Claw → template" one-shot migration below.
 */
const USER_NAME = process.env.USER_NAME?.trim() || "Quan";
const DEFAULT_AGENT_NAME = `${USER_NAME}'s Agent`;

export function getDefaultAgentName(): string {
  return DEFAULT_AGENT_NAME;
}

export async function ensureDefaultAgent(): Promise<AgentMeta> {
  const existing = await prisma.agent.findUnique({ where: { id: DEFAULT_AGENT_ID } });
  if (existing) {
    // One-shot migration: rows seeded before the rename feature landed used
    // the legacy "Claw" literal. If nobody has customized it since, bump it
    // to the new `${USER_NAME}'s Agent` template so fresh UX matches spec.
    // Any custom name (anything != "Claw") is left untouched.
    if (existing.name === "Claw" && DEFAULT_AGENT_NAME !== "Claw") {
      const migrated = await prisma.agent.update({
        where: { id: existing.id },
        data: { name: DEFAULT_AGENT_NAME },
      });
      await ensureAgentFiles(migrated.id);
      return migrated;
    }
    // Make sure the filesystem is in sync even if DB row existed without it.
    await ensureAgentFiles(existing.id);
    return existing;
  }
  return createAgent({
    id: DEFAULT_AGENT_ID,
    userId: DEFAULT_USER_ID,
    name: DEFAULT_AGENT_NAME,
  });
}

// ─── Phase 4 · Runtime state files ───
//
// state/ holds three runtime artifacts. They live on the filesystem (not DB)
// for the same reason soul.md does — the Agent owns them, they should be
// greppable for humans, and a rogue heartbeat loop won't DoS Postgres.
//
//   state/heartbeat.log   — append-only JSONL, one line per tick
//   state/inbox.jsonl     — append-only JSONL, one line per inbound message
//   state/cron.json       — { jobs: [{ id, schedule, prompt, ... }] }

/** Cross-user listing used by the runtime loop to iterate every agent. */
export async function listAllAgents(): Promise<AgentMeta[]> {
  return prisma.agent.findMany({ orderBy: { createdAt: "asc" } });
}

export interface HeartbeatLogEntry {
  timestamp: string; // ISO
  tickId: string;    // uuid-lite, unique per loop tick
  outcome: "idle" | "triggered" | "error";
  // Free-form details keyed by subsystem (inbox/cron/consolidator). Kept
  // loose in Day 1 so later phases can grow the payload without schema churn.
  details?: Record<string, unknown>;
}

function heartbeatLogPath(agentId: string): string {
  return path.join(agentDir(agentId), "state", "heartbeat.log");
}

export async function appendHeartbeatLog(
  agentId: string,
  entry: HeartbeatLogEntry
): Promise<void> {
  await ensureAgentFiles(agentId);
  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(heartbeatLogPath(agentId), line, "utf8");
}

export async function readHeartbeatLog(
  agentId: string,
  opts?: { tail?: number }
): Promise<HeartbeatLogEntry[]> {
  await ensureAgentFiles(agentId);
  let raw: string;
  try {
    raw = await fs.readFile(heartbeatLogPath(agentId), "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const all: HeartbeatLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      all.push(JSON.parse(t));
    } catch {
      // Skip corrupted line, keep going.
    }
  }
  const tail = opts?.tail;
  return tail && tail > 0 && all.length > tail ? all.slice(-tail) : all;
}

export interface InboxMessage {
  id: string;
  timestamp: string; // ISO
  source: "cron" | "mention" | "webhook" | "system";
  subject: string;
  body?: string;
  /** If set, the message is unread. Cleared when the Agent processes it. */
  unread: boolean;
  /** Free-form payload carried from the producer. */
  meta?: Record<string, unknown>;
}

function inboxPath(agentId: string): string {
  return path.join(agentDir(agentId), "state", "inbox.jsonl");
}

export async function appendInboxMessage(
  agentId: string,
  msg: Omit<InboxMessage, "id" | "timestamp" | "unread"> & { id?: string; timestamp?: string; unread?: boolean }
): Promise<InboxMessage> {
  await ensureAgentFiles(agentId);
  const full: InboxMessage = {
    id: msg.id ?? `inbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: msg.timestamp ?? new Date().toISOString(),
    source: msg.source,
    subject: msg.subject,
    body: msg.body,
    unread: msg.unread ?? true,
    meta: msg.meta,
  };
  await fs.appendFile(inboxPath(agentId), JSON.stringify(full) + "\n", "utf8");
  return full;
}

export async function readInbox(
  agentId: string,
  opts?: { onlyUnread?: boolean; limit?: number }
): Promise<InboxMessage[]> {
  await ensureAgentFiles(agentId);
  let raw: string;
  try {
    raw = await fs.readFile(inboxPath(agentId), "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const out: InboxMessage[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const msg = JSON.parse(t) as InboxMessage;
      if (opts?.onlyUnread && !msg.unread) continue;
      out.push(msg);
    } catch {
      // Skip corrupted line.
    }
  }
  const limit = opts?.limit;
  return limit && limit > 0 && out.length > limit ? out.slice(-limit) : out;
}

/**
 * Mark one inbox message as read (unread=false). Rewrites inbox.jsonl in
 * full — fine at our scale where inboxes are small. Returns the updated
 * message or `null` if the id wasn't found.
 */
export async function ackInboxMessage(
  agentId: string,
  messageId: string
): Promise<InboxMessage | null> {
  await ensureAgentFiles(agentId);
  let raw: string;
  try {
    raw = await fs.readFile(inboxPath(agentId), "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  const all: InboxMessage[] = [];
  let found: InboxMessage | null = null;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const msg = JSON.parse(t) as InboxMessage;
      if (msg.id === messageId && msg.unread) {
        msg.unread = false;
        found = msg;
      } else if (msg.id === messageId) {
        // Already read — return it but no rewrite needed yet; keep going
        // to preserve JSONL layout.
        found = msg;
      }
      all.push(msg);
    } catch {
      // Skip corrupted line; preserving it would re-corrupt the rewrite.
    }
  }
  if (!found) return null;
  // Atomic-ish rewrite: write to temp path then rename.
  const target = inboxPath(agentId);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, all.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
  await fs.rename(tmp, target);
  return found;
}

export async function inboxUnreadCount(agentId: string): Promise<number> {
  const msgs = await readInbox(agentId, { onlyUnread: true });
  return msgs.length;
}

export interface CronJob {
  id: string;
  schedule: string;    // cron expression, e.g. "0 17 * * 5"
  prompt: string;      // Task the Agent should run when fired
  workspaceId?: string;
  skills?: string[];
  /** ISO timestamp of last fire, or null if never. */
  lastFiredAt?: string | null;
  /** Freeform meta the scheduler can stash (next-fire cache, retry count, etc.). */
  meta?: Record<string, unknown>;
  /** "system" = pre-seeded habit, "user" = user-created. Default "user". */
  type?: "system" | "user";
  /** Whether this job is active. Default true. */
  enabled?: boolean;
  /** Human-readable name for UI display. */
  displayName?: string;
  /** Brief description of what this habit does. */
  description?: string;
  /** Message ID of the last execution result in inbox. */
  lastResult?: string;
}

export interface CronFile {
  jobs: CronJob[];
}

function cronPath(agentId: string): string {
  return path.join(agentDir(agentId), "state", "cron.json");
}

export async function readCron(agentId: string): Promise<CronFile> {
  await ensureAgentFiles(agentId);
  const raw = await fs.readFile(cronPath(agentId), "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.jobs)) return parsed as CronFile;
  } catch {
    // fallthrough to default
  }
  return { jobs: [] };
}

export async function writeCron(agentId: string, file: CronFile): Promise<void> {
  await ensureAgentFiles(agentId);
  const serialized = JSON.stringify(file, null, 2);
  assertSize(serialized, "state/cron.json");
  await fs.writeFile(cronPath(agentId), serialized, "utf8");
}
