/**
 * Chaos Monkey Service — High Agency Mode 的规划 & 验收 Agent
 *
 * 职责：
 *   1. Planning: 接收 Goal + Todos + Workspace 上下文 → 输出结构化 Roadmap JSON
 *   2. Validation: 接收里程碑 + 执行结果 → 输出 pass/fail 判定 JSON
 *
 * 设计特点：
 *   - 无状态：每次调用都是独立的 model call，不存 conversation
 *   - 使用 modelRegistry 获取 adapter，默认 gpt-5.5
 *   - 结构化 JSON 输出，带 schema 校验
 *   - Planning 温度 0.7（需要创造性），Validation 温度 0.3（需要确定性）
 */

import { resolveModelForCall, resolveAdapter } from "./modelRegistry.js";
import type { ProviderInputItem, ProviderStreamEvent } from "./providers/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgencyRoadmap {
  segments: AgencySegment[];
}

export interface AgencySegment {
  from: string; // "now" or todo label
  to: string; // todo label or goal
  milestones: AgencyMilestoneSpec[];
}

export interface AgencyMilestoneSpec {
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface ValidationResult {
  passed: boolean;
  reason: string;
  suggestions?: string[];
}

export interface WorkspaceContext {
  tables: { id: string; name: string; fieldCount: number; recordCount: number }[];
  ideas: { id: string; title: string }[];
  designs: { id: string; name: string }[];
  demos: { id: string; name: string }[];
}

export interface PlanInput {
  goal: string;
  todos: string[];
  workspaceContext: WorkspaceContext;
  fromScope?: { exclude?: string[] };
  model?: string; // override, default gpt-5.5
}

export interface ValidateInput {
  milestone: {
    title: string;
    description: string;
    acceptanceCriteria: string[];
  };
  executionResult: string; // Agent 最终输出文本
  artifactsChanged: { type: string; id: string; name: string; action: "created" | "modified" }[];
  failureHistory?: { reason: string; suggestions?: string[]; timestamp: string }[];
  model?: string;
}

// ─── System Prompts ─────────────────────────────────────────────────────────

const PLANNING_SYSTEM_PROMPT = `你是 Chaos Monkey，一个独立的任务规划 Agent。你的职责是将用户的目标拆解为可执行的里程碑路线图。

## 输入
- Goal: 用户的最终目标
- Todos: 用户强制要求的途径点（即使与 Goal 无关也必须经过，可以理解为"绕路"）
- Workspace 上下文: 当前已有的表/文档/画布/Demo 列表
- Scope 约束: 禁止修改的 artifacts（如有）

## 输出格式（严格 JSON，不要包含任何其他文字）
{
  "segments": [
    {
      "from": "now",
      "to": "第一个途径点或目标",
      "milestones": [
        {
          "title": "里程碑标题（简洁动宾短语）",
          "description": "给执行 Agent 的详细指令，包含具体要做什么、怎么做",
          "acceptanceCriteria": [
            "验收条件1：具体、客观、可验证",
            "验收条件2"
          ]
        }
      ]
    }
  ]
}

## 规则
1. 路线图按 segments 拆分：From→Todo1 是第一段，Todo1→Todo2 是第二段，直到最后一段 TodoN→Goal
2. 如果没有 Todos，则只有一段：From→Goal
3. 每个 segment 包含 2-8 个里程碑，根据复杂度灵活调整
4. 每个里程碑必须是单轮 Agent 可完成的任务（1-5 次工具调用）
5. 验收标准必须客观可验证（检查存在性、内容匹配、结构完整性）
6. 里程碑按依赖关系排序，后续可建立在前序结果上
7. 验收标准要引用具体的 artifact 名称、字段名、文档章节
8. description 中要给出足够的上下文，让执行 Agent 无需额外信息就能完成任务
9. 如果有 Scope 约束（禁止修改的 artifacts），里程碑中不能包含对这些 artifacts 的修改操作`;

const VALIDATION_SYSTEM_PROMPT = `你是 Chaos Monkey，一个独立的验收 Agent。你的职责是严格验证执行结果是否满足里程碑的验收标准。

## 输入
- 里程碑: title + description + acceptanceCriteria
- 执行结果: Agent 的最终输出文本 + 产物变更列表
- 历史失败记录（如有）: 之前的失败原因和建议

## 输出格式（严格 JSON，不要包含任何其他文字）
{
  "passed": true或false,
  "reason": "清晰解释为什么通过或失败",
  "suggestions": ["如果失败：具体的改进建议（与之前不同的新方向）"]
}

## 规则
1. 严格逐条验证 acceptanceCriteria，全部满足才算通过
2. 失败时必须给出与之前不同的、具体可执行的改进建议
3. 理由中引用具体 artifacts 或内容作为证据
4. 不能因为重试次数多就降低标准——标准永远不变
5. 如果执行结果明显偏离方向，suggestions 中要指出根本问题而不只是表面修补
6. 对"部分完成"的情况也判为 failed，但在 suggestions 中肯定已完成的部分并指出缺失`;

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * 调用 Chaos Monkey 规划路线图
 */
export async function planRoadmap(input: PlanInput): Promise<AgencyRoadmap> {
  const { goal, todos, workspaceContext, fromScope, model } = input;

  const userMessage = buildPlanningUserMessage(goal, todos, workspaceContext, fromScope);
  const raw = await callChaosMonkey(PLANNING_SYSTEM_PROMPT, userMessage, {
    model: model ?? "gpt-5.5",
    temperature: 0.7,
  });

  const roadmap = parseRoadmapJSON(raw);
  return roadmap;
}

/**
 * 调用 Chaos Monkey 验收里程碑
 */
export async function validateMilestone(input: ValidateInput): Promise<ValidationResult> {
  const { milestone, executionResult, artifactsChanged, failureHistory, model } = input;

  const userMessage = buildValidationUserMessage(milestone, executionResult, artifactsChanged, failureHistory);
  const raw = await callChaosMonkey(VALIDATION_SYSTEM_PROMPT, userMessage, {
    model: model ?? "gpt-5.5",
    temperature: 0.3,
  });

  const result = parseValidationJSON(raw);
  return result;
}

// ─── Helper: Call Chaos Monkey (model call) ────────────────────────────────

interface CallOptions {
  model: string;
  temperature: number;
}

async function callChaosMonkey(
  systemPrompt: string,
  userMessage: string,
  opts: CallOptions
): Promise<string> {
  const { resolved } = resolveModelForCall(opts.model);
  const adapter = resolveAdapter(resolved);

  const input: ProviderInputItem[] = [
    { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
    { role: "user", content: [{ type: "input_text", text: userMessage }] },
  ];

  let fullText = "";
  const gen = adapter.stream({
    model: { ...resolved, defaults: { ...resolved.defaults, temperature: opts.temperature } },
    input,
    tools: [], // Chaos Monkey 不使用工具
  });

  for await (const event of gen) {
    if (event.kind === "text_delta") {
      fullText += event.text;
    } else if (event.kind === "error") {
      throw new Error(`Chaos Monkey model error: ${event.message}`);
    }
    // ignore thinking_delta, tool_call_done, done
  }

  return fullText.trim();
}

// ─── Helper: Build User Messages ───────────────────────────────────────────

function buildPlanningUserMessage(
  goal: string,
  todos: string[],
  wsCtx: WorkspaceContext,
  fromScope?: { exclude?: string[] }
): string {
  const parts: string[] = [];

  parts.push(`## Goal\n${goal}`);

  if (todos.length > 0) {
    parts.push(`## Todos（途径点，必须按顺序经过）\n${todos.map((t, i) => `${i + 1}. ${t}`).join("\n")}`);
  } else {
    parts.push(`## Todos\n无（直接从 From 到 Goal）`);
  }

  // Workspace context
  const wsLines: string[] = [];
  if (wsCtx.tables.length > 0) {
    wsLines.push(`### 数据表 (${wsCtx.tables.length})`);
    wsCtx.tables.forEach((t) => wsLines.push(`- ${t.name} (${t.fieldCount} 字段, ${t.recordCount} 条记录)`));
  }
  if (wsCtx.ideas.length > 0) {
    wsLines.push(`### 文档 (${wsCtx.ideas.length})`);
    wsCtx.ideas.forEach((i) => wsLines.push(`- ${i.title}`));
  }
  if (wsCtx.designs.length > 0) {
    wsLines.push(`### 画布 (${wsCtx.designs.length})`);
    wsCtx.designs.forEach((d) => wsLines.push(`- ${d.name}`));
  }
  if (wsCtx.demos.length > 0) {
    wsLines.push(`### Demo (${wsCtx.demos.length})`);
    wsCtx.demos.forEach((d) => wsLines.push(`- ${d.name}`));
  }
  if (wsLines.length > 0) {
    parts.push(`## Workspace 当前状态\n${wsLines.join("\n")}`);
  } else {
    parts.push(`## Workspace 当前状态\n空白 workspace，尚无任何 artifacts`);
  }

  // Scope constraints
  if (fromScope?.exclude && fromScope.exclude.length > 0) {
    parts.push(`## Scope 约束（禁止修改）\n${fromScope.exclude.map((e) => `- ${e}`).join("\n")}`);
  }

  return parts.join("\n\n");
}

function buildValidationUserMessage(
  milestone: { title: string; description: string; acceptanceCriteria: string[] },
  executionResult: string,
  artifactsChanged: { type: string; id: string; name: string; action: "created" | "modified" }[],
  failureHistory?: { reason: string; suggestions?: string[]; timestamp: string }[]
): string {
  const parts: string[] = [];

  parts.push(`## 里程碑\n**${milestone.title}**\n\n${milestone.description}`);
  parts.push(
    `## 验收标准\n${milestone.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
  );

  parts.push(`## 执行结果\n${executionResult}`);

  if (artifactsChanged.length > 0) {
    parts.push(
      `## 产物变更\n${artifactsChanged.map((a) => `- [${a.action}] ${a.type}: ${a.name} (${a.id})`).join("\n")}`
    );
  } else {
    parts.push(`## 产物变更\n无任何 artifact 被创建或修改`);
  }

  if (failureHistory && failureHistory.length > 0) {
    const historyLines = failureHistory.map(
      (f, i) =>
        `### 第 ${i + 1} 次失败\n原因: ${f.reason}${f.suggestions ? "\n建议: " + f.suggestions.join("; ") : ""}`
    );
    parts.push(`## 历史失败记录（共 ${failureHistory.length} 次）\n${historyLines.join("\n\n")}`);
  }

  return parts.join("\n\n");
}

// ─── Helper: JSON Parsing ───────────────────────────────────────────────────

function extractJSON(raw: string): string {
  // 模型有时会在 JSON 前后包裹 markdown code fence
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) return fenced[1].trim();
  // 尝试直接找 { ... } 或 [ ... ]
  const braceStart = raw.indexOf("{");
  const braceEnd = raw.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    return raw.slice(braceStart, braceEnd + 1);
  }
  return raw;
}

function parseRoadmapJSON(raw: string): AgencyRoadmap {
  const json = extractJSON(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Chaos Monkey planning output is not valid JSON:\n${raw.slice(0, 500)}`);
  }

  // Basic schema validation
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.segments)) {
    throw new Error(`Chaos Monkey planning output missing "segments" array:\n${json.slice(0, 300)}`);
  }

  const segments: AgencySegment[] = [];
  for (const seg of obj.segments as unknown[]) {
    const s = seg as Record<string, unknown>;
    if (typeof s.from !== "string" || typeof s.to !== "string" || !Array.isArray(s.milestones)) {
      throw new Error(`Invalid segment format: ${JSON.stringify(seg).slice(0, 200)}`);
    }
    const milestones: AgencyMilestoneSpec[] = [];
    for (const m of s.milestones as unknown[]) {
      const ms = m as Record<string, unknown>;
      if (
        typeof ms.title !== "string" ||
        typeof ms.description !== "string" ||
        !Array.isArray(ms.acceptanceCriteria)
      ) {
        throw new Error(`Invalid milestone format: ${JSON.stringify(m).slice(0, 200)}`);
      }
      milestones.push({
        title: ms.title,
        description: ms.description,
        acceptanceCriteria: (ms.acceptanceCriteria as unknown[]).map(String),
      });
    }
    segments.push({ from: s.from, to: s.to, milestones });
  }

  if (segments.length === 0) {
    throw new Error("Chaos Monkey produced an empty roadmap (0 segments)");
  }

  return { segments };
}

function parseValidationJSON(raw: string): ValidationResult {
  const json = extractJSON(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Chaos Monkey validation output is not valid JSON:\n${raw.slice(0, 500)}`);
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.passed !== "boolean") {
    throw new Error(`Chaos Monkey validation output missing "passed" boolean:\n${json.slice(0, 300)}`);
  }

  return {
    passed: obj.passed,
    reason: typeof obj.reason === "string" ? obj.reason : "No reason provided",
    suggestions: Array.isArray(obj.suggestions)
      ? (obj.suggestions as unknown[]).map(String)
      : undefined,
  };
}
