/**
 * Volcano ARK adapter — Responses API streaming.
 *
 * This is a near-verbatim extraction of the old `callArkStream` generator
 * that lived inside chatAgentService.ts. Behavior is byte-for-byte identical
 * so Day 1 is a zero-regression refactor. The only additions are:
 *   - Reads model id + temperature + max_output_tokens from the passed-in
 *     ModelEntry instead of module-level env constants
 *   - Conforms to the ProviderAdapter interface
 *
 * ## ARK SSE frames we handle
 *   response.output_text.delta              — incremental assistant text
 *   response.reasoning(_summary_text).delta — incremental thinking text
 *   response.function_call_arguments.delta  — incremental tool-call args
 *   response.output_item.added              — new function_call/message item
 *   response.output_item.done               — item complete (final fields)
 *   response.completed                      — stream end (fallback for calls)
 *   response.error                          — terminal error
 *
 * Naming drift: some deployments emit the bare form (`output_text.delta`
 * without the `response.` prefix). We tolerate both.
 */

import { v4 as uuidv4 } from "uuid";
import { toArkToolFormat } from "../../../mcp-server/src/tools/index.js";
import type {
  ProviderAdapter,
  ProviderStreamEvent,
  ProviderStreamParams,
} from "./types.js";

const ARK_BASE_URL =
  process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";

/**
 * Strip IBASE_IMAGE markers from the input array. ARK (Doubao) Responses
 * API accepts images via its own content-parts schema, not as inlined
 * base64 strings — if we pass through the raw `__IBASE_IMAGE_v1__<json>`
 * payload, ARK treats it as text, and a typical PNG (~100KB base64)
 * instantly blows the max_message_tokens limit (observed: ARK 400
 * "Total tokens of image and text exceed max message tokens").
 *
 * This usually triggers when a turn that captured an image on Claude
 * falls back to ARK (overload cascade). The image history is replayed
 * every round, so one view_taste_image call can kill dozens of subsequent
 * ARK rounds until the session is reset.
 *
 * Replace image tool_results with a short text-only note so ARK can
 * continue the turn without exploding. Visual fidelity is lost — the
 * Agent simply doesn't "see" those images anymore — but data-loss beats
 * turn-killing 400.
 */
const IBASE_IMAGE_MARKER = "__IBASE_IMAGE_v1__";
function sanitizeInputForArk(input: unknown[]): unknown[] {
  return input.map((it: any) => {
    if (!it || typeof it !== "object") return it;
    if (it.type !== "function_call_output") return it;
    const raw = typeof it.output === "string" ? it.output : "";
    if (!raw.startsWith(IBASE_IMAGE_MARKER)) return it;
    let payload: { mediaType?: string; caption?: string; text?: string } = {};
    try {
      payload = JSON.parse(raw.slice(IBASE_IMAGE_MARKER.length));
    } catch { /* malformed marker — drop silently */ }
    const replacement =
      (payload.caption ? payload.caption + "\n\n" : "") +
      (payload.text ?? "") +
      "\n\n[image omitted — Volcano ARK vision schema not implemented on this channel. " +
      "Switch to a Claude model in the picker to see the pixels.]";
    return { ...it, output: replacement.trim() };
  });
}

export const arkAdapter: ProviderAdapter = {
  name: "ark",

  async *stream(params: ProviderStreamParams): AsyncGenerator<ProviderStreamEvent> {
    const { model, input, tools, signal } = params;

    const apiKey = process.env.ARK_API_KEY;
    if (!apiKey) throw new Error("ARK_API_KEY not configured");

    // Strip IBASE_IMAGE markers before handing off — ARK can't read them
    // and the raw base64 blows max_message_tokens.
    const sanitizedInput = sanitizeInputForArk(input as unknown[]);
    const body: Record<string, unknown> = {
      model: model.providerModelId,
      input: sanitizedInput,
      max_output_tokens: model.defaults.maxOutputTokens,
      temperature: model.defaults.temperature,
      stream: true,
      tools: toArkToolFormat(tools),
    };
    // Only ask for thinking when the model supports it. Doubao 2.0 currently
    // runs with `thinking: disabled` (the old hardcoded path set
    // `{ type: "enabled" }` for every model, but in practice Doubao treated
    // that as a no-op). Future reasoning-enabled ARK models can flip the
    // capability flag and get thinking automatically.
    if (model.capabilities.thinking) {
      body.thinking = { type: "enabled" };
    }

    const res = await fetch(`${ARK_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => "");
      throw new Error(`ARK ${res.status}: ${txt.slice(0, 400)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    // Per-item accumulators — function_call arguments stream as chunks and
    // only become callable at output_item.done time.
    const pendingCalls = new Map<
      string,
      { name?: string; args: string; callId?: string }
    >();
    // Dedupe across output_item.done and the response.completed fallback.
    const yieldedCallIds = new Set<string>();

    function parseEventBlock(
      block: string
    ): { event: string; data: any } | null {
      let event = "message";
      let dataStr = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!dataStr || dataStr === "[DONE]") return { event, data: null };
      try {
        return { event, data: JSON.parse(dataStr) };
      } catch {
        return { event, data: dataStr };
      }
    }

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
          const parsed = parseEventBlock(block);
          if (!parsed) continue;
          const { event, data } = parsed;
          if (data === null) {
            if (event === "done" || event === "response.completed") {
              yield { kind: "done" };
              return;
            }
            continue;
          }

          // ── Text deltas ──
          if (
            event === "response.output_text.delta" ||
            event === "output_text.delta"
          ) {
            const txt =
              typeof data === "string"
                ? data
                : (data.delta ?? data.text ?? "");
            if (txt) yield { kind: "text_delta", text: String(txt) };
            continue;
          }
          // ── Thinking / reasoning deltas ──
          if (
            event === "response.reasoning_summary_text.delta" ||
            event === "response.reasoning.delta" ||
            event === "response.thinking.delta" ||
            event === "reasoning.delta" ||
            event === "thinking.delta" ||
            event === "response.reasoning_text.delta"
          ) {
            const txt =
              typeof data === "string"
                ? data
                : (data.delta ?? data.text ?? "");
            if (txt) yield { kind: "thinking_delta", text: String(txt) };
            continue;
          }
          // ── Function-call arg accumulation ──
          if (
            event === "response.function_call_arguments.delta" ||
            event === "function_call_arguments.delta"
          ) {
            const itemId =
              data.item_id || data.id || data.call_id || "default";
            const entry = pendingCalls.get(itemId) ?? { args: "" };
            entry.args +=
              typeof data.delta === "string"
                ? data.delta
                : (data.arguments ?? "");
            if (!entry.callId && data.call_id) entry.callId = data.call_id;
            pendingCalls.set(itemId, entry);
            continue;
          }
          if (
            event === "response.function_call_arguments.done" ||
            event === "function_call_arguments.done"
          ) {
            const itemId =
              data.item_id || data.id || data.call_id || "default";
            const entry = pendingCalls.get(itemId);
            if (entry) {
              if (data.arguments && !entry.args) entry.args = data.arguments;
              if (data.call_id && !entry.callId)
                entry.callId = data.call_id;
            }
            continue;
          }
          // ── New output item ──
          if (
            event === "response.output_item.added" ||
            event === "output_item.added"
          ) {
            const item = data.item ?? data;
            if (item?.type === "function_call") {
              const itemId =
                data.item_id || item.id || item.call_id || "default";
              pendingCalls.set(itemId, {
                name: item.name,
                args:
                  typeof item.arguments === "string" ? item.arguments : "",
                callId: item.call_id || item.id,
              });
            }
            continue;
          }
          // ── Item complete: emit assembled tool call ──
          if (
            event === "response.output_item.done" ||
            event === "output_item.done"
          ) {
            const item = data.item ?? data;
            if (item?.type === "function_call") {
              const itemId =
                data.item_id || item.id || item.call_id || "default";
              const entry: { name?: string; args: string; callId?: string } =
                pendingCalls.get(itemId) ?? {
                  args: "",
                  name: item.name,
                  callId: item.call_id || item.id,
                };
              const finalArgs =
                entry.args ||
                (typeof item.arguments === "string"
                  ? item.arguments
                  : "") ||
                "{}";
              const name = entry.name || item.name;
              const callId =
                entry.callId || item.call_id || item.id || uuidv4();
              pendingCalls.delete(itemId);
              if (name && !yieldedCallIds.has(callId)) {
                yieldedCallIds.add(callId);
                yield {
                  kind: "tool_call_done",
                  call: { callId, name, arguments: finalArgs },
                };
              }
            }
            continue;
          }
          // ── Response completed (fallback for missed tool calls) ──
          if (event === "response.completed" || event === "completed") {
            const output = data?.response?.output ?? data?.output;
            if (Array.isArray(output)) {
              for (const it of output) {
                if (it?.type === "function_call" && it.name) {
                  const callId = it.call_id || it.id || uuidv4();
                  if (!yieldedCallIds.has(callId)) {
                    yieldedCallIds.add(callId);
                    yield {
                      kind: "tool_call_done",
                      call: {
                        callId,
                        name: it.name,
                        arguments: it.arguments || "{}",
                      },
                    };
                  }
                }
              }
            }
            yield { kind: "done" };
            return;
          }
          if (event === "response.error" || event === "error") {
            const msg =
              typeof data === "string"
                ? data
                : (data.message || data.error || JSON.stringify(data));
            yield { kind: "error", message: String(msg) };
            return;
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
  },
};
