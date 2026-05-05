/**
 * ARK Image adapter — Seedream 5.0 Lite.
 * Endpoint: POST /api/v3/images/generations
 * Uses its own API key (ARK_SEEDREAM_API_KEY).
 */

import type { ProviderAdapter, ProviderStreamEvent, ProviderStreamParams } from "./types.js";
import { recordTokenUsage } from "../tokenUsageService.js";

const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";

export const arkImageAdapter: ProviderAdapter = {
  name: "ark-image",

  async *stream(params: ProviderStreamParams): AsyncGenerator<ProviderStreamEvent> {
    const apiKey = process.env.ARK_SEEDREAM_API_KEY || process.env.ARK_API_KEY || "";
    // Extract user text from the last user input item
    let prompt = "";
    for (const item of [...params.input].reverse()) {
      if ("role" in item && item.role === "user" && item.content?.[0]?.text) {
        prompt = item.content[0].text;
        break;
      }
    }

    const startedAt = Date.now();
    try {
      const res = await fetch(`${ARK_BASE_URL}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        // Parse size hint from prompt: "2K" / "1K" / "512x512" etc.
        // Default to 1K for reasonable file size.
        body: JSON.stringify({
          model: params.model.providerModelId,
          prompt,
          response_format: "url",
          size: /\b[34][Kk]\b/.test(prompt) ? (/\b3[Kk]\b/.test(prompt) ? "3k" : "4k") : "2k",
          stream: false,
          watermark: false,
        }),
        signal: params.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        yield { kind: "error", message: `ARK ${res.status}: ${body.slice(0, 300)}` };
        return;
      }

      const data = await res.json() as { data?: Array<{ url?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
      const imageUrl = data.data?.[0]?.url;

      if (imageUrl) {
        yield { kind: "text_delta", text: `![Generated Image](${imageUrl})` };
      } else {
        yield { kind: "text_delta", text: "Image generation completed but no URL returned." };
      }
      const u = data.usage;
      const usage = u ? { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0 } : undefined;
      if (params.recordContext && usage) {
        void recordTokenUsage(
          { ...params.recordContext, model: params.model.providerModelId, provider: "ark-image" },
          { ...usage, durationMs: Date.now() - startedAt },
        );
      }
      yield { kind: "done", usage };
    } catch (err: any) {
      yield { kind: "error", message: err.message ?? "ark-image request failed" };
    }
  },
};
