/**
 * Vision tools (Tier 1 · always-on).
 *
 * `analyze_image` — 对图片进行深度分析（OCR、表格提取、UI 描述等）。
 * 内部调用 visionSubagentService，路由到 vision-capable 模型（Claude/GPT）。
 * 任何模型都能调用此工具 — 即使主模型本身支持 vision，有时也需要
 * 更深入的专项分析（比如"把这张截图里的表格 OCR 成数据"）。
 *
 * See docs/vision-capability-plan.md (V2 Layer 2c).
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { ToolDefinition } from "./tableTools.js";
import { analyzeImagesViaSubagent } from "../../../src/services/visionSubagentService.js";
import type { ImageContentBlock } from "../../../src/services/providers/types.js";

const UPLOAD_ROOT = path.join(
  process.env.IMAGEBASE_HOME?.trim() || path.join(os.homedir(), ".imagebase"),
  "uploads", "chat"
);

export const visionTools: ToolDefinition[] = [
  {
    name: "analyze_image",
    description:
      "对图片进行深度视觉分析。支持 OCR 文字提取、表格识别、UI 截图描述、" +
      "图表数据解读等。输入本地上传路径（/uploads/chat/xxx）或 http(s) URL。" +
      "可带具体问题让分析更聚焦。\n\n" +
      "适用场景：\n" +
      "- 用户说'识别这张图里的文字/表格' → mode: ocr 或 table-extract\n" +
      "- 用户说'描述这个UI/界面' → mode: ui-audit\n" +
      "- 需要从图片中提取结构化数据时\n" +
      "- 主模型已看到图但需要更细致分析时",
    inputSchema: {
      type: "object",
      properties: {
        imageUrl: {
          type: "string",
          description:
            "图片路径。本地上传路径如 /uploads/chat/abc.png，" +
            "或 http(s) URL。",
        },
        question: {
          type: "string",
          description:
            "可选：针对图片的具体问题，如'表格第三列的数据是什么'、'这个按钮是什么颜色'。" +
            "不填则进行全面描述。",
        },
        mode: {
          type: "string",
          enum: ["describe", "ocr", "table-extract", "ui-audit"],
          description:
            "分析模式。describe=全面描述(默认)，ocr=文字提取，" +
            "table-extract=表格识别并输出Markdown表格，ui-audit=UI界面分析。",
        },
      },
      required: ["imageUrl"],
    },
    handler: async (args): Promise<string> => {
      const { imageUrl, question, mode } = args as {
        imageUrl: string;
        question?: string;
        mode?: "describe" | "ocr" | "table-extract" | "ui-audit";
      };

      // Build the image block
      let imageBlock: ImageContentBlock;

      if (imageUrl.startsWith("/uploads/chat/")) {
        // Local upload — read file and encode as base64
        const fileName = imageUrl.split("/").pop() ?? "";
        const filePath = path.join(UPLOAD_ROOT, fileName);
        try {
          const buf = fs.readFileSync(filePath);
          // Guess mime from extension
          const ext = path.extname(fileName).toLowerCase();
          const mimeMap: Record<string, string> = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".svg": "image/svg+xml",
          };
          imageBlock = {
            type: "input_image",
            data: buf.toString("base64"),
            media_type: mimeMap[ext] || "image/png",
          };
        } catch {
          return `错误：无法读取图片文件 ${imageUrl}`;
        }
      } else if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
        // Remote URL — fetch and encode
        try {
          const res = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) return `错误：无法下载图片 (HTTP ${res.status})`;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 20 * 1024 * 1024) return "错误：图片超过 20MB 限制";
          const contentType = res.headers.get("content-type") || "image/png";
          imageBlock = {
            type: "input_image",
            data: buf.toString("base64"),
            media_type: contentType.split(";")[0].trim(),
          };
        } catch (err) {
          return `错误：下载图片失败 — ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        return "错误：imageUrl 必须是 /uploads/chat/... 路径或 http(s) URL";
      }

      // Build the analysis prompt based on mode
      const modePrompts: Record<string, string> = {
        describe: question || "请全面描述这张图片的内容。",
        ocr: `请提取这张图片中的所有文字内容，保持原始排版格式。${question ? `\n额外问题：${question}` : ""}`,
        "table-extract": `请识别这张图片中的表格，并输出为 Markdown 表格格式。尽量保证数据准确。${question ? `\n额外问题：${question}` : ""}`,
        "ui-audit": `请分析这个 UI 界面截图：描述布局结构、组件类型、交互状态、文字内容、色彩方案。${question ? `\n额外问题：${question}` : ""}`,
      };
      const prompt = modePrompts[mode || "describe"];

      const result = await analyzeImagesViaSubagent([imageBlock], prompt);
      if (!result) {
        return "错误：当前无可用视觉模型。请确认 Claude 或 GPT 模型可用。";
      }

      return `[视觉分析 by ${result.modelId}]\n\n${result.description}`;
    },
  },
];
