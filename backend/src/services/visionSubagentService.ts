/**
 * Vision Subagent Service — transparent vision proxy for non-vision models.
 *
 * When the main chat model doesn't support vision (e.g. Doubao 2.0), this
 * service routes image analysis to a vision-capable model (Claude/GPT via
 * OneAPI) and returns a text description that gets injected into the main
 * model's context. The user doesn't need to know or care which model
 * supports vision — the experience is consistent.
 *
 * Architecture:
 *   1. Check if main model supports vision: `model.modality.includes("image")`
 *   2. If yes → images pass through directly as content blocks (Layer 2a)
 *   3. If no → call this service → get text description → inject into context
 *
 * See docs/vision-capability-plan.md (V2 Subagent Architecture).
 */

import { MODELS, type ModelEntry } from "./modelRegistry.js";
import { resolveAdapter } from "./modelRegistry.js";
import type { ArkInputMessage, ImageContentBlock } from "./providers/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VisionAttachment {
  kind: "image";
  url: string;
  mime: string;
  fileId: string;
  width?: number;
  height?: number;
}

interface VisionAnalysisResult {
  /** The text description/analysis of the images */
  description: string;
  /** Which model was used for analysis */
  modelId: string;
}

// ─── Subagent model selection ───────────────────────────────────────────────

/**
 * Find the best available vision-capable model for subagent use.
 * Priority: Claude Opus 4.7 → Claude Opus 4.6 → GPT-5.5 → GPT-5.4 → GPT-5.4-mini
 */
function findVisionModel(): ModelEntry | null {
  const preferred = [
    "claude-opus-4.7",
    "claude-opus-4.6",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
  ];
  for (const id of preferred) {
    const m = MODELS.find((model) => model.id === id);
    if (m && m.available !== false && m.modality.includes("image")) {
      return m;
    }
  }
  return null;
}

// ─── System prompt for vision subagent ──────────────────────────────────────

const VISION_SYSTEM_PROMPT = `你是一个视觉分析助手。你的任务是准确描述和分析用户提供的图片内容。

规则：
- 直接输出分析内容，不要废话或寒暄
- 如果用户有具体问题，带着问题分析图片并回答
- 如果用户只发了图没说话，全面描述图片内容（布局、文字、数据、色彩等）
- 表格/数据截图 → 尽量 OCR 成结构化 Markdown 表格
- UI 截图 → 描述组件布局、交互状态、文字内容
- 图表/可视化 → 描述数据趋势、关键数值、轴标签
- 保持客观准确，不确定的部分标注"可能"
- 使用与用户消息相同的语言回复`;

// ─── Core function ──────────────────────────────────────────────────────────

/**
 * Analyze images using a vision-capable subagent model.
 * Called when the main model doesn't support vision.
 *
 * @param imageBlocks - Image content blocks (already encoded as base64)
 * @param userMessage - The user's text message (provides context for analysis)
 * @returns Text description of the images, or null if no vision model available
 */
export async function analyzeImagesViaSubagent(
  imageBlocks: ImageContentBlock[],
  userMessage: string,
): Promise<VisionAnalysisResult | null> {
  const visionModel = findVisionModel();
  if (!visionModel) {
    console.warn("[vision-subagent] no vision-capable model available");
    return null;
  }

  const adapter = resolveAdapter(visionModel);

  // Build the input: system prompt + user message with images
  const contentBlocks: ArkInputMessage["content"] = [];
  if (userMessage.trim()) {
    contentBlocks.push({ type: "input_text", text: userMessage });
  }
  for (const img of imageBlocks) {
    contentBlocks.push(img);
  }
  if (!contentBlocks.some((b) => b.type === "input_text")) {
    contentBlocks.unshift({ type: "input_text", text: "请描述这张图片的内容。" });
  }

  const input = [
    { role: "system" as const, content: [{ type: "input_text" as const, text: VISION_SYSTEM_PROMPT }] },
    { role: "user" as const, content: contentBlocks },
  ];

  let result = "";
  try {
    const stream = adapter.stream({
      model: visionModel,
      input,
      tools: [], // no tools needed for vision analysis
    });

    for await (const event of stream) {
      if (event.kind === "text_delta") {
        result += event.text;
      } else if (event.kind === "error") {
        console.error("[vision-subagent] stream error:", event.message);
        return null;
      }
      // ignore thinking_delta, tool_call_done, done
    }
  } catch (err) {
    console.error("[vision-subagent] call failed:", err);
    return null;
  }

  if (!result.trim()) {
    return null;
  }

  return {
    description: result.trim(),
    modelId: visionModel.id,
  };
}

/**
 * Check if a model supports vision natively.
 */
export function modelSupportsVision(model: ModelEntry): boolean {
  return model.modality.includes("image");
}
