/**
 * ARK Video adapter — Seedance 2.0.
 * Endpoint: POST /api/v3/contents/generations/tasks (async task)
 * Then poll GET /api/v3/contents/generations/tasks/<taskId> until complete.
 * Uses its own API key (ARK_SEEDANCE_API_KEY).
 */

import type { ProviderAdapter, ProviderStreamEvent, ProviderStreamParams } from "./types.js";
import { recordTokenUsage } from "../tokenUsageService.js";

const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const POLL_INTERVAL = 5000;
const MAX_POLL_TIME = 600000; // 10min — video generation can take a while

export const arkVideoAdapter: ProviderAdapter = {
  name: "ark-video",

  async *stream(params: ProviderStreamParams): AsyncGenerator<ProviderStreamEvent> {
    const apiKey = process.env.ARK_SEEDANCE_API_KEY || process.env.ARK_API_KEY || "";
    let prompt = "";
    for (const item of [...params.input].reverse()) {
      if ("role" in item && item.role === "user" && item.content?.[0]?.type === "input_text") {
        prompt = (item.content[0] as { type: "input_text"; text: string }).text;
        break;
      }
    }

    try {
      // Parse ratio from prompt: "9:16" / "1:1" / "16:9" (default)
      let ratio = "16:9";
      if (/\b9\s*:\s*16\b/.test(prompt)) ratio = "9:16";
      else if (/\b1\s*:\s*1\b/.test(prompt)) ratio = "1:1";

      // Parse duration from prompt: number between 5-11
      let duration = 8;
      const durMatch = prompt.match(/(\d+)\s*[秒s]/);
      if (durMatch) {
        const d = parseInt(durMatch[1]);
        if (d >= 5 && d <= 11) duration = d;
      }


      const createRes = await fetch(`${ARK_BASE_URL}/contents/generations/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: params.model.providerModelId,
          content: [{ type: "text", text: prompt }],
          ratio,
          duration,
          watermark: false,
        }),
        signal: params.signal,
      });

      if (!createRes.ok) {
        const body = await createRes.text().catch(() => "");
        yield { kind: "error", message: `ARK ${createRes.status}: ${body.slice(0, 300)}` };
        return;
      }

      const taskData = await createRes.json() as { id?: string };
      const taskId = taskData.id;
      if (!taskId) {
        yield { kind: "error", message: "No task ID returned" };
        return;
      }


      const startTime = Date.now();
      while (Date.now() - startTime < MAX_POLL_TIME) {
        if (params.signal?.aborted) {
          yield { kind: "error", message: "Aborted" };
          return;
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL));

        // Yield a thinking delta to keep upstream timeouts (180s tool timeout,
        // SSE heartbeat) alive during the long polling loop.
        yield { kind: "thinking_delta", text: "" };

        const pollRes = await fetch(`${ARK_BASE_URL}/contents/generations/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: params.signal,
        });

        if (!pollRes.ok) continue;

        const pollData = await pollRes.json() as {
          status?: string;
          content?: { video_url?: string };
          error?: { message?: string };
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };

        if (pollData.status === "succeeded") {
          const videoUrl = pollData.content?.video_url;
          if (videoUrl) {
            yield { kind: "text_delta", text: `[Generated Video](${videoUrl})` };
          } else {
            yield { kind: "text_delta", text: "Video generated but no URL returned." };
          }
          const u = pollData.usage;
          const usage = u ? { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0 } : undefined;
          if (params.recordContext && usage) {
            void recordTokenUsage(
              { ...params.recordContext, model: params.model.providerModelId, provider: "ark-video" },
              { ...usage, durationMs: Date.now() - startTime },
            );
          }
          yield { kind: "done", usage };
          return;
        }

        if (pollData.status === "failed") {
          yield { kind: "error", message: pollData.error?.message ?? "Video generation failed" };
          return;
        }

      }

      yield { kind: "error", message: "Video generation timed out (10min)" };
    } catch (err: any) {
      yield { kind: "error", message: err.message ?? "ark-video request failed" };
    }
  },
};
