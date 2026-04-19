/**
 * Chat Agent Service — the core of the Table Agent feature.
 *
 * Responsibilities:
 *  - Accept a user message + conversation history + documentId
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
import { allTools, toolsByName, isDangerousTool, toArkToolFormat } from "../../mcp-server/src/tools/index.js";
import * as convStore from "./conversationStore.js";
import type { Message, ToolCall } from "./conversationStore.js";
import * as store from "./dbStore.js";

const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const SEED_MODEL = process.env.SEED_MODEL || process.env.ARK_MODEL || "ep-20260412192731-vwdh7";
const MAX_TOOL_ROUNDS = 10;

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

// ─── System Prompt ───────────────────────────────────────────────────────

const SYSTEM_PROMPT_ZH = `# 角色
你是飞书多维表格的智能助手 "Table Agent"，通过调用工具帮用户创建和管理数据表、字段、记录、视图。

# 核心规则
1. 用户用自然语言描述需求（如"创建 CRM 系统"），你拆解成多步骤，逐步调用工具完成。
2. 每次调用工具前，用一两句自然语言简短说明正在做什么（不用 Markdown 代码块）。
3. 调用带 "⚠️" 标记的删除类工具前，必须先用自然语言征得用户同意，不能直接调用。
4. 工具调用失败时，说明原因并询问用户如何处理，不要重试超过 2 次。
5. 完成任务后用 1-2 句总结。

# 工具使用策略
- 需要了解现状时先调 list_tables / get_table / list_fields / query_records
- 批量操作优先使用 batch_ 系列（减少轮次）
- 创建复杂表时顺序：create_table 取 tableId → 逐个 create_field → batch_create_records
- 创建 SingleSelect/MultiSelect 字段时，config.options 的每项要包含 name 和 color（如 '#FFE2D9'）
- 包含"姓名"或以"人"结尾的字段使用 User 类型

# 输出约束
- 用自然语言 + 工具调用交错输出，不要用 Markdown
- 生成 SingleSelect/MultiSelect 的 options 时，color 用以下任一：#FFE2D9 #FFEBD1 #FFF5C2 #DFF5C9 #CCEBD9 #CFE8F5 #D9E0FC #E5D9FC #F4D9F5 #F9CFD3
- 字段的 config 必须符合每种类型的规范（Number 带 numberFormat，Currency 带 currencyCode 等）`;

// ─── Document snapshot (context injection) ───────────────────────────────

async function buildDocumentSnapshot(documentId: string): Promise<string> {
  try {
    const tables = await store.listTablesForDocument(documentId);
    if (!tables || tables.length === 0) {
      return `# 当前文档状态\n文档 ${documentId} 目前没有数据表。`;
    }
    const lines: string[] = [`# 当前文档状态（${documentId}）`];
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
    return `# 当前文档状态\n(获取失败: ${err instanceof Error ? err.message : String(err)})`;
  }
}

// ─── Context assembly (sliding window + snapshot) ────────────────────────

interface ArkInputMessage {
  role: "system" | "user" | "assistant";
  content: Array<{ type: "input_text"; text: string }>;
}

type ArkInputItem =
  | ArkInputMessage
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

async function assembleInput(conversationId: string, documentId: string, newUserMessage: string): Promise<ArkInputItem[]> {
  const snapshot = await buildDocumentSnapshot(documentId);
  const systemText = SYSTEM_PROMPT_ZH + "\n\n" + snapshot;

  const history = convStore.getMessages(conversationId);
  // Sliding window: last 20 messages (plan Phase 3.2)
  const windowed = history.slice(-20);

  const input: ArkInputItem[] = [
    { role: "system", content: [{ type: "input_text", text: systemText }] },
  ];

  // Add conversation summary if present (for long conversations)
  const conv = convStore.getConversation(conversationId);
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

// ─── ARK Responses API (non-streaming; see note below) ───────────────────
// For MVP we use non-streaming and rely on in-loop yields to deliver tool
// cards and final text as discrete events. Token-by-token streaming for the
// "message" and "thinking" channels can be added by switching to stream:true
// and parsing SSE chunks — the agent's generator interface doesn't change.

interface ArkResponse {
  output?: Array<{
    type: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    text?: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
  }>;
}

async function callArk(input: ArkInputItem[]): Promise<ArkResponse> {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) throw new Error("ARK_API_KEY not configured");

  const body: Record<string, unknown> = {
    model: SEED_MODEL,
    input,
    max_output_tokens: 4096,
    temperature: 0.1,
    stream: false,
    // thinking is enabled per plan; set to disabled if the endpoint doesn't
    // support thinking for the configured model
    thinking: { type: "disabled" },
    tools: toArkToolFormat(),
  };

  const res = await fetch(`${ARK_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ARK ${res.status}: ${txt.slice(0, 400)}`);
  }
  return (await res.json()) as ArkResponse;
}

function extractTextContent(r: ArkResponse): string | null {
  if (r.output) {
    for (const it of r.output) {
      if (it.type === "message" && it.content) {
        for (const c of it.content) {
          if (c.type === "output_text" && c.text) return c.text;
        }
      }
      if (it.type === "output_text" && it.text) return it.text;
    }
  }
  if (r.choices?.[0]?.message?.content) return r.choices[0].message.content;
  return null;
}

interface RawFunctionCall { callId: string; name: string; arguments: string; }

function extractFunctionCalls(r: ArkResponse): RawFunctionCall[] {
  const calls: RawFunctionCall[] = [];
  if (r.output) {
    for (const it of r.output) {
      if (it.type === "function_call" && it.name && it.arguments) {
        calls.push({ callId: it.call_id || it.id || uuidv4(), name: it.name, arguments: it.arguments });
      }
    }
  }
  if (calls.length === 0 && r.choices?.[0]?.message?.tool_calls) {
    for (const tc of r.choices[0].message.tool_calls) {
      calls.push({ callId: tc.id, name: tc.function.name, arguments: tc.function.arguments });
    }
  }
  return calls;
}

// ─── Agent loop ──────────────────────────────────────────────────────────

export interface SseEvent {
  event: "start" | "thinking" | "message" | "tool_start" | "tool_result" | "confirm" | "error" | "done";
  data: Record<string, unknown>;
}

export interface AgentContext {
  conversationId: string;
  documentId: string;
  /** Per-call mapping of pending confirmations. When the user confirms via
   * POST /confirm, the agent resumes with this callId's args patched with
   * confirmed=true. */
  pendingConfirmations?: Map<string, { tool: string; args: Record<string, unknown> }>;
}

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
  const { conversationId, documentId } = ctx;
  const assistantMsgId = `msg_${uuidv4()}`;

  yield { event: "start", data: { messageId: assistantMsgId } };

  // Persist the user message immediately so it shows up in history.
  convStore.appendMessage(conversationId, {
    role: "user",
    content: userMessage,
  });

  // Running copy of ARK input — appended as tool calls happen.
  const input = await assembleInput(conversationId, documentId, userMessage);

  let accumulatedText = "";
  const accumulatedToolCalls: ToolCall[] = [];

  logAgent({ event: "turn_start", conversationId, userMessage });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (abortSignal?.aborted) {
      yield { event: "error", data: { code: "ABORTED", message: "用户中止" } };
      break;
    }

    let resp: ArkResponse;
    try {
      resp = await callArk(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logAgent({ event: "ark_error", round, error: msg });
      yield { event: "error", data: { code: "ARK_ERROR", message: msg } };
      break;
    }

    const text = extractTextContent(resp);
    const funcCalls = extractFunctionCalls(resp);

    // If the model produced text, stream it as a "message" event.
    if (text) {
      accumulatedText += (accumulatedText ? "\n" : "") + text;
      yield { event: "message", data: { text, delta: true } };
    }

    // No tool calls → final answer; break out.
    if (funcCalls.length === 0) {
      logAgent({ event: "final_answer", round, textLen: (text || "").length });
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
        toolOutput = await tool.handler(parsedArgs);
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

  // Persist the assistant message (aggregated text + tool calls).
  convStore.appendMessage(conversationId, {
    role: "assistant",
    content: accumulatedText,
    toolCalls: accumulatedToolCalls,
  });

  yield { event: "done", data: { messageId: assistantMsgId } };
  logAgent({ event: "turn_end", conversationId, textLen: accumulatedText.length, toolCalls: accumulatedToolCalls.length });
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
  try {
    output = await tool.handler({ ...pending.args, confirmed: true });
  } catch (err) {
    success = false;
    output = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
  yield { event: "tool_result", data: { callId, tool: pending.tool, success, result: output } };
  yield { event: "done", data: {} };
}

// Re-export tool metadata for debugging/introspection endpoints.
export { allTools, toolsByName };
