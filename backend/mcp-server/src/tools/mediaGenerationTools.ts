/**
 * Media generation tools — direct wrappers around ARK Seedream / Seedance.
 *
 * These are tools instead of "subagent models" because image/video models do
 * not support tool calling. The agent can call these tools, then use normal
 * settings tools to apply the generated asset.
 */

import {
  getModel,
  getModelSemaphore,
  ModelRequestPriority,
  registerProviderAdapter,
  resolveAdapter,
  type ModelEntry,
} from "../../../src/services/modelRegistry.js";
import { arkImageAdapter } from "../../../src/services/providers/arkImageAdapter.js";
import { arkVideoAdapter } from "../../../src/services/providers/arkVideoAdapter.js";
import type { ProviderInputItem } from "../../../src/services/providers/types.js";
import type { ToolContext, ToolDefinition } from "./tableTools.js";

registerProviderAdapter(arkImageAdapter);
registerProviderAdapter(arkVideoAdapter);

function parseGeneratedUrl(text: string): string | null {
  const markdown = text.match(/\]\((https?:\/\/[^)\s]+)\)/);
  if (markdown?.[1]) return markdown[1];
  const plain = text.match(/https?:\/\/\S+/);
  return plain?.[0]?.replace(/[)\],.]+$/, "") ?? null;
}

function assertMediaModel(modelId: string, provider: ModelEntry["provider"]): ModelEntry {
  const model = getModel(modelId);
  if (!model) throw new Error(`unknown model: ${modelId}`);
  if (model.provider !== provider) {
    throw new Error(`model ${modelId} is provider=${model.provider}; expected ${provider}`);
  }
  if (model.available === false) {
    throw new Error(`model ${modelId} is currently unavailable`);
  }
  return model;
}

async function runMediaModel(
  model: ModelEntry,
  prompt: string,
  ctx: ToolContext | undefined,
  feature: string,
): Promise<{ text: string; url: string | null; modelId: string; providerModelId: string }> {
  const input: ProviderInputItem[] = [
    { role: "user", content: [{ type: "input_text", text: prompt }] },
  ];
  const sem = getModelSemaphore(model.id);
  const release = await sem.acquire(ModelRequestPriority.SUBAGENT);
  let text = "";
  try {
    const adapter = resolveAdapter(model);
    for await (const ev of adapter.stream({
      model,
      input,
      recordContext: {
        userId: null,
        workspaceId: ctx?.workspaceId ?? null,
        feature,
      },
    })) {
      if (ev.kind === "text_delta") text += ev.text;
      else if (ev.kind === "error") throw new Error(ev.message);
    }
  } finally {
    release();
  }
  return {
    text,
    url: parseGeneratedUrl(text),
    modelId: model.id,
    providerModelId: model.providerModelId,
  };
}

export const mediaGenerationTools: ToolDefinition[] = [
  {
    name: "generate_image",
    description:
      "用 Seedream 生成图片，返回图片 URL 和 Markdown。适合生成 workspace/avatar/logo/插画等视觉资产。媒体模型不支持工具调用，所以需要通过这个工具调用，而不是让普通 subagent 直接拿 Seedream 当聊天模型。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "图像生成提示词。请写清主体、风格、用途、构图、背景、比例和禁用项。生成 workspace logo/avatar 时建议说明：简洁图标、居中、无文字、适合 1:1 小尺寸。",
        },
        modelId: {
          type: "string",
          description: "可选，默认 seedream-5.0-lite。必须是 ark-image provider 的模型。",
        },
      },
      required: ["prompt"],
    },
    handler: async (args, ctx) => {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) return JSON.stringify({ ok: false, error: "prompt is required" });
      try {
        const model = assertMediaModel(
          typeof args.modelId === "string" && args.modelId.trim() ? args.modelId.trim() : "seedream-5.0-lite",
          "ark-image",
        );
        const result = await runMediaModel(model, prompt, ctx, "tool-image-generation");
        return JSON.stringify({ ok: true, ...result });
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err?.message ?? String(err) });
      }
    },
  },
  {
    name: "generate_video",
    description:
      "用 Seedance 生成视频，返回视频 URL 和 Markdown。适合短视频 / 动态 logo / 演示片段。提示词里可写 16:9、9:16、1:1，以及 5-11 秒时长。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "视频生成提示词。可包含比例 16:9/9:16/1:1 和 5-11 秒时长。",
        },
        modelId: {
          type: "string",
          description: "可选，默认 seedance-2.0。必须是 ark-video provider 的模型。",
        },
      },
      required: ["prompt"],
    },
    handler: async (args, ctx) => {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) return JSON.stringify({ ok: false, error: "prompt is required" });
      try {
        const model = assertMediaModel(
          typeof args.modelId === "string" && args.modelId.trim() ? args.modelId.trim() : "seedance-2.0",
          "ark-video",
        );
        const result = await runMediaModel(model, prompt, ctx, "tool-video-generation");
        return JSON.stringify({ ok: true, ...result });
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err?.message ?? String(err) });
      }
    },
  },
];
