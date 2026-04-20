/**
 * Tier 0 memory tools — let the Agent read its own long-term memory.
 *
 * Phase 2 Day 1 scope: `read_memory` only. Lists recent episodic memories
 * (newest first) with preview text, or loads a single memory file in full
 * when `filename` is supplied.
 *
 * Day 2 will add `recall_memory` (keyword + tag + recency ranking). Day 3
 * will wire auto-recall into the Layer 3 Turn Context so the Agent doesn't
 * have to explicitly ask.
 *
 * Like metaTools, the active agent is resolved from (args.agentId, ctx.agentId,
 * "agent_default") — never from an env var, so concurrent agents can't clobber.
 */

import {
  listEpisodicMemories,
  readEpisodicMemory,
  ensureAgentFiles,
} from "../../../src/services/agentService.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

const DEFAULT_AGENT_ID = "agent_default";

function resolveAgentId(args: Record<string, any>, ctx?: ToolContext): string {
  if (typeof args.agentId === "string" && args.agentId.trim()) return args.agentId.trim();
  if (ctx?.agentId) return ctx.agentId;
  return DEFAULT_AGENT_ID;
}

export const memoryTools: ToolDefinition[] = [
  {
    name: "read_memory",
    description:
      "读取你自己的长期 episodic 记忆。两种用法：(1) 不传 filename：列出最近的 memory 摘要（最多 limit 条，默认 20，最大 100），每条包含 filename / title / timestamp / tags / 正文前 200 字预览；(2) 传 filename：返回该文件完整正文。调用时机：用户提到过去的事 / 你不确定之前是否发生过某事 / 需要回溯长程目标。记忆按修改时间倒序，新的在前。",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description:
            "可选。形如 '2026-04-20_做了crm_ab12.md'。传了就返回该文件完整内容；不传则列出摘要。",
        },
        limit: {
          type: "number",
          description: "可选，默认 20，最大 100。仅在不传 filename 时生效。",
        },
        tag: {
          type: "string",
          description:
            "可选标签过滤，仅返回 tags 中包含该关键词（小写英文）的 memory。仅在不传 filename 时生效。",
        },
        agentId: {
          type: "string",
          description: "可选；默认读取当前 Agent 的记忆。",
        },
      },
    },
    handler: async (args, ctx) => {
      const agentId = resolveAgentId(args, ctx);
      await ensureAgentFiles(agentId);

      const filename = typeof args.filename === "string" ? args.filename.trim() : "";
      if (filename) {
        try {
          const mem = await readEpisodicMemory(agentId, filename);
          if (!mem) {
            return JSON.stringify({ ok: false, error: `memory not found: ${filename}` });
          }
          return JSON.stringify({ ok: true, agentId, memory: mem });
        } catch (err: any) {
          return JSON.stringify({ ok: false, error: err?.message || String(err) });
        }
      }

      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const tag = typeof args.tag === "string" && args.tag.trim() ? args.tag.trim().toLowerCase() : undefined;
      const summaries = await listEpisodicMemories(agentId, { limit, tag });
      return JSON.stringify({
        ok: true,
        agentId,
        count: summaries.length,
        memories: summaries,
      });
    },
  },
];
