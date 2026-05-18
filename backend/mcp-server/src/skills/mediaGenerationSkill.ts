/**
 * media-generation-skill — Seedream / Seedance content generation.
 */

import { mediaGenerationTools } from "../tools/mediaGenerationTools.js";
import type { SkillDefinition } from "./types.js";

export const mediaGenerationSkill: SkillDefinition = {
  name: "media-generation-skill",
  displayName: "媒体生成",
  description: "用 Seedream 生成图片、用 Seedance 生成视频，产出可用于头像、logo、插图、短视频的媒体 URL。",
  artifacts: ["workspace", "image", "video"],
  when:
    "用户要求生成图片、logo、头像、workspace 视觉标识、插图、短视频，或明确提到 seedream / seedance 时激活。",
  triggers: [
    "生成图片",
    "生成图像",
    "生成 logo",
    "生成头像",
    "workspace 头像",
    "工作区头像",
    "seedream",
    "seedance",
    "视频生成",
    "generate image",
    "generate video",
    /生成.*(图片|图像|logo|头像|视频)/i,
    /(seedream|seedance|image generation|video generation|workspace avatar|workspace logo)/i,
  ],
  tools: [...mediaGenerationTools],
};
