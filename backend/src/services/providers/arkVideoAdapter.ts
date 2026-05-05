/**
 * ARK Video adapter — Seedance 2.0.
 * Endpoint: POST /api/v3/contents/generations/tasks (async task)
 * Then poll GET /api/v3/contents/generations/tasks/<taskId> until complete.
 * Uses its own API key (ARK_SEEDANCE_API_KEY).
 */

import type { ProviderAdapter, ProviderStreamEvent, ProviderStreamParams } from "./types.js";

const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const POLL_INTERVAL = 5000;
const MAX_POLL_TIME = 300000;

export const arkVideoAdapter: ProviderAdapter = {
  name: "ark-video",

  async *stream(params: ProviderStreamParams): AsyncGenerator<ProviderStreamEvent> {
    const apiKey = process.env.ARK_SEEDANCE_API_KEY || process.env.ARK_API_KEY || "";
    let prompt = "";
    for (const item of [...params.input].reverse()) {
      if ("role" in item && item.role === "user" && item.content?.[0]?.text) {
        prompt = item.content[0].text;
        break;
      }
    }

    try {
      yield { kind: "text_delta", text: "Creating video generation task...\n" };

      const createRes = await fetch(`${ARK_BASE_URL}/contents/generations/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: params.model.providerModelId,
          content: [{ type: "text", text: prompt }],
          ratio: "16:9",
          duration: 8,
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

      yield { kind: "text_delta", text: `Task created: ${taskId}\n` };

      const startTime = Date.now();
      while (Date.now() - startTime < MAX_POLL_TIME) {
        if (params.signal?.aborted) {
          yield { kind: "error", message: "Aborted" };
          return;
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL));

        const pollRes = await fetch(`${ARK_BASE_URL}/contents/generations/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: params.signal,
        });

        if (!pollRes.ok) continue;

        const pollData = await pollRes.json() as {
          status?: string;
          content?: { video_url?: string };
          error?: { message?: string };
        };

        if (pollData.status === "succeeded") {
          const videoUrl = pollData.content?.video_url;
          if (videoUrl) {
            yield { kind: "text_delta", text: `\nVideo generated successfully!\n\n${videoUrl}` };
          } else {
            yield { kind: "text_delta", text: "\nVideo generated but no URL returned." };
          }
          yield { kind: "done" };
          return;
        }

        if (pollData.status === "failed") {
          yield { kind: "error", message: pollData.error?.message ?? "Video generation failed" };
          return;
        }

        yield { kind: "text_delta", text: "." };
      }

      yield { kind: "error", message: "Video generation timed out (5min)" };
    } catch (err: any) {
      yield { kind: "error", message: err.message ?? "ark-video request failed" };
    }
  },
};
