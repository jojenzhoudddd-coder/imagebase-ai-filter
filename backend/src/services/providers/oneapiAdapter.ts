/**
 * OneAPI adapter — bridges Claude + GPT-5 families through a OneAPI proxy
 * (github.com/songquanpeng/one-api). The proxy speaks two wire formats:
 *
 *   · `/v1/messages`         — Anthropic-native (used for Claude family).
 *     Only this endpoint honors `thinking: {type:"enabled"}`; the OpenAI-
 *     compatible path silently drops thinking requests. Verified by
 *     probing oneapi.iline.work directly.
 *   · `/v1/chat/completions` — OpenAI-compatible (used for GPT-5 family).
 *
 * One adapter, two branches. The registry's `provider` field is `"oneapi"`
 * for every non-ARK model; we pick the wire format from `model.group` at
 * request time. That keeps the registry simple and `resolveAdapter()` a
 * pure lookup.
 *
 * ## Input normalization
 *
 * Upstream (chatAgentService.ts) hands us `ProviderInputItem[]` — an
 * ARK-shaped mix of `{role, content:[{type:"input_text", text}]}` items
 * and standalone `{type:"function_call"}` / `{type:"function_call_output"}`
 * items. Both branches below translate that into their respective shapes:
 *
 *   ARK system items            → Anthropic top-level `system` field, or
 *                                  OpenAI `{role:"system"}` message
 *   ARK user/assistant items    → message with plain string content
 *   ARK function_call items     → Anthropic `tool_use` block on an
 *                                  assistant message, or OpenAI
 *                                  `tool_calls[]` entry on an assistant
 *                                  message with `content:null`
 *   ARK function_call_output    → Anthropic `tool_result` block on a
 *                                  user message, or OpenAI `{role:"tool",
 *                                  tool_call_id, content}`
 *
 * Adjacent same-role items collapse into one message (Anthropic requires
 * strict user↔assistant alternation; OpenAI accepts either). We never
 * replay the *text* content of prior assistant turns that were followed
 * by tool calls — chatAgentService already strips those, so we just see
 * function_call / function_call_output pairs.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  ProviderAdapter,
  ProviderInputItem,
  ProviderStreamEvent,
  ProviderStreamParams,
} from "./types.js";
import type { ModelEntry } from "../modelRegistry.js";
import type { ToolDefinition } from "../../../mcp-server/src/tools/tableTools.js";

const ONEAPI_BASE_URL =
  (process.env.ONEAPI_BASE_URL || "https://oneapi.example.com/v1").replace(/\/$/, "");

// ─── Typed upstream errors ──────────────────────────────────────────────
//
// Distinguishing *transient upstream overload* (retryable) from *hard
// failure* (caller should fall back or bubble) makes the agent loop's
// recovery policy straightforward: catch UpstreamOverloadError → reroute
// to a different model; catch anything else → surface to user.

export class UpstreamOverloadError extends Error {
  readonly provider: "anthropic" | "openai";
  readonly status: number;
  readonly retryableAfterMs: number;
  constructor(provider: "anthropic" | "openai", status: number, message: string, retryableAfterMs = 0) {
    super(message);
    this.name = "UpstreamOverloadError";
    this.provider = provider;
    this.status = status;
    this.retryableAfterMs = retryableAfterMs;
  }
}

/**
 * Inspect a non-OK Response to decide whether this is a transient overload
 * (`overloaded_error` per Anthropic, 429/503/5xx in general) vs a hard
 * protocol-level failure. We parse the body lazily — bodies over a few KB
 * get trimmed so we don't buffer huge HTML error pages.
 */
async function classifyError(
  res: Response,
  provider: "anthropic" | "openai",
): Promise<{ overloaded: boolean; message: string; retryAfterMs: number }> {
  const retryAfter = res.headers.get("retry-after");
  // Retry-After may be seconds OR an HTTP-date; we only support the seconds form.
  const retryAfterMs = retryAfter ? (Number.isFinite(+retryAfter) ? Math.max(0, +retryAfter * 1000) : 0) : 0;
  const txt = await res.text().catch(() => "");
  const trimmed = txt.slice(0, 600);
  let overloaded = false;

  // Anthropic surfaces `{"error":{"type":"overloaded_error"}}` — case matters.
  // 429 (rate-limited) and 503 (service unavailable) are also retryable.
  // 5xx without a structured body is usually also transient (proxy blips).
  if (res.status === 429 || res.status === 503) overloaded = true;
  if (res.status >= 500 && res.status < 600) overloaded = true;
  if (/\boverloaded_error\b|\bOverloaded\b/i.test(trimmed)) overloaded = true;

  const message = `OneAPI(${provider}) ${res.status}: ${trimmed}`;
  return { overloaded, message, retryAfterMs };
}

/**
 * Execute `attempt` up to `maxAttempts` times, treating UpstreamOverloadError
 * as retryable. Delays grow exponentially (base 1s, max 6s) unless the
 * server's Retry-After header specifies longer. Aborted signals short-circuit.
 */
async function withOverloadRetry<T>(
  attempt: () => Promise<T>,
  opts: { maxAttempts: number; signal?: AbortSignal; onRetry?: (err: UpstreamOverloadError, nextDelayMs: number, attemptIndex: number) => void },
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < opts.maxAttempts; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      if (!(err instanceof UpstreamOverloadError)) throw err;
      if (i === opts.maxAttempts - 1) break;
      // Exponential backoff 1s → 2s → 4s, capped at 6s. Retry-After wins when set.
      const expDelay = Math.min(6_000, 1_000 * 2 ** i);
      const delay = Math.max(expDelay, err.retryableAfterMs);
      opts.onRetry?.(err, delay, i);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        if (opts.signal) {
          const onAbort = () => { clearTimeout(t); reject(new Error("aborted during retry delay")); };
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
  }
  throw lastErr;
}

// ─── Tool-schema conversion ─────────────────────────────────────────────

function toAnthropicTools(tools: ToolDefinition[] = []) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

function toOpenAITools(tools: ToolDefinition[] = []) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ─── Input conversion helpers ────────────────────────────────────────────

type AnthropicImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

type AnthropicInnerBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource };

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | AnthropicInnerBlock[];
    };

/**
 * Magic marker prefix a tool handler uses to smuggle image payloads through
 * the string-based tool_result channel. When detected here we expand the
 * string into a proper Anthropic `tool_result.content` array with an
 * `{type:"image"}` block — giving Claude real vision over the payload.
 *
 * Shape after the marker: JSON of
 *   { mediaType, base64, caption?, text? }
 * Tools that don't need vision (most of them) just return plain strings
 * and this code path is a no-op.
 */
const IBASE_IMAGE_MARKER = "__IBASE_IMAGE_v1__";
interface ImagePayload {
  mediaType: string;
  base64: string;
  caption?: string;
  /** Optional structured text to render alongside the image block. */
  text?: string;
}

function decodeImageToolResult(raw: string): ImagePayload | null {
  if (!raw.startsWith(IBASE_IMAGE_MARKER)) return null;
  try {
    return JSON.parse(raw.slice(IBASE_IMAGE_MARKER.length)) as ImagePayload;
  } catch {
    return null;
  }
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

function extractText(item: ProviderInputItem): string {
  if ("content" in item && Array.isArray(item.content)) {
    return item.content
      .map((c) => ("text" in c ? c.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

/** ARK → Anthropic: split into `system` (concatenated) + `messages[]`. */
function toAnthropicShape(input: ProviderInputItem[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const msgs: AnthropicMessage[] = [];

  const pushBlock = (role: "user" | "assistant", block: AnthropicContentBlock) => {
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) {
      last.content.push(block);
    } else {
      msgs.push({ role, content: [block] });
    }
  };

  for (const it of input) {
    // ARK role-based item
    if ("role" in it) {
      if (it.role === "system") {
        const t = extractText(it);
        if (t) systemParts.push(t);
        continue;
      }
      if (it.role === "user" || it.role === "assistant") {
        const t = extractText(it);
        if (t) pushBlock(it.role, { type: "text", text: t });
        continue;
      }
    }
    // ARK tool-call items
    if ("type" in it && it.type === "function_call") {
      let parsed: unknown = {};
      try {
        parsed = it.arguments ? JSON.parse(it.arguments) : {};
      } catch {
        parsed = {};
      }
      pushBlock("assistant", {
        type: "tool_use",
        id: it.call_id,
        name: it.name,
        input: parsed,
      });
      continue;
    }
    if ("type" in it && it.type === "function_call_output") {
      const rawOutput = typeof it.output === "string" ? it.output : JSON.stringify(it.output);
      const imagePayload = decodeImageToolResult(rawOutput);
      if (imagePayload) {
        // Expand the marker into a proper tool_result with an image inner
        // block so Claude can actually see the pixels. Text block (caption
        // + optional extra text) gives Claude structured metadata alongside.
        const inner: AnthropicInnerBlock[] = [];
        const textPieces: string[] = [];
        if (imagePayload.caption) textPieces.push(imagePayload.caption);
        if (imagePayload.text) textPieces.push(imagePayload.text);
        if (textPieces.length) inner.push({ type: "text", text: textPieces.join("\n\n") });
        inner.push({
          type: "image",
          source: {
            type: "base64",
            media_type: imagePayload.mediaType,
            data: imagePayload.base64,
          },
        });
        pushBlock("user", {
          type: "tool_result",
          tool_use_id: it.call_id,
          content: inner,
        });
        continue;
      }
      pushBlock("user", {
        type: "tool_result",
        tool_use_id: it.call_id,
        content: rawOutput,
      });
      continue;
    }
  }

  // Anthropic requires the first message to be user. If an assistant
  // message leaks in first (shouldn't happen in practice, but defensively),
  // prepend an empty user turn.
  if (msgs.length && msgs[0].role !== "user") {
    msgs.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  }

  return { system: systemParts.join("\n\n"), messages: msgs };
}

// ─── OpenAI shape ────────────────────────────────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

/** ARK → OpenAI chat.completions messages. */
function toOpenAIShape(input: ProviderInputItem[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const it of input) {
    if ("role" in it) {
      const t = extractText(it);
      if (it.role === "system" || it.role === "user" || it.role === "assistant") {
        // Skip empty assistant messages — OpenAI rejects them.
        if (!t && it.role === "assistant") continue;
        out.push({ role: it.role, content: t });
      }
      continue;
    }
    if ("type" in it && it.type === "function_call") {
      // Merge into previous assistant message if any, else push fresh.
      const last = out[out.length - 1];
      const toolCall = {
        id: it.call_id,
        type: "function" as const,
        function: { name: it.name, arguments: it.arguments || "{}" },
      };
      if (last && last.role === "assistant" && !last.tool_calls?.length && !last.content) {
        last.tool_calls = [toolCall];
      } else if (last && last.role === "assistant" && last.tool_calls) {
        last.tool_calls.push(toolCall);
      } else {
        out.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      continue;
    }
    if ("type" in it && it.type === "function_call_output") {
      const rawOutput =
        typeof it.output === "string" ? it.output : JSON.stringify(it.output);
      // OpenAI chat.completions `role: tool` content is string-only. If an
      // image tool_result leaks through on this branch, strip the image and
      // keep the caption/text so at least the model sees something useful.
      // Full vision support on GPT-5 would need the newer Responses API
      // content-part format; left as future work.
      const imagePayload = decodeImageToolResult(rawOutput);
      if (imagePayload) {
        const fallbackText =
          (imagePayload.caption ? imagePayload.caption + "\n\n" : "") +
          (imagePayload.text ?? "") +
          `\n\n[image omitted — current OpenAI tool channel accepts text only. ` +
          `Switch to an Anthropic model to see the actual pixels.]`;
        out.push({ role: "tool", tool_call_id: it.call_id, content: fallbackText });
        continue;
      }
      out.push({ role: "tool", tool_call_id: it.call_id, content: rawOutput });
      continue;
    }
  }
  return out;
}

// ─── SSE parsing helpers ─────────────────────────────────────────────────

function parseSseBlock(block: string): { event: string; data: unknown } | null {
  let event = "message";
  let dataStr = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
  }
  if (!dataStr) return null;
  if (dataStr === "[DONE]") return { event, data: null };
  try {
    return { event, data: JSON.parse(dataStr) };
  } catch {
    return { event, data: dataStr };
  }
}

// ─── Anthropic branch ────────────────────────────────────────────────────

async function* streamAnthropic(
  model: ModelEntry,
  params: ProviderStreamParams,
  apiKey: string
): AsyncGenerator<ProviderStreamEvent> {
  const { system, messages } = toAnthropicShape(params.input);

  // ── OneAPI-Claude-Code-override workaround ───────────────────────────────
  //
  // The oneapi.iline.work proxy runs Claude through the Claude Code SDK, not
  // raw Anthropic. That SDK injects its own ~2000-token "You are Claude Code,
  // Anthropic's official CLI…" system prompt BEFORE ours, and Claude then
  // bonds to that persona and ignores whatever we put in the `system` field.
  // Reproducible: POST /v1/messages with system="your name is Claw" → Claude
  // still introduces itself as Claude Code.
  //
  // The fix is to stop using the `system` field entirely on this channel and
  // instead bootstrap the identity as the first turn in `messages[]` — one
  // user message carrying our composed prompt wrapped in sentinel tags, plus
  // a one-line assistant acknowledgment. OneAPI doesn't touch message content,
  // so this survives untouched. Costs us two extra turns per request in
  // token accounting but that's cheap next to the value of actually honoring
  // our identity. Direct curl confirmed this yields the correct persona.
  const finalMessages: AnthropicMessage[] = [];
  if (system) {
    finalMessages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `<持久系统指令 priority="highest">\n${system}\n</持久系统指令>`,
        },
      ],
    });
    finalMessages.push({
      role: "assistant",
      content: [{ type: "text", text: "明白，我会严格遵循以上系统指令。" }],
    });
  }
  finalMessages.push(...messages);

  const body: Record<string, unknown> = {
    model: model.providerModelId,
    max_tokens: model.defaults.maxOutputTokens,
    temperature: model.defaults.temperature,
    stream: true,
    messages: finalMessages,
    tools: toAnthropicTools(params.tools),
  };
  // Intentionally NOT setting body.system — see workaround comment above.
  if (model.capabilities.thinking) {
    body.thinking = {
      type: "enabled",
      budget_tokens: model.capabilities.thinkingBudget ?? 4096,
    };
  }

  const url = `${ONEAPI_BASE_URL.replace(/\/v1$/, "")}/v1/messages`;
  // Retry the initial POST up to 3× on upstream overload (Anthropic's
  // `overloaded_error` / HTTP 503 / 429). Only the HEADERS/handshake phase
  // is retryable — once we have a body stream, errors mid-stream go to the
  // caller unchanged (the partial tokens have already been delivered and
  // retrying would double-speak).
  const res = await withOverloadRetry(
    async () => {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });
      if (!r.ok || !r.body) {
        const cls = await classifyError(r, "anthropic");
        if (cls.overloaded) throw new UpstreamOverloadError("anthropic", r.status, cls.message, cls.retryAfterMs);
        throw new Error(cls.message);
      }
      return r;
    },
    { maxAttempts: 3, signal: params.signal, onRetry: (err, ms, i) => {
      console.warn(`[oneapi:anthropic] upstream overload (status=${err.status}), retry ${i + 1}/3 in ${ms}ms`);
    } },
  );

  // withOverloadRetry throws if body was null, so this is safe.
  const reader = res.body!.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  // Per content-block accumulators, keyed by block `index`.
  const blocks = new Map<
    number,
    {
      type: "text" | "thinking" | "tool_use";
      toolName?: string;
      toolId?: string;
      toolArgs?: string;
    }
  >();
  const yieldedCallIds = new Set<string>();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!block.trim()) continue;
        const parsed = parseSseBlock(block);
        if (!parsed) continue;
        const { event, data } = parsed;
        if (data === null) {
          yield { kind: "done" };
          return;
        }
        const d = data as any;

        if (event === "content_block_start") {
          const index = d.index as number;
          const cb = d.content_block;
          if (cb?.type === "thinking") {
            blocks.set(index, { type: "thinking" });
            // Some OneAPI channels strip `thinking_delta` content and only
            // forward `signature_delta`. Emit a single marker so the UI's
            // "深度思考中…" indicator still lights up on those channels;
            // real thinking text (if present) will still stream below.
            yield { kind: "thinking_delta", text: "" };
          } else if (cb?.type === "text") {
            blocks.set(index, { type: "text" });
          } else if (cb?.type === "tool_use") {
            blocks.set(index, {
              type: "tool_use",
              toolName: cb.name,
              toolId: cb.id,
              toolArgs: "",
            });
          }
          continue;
        }

        if (event === "content_block_delta") {
          const index = d.index as number;
          const b = blocks.get(index);
          if (!b) continue;
          const delta = d.delta;
          if (b.type === "text" && delta?.type === "text_delta") {
            if (delta.text) yield { kind: "text_delta", text: String(delta.text) };
          } else if (b.type === "thinking") {
            // `thinking_delta` carries the reasoning text; `signature_delta`
            // is a signed envelope we can ignore — it's only meaningful if
            // we want to preserve the thinking block for a later turn,
            // which we don't (we never replay thinking).
            if (delta?.type === "thinking_delta" && delta.thinking) {
              yield { kind: "thinking_delta", text: String(delta.thinking) };
            }
          } else if (b.type === "tool_use" && delta?.type === "input_json_delta") {
            b.toolArgs = (b.toolArgs || "") + (delta.partial_json || "");
          }
          continue;
        }

        if (event === "content_block_stop") {
          const index = d.index as number;
          const b = blocks.get(index);
          if (b?.type === "tool_use" && b.toolName && b.toolId) {
            const callId = b.toolId;
            if (!yieldedCallIds.has(callId)) {
              yieldedCallIds.add(callId);
              yield {
                kind: "tool_call_done",
                call: {
                  callId,
                  name: b.toolName,
                  arguments: b.toolArgs || "{}",
                },
              };
            }
          }
          blocks.delete(index);
          continue;
        }

        if (event === "message_stop") {
          yield { kind: "done" };
          return;
        }

        if (event === "error") {
          const msg =
            typeof d === "string"
              ? d
              : d?.error?.message || d?.message || JSON.stringify(d);
          yield { kind: "error", message: String(msg) };
          return;
        }
        // message_start / message_delta / ping → ignore
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* noop */
    }
  }
  yield { kind: "done" };
}

// ─── OpenAI branch ───────────────────────────────────────────────────────

async function* streamOpenAI(
  model: ModelEntry,
  params: ProviderStreamParams,
  apiKey: string
): AsyncGenerator<ProviderStreamEvent> {
  const messages = toOpenAIShape(params.input);

  const body: Record<string, unknown> = {
    model: model.providerModelId,
    messages,
    stream: true,
    temperature: model.defaults.temperature,
    max_tokens: model.defaults.maxOutputTokens,
  };
  if (params.tools && params.tools.length) {
    body.tools = toOpenAITools(params.tools);
  }

  const url = `${ONEAPI_BASE_URL}/chat/completions`;
  const res = await withOverloadRetry(
    async () => {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });
      if (!r.ok || !r.body) {
        const cls = await classifyError(r, "openai");
        if (cls.overloaded) throw new UpstreamOverloadError("openai", r.status, cls.message, cls.retryAfterMs);
        throw new Error(cls.message);
      }
      return r;
    },
    { maxAttempts: 3, signal: params.signal, onRetry: (err, ms, i) => {
      console.warn(`[oneapi:openai] upstream overload (status=${err.status}), retry ${i + 1}/3 in ${ms}ms`);
    } },
  );

  const reader = res.body!.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  // Tool-call accumulator — OpenAI streams partial arguments keyed by index.
  const toolCallsByIndex = new Map<
    number,
    { id: string; name: string; args: string }
  >();
  const yieldedCallIds = new Set<string>();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!block.trim()) continue;
        const parsed = parseSseBlock(block);
        if (!parsed) continue;
        const { data } = parsed;
        if (data === null) {
          // [DONE] — emit pending tool calls, then done.
          for (const tc of toolCallsByIndex.values()) {
            if (tc.name && !yieldedCallIds.has(tc.id)) {
              yieldedCallIds.add(tc.id);
              yield {
                kind: "tool_call_done",
                call: { callId: tc.id, name: tc.name, arguments: tc.args || "{}" },
              };
            }
          }
          yield { kind: "done" };
          return;
        }

        const d = data as any;
        const choice = d?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        if (typeof delta.content === "string" && delta.content) {
          yield { kind: "text_delta", text: delta.content };
        }
        // Some OneAPI channels expose reasoning via `reasoning_content` — not
        // spec but cheap to support. Won't fire for Claude-via-OpenAI-compat
        // (that path silently drops thinking).
        if (
          typeof delta.reasoning_content === "string" &&
          delta.reasoning_content
        ) {
          yield { kind: "thinking_delta", text: delta.reasoning_content };
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = typeof tc.index === "number" ? tc.index : 0;
            const existing = toolCallsByIndex.get(index) ?? {
              id: "",
              name: "",
              args: "",
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (typeof tc.function?.arguments === "string") {
              existing.args += tc.function.arguments;
            }
            toolCallsByIndex.set(index, existing);
          }
        }

        if (choice.finish_reason) {
          // Emit any completed tool calls before the terminal [DONE].
          for (const tc of toolCallsByIndex.values()) {
            if (tc.name && tc.id && !yieldedCallIds.has(tc.id)) {
              yieldedCallIds.add(tc.id);
              yield {
                kind: "tool_call_done",
                call: { callId: tc.id, name: tc.name, arguments: tc.args || "{}" },
              };
            }
          }
          // Don't return here — [DONE] event still pending in the stream.
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* noop */
    }
  }
  yield { kind: "done" };
}

// ─── Adapter shell ───────────────────────────────────────────────────────

export const oneapiAdapter: ProviderAdapter = {
  name: "oneapi",

  async *stream(params: ProviderStreamParams): AsyncGenerator<ProviderStreamEvent> {
    const { model } = params;
    const apiKey = process.env.ONEAPI_API_KEY;
    if (!apiKey) {
      throw new Error("ONEAPI_API_KEY not configured");
    }

    if (model.group === "anthropic") {
      yield* streamAnthropic(model, params, apiKey);
      return;
    }
    // Default to OpenAI-compat wire format (openai group + any future
    // providers that OneAPI exposes under chat.completions).
    yield* streamOpenAI(model, params, apiKey);
  },
};

// Exposed for focused unit testing — not part of the public adapter API.
export const __testOnly__ = {
  toAnthropicShape,
  toOpenAIShape,
  toAnthropicTools,
  toOpenAITools,
};
