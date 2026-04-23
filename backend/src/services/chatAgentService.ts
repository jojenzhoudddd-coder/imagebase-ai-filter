/**
 * Chat Agent Service — the core of the Table Agent feature.
 *
 * Responsibilities:
 *  - Accept a user message + conversation history + workspaceId
 *  - Call Volcano ARK (Seed 2.0 pro) with thinking enabled, streaming output
 *  - Run a multi-turn tool loop: intercept tool calls, execute via in-process
 *    MCP tools registry, feed results back to the model
 *  - Yield SSE events (thinking / message / tool_start / tool_result /
 *    confirm / error / done) for the route handler to forward to the client
 *
 * Design references:
 *  - docs/chat-sidebar-plan.md Phase 2 (agent loop)
 *  - docs/chat-sidebar-plan.md Phase 2.1.1 (end-to-end streaming)
 *  - docs/chat-sidebar-plan.md Phase 3.2 (context assembly)
 *  - backend/src/services/aiService.ts (reference pattern for ARK Responses API)
 */

import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import {
  allTools,
  toolsByName,
  isDangerousTool,
  resolveActiveTools,
} from "../../mcp-server/src/tools/index.js";
import { allSkills, skillsByName } from "../../mcp-server/src/skills/index.js";
import type { ToolDefinition, ToolContext } from "../../mcp-server/src/tools/tableTools.js";
import * as convStore from "./conversationStore.js";
import type { Message, ToolCall } from "./conversationStore.js";
import * as store from "./dbStore.js";
import { readSoul, readProfile, getAgent } from "./agentService.js";
import * as agentSvc from "./agentService.js";
import { resolveModelForCall, resolveAdapter, type ModelEntry } from "./modelRegistry.js";
import * as ideaStream from "./ideaStreamSessionService.js";
import { LongTaskTracker } from "./longTaskService.js";
import { listHandlesIfExists } from "./analyst/duckdbRuntime.js";
// Importing providers/index.ts registers every adapter with modelRegistry.
// Must happen before the first runAgent() call. Don't remove the import
// even though `arkAdapter` is not referenced by name here.
import "./providers/index.js";
import type { ProviderInputItem, ProviderStreamEvent } from "./providers/types.js";

// Pushed up from 10 per user request. Seed can chain dozens of tool calls in
// a single CRM-build turn; cap is only a last-resort runaway guard.
const MAX_TOOL_ROUNDS = 50;
// Day 4: once working.jsonl holds this many turns, the next turn triggers a
// compression pass that folds them into one episodic memory file.
const WORKING_MEMORY_COMPRESS_THRESHOLD = 10;

// ─── Phase 3 · Per-conversation skill activation state ─────────────────
//
// Skills (Tier 2) are opt-in. We track the set of active skills per
// conversationId in-memory — losing it on backend restart just means the
// Agent has to re-activate the skill one more time, which is cheap
// (a single round-trip to call `activate_skill`). Persisting to DB would be
// over-engineering until we see eviction thrash in real traffic.
//
// Eviction: if a skill's tools haven't been invoked for
// SKILL_EVICTION_TURNS consecutive assistant turns on this conversation,
// it's dropped from the active set. Keeps context lean on long-running
// conversations that pivot away from a skill's domain.
const SKILL_EVICTION_TURNS = 10;

interface ConvSkillState {
  /** Skill names currently active for this conversation. */
  active: Set<string>;
  /** turnIndex at which each active skill was last used. */
  lastUsedTurn: Map<string, number>;
  /** Monotonically-incrementing turn counter for this conversation. */
  turnIndex: number;
}

const skillStateByConv = new Map<string, ConvSkillState>();

function getOrInitSkillState(conversationId: string): ConvSkillState {
  let s = skillStateByConv.get(conversationId);
  if (!s) {
    s = { active: new Set(), lastUsedTurn: new Map(), turnIndex: 0 };
    skillStateByConv.set(conversationId, s);
  }
  return s;
}

/** Map tool-name → owning skill name (for tracking lastUsedTurn on tool invocation). */
const skillNameForTool: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const s of allSkills) {
    for (const t of s.tools) m.set(t.name, s.name);
  }
  return m;
})();

/**
 * Auto-activate any skill whose `triggers` match the user's turn message.
 * Mutates `state.active` in place. Called once per turn before we build the
 * tool list for ARK. Keeps the user out of the "explicit activate_skill"
 * round trip when their intent is obvious from keywords.
 */
function autoActivateByTriggers(state: ConvSkillState, userMessage: string): string[] {
  const added: string[] = [];
  for (const skill of allSkills) {
    if (state.active.has(skill.name)) continue;
    const hit = skill.triggers.some((pat) =>
      typeof pat === "string" ? userMessage.includes(pat) : pat.test(userMessage)
    );
    if (hit) {
      state.active.add(skill.name);
      state.lastUsedTurn.set(skill.name, state.turnIndex);
      added.push(skill.name);
    }
  }
  return added;
}

/**
 * Evict skills whose tools haven't been invoked for SKILL_EVICTION_TURNS
 * consecutive turns. Called at end-of-turn. Returns the dropped names.
 *
 * Analyst P1: honors `softDeps`. If skill A is active and lists B as a
 * softDep, B's lastUsedTurn is refreshed to the current turn before the
 * eviction sweep — i.e. A keeps B alive. Intentionally non-transitive
 * (see SkillDefinition.softDeps docstring).
 */
function evictStaleSkills(state: ConvSkillState): string[] {
  // Refresh softDep lastUsedTurn so protected skills survive this sweep.
  for (const name of state.active) {
    const deps = skillsByName[name]?.softDeps;
    if (!deps) continue;
    for (const dep of deps) {
      if (state.active.has(dep)) {
        state.lastUsedTurn.set(dep, state.turnIndex);
      }
    }
  }
  const dropped: string[] = [];
  for (const name of state.active) {
    const lastUsed = state.lastUsedTurn.get(name) ?? state.turnIndex;
    if (state.turnIndex - lastUsed >= SKILL_EVICTION_TURNS) {
      state.active.delete(name);
      state.lastUsedTurn.delete(name);
      dropped.push(name);
    }
  }
  return dropped;
}

/**
 * Process `_suggestActivate` hints from a tool's output — activate any named
 * skill that isn't already active. Safe to call with any JSON-parsed output;
 * non-matching shapes are ignored.
 *
 * Added P1 · cooperative skill activation for cross-skill workflows
 * (e.g. analyst-skill suggesting idea-skill before writing results).
 */
function processSuggestActivate(
  parsedOutput: unknown,
  state: ConvSkillState,
  logFn: (entry: Record<string, unknown>) => void,
): string[] {
  const hints = (parsedOutput as { _suggestActivate?: unknown } | null)?._suggestActivate;
  if (!Array.isArray(hints)) return [];
  const newly: string[] = [];
  for (const h of hints) {
    const name = (h as { skill?: unknown })?.skill;
    if (typeof name !== "string") continue;
    if (!skillsByName[name]) continue;
    if (state.active.has(name)) continue;
    state.active.add(name);
    state.lastUsedTurn.set(name, state.turnIndex);
    newly.push(name);
    logFn({
      event: "skill_activated",
      skill: name,
      reason: "suggest_activate",
      hint: (h as { reason?: string })?.reason,
    });
  }
  return newly;
}

// ─── Logging ───
const LOG_DIR = path.resolve("logs");
const LOG_FILE = path.join(LOG_DIR, "Chat Agent 日志.log");

function gmt8ts(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().replace("Z", "+08:00");
}

function logAgent(entry: Record<string, unknown>) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ timestamp: gmt8ts(), ...entry }) + "\n", "utf-8");
  } catch (err) {
    // Logging failures should never break the agent loop
    console.warn("[chatAgent] log failed:", err);
  }
}

// ─── System Prompt (three-layer structure, plan §3) ─────────────────────
//
//   Layer 1: META  — hardcoded, immutable. Meta-behavior + safety red lines.
//                    The Agent cannot edit this via update_soul.
//   Layer 2: IDENTITY — dynamic. Loaded from the Agent's own soul.md and
//                       profile.md at ~/.imagebase/agents/<id>/. The Agent
//                       edits these via update_soul / update_profile (Day 4).
//   Tool Guidance   — current Table-Agent operational knowledge. This is a
//                     stopgap until Tier 1/2 skills land; it would ideally
//                     move into the table-skill's instructions.md.
//   Layer 3: TURN CONTEXT — per-turn workspace snapshot (built elsewhere).

const META_SYSTEM_PROMPT = `# Layer 1 · Meta（OpenClaw Agent 元规则）

你是一位 OpenClaw-style 的长期 Agent。你属于用户本人，不绑定任何单个工作空间；
你的身份（soul）、用户画像（profile）、长期记忆（memory）都持久化在你的
文件系统里，会随着每一次协作演进。

## 身份与记忆的读取方式（非常重要，不要搞错）
- 下方 **Layer 2 · Identity** 就是你当前的 soul.md 和 profile.md 的 **完整实时内容**，
  已经在 system prompt 里加载好了。用户问"你的 soul 是什么 / 自我介绍 / 性格"时，
  **直接从 Layer 2 回答**，不要说"我没有读取 soul 的工具"——那是错的。
- 下方 **Layer 3 · Turn Context** 里的"自动召回的相关长期记忆"已经把最相关的
  几条 episodic 记忆摘要放进来了。想看更早 / 更全的记忆再调用 \`recall_memory\`
  或 \`read_memory\`。
- \`update_soul\` / \`update_profile\` / \`create_memory\` 是 **写入** 工具；读是已经
  通过 system prompt 注入完成的，不需要再调工具读。

## 元行为规则（每轮对话必须遵守）
1. 当你从对话中识别到稳定的用户偏好 / 习惯 / 关键事实（如：常用语言、工作时区、
   项目上下文），调用 \`update_profile\` 把它写进 profile.md。
2. 当你认为自己需要调整沟通风格、口吻、价值观时，调用 \`update_soul\` 修改 soul.md。
3. 当这一轮发生了值得长期记住的事情（重要任务、关键决策、长程目标），调用
   \`create_memory\` 写一条 episodic 记忆。
4. 当用户提起过去的事、或你需要回溯长程目标 / 决策时，优先调用
   \`recall_memory\`（传一段关键词或 tags 拿到 top-K 最相关的摘要）；只有当
   你已经知道具体 filename 或想浏览最近全部记忆时才用 \`read_memory\`。
5. 调用工具前先用一两句自然语言说明即将做什么（不用 Markdown 代码块）。
6. 工具调用失败连续 ≥ 3 次时，停下来询问用户如何继续，不要盲目重试。
7. 不确定用户意图时，先问清楚再动手，不要猜。

## 安全红线（不可突破）
- 带 "⚠️" 的删除 / 重置类工具，必须先用自然语言向用户解释并等待二次确认。
- 跨 workspace 操作（例如 \`switch_workspace\`、在 B workspace 写入基于 A 数据的
  内容）必须先向用户确认。
- 不得尝试修改本 Meta 层（Layer 1）的内容。本层不可写。

## 输出约束
- 自然语言与工具调用交错输出，不要用 Markdown 代码块包裹自然语言回复。
- 回复使用用户的主要语言（可从 profile 读到，默认中文）。
- **Chat 回复排版（严格）**：这是一个 350px 宽的对话气泡，不是博客正文：
  - 不要用一级/二级/三级标题（\`#\`/\`##\`/\`###\`）。需要强调时用 **加粗** 即可。
  - 段落之间最多一个空行，**不要出现连续 2 个以上换行**。
  - **不要用缩进式代码块**（4 空格起始会被 Markdown 当代码块，一大块灰底）。真要贴代码就用 \`\`\`fence\`\`\`。
  - 列表项保持一行一件事，不要在列表项里塞连续空行。
  - 表格用 GFM \`| --- |\` 语法，前端会自动渲染为虚拟滚动容器。`;

// Table Agent-specific operational knowledge. Until the table-skill lands in
// Phase 3 this stays in the prompt; it lives below the Identity block so the
// model treats it as "current tool guidance" rather than identity.
// ─── Phase 3 Day 3 · Skill catalog block for system prompt ──────────────
//
// Tier 2 skills are hidden behind `activate_skill` by default, so without
// some form of advertisement the model has no way to know they exist. We
// render a compact catalog (name + when + tool count + active flag) and
// inject it just after the tool-guidance block so Seed can spot the right
// bundle without having to call `find_skill` first.
//
// Keep this tight: each skill is one line. Heavy per-tool detail stays in
// the tools themselves once they're activated.
function buildSkillCatalog(activeSkillNames: string[]): string {
  if (!allSkills.length) return "";
  const activeSet = new Set(activeSkillNames);
  const lines: string[] = [
    "# Tier 2 · 可激活技能目录（Skill Catalog）",
    "默认只有 Tier 0（记忆 / 身份 / skill 路由）和 Tier 1（list_tables / get_table）工具。",
    "当用户的需求落在以下场景时，先调 activate_skill({name}) 把对应技能挂进来，下一轮就能调用里面的工具。",
    "已 active 的技能会标记为 ✅；无需重复激活。",
    "",
  ];
  for (const s of allSkills) {
    const flag = activeSet.has(s.name) ? "✅ " : "";
    lines.push(
      `- ${flag}**${s.name}** (${s.displayName}, ${s.tools.length} 个工具) — ${s.when}`
    );
  }
  lines.push("");
  lines.push(
    "触发匹配时我们会自动替你激活（如用户说「创建字段」「删除记录」「加视图」），你只需关心业务逻辑。找不到对应能力时先 find_skill 看完整目录。"
  );
  return lines.join("\n");
}

const TOOL_GUIDANCE_ZH = `# 当前工具使用指南（Tier 1 Core MCP）
- 需要了解现状时先调 list_tables / get_table / list_fields / query_records
- 批量操作优先使用 batch_ 系列（减少轮次）
- 创建复杂表时顺序：create_table → **先用 update_field 改造默认主字段**（见下条）→ 再逐个 create_field 追加其余字段 → **先 batch_delete_records 删掉默认 5 条空记录** → batch_create_records 写入真实数据
- **create_table 会自动生成一个默认 Text 类型主字段（中文名 "名称"），返回值里的 primaryField 字段给出它的 id / name / type。** 当用户期望的第一列与默认主字段不一致（例如要求第一列叫 "客户名称" / "需求ID" 或类型为 AutoNumber/SingleSelect 等）时，你必须调用 update_field 把这个默认主字段就地修改成用户想要的第一列（name/type/config），绝对不要再额外 create_field 一个新的第一列，否则会出现两个语义重复的字段。只有在用户明确表达"保留默认名称字段"时才跳过此步。
- **create_table 还会自动生成 5 条空记录占位。若用户要求你往新表里写入真实数据（而不是保留空白表），在 batch_create_records 之前必须先 query_records 拿到这 5 条空记录的 id，再 batch_delete_records 把它们删掉**（此调用需要用户确认，你要在自然语言里提前说明"先清理默认空记录再写入数据"）。只有用户明确说"保留空白记录"或"在现有基础上追加"时才跳过此步。
- 创建 SingleSelect/MultiSelect 字段时，config.options 的每项要包含 name 和 color（如 '#FFE2D9'）
- 包含"姓名"或以"人"结尾的字段使用 User 类型
- 生成 SingleSelect/MultiSelect 的 options 时，color 用以下任一：#FFE2D9 #FFEBD1 #FFF5C2 #DFF5C9 #CCEBD9 #CFE8F5 #D9E0FC #E5D9FC #F4D9F5 #F9CFD3
- 字段的 config 必须符合每种类型的规范（Number 带 numberFormat，Currency 带 currencyCode 等）

## 灵感文档（Ideas）写入与 @ 引用
- 对灵感文档进行任何写入操作前，先调 \`list_ideas\` 看现状；需要在特定章节插入时，先调 \`get_idea\` 拿到 sections[]（每项含 slug），再用 \`insert_into_idea({ideaId, anchor:{section:"<slug>", mode:"append"|"after"|"replace"}, payload:"..."})\`。
- 没有明确章节目标时用 \`append_to_idea\`（默认追加到文末）；整篇重写才用 \`replace_idea_content\`（危险操作，必须先征得同意）。
- 写入内容允许 **Markdown 嵌入 HTML**：前端使用 rehype-raw + rehype-sanitize 渲染，允许 \`<div>\`、\`<figure>\`、\`<table>\`、\`<pre>\`、内联 SVG 等大部分常见块级标签。若要用 HTML 做排版，写闭合良好的成对标签，不要混入 \`<script>/<style>/onclick="..."\`（会被净化移除）。
- 写入 @ 提及其他实体（视图 / 设计切片 / 其他灵感 / 灵感章节）时：**先调 \`find_mentionable\` 得到命中的 \`markdown\` 字段**，直接把该 markdown 片段拼进 payload 即可形成可点击的 chip。格式规范是 \`[@标签](mention://type/id[?query])\`——不要手写这个格式，以免 ID / query 参数不一致导致死链。

## @ 引用的反向关系与删除安全
- 每个 mention 链接会被后端索引为一条 Mention 行。删除被引用的实体前，先调 \`list_incoming_mentions({targetType, targetId})\` 看有哪些文档在引用它。\`idea-section\` 的 targetId 用 "<ideaId>#<slug>" 组合键。
- 当你即将调用带 ⚠️ 的删除工具（如 \`delete_idea\`、\`delete_table\`）时：
  1. 先用自然语言说明"即将删除 X，现有 N 处引用来自 …"，把影响面列清。
  2. 等用户在 UI 的确认卡片上点"确认"后，才会带 \`confirmed:true\` 重新触发同一个工具调用并真正执行。
  3. 如果 \`list_incoming_mentions\` 返回非空但用户仍坚持删除，执行删除后记得在自然语言总结里提醒"对应的 @ 链接将变成死链"，方便用户后续修复。`;

// ─── Layer 2 · Agent Identity ────────────────────────────────────────────

/**
 * Build Layer 2 (Agent Identity) from the agent's soul.md + profile.md.
 * Falls back to placeholders when the agent has no filesystem yet — this
 * should not happen at runtime because ensureDefaultAgent runs on boot, but
 * we stay resilient so a missing agent never crashes the turn.
 */
async function buildIdentityLayer(agentId: string): Promise<string> {
  let soul = "";
  let profile = "";
  let agentName = "Agent";
  try {
    const agent = await getAgent(agentId);
    if (agent?.name) agentName = agent.name;
    soul = await readSoul(agentId);
  } catch {
    soul = "(soul.md 不可读，使用默认身份)";
  }
  try {
    profile = await readProfile(agentId);
  } catch {
    profile = "(profile.md 不可读)";
  }
  return [
    `# Layer 2 · Identity（${agentName} · agentId=${agentId}）`,
    "",
    "## Soul（身份，来自 soul.md）",
    soul.trim(),
    "",
    "## User Profile（用户画像，来自 profile.md）",
    profile.trim(),
  ].join("\n");
}

// ─── Auto-recall (Day 3): surface top memories for the current turn ─────
//
// Every turn we run recallMemories(userMessage) and inject the top-K hits
// into Layer 3. This is cheap (filesystem scan + scoring, no LLM call) and
// means the Agent doesn't have to explicitly call recall_memory to notice
// "we've talked about this before" — the relevant history is already in
// context.
//
// Tight budget on purpose: top 3 hits, previews only. The Agent can still
// call read_memory / recall_memory for more depth if it needs the full body.

const AUTO_RECALL_LIMIT = 3;

export async function buildRecalledMemoriesSection(
  agentId: string,
  userMessage: string
): Promise<string> {
  try {
    const hits = await agentSvc.recallMemories(agentId, userMessage, {
      limit: AUTO_RECALL_LIMIT,
    });
    if (!hits.length) return "";
    const lines: string[] = [
      `# 自动召回的相关长期记忆（top ${hits.length}，供参考，不一定都有关）`,
    ];
    for (const h of hits) {
      const ts = h.timestamp ? h.timestamp.slice(0, 10) : "(no-date)";
      const tagStr = h.tags.length ? ` [${h.tags.map((t) => `#${t}`).join(" ")}]` : "";
      lines.push(`- (${ts}) **${h.title}**${tagStr}`);
      if (h.preview) lines.push(`  ${h.preview}`);
      lines.push(`  filename: ${h.filename}（想看全文就调用 read_memory）`);
    }
    return lines.join("\n");
  } catch (err) {
    // Never let auto-recall kill a turn.
    return `# 自动召回的相关长期记忆\n(召回失败: ${err instanceof Error ? err.message : String(err)})`;
  }
}

// ─── Runtime layer: tell the Agent which model it's actually running on ─
//
// Without this the model has no idea what it is — OneAPI's Claude Code
// wrapper (and some upstream providers) inject their own "You are Claude
// Code" identity that we explicitly work around in oneapiAdapter.ts, but the
// Agent still needs a positive statement of its own model to answer the
// very common user question "你目前是什么模型". Belt-and-suspenders: we
// also include the app-side id so if the user shares a transcript the
// runtime is unambiguous.
function buildRuntimeLayer(
  model: ModelEntry,
  requestedId: string | null | undefined,
  usedFallback: boolean
): string {
  const lines: string[] = ["# 运行时信息（Runtime）"];
  const groupLabel =
    model.group === "anthropic" ? "Anthropic"
    : model.group === "openai" ? "OpenAI"
    : model.group === "volcano" ? "Volcano（火山方舟）"
    : model.group;
  lines.push(
    `当前实际运行的模型：**${model.displayName}**（id: \`${model.id}\`，厂商：${groupLabel}，provider: ${model.provider}）。`
  );
  if (usedFallback && requestedId && requestedId !== model.id) {
    lines.push(
      `注意：用户为此 Agent 保存的偏好模型是 \`${requestedId}\`，但当前不可用，已临时回退到同组可用模型 \`${model.id}\`。偏好保持不变，一旦 \`${requestedId}\` 恢复可用会自动切回。`
    );
  }
  lines.push(
    "当用户询问你当前使用的是什么模型 / 你是谁的模型 / 底层是哪个 LLM 时，**以上面这段为准**回答。不要自称 Claude Code、不要泛泛自称「一个 AI 助手」、也不要编造厂商或版本。"
  );
  return lines.join("\n");
}

// ─── Analyst handles (context injection) ────────────────────────────────
//
// Cross-turn result references. tool_result payloads aren't replayed to the
// model on subsequent turns (see `assembleInput` below — only assistant text
// content is). Without this section, the Agent genuinely can't reference a
// handle from an earlier turn even though the underlying DuckDB result is
// still in _result_meta.
//
// We surface up to 10 most-recent handles per conversation. Cheap — one
// DuckDB SELECT on _result_meta, skipped entirely for conversations that
// never touched analyst (no .duckdb file yet).

const ANALYST_HANDLES_LIMIT = 10;

async function buildAnalystHandlesSection(conversationId: string): Promise<string> {
  try {
    const handles = await listHandlesIfExists(conversationId);
    if (!handles.length) return "";
    const lines: string[] = [
      "# 最近的 Analyst 结果（仍然可用）",
      "",
      "列表项格式： `<handle>` · SQL 表名 `<duckdbTable>` · <产生工具> · <行数> · [字段…] · <时间>",
      "",
    ];
    for (const h of handles.slice(0, ANALYST_HANDLES_LIMIT)) {
      const ts = h.producedAt ? h.producedAt.slice(5, 16).replace("T", " ") : "?";
      const fieldStr = h.fields
        .slice(0, 6)
        .map((f) => f.name)
        .join(", ");
      const ellipsis = h.fields.length > 6 ? `…+${h.fields.length - 6}` : "";
      const descSuffix = h.description ? ` — ${h.description}` : "";
      lines.push(
        `- \`${h.handle}\` · SQL 表名 \`${h.duckdbTable}\` · ${h.producedBy} · ${h.rowCount} 行 · [${fieldStr}${ellipsis}]${descSuffix} · ${ts}`,
      );
    }
    lines.push("");
    lines.push(
      "**两种名字的用法（千万别搞混）**：",
    );
    lines.push(
      "- 调用 MCP 工具（group_aggregate / pivot_result / write_analysis_to_idea 等）的 `handle` 参数 → 用 **`ducktbl_xxxxxxxxxxxx`**（上面第 1 列）",
    );
    lines.push(
      "- 写 `run_sql` 里的 FROM 子句 → 用 **`r_xxxxxxxxxxxx`**（上面第 2 列，即 duckdbTable）。注：即便你写成 `FROM ducktbl_xxx` 也能 run（后端自动翻译），但写对能省一次重试。",
    );
    lines.push("");
    lines.push(
      "用户说「保存这个结果 / 整理成文档 / 存为新表」等意图词时，**使用最顶部（最新）handle** 调 write_analysis_to_idea / write_analysis_to_table；不要回「handle 丢了」。",
    );
    return lines.join("\n");
  } catch (err) {
    // Don't let a DuckDB hiccup kill the turn — just log and return empty.
    // Without the log the same issue that surfaced as "HTTP 500" in the
    // FE becomes invisible.
    logAgent({
      event: "analyst_handles_section_failed",
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

// ─── Workspace snapshot (context injection) ──────────────────────────────

async function buildWorkspaceSnapshot(workspaceId: string): Promise<string> {
  try {
    const tables = await store.listTablesForWorkspace(workspaceId);
    // Idea listing goes through prisma directly to avoid pulling the full
    // content column on every turn — we only need the sidebar view here, and
    // idea content can be megabytes. The HTTP endpoint does the same cheap
    // select when `includeContent` is omitted; duplicating the query locally
    // saves one HTTP round trip per turn.
    let ideas: Array<{ id: string; name: string; updatedAt: Date }> = [];
    try {
      ideas = await ideaListForSnapshot(workspaceId);
    } catch {
      // Non-fatal — just means ideas section is empty for this turn.
    }

    const hasTables = tables && tables.length > 0;
    const hasIdeas = ideas.length > 0;
    if (!hasTables && !hasIdeas) {
      return `# 当前工作空间状态\n工作空间 ${workspaceId} 目前没有任何数据表或灵感文档。`;
    }

    const lines: string[] = [`# 当前工作空间状态（${workspaceId}）`];
    if (hasTables) {
      lines.push("## 数据表（Tables）");
      for (const t of tables) {
        const detail = await store.getTable(t.id);
        if (!detail) continue;
        const fieldList = detail.fields
          .map((f) => `${f.name}:${f.type}`)
          .join(", ");
        lines.push(
          `- ${detail.name} (${detail.id}): 字段 [${fieldList}]，记录 ${detail.records.length} 条，视图 ${detail.views.length} 个`
        );
      }
    }
    if (hasIdeas) {
      if (hasTables) lines.push("");
      lines.push("## 灵感文档（Ideas）");
      for (const i of ideas) {
        // Keep each line short — we're advertising existence, not content.
        // The agent can list_ideas / get_idea when it needs detail or section
        // slugs for anchor writes.
        const ts = i.updatedAt.toISOString().slice(0, 10);
        lines.push(`- ${i.name} (${i.id}), 最近更新 ${ts}`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `# 当前工作空间状态\n(获取失败: ${err instanceof Error ? err.message : String(err)})`;
  }
}

// Lightweight idea list for the snapshot. Separate helper keeps Prisma import
// scoped and easy to stub in tests.
async function ideaListForSnapshot(
  workspaceId: string
): Promise<Array<{ id: string; name: string; updatedAt: Date }>> {
  const { PrismaClient } = await import("../generated/prisma/client.js");
  const pg = await import("pg");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  // Reuse a cached client so we don't open a new pool per turn. Module-scope
  // cache keyed by DATABASE_URL — backend overall has one in most places,
  // but chatAgentService is called from multiple modules so we guard.
  const pool = getPool(pg.default);
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  return prisma.idea.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, updatedAt: true },
  });
}
let _sharedPool: any = null;
function getPool(pg: any) {
  if (_sharedPool) return _sharedPool;
  _sharedPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return _sharedPool;
}

// ─── Context assembly (sliding window + snapshot) ────────────────────────

// Input-item shape comes from the provider abstraction. Today it matches the
// ARK Responses API schema verbatim; Day 2 (OneAPI adapter) will introduce
// a provider-agnostic canonical format and each adapter will serialize from it.
type ArkInputItem = ProviderInputItem;

async function assembleInput(
  conversationId: string,
  workspaceId: string,
  agentId: string,
  newUserMessage: string,
  activeSkillNames: string[] = [],
  runtime?: {
    model: ModelEntry;
    requestedId: string | null | undefined;
    usedFallback: boolean;
  }
): Promise<ArkInputItem[]> {
  const [identity, snapshot, recalled, analystHandles] = await Promise.all([
    buildIdentityLayer(agentId),
    buildWorkspaceSnapshot(workspaceId),
    buildRecalledMemoriesSection(agentId, newUserMessage),
    buildAnalystHandlesSection(conversationId),
  ]);
  // Layer 1 + Layer 2 + Skill Catalog + Tool Guidance + Layer 3. Layer 1 is
  // hardcoded at the very top so no amount of identity mutation can override
  // meta behavior. The skill catalog sits between identity and tool guidance
  // so the model reads "who am I → what bundles can I pull in → how do I use
  // the ones already loaded" in order. Layer 3 Turn Context stacks runtime
  // info + workspace snapshot + auto-recalled memories (Phase 2 Day 3); we
  // skip empty pieces to keep the prompt tight. Runtime goes first in Layer
  // 3 because "what model am I" is the most frequently asked meta-question
  // and also the cheapest to surface.
  const layer3Parts: string[] = [];
  if (runtime) {
    layer3Parts.push(buildRuntimeLayer(runtime.model, runtime.requestedId, runtime.usedFallback));
  }
  layer3Parts.push(snapshot);
  if (recalled) layer3Parts.push(recalled);
  if (analystHandles) layer3Parts.push(analystHandles);
  const skillCatalog = buildSkillCatalog(activeSkillNames);
  const systemParts = [META_SYSTEM_PROMPT, identity];
  if (skillCatalog) systemParts.push(skillCatalog);
  systemParts.push(TOOL_GUIDANCE_ZH);
  // Per-skill prompt fragments for currently-active skills. Each skill that
  // declares `promptFragment` contributes one block so the model sees its
  // domain rules alongside Tier 1 guidance. Skipped when no active skills
  // have fragments (keeps prompt tight for vanilla conversations).
  const activeFragments: string[] = [];
  for (const name of activeSkillNames) {
    const frag = skillsByName[name]?.promptFragment;
    if (frag && frag.trim()) {
      activeFragments.push(`# Active Skill · ${name}\n${frag.trim()}`);
    }
  }
  if (activeFragments.length) {
    systemParts.push(activeFragments.join("\n\n"));
  }
  systemParts.push(`# Layer 3 · Turn Context\n${layer3Parts.join("\n\n")}`);
  const systemText = systemParts.join("\n\n");

  const history = await convStore.getMessages(conversationId);
  // Sliding window: last 20 messages (plan Phase 3.2)
  const windowed = history.slice(-20);

  const input: ArkInputItem[] = [
    { role: "system", content: [{ type: "input_text", text: systemText }] },
  ];

  // Add conversation summary if present (for long conversations)
  const conv = await convStore.getConversation(conversationId);
  if (conv?.summary) {
    input.push({
      role: "system",
      content: [{ type: "input_text", text: `# 此前对话摘要\n${conv.summary}` }],
    });
  }

  for (const m of windowed) {
    if (m.role === "user") {
      input.push({ role: "user", content: [{ type: "input_text", text: m.content }] });
    } else if (m.role === "assistant") {
      // Assistant textual content goes in as user-context for simplicity
      // (tool_calls aren't replayed — they're side effects already applied)
      if (m.content) {
        input.push({ role: "assistant", content: [{ type: "input_text", text: m.content }] });
      }
    }
    // role === "tool" messages are not replayed to the model
  }

  input.push({ role: "user", content: [{ type: "input_text", text: newUserMessage }] });
  return input;
}

// ─── Incoming-refs pre-fetch for danger confirmation ────────────────────
//
// For danger tools that delete a target referenced by mentions, we do a
// best-effort reverse-lookup so the confirm event already carries the list
// of dependent docs — the frontend confirm card can then render
// "3 references in Roadmap, Ideas/Backlog, …" without its own round trip.
//
// Currently idea targets are the only ones we emit (the only source type that
// writes Mention rows in v1). Adding new mappings is a one-line switch below.
async function fetchIncomingRefsForConfirm(
  toolName: string,
  args: Record<string, unknown>,
  workspaceId: string
): Promise<unknown | undefined> {
  const mapping = dangerTargetForTool(toolName, args);
  if (!mapping) return undefined;
  const port = process.env.PORT || "3001";
  const url = new URL(`http://localhost:${port}/api/mentions/reverse`);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("targetType", mapping.targetType);
  url.searchParams.set("targetId", mapping.targetId);
  url.searchParams.set("limit", "50");
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { refs: unknown[]; total: number };
  return data;
}

function dangerTargetForTool(
  toolName: string,
  args: Record<string, unknown>
): { targetType: "view" | "taste" | "idea" | "idea-section"; targetId: string } | null {
  // Today only `delete_idea` benefits from pre-fetched incoming refs — no
  // other source type emits Mention rows in v1. The switch is here (rather
  // than a single if-branch) so adding delete_view / delete_taste later is
  // drop-in. `delete_table` is NOT mapped: a table isn't a mention target in
  // v1 — only its `view` children are, and those have their own delete tool.
  switch (toolName) {
    case "delete_idea": {
      const id = typeof args.ideaId === "string" ? args.ideaId : "";
      if (!id) return null;
      return { targetType: "idea", targetId: id };
    }
    default:
      return null;
  }
}

// ─── Provider dispatch ───────────────────────────────────────────────────
//
// The ARK streaming logic that used to live here has moved into
// providers/arkAdapter.ts. Day 2 will add providers/oneapiAdapter.ts for
// Claude / GPT-5 family. This dispatcher picks the adapter based on the
// resolved model's `provider` field and yields canonical events that the
// agent loop below consumes without caring which provider responded.

type RawFunctionCall = { callId: string; name: string; arguments: string };

async function* callModelStream(
  model: ModelEntry,
  input: ArkInputItem[],
  abortSignal?: AbortSignal,
  tools?: ToolDefinition[]
): AsyncGenerator<ProviderStreamEvent> {
  const adapter = resolveAdapter(model);
  yield* adapter.stream({ model, input, tools, signal: abortSignal });
}

// ─── Agent loop ──────────────────────────────────────────────────────────

export interface SseEvent {
  event:
    | "start"
    | "thinking"
    | "message"
    | "tool_start"
    | "tool_progress"
    | "tool_heartbeat"
    | "tool_result"
    | "confirm"
    | "error"
    | "done";
  data: Record<string, unknown>;
}

export interface AgentContext {
  conversationId: string;
  workspaceId: string;
  /** Identity scope. Defaults to "agent_default" if the caller doesn't set
   * one — that seed agent is created on backend boot. Once UI has multi-agent
   * selection this should be the active agent from the conversation. */
  agentId?: string;
  /** Per-call mapping of pending confirmations. When the user confirms via
   * POST /confirm, the agent resumes with this callId's args patched with
   * confirmed=true. */
  pendingConfirmations?: Map<string, { tool: string; args: Record<string, unknown> }>;
}

const DEFAULT_AGENT_ID = "agent_default";

/**
 * Run the agent for one user turn. Yields SSE events; the route handler is
 * responsible for forwarding them to the client.
 *
 * If the turn ends with a pending confirmation, the agent saves state to
 * `ctx.pendingConfirmations` and the generator returns after the `confirm`
 * event. The route handler should then wait for the confirm POST and invoke
 * `resumeAfterConfirm()` to continue.
 */
export async function* runAgent(
  ctx: AgentContext,
  userMessage: string,
  abortSignal?: AbortSignal
): AsyncGenerator<SseEvent, void, undefined> {
  const { conversationId, workspaceId } = ctx;
  const agentId = ctx.agentId || DEFAULT_AGENT_ID;
  const assistantMsgId = `msg_${uuidv4()}`;

  // Resolve the target model once per turn. We don't re-resolve per round
  // because a model swap mid-turn would confuse the tool-call loop (different
  // thinking/temperature rules, potentially different tool-format wire
  // shape). `usedFallback` lets us log when the user's preference was
  // unreachable and we substituted a sibling. Preference stays written as-is
  // in config.json — the very next turn auto-recovers when availability
  // flips back.
  const storedModelId = await agentSvc.getSelectedModel(agentId);
  const { resolved: model, requested, usedFallback } = resolveModelForCall(storedModelId);
  if (usedFallback) {
    logAgent({
      event: "model_fallback",
      conversationId,
      requested: requested?.id ?? storedModelId,
      resolved: model.id,
      reason: requested ? "unavailable" : "unknown_id",
    });
  }

  yield { event: "start", data: { messageId: assistantMsgId, model: model.id } };

  // NB: we intentionally persist the user message *after* assembleInput below,
  // not before. assembleInput re-loads the sliding window from storage and then
  // appends `newUserMessage` itself — if we persisted first, the message would
  // show up twice in the outgoing prompt (once from the window, once appended),
  // which (a) wastes tokens and (b) has caused Claude to act as if the user
  // asked the same question twice. Persisting after is safe because the agent
  // loop doesn't re-query storage until the next turn.

  // ── Phase 3: skill activation ───────────────────────────────────────
  const skillState = getOrInitSkillState(conversationId);
  skillState.turnIndex += 1;
  const autoActivated = autoActivateByTriggers(skillState, userMessage);
  if (autoActivated.length) {
    logAgent({
      event: "skill_auto_activated",
      conversationId,
      skills: autoActivated,
      reason: "trigger_match",
    });
  }

  // Long-task tracker: one per turn. Buffers progress/heartbeat events to a
  // shared queue *and* signals a waiter-promise so the runAgent generator can
  // yield them while a tool is still executing (tool await would otherwise
  // block the generator and starve SSE — breaking nginx keepalive + FE
  // progress UI).
  const queuedEvents: SseEvent[] = [];
  let resolveQueueWaiter: (() => void) | null = null;
  const signalQueue = () => {
    const r = resolveQueueWaiter;
    resolveQueueWaiter = null;
    if (r) r();
  };
  const waitForQueue = () =>
    new Promise<void>((resolve) => {
      if (queuedEvents.length > 0) return resolve();
      resolveQueueWaiter = resolve;
    });

  const longTask = new LongTaskTracker({
    onProgress: (p) => {
      queuedEvents.push({
        event: "tool_progress",
        data: {
          callId: p.callId,
          phase: p.phase,
          message: p.message,
          ...(typeof p.progress === "number" ? { progress: p.progress } : {}),
          ...(typeof p.current === "number" ? { current: p.current } : {}),
          ...(typeof p.total === "number" ? { total: p.total } : {}),
          elapsedMs: p.elapsedMs,
        },
      });
      signalQueue();
    },
    onHeartbeat: (p) => {
      queuedEvents.push({
        event: "tool_heartbeat",
        data: { callId: p.callId, elapsedMs: p.elapsedMs },
      });
      signalQueue();
    },
    onTimeout: (p) => {
      queuedEvents.push({
        event: "error",
        data: {
          code: "TOOL_TIMEOUT",
          message: `工具 ${p.tool} 超过 ${p.elapsedMs}ms 未返回，已中止`,
          callId: p.callId,
        },
      });
      signalQueue();
    },
  });

  // Build the tool context once — the handlers see the live activation set
  // and can mutate it via the callbacks (used by skillRouterTools).
  // `callId` is rewritten right before each handler dispatch so the progress
  // callback always references the currently-executing tool.
  const toolCtx = {
    agentId,
    conversationId,
    workspaceId,
    activeSkills: [...skillState.active],
    callId: undefined as string | undefined,
    progress: (payload: {
      phase?: string;
      progress?: number;
      message: string;
      current?: number;
      total?: number;
    }) => {
      if (toolCtx.callId) longTask.emitProgress(toolCtx.callId, payload);
    },
    abortSignal: abortSignal,
    onActivateSkill: (name: string) => {
      if (!skillsByName[name]) return;
      skillState.active.add(name);
      skillState.lastUsedTurn.set(name, skillState.turnIndex);
      logAgent({ event: "skill_activated", conversationId, skill: name, reason: "explicit" });
    },
    onDeactivateSkill: (name: string) => {
      skillState.active.delete(name);
      skillState.lastUsedTurn.delete(name);
      logAgent({ event: "skill_deactivated", conversationId, skill: name });
    },
  };

  // The tool-call loop below uses the `signalQueue` / `waitForQueue` pair to
  // stream queued progress/heartbeat events in real time while a tool is
  // executing — see the pump section inside the runAgent round loop.

  // Running copy of ARK input — appended as tool calls happen. Pass the
  // currently-active skills so the system prompt's skill catalog can mark
  // them as ✅ already-loaded (prevents the model from re-activating).
  // Also pass runtime info (resolved model + fallback state) so Layer 3
  // tells the Agent exactly which LLM it's running on — without this the
  // model has no idea and either guesses or parrots OneAPI's injected
  // "Claude Code" identity.
  const input = await assembleInput(
    conversationId,
    workspaceId,
    agentId,
    userMessage,
    [...skillState.active],
    { model, requestedId: storedModelId, usedFallback }
  );

  // Persist the user message now that assembleInput has already snapshotted
  // the pre-existing window. Subsequent turns will see this message on their
  // next reload.
  await convStore.appendMessage(conversationId, {
    role: "user",
    content: userMessage,
  });

  let accumulatedText = "";
  let accumulatedThinking = "";
  const accumulatedToolCalls: ToolCall[] = [];

  // V2 streaming write: when the Agent calls `begin_idea_stream_write`, we
  // pin the returned sessionId here and route subsequent `text_delta` events
  // into the idea doc's per-idea SSE channel (via ideaStream.pushDelta)
  // instead of forwarding them to the chat bubble. Cleared when
  // `end_idea_stream_write` returns, when the round finishes with no matching
  // end call, or when the turn aborts. Only one active stream per turn —
  // nested begin calls will kick the prior one via `ideaStream.begin()`'s
  // internal "last begin wins" rule.
  let activeStreamSessionId: string | null = null;

  logAgent({
    event: "turn_start",
    conversationId,
    userMessage,
    model: model.id,
    provider: model.provider,
    requestedModel: storedModelId,
    activeSkills: [...skillState.active],
    turnIndex: skillState.turnIndex,
  });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (abortSignal?.aborted) {
      yield { event: "error", data: { code: "ABORTED", message: "用户中止" } };
      break;
    }

    // Build the current tool subset before each ARK call. Re-compute per
    // round because an `activate_skill` call in this very turn should
    // expose that skill's tools on the NEXT round.
    toolCtx.activeSkills = [...skillState.active];
    const activeTools = resolveActiveTools(toolCtx.activeSkills);

    // Consume the ARK stream, forwarding deltas to the client in real time
    // and collecting tool calls to execute after the stream ends.
    const funcCalls: RawFunctionCall[] = [];
    let roundText = "";
    let streamErrored: string | null = null;
    try {
      for await (const ev of callModelStream(model, input, abortSignal, activeTools)) {
        if (ev.kind === "text_delta") {
          // V2 streaming-write interception. Route to the idea doc's SSE
          // channel instead of the chat bubble so the user sees the content
          // appear inline in the editor. Don't also append to the chat
          // message — double-rendering would clutter both surfaces. We still
          // track it in roundText so the tool-call loop knows this round
          // produced text (the model won't go to "final answer" mode just
          // because the bubble was empty).
          if (activeStreamSessionId) {
            ideaStream.pushDelta(activeStreamSessionId, ev.text);
            roundText += ev.text;
            // Intentionally NOT appending to accumulatedText — the chat
            // transcript should show the tool-call card, not the raw stream.
          } else {
            roundText += ev.text;
            accumulatedText += ev.text;
            yield { event: "message", data: { text: ev.text, delta: true } };
          }
        } else if (ev.kind === "thinking_delta") {
          accumulatedThinking += ev.text;
          yield { event: "thinking", data: { text: ev.text } };
        } else if (ev.kind === "tool_call_done") {
          funcCalls.push(ev.call);
        } else if (ev.kind === "error") {
          streamErrored = ev.message;
          break;
        } else if (ev.kind === "done") {
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logAgent({ event: "provider_error", round, model: model.id, provider: model.provider, error: msg });
      yield { event: "error", data: { code: "PROVIDER_ERROR", message: msg, model: model.id } };
      break;
    }
    if (streamErrored) {
      logAgent({ event: "provider_stream_error", round, model: model.id, provider: model.provider, error: streamErrored });
      yield { event: "error", data: { code: "PROVIDER_ERROR", message: streamErrored, model: model.id } };
      break;
    }

    // No tool calls → final answer; break out.
    if (funcCalls.length === 0) {
      logAgent({ event: "final_answer", round, textLen: roundText.length });
      break;
    }

    // Execute each tool call sequentially.
    let hitConfirmation = false;
    for (const fc of funcCalls) {
      if (abortSignal?.aborted) {
        yield { event: "error", data: { code: "ABORTED", message: "用户中止" } };
        hitConfirmation = true; // jump out of loops
        break;
      }
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(fc.arguments || "{}");
      } catch (err) {
        yield { event: "error", data: { code: "BAD_ARGS", message: `工具参数 JSON 解析失败: ${fc.name}` } };
        continue;
      }

      const tool = toolsByName[fc.name];
      if (!tool) {
        const msg = `未知工具: ${fc.name}`;
        yield { event: "error", data: { code: "UNKNOWN_TOOL", message: msg } };
        input.push({ type: "function_call", call_id: fc.callId, name: fc.name, arguments: fc.arguments });
        input.push({ type: "function_call_output", call_id: fc.callId, output: JSON.stringify({ error: msg }) });
        continue;
      }

      // Dangerous tool with no confirmation? Ask the client, pause the loop.
      const isDanger = isDangerousTool(fc.name);
      const alreadyConfirmed = parsedArgs.confirmed === true;
      if (isDanger && !alreadyConfirmed) {
        // Record pending confirmation so the route handler can resume later.
        if (ctx.pendingConfirmations) {
          ctx.pendingConfirmations.set(fc.callId, { tool: fc.name, args: parsedArgs });
        }
        const preview = typeof parsedArgs["preview"] === "string"
          ? String(parsedArgs["preview"])
          : `即将执行 ${fc.name}`;
        // For target-deletion tools we can proactively surface the incoming
        // mention list so the confirmation UI shows "N references will become
        // dead links" without the frontend having to fetch it after the fact.
        // Keeps the two-step confirm UX feeling instant. Fetch is best-effort:
        // if it fails, the UI can still fall back to an inline client fetch.
        let incomingRefs: unknown = undefined;
        try {
          incomingRefs = await fetchIncomingRefsForConfirm(fc.name, parsedArgs, workspaceId);
        } catch (err) {
          logAgent({
            event: "confirm_incoming_refs_failed",
            tool: fc.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        yield {
          event: "confirm",
          data: {
            callId: fc.callId,
            tool: fc.name,
            args: parsedArgs,
            prompt: preview,
            ...(incomingRefs !== undefined ? { incomingRefs } : {}),
          },
        };
        accumulatedToolCalls.push({
          callId: fc.callId,
          tool: fc.name,
          args: parsedArgs,
          status: "awaiting_confirmation",
        });
        hitConfirmation = true;
        break;
      }

      // Execute safe tool (or confirmed danger tool)
      yield { event: "tool_start", data: { callId: fc.callId, tool: fc.name, args: parsedArgs } };
      logAgent({ event: "tool_call", round, tool: fc.name, args: parsedArgs });

      // Begin long-task tracking for this call — any progress() emissions
      // from the handler will queue events; any 180s+ silence triggers an
      // abort. Reset callId on toolCtx so the progress callback targets us.
      toolCtx.callId = fc.callId;
      const toolAbort = longTask.beginTool(fc.callId, fc.name, abortSignal);
      toolCtx.abortSignal = toolAbort.signal;

      // Spawn the tool call as a detached promise so the generator is not
      // blocked on `await`. The event-pump loop below yields queued progress
      // / heartbeat events as they arrive, keeping nginx + browser SSE alive
      // during long tool calls and feeding the FE progress bar in real time.
      let toolOutput: string = "";
      let success = true;
      let toolSettled = false;
      const toolPromise = (async () => {
        try {
          const out = await tool.handler(parsedArgs, toolCtx);
          toolOutput = out;
          // Bump lastUsedTurn on the owning skill, if any.
          const owningSkill = skillNameForTool.get(fc.name);
          if (owningSkill && skillState.active.has(owningSkill)) {
            skillState.lastUsedTurn.set(owningSkill, skillState.turnIndex);
          }
        } catch (err) {
          success = false;
          toolOutput = JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          toolSettled = true;
          signalQueue(); // wake the pump immediately on completion
        }
      })();

      // Pump: drain queue + wait for next signal (either a new queued event
      // or the tool finishing). Loop terminates when the tool has settled
      // AND the queue is empty.
      while (!toolSettled || queuedEvents.length > 0) {
        while (queuedEvents.length) yield queuedEvents.shift()!;
        if (toolSettled) break;
        await waitForQueue();
      }

      await toolPromise;
      longTask.settleTool();
      toolCtx.callId = undefined;
      toolCtx.abortSignal = abortSignal;

      // V2 streaming-write hook: detect begin/end so the text_delta router
      // knows when to redirect into the idea session. We look at the tool
      // result's `_stream` marker rather than hard-coding the tool name so
      // this stays schema-driven.
      if (success) {
        try {
          const parsed = JSON.parse(toolOutput);
          // Cooperative skill activation — tools can suggest follow-up
          // skills via `_suggestActivate: [{skill, reason}]`. Activate
          // immediately so the next round's tool list includes them.
          processSuggestActivate(parsed, skillState, (entry) =>
            logAgent({ ...entry, conversationId }),
          );
          const marker = parsed?._stream;
          if (marker && typeof marker === "object") {
            if (marker.mode === "begin" && typeof marker.sessionId === "string") {
              activeStreamSessionId = marker.sessionId;
              // Wire the session back to this conversation so the abort sweep
              // below finds it even though the MCP HTTP call opened it.
              ideaStream.attachConversation(marker.sessionId, conversationId);
              logAgent({
                event: "idea_stream_begin",
                conversationId,
                sessionId: marker.sessionId,
                ideaId: marker.ideaId,
              });
            } else if (marker.mode === "end") {
              if (activeStreamSessionId === marker.sessionId) {
                activeStreamSessionId = null;
              }
              logAgent({
                event: "idea_stream_end",
                conversationId,
                sessionId: marker.sessionId,
                discarded: parsed.discarded ?? false,
              });
            }
          }
        } catch {
          // tool output wasn't JSON (e.g. `toolResult` wraps in a structured
          // shape; JSON.parse may fail on that). Silently ignore — if the
          // tool really was a stream-write, the MCP layer's marker would
          // have been JSON-serializable.
        }
      }

      yield {
        event: "tool_result",
        data: { callId: fc.callId, tool: fc.name, success, result: toolOutput },
      };
      accumulatedToolCalls.push({
        callId: fc.callId,
        tool: fc.name,
        args: parsedArgs,
        status: success ? "success" : "error",
        result: toolOutput,
        error: success ? undefined : toolOutput,
      });

      // Feed back to model
      input.push({ type: "function_call", call_id: fc.callId, name: fc.name, arguments: fc.arguments });
      input.push({ type: "function_call_output", call_id: fc.callId, output: toolOutput });
    }

    if (hitConfirmation) {
      // Stop streaming and wait for /confirm POST.
      // If the Agent was mid-stream-write when confirmation kicked in, we
      // don't want the editor locked until the user decides. Abort the
      // session now; the Agent can re-open on resume if it decides to.
      if (activeStreamSessionId) {
        ideaStream.abort(activeStreamSessionId, "confirmation-pause");
        activeStreamSessionId = null;
      }
      // Persist the partial assistant turn before bailing out so that
      // (a) the successful tool calls already executed this round are
      // preserved across reloads, and (b) the `awaiting_confirmation`
      // placeholder survives — the resume path will fold its final status
      // onto the tail end via appendMessage below. Without this, the turn
      // that hit a confirm pause disappears from DB history entirely.
      try {
        await convStore.appendMessage(conversationId, {
          role: "assistant",
          content: accumulatedText,
          thinking: accumulatedThinking || undefined,
          toolCalls: accumulatedToolCalls,
        });
      } catch (err) {
        logAgent({
          event: "append_message_failed",
          stage: "hit_confirmation",
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
  }

  // Post-loop cleanup: if the model finished without calling
  // `end_idea_stream_write`, discard the orphan session rather than leaving
  // the editor locked until the 2-minute idle timer fires. This is the
  // expected path when the Agent's generation ends naturally and it simply
  // forgot the explicit end call.
  if (activeStreamSessionId) {
    logAgent({
      event: "idea_stream_orphan_abort",
      conversationId,
      sessionId: activeStreamSessionId,
      reason: "turn-ended-without-end-call",
    });
    ideaStream.abort(activeStreamSessionId, "turn-ended-without-end-call");
    activeStreamSessionId = null;
  }

  // Persist the assistant message (aggregated text + thinking + tool calls).
  await convStore.appendMessage(conversationId, {
    role: "assistant",
    content: accumulatedText,
    thinking: accumulatedThinking || undefined,
    toolCalls: accumulatedToolCalls,
  });

  // Day 4: append this turn to working-memory, and fire-and-forget a
  // compression pass if the buffer is big enough. Compression is
  // deterministic (no LLM call) so it's cheap; we still detach it so slow
  // filesystems can't delay the user's `done` event.
  agentSvc
    .appendWorkingMemory(agentId, {
      timestamp: new Date().toISOString(),
      conversationId,
      userMessage,
      assistantMessage: accumulatedText,
      toolCalls: accumulatedToolCalls.map((c) => c.tool),
    })
    .then(async () => {
      const result = await agentSvc.compressWorkingMemory(agentId, {
        minTurns: WORKING_MEMORY_COMPRESS_THRESHOLD,
      });
      if (result.compressed) {
        logAgent({
          event: "working_memory_compressed",
          agentId,
          turns: result.turns,
          filename: result.filename,
        });
      }
    })
    .catch((err) => {
      logAgent({
        event: "working_memory_error",
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // End-of-turn: drop skills that haven't been used for N turns.
  const evicted = evictStaleSkills(skillState);
  if (evicted.length) {
    logAgent({ event: "skill_evicted", conversationId, skills: evicted, reason: "idle_turns" });
  }

  // Release the long-task tracker's timers (heartbeat + timeout).
  longTask.dispose();

  yield { event: "done", data: { messageId: assistantMsgId } };
  logAgent({
    event: "turn_end",
    conversationId,
    textLen: accumulatedText.length,
    thinkingLen: accumulatedThinking.length,
    toolCalls: accumulatedToolCalls.length,
    activeSkills: [...skillState.active],
  });
}

/**
 * Resume agent after a user confirmation. The route handler should call this
 * after receiving a POST /confirm event. Semantics:
 *  - If confirmed === true, the pending tool is executed and the loop continues
 *  - If confirmed === false, a message is appended to the model input saying
 *    "user cancelled the action" and the loop continues (letting the model
 *    decide what to do next)
 */
export async function* resumeAfterConfirm(
  ctx: AgentContext,
  callId: string,
  confirmed: boolean,
  abortSignal?: AbortSignal
): AsyncGenerator<SseEvent, void, undefined> {
  if (!ctx.pendingConfirmations) {
    yield { event: "error", data: { code: "NO_CONTEXT", message: "会话上下文已丢失，请重新发起提问" } };
    return;
  }
  const pending = ctx.pendingConfirmations.get(callId);
  if (!pending) {
    yield { event: "error", data: { code: "NO_PENDING", message: "找不到待确认的工具调用" } };
    return;
  }
  ctx.pendingConfirmations.delete(callId);

  if (!confirmed) {
    yield {
      event: "tool_result",
      data: { callId, tool: pending.tool, success: true, result: JSON.stringify({ cancelled: true }) },
    };
    yield { event: "message", data: { text: "好的，已取消该操作。", delta: false } };
    yield { event: "done", data: {} };
    // Append a synthetic assistant turn recording the cancellation so the
    // Agent's next turn (and a page reload) sees an honest history entry
    // instead of the bare user message with no reply attached.
    try {
      await convStore.appendMessage(ctx.conversationId, {
        role: "assistant",
        content: "好的，已取消该操作。",
        toolCalls: [
          {
            callId,
            tool: pending.tool,
            args: pending.args,
            status: "error",
            result: JSON.stringify({ cancelled: true }),
          },
        ],
      });
    } catch (err) {
      logAgent({
        event: "append_message_failed",
        stage: "resume_cancel",
        conversationId: ctx.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  const tool = toolsByName[pending.tool];
  if (!tool) {
    yield { event: "error", data: { code: "UNKNOWN_TOOL", message: `未知工具: ${pending.tool}` } };
    return;
  }

  yield { event: "tool_start", data: { callId, tool: pending.tool, args: pending.args } };
  let output: string;
  let success = true;
  const resumeAgentId = ctx.agentId || DEFAULT_AGENT_ID;
  // Reuse the per-conversation skill state so that if the confirmed tool
  // happens to be a skill-router tool (today none are danger=true, but keep
  // it defensively consistent), activation callbacks still mutate the same
  // state the next turn will read.
  const resumeSkillState = getOrInitSkillState(ctx.conversationId);
  const resumeToolCtx: ToolContext = {
    agentId: resumeAgentId,
    activeSkills: [...resumeSkillState.active],
    onActivateSkill: (name: string) => {
      if (!skillsByName[name]) return;
      resumeSkillState.active.add(name);
      resumeSkillState.lastUsedTurn.set(name, resumeSkillState.turnIndex);
    },
    onDeactivateSkill: (name: string) => {
      resumeSkillState.active.delete(name);
      resumeSkillState.lastUsedTurn.delete(name);
    },
  };
  // Bump lastUsedTurn for the owning skill so it doesn't get evicted just
  // because the confirmation round-tripped across turns.
  const owningSkill = skillNameForTool.get(pending.tool);
  if (owningSkill && resumeSkillState.active.has(owningSkill)) {
    resumeSkillState.lastUsedTurn.set(owningSkill, resumeSkillState.turnIndex);
  }
  try {
    output = await tool.handler({ ...pending.args, confirmed: true }, resumeToolCtx);
  } catch (err) {
    success = false;
    output = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
  yield { event: "tool_result", data: { callId, tool: pending.tool, success, result: output } };
  yield { event: "done", data: {} };
  // Persist the confirmed tool's final state as its own short assistant
  // turn, so the DB history reflects the resume. Without this, nothing the
  // user confirmed would show up on reload — only the partial paused turn
  // that runAgent persisted before bailing.
  try {
    await convStore.appendMessage(ctx.conversationId, {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          callId,
          tool: pending.tool,
          args: { ...pending.args, confirmed: true },
          status: success ? "success" : "error",
          result: output,
          error: success ? undefined : output,
        },
      ],
    });
  } catch (err) {
    logAgent({
      event: "append_message_failed",
      stage: "resume_commit",
      conversationId: ctx.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Re-export tool metadata for debugging/introspection endpoints.
export { allTools, toolsByName };
