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
 */
function evictStaleSkills(state: ConvSkillState): string[] {
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
- 回复使用用户的主要语言（可从 profile 读到，默认中文）。`;

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
- 字段的 config 必须符合每种类型的规范（Number 带 numberFormat，Currency 带 currencyCode 等）`;

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

// ─── Workspace snapshot (context injection) ──────────────────────────────

async function buildWorkspaceSnapshot(workspaceId: string): Promise<string> {
  try {
    const tables = await store.listTablesForWorkspace(workspaceId);
    if (!tables || tables.length === 0) {
      return `# 当前工作空间状态\n工作空间 ${workspaceId} 目前没有数据表。`;
    }
    const lines: string[] = [`# 当前工作空间状态（${workspaceId}）`];
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
    return lines.join("\n");
  } catch (err) {
    return `# 当前工作空间状态\n(获取失败: ${err instanceof Error ? err.message : String(err)})`;
  }
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
  const [identity, snapshot, recalled] = await Promise.all([
    buildIdentityLayer(agentId),
    buildWorkspaceSnapshot(workspaceId),
    buildRecalledMemoriesSection(agentId, newUserMessage),
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
  const skillCatalog = buildSkillCatalog(activeSkillNames);
  const systemParts = [META_SYSTEM_PROMPT, identity];
  if (skillCatalog) systemParts.push(skillCatalog);
  systemParts.push(TOOL_GUIDANCE_ZH);
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
  event: "start" | "thinking" | "message" | "tool_start" | "tool_result" | "confirm" | "error" | "done";
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

  // Build the tool context once — the handlers see the live activation set
  // and can mutate it via the callbacks (used by skillRouterTools).
  const toolCtx = {
    agentId,
    activeSkills: [...skillState.active],
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
          roundText += ev.text;
          accumulatedText += ev.text;
          yield { event: "message", data: { text: ev.text, delta: true } };
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
        yield {
          event: "confirm",
          data: {
            callId: fc.callId,
            tool: fc.name,
            args: parsedArgs,
            prompt: preview,
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

      let toolOutput: string;
      let success = true;
      try {
        // Pass the live skill context so skillRouterTools can mutate state.
        toolOutput = await tool.handler(parsedArgs, toolCtx);
        // Bump lastUsedTurn on the owning skill, if any.
        const owningSkill = skillNameForTool.get(fc.name);
        if (owningSkill && skillState.active.has(owningSkill)) {
          skillState.lastUsedTurn.set(owningSkill, skillState.turnIndex);
        }
      } catch (err) {
        success = false;
        toolOutput = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
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
      // Stop streaming and wait for /confirm POST
      return;
    }
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
}

// Re-export tool metadata for debugging/introspection endpoints.
export { allTools, toolsByName };
