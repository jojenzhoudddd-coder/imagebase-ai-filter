/**
 * Provider adapter contract — internal to chatAgentService.
 *
 * The agent loop in chatAgentService.ts used to call Volcano ARK directly
 * via a hardcoded `callArkStream` generator. To support switching between
 * ARK (Doubao/Seed) and OneAPI (Claude/GPT-5 family) per user preference,
 * that function is now behind this adapter interface.
 *
 * ## Design notes
 *
 * - **Event shape is canonical** (`ProviderStreamEvent`). Every adapter
 *   normalizes its provider's native event stream into these five kinds.
 *   chatAgentService consumes events without knowing the underlying provider.
 *
 * - **Input shape is ARK-native today** (`ProviderInputItem[]`). The legacy
 *   path uses the ARK Responses API schema verbatim. When the OneAPI adapter
 *   lands (Day 2), we'll introduce a provider-agnostic `CanonicalMessage[]`
 *   format and each adapter serializes from it. Doing that shift today would
 *   force a rewrite of `assembleInput` which is out of scope for the Day 1
 *   "zero-regression" refactor.
 *
 * - **Tools are passed as ToolDefinition[]** — adapters convert to their
 *   provider's tool schema internally (ARK → `toArkToolFormat`; OneAPI will
 *   add a `toOpenAIToolFormat`).
 */

import type { ModelEntry } from "../modelRegistry.js";
import type { ToolDefinition } from "../../../mcp-server/src/tools/tableTools.js";

// ─── Canonical stream events (what adapters yield) ──────────────────────

export interface RawFunctionCall {
  callId: string;
  name: string;
  arguments: string; // JSON string; caller parses
}

export type ProviderStreamEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_call_done"; call: RawFunctionCall }
  /** done 事件可附带 usage —— provider 解析到 stop/usage 时填，business
   * 层不直接消费（adapter 已经主动写了 token_usage 表）；保留在事件
   * 里方便日志 / 调试。 */
  | { kind: "done"; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }
  | { kind: "error"; message: string };

// ─── Input shape (ARK Responses API today; provider-agnostic on Day 2) ───

export interface ArkInputMessage {
  role: "system" | "user" | "assistant";
  content: Array<{ type: "input_text"; text: string }>;
}

export type ProviderInputItem =
  | ArkInputMessage
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

// ─── Adapter interface ──────────────────────────────────────────────────

export interface ProviderStreamParams {
  model: ModelEntry;
  input: ProviderInputItem[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** 记账上下文 —— 业务方传 { userId, workspaceId, feature }，provider
   * adapter 在 stream 完成时把 usage 写入 token_usage 表。
   * 不传 → 不记录（兼容 cron / 系统调用 / 单测）。 */
  recordContext?: {
    userId: string | null;
    workspaceId?: string | null;
    feature: string;
  };
}

export interface ProviderAdapter {
  /** Short, stable id used in the registry dispatch table. */
  readonly name: "ark" | "oneapi";
  /**
   * Open a streaming request to the provider and yield canonical events.
   * The generator must terminate on `done`, `error`, or when the underlying
   * stream closes. Adapters are responsible for aborting via `signal`.
   */
  stream(params: ProviderStreamParams): AsyncGenerator<ProviderStreamEvent>;
}
