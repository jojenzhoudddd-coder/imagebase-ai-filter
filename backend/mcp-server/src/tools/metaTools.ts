/**
 * Tier 0 meta-tools — let the Agent edit its own identity and memory.
 *
 * Plan reference: docs/chatbot-openclaw-plan.md §3 (three-layer System Prompt)
 * and §4 (Tier 0 tools are permanently loaded and ~500 tokens).
 *
 * Phase 1 scope is WRITE ONLY. No retrieval / ranking / consolidation yet —
 * those are Phase 2. The point today is to make the meta-behavior rules in
 * Layer 1 executable: when the Agent decides "I should remember this" it now
 * has a tool that actually writes to the filesystem.
 *
 * All three tools operate on the active Agent's `~/.imagebase/agents/<id>/`
 * directory. The agent id is resolved in priority order:
 *   1. Explicit `agentId` in args (useful for MCP stdio callers and for the
 *      eventual multi-agent case)
 *   2. `ctx.agentId` injected by the in-process agent loop
 *   3. Hard fallback: "agent_default" (seeded at boot)
 *
 * We intentionally avoid swallowing agentId into an environment variable —
 * two concurrent agents sharing one backend must not clobber each other.
 */

import {
  writeSoul,
  writeProfile,
  appendEpisodicMemory,
  ensureAgentFiles,
} from "../../../src/services/agentService.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

const DEFAULT_AGENT_ID = "agent_default";

function resolveAgentId(args: Record<string, any>, ctx?: ToolContext): string {
  if (typeof args.agentId === "string" && args.agentId.trim()) return args.agentId.trim();
  if (ctx?.agentId) return ctx.agentId;
  return DEFAULT_AGENT_ID;
}

export const metaTools: ToolDefinition[] = [
  {
    name: "update_profile",
    description:
      "用新的完整内容替换用户画像 profile.md。调用时机：你从对话里识别到值得长期记住的用户偏好 / 习惯 / 关键事实（例如常用语言、工作时区、项目上下文、偏好的工具）。注意这是 **整文件替换**，调用前请先把已有画像保留下来再在其上追加/修订，不要丢失历史事实。单次写入上限 64 KiB。",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "profile.md 的完整新内容（Markdown），会整文件替换旧 profile。",
        },
        agentId: {
          type: "string",
          description: "可选；默认写入当前 Agent 的 profile.md。",
        },
      },
      required: ["content"],
    },
    handler: async (args, ctx) => {
      const agentId = resolveAgentId(args, ctx);
      const content = typeof args.content === "string" ? args.content : "";
      if (!content.trim()) {
        return JSON.stringify({ ok: false, error: "content 不能为空" });
      }
      await ensureAgentFiles(agentId);
      await writeProfile(agentId, content);
      return JSON.stringify({ ok: true, agentId, bytes: Buffer.byteLength(content, "utf8") });
    },
  },

  {
    name: "update_soul",
    description:
      "用新的完整内容替换 Agent 自身身份 soul.md。调用时机：你觉得自己应当调整沟通风格、口吻、价值观或自我认知。**整文件替换**，请保留之前 soul 的主要立意再做修订，不要把核心人格抹掉。单次写入上限 64 KiB。",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "soul.md 的完整新内容（Markdown），会整文件替换旧 soul。",
        },
        agentId: {
          type: "string",
          description: "可选；默认写入当前 Agent 的 soul.md。",
        },
      },
      required: ["content"],
    },
    handler: async (args, ctx) => {
      const agentId = resolveAgentId(args, ctx);
      const content = typeof args.content === "string" ? args.content : "";
      if (!content.trim()) {
        return JSON.stringify({ ok: false, error: "content 不能为空" });
      }
      await ensureAgentFiles(agentId);
      await writeSoul(agentId, content);
      return JSON.stringify({ ok: true, agentId, bytes: Buffer.byteLength(content, "utf8") });
    },
  },

  {
    name: "create_memory",
    description:
      "写一条 episodic 长期记忆到 memory/episodic/。调用时机：这一轮发生了值得长期记住的事情（重要任务、关键决策、长程目标、里程碑、用户明确说的 '请记住…'）。title 一句话概括；body 写清楚背景 + 决策 + 后续要做什么；tags 用小写英文关键词便于以后检索。**不要** 把日常闲聊或已经写进 profile 的稳定事实塞进来。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "一句话概括，<40 字。" },
        body: { type: "string", description: "正文，支持多行 Markdown；写清楚背景 / 决策 / 后续。" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "可选标签，小写英文关键词，如 ['crm','milestone']。",
        },
        agentId: {
          type: "string",
          description: "可选；默认写入当前 Agent 的 memory/episodic/。",
        },
      },
      required: ["title", "body"],
    },
    handler: async (args, ctx) => {
      const agentId = resolveAgentId(args, ctx);
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const body = typeof args.body === "string" ? args.body : "";
      const tags = Array.isArray(args.tags) ? args.tags.filter((t: unknown) => typeof t === "string") : undefined;
      if (!title || !body.trim()) {
        return JSON.stringify({ ok: false, error: "title 和 body 都不能为空" });
      }
      const { filename } = await appendEpisodicMemory(agentId, { title, body, tags });
      return JSON.stringify({ ok: true, agentId, filename });
    },
  },
];
