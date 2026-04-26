/**
 * Subagent MCP tools (PR3 Agent Workflow).
 *
 * `spawn_subagent` lets the host agent fork a focused sub-task to a
 * specific model. The actual spawn happens inside the chat agent loop
 * (it owns the SSE stream + tool list); this MCP tool is a thin shim
 * that calls `ctx.spawnSubagent(...)` which the loop populates.
 *
 * V1 limits (PR3):
 *   - depth ≤ 1 (host → subagent only; PR4 enables nested subagents)
 *   - subagent inherits all of host's currently-active tools by default
 *   - subagent CANNOT call danger tools (delete/reset/etc.) — they're
 *     denied with a marker error inside the subagent loop. PR4 introduces
 *     full upcall protocol (subagent → host → optional user confirm).
 *
 * Tier-1 (always available) so any host agent can self-route to subagents
 * without first activating workflow-skill. Workflow-skill (PR4) layers on
 * top with `compose_workflow` + `execute_workflow` for multi-step DSL.
 */

import type { ToolContext, ToolDefinition } from "./tableTools.js";

export const subagentTools: ToolDefinition[] = [
  {
    name: "spawn_subagent",
    description:
      "拉起一个聚焦任务的子 agent,用指定模型完成单一目标后返回结果。" +
      "适合场景:让 GPT-5.5 review Claude 写的方案 / 让 doubao 快速翻译一段文字 / " +
      "让另一个模型从不同角度产出 brainstorm 内容。" +
      "限制:V1 仅 host 可调,subagent 不能再调 subagent (depth ≤ 1);" +
      "subagent 不能执行 delete/reset 等危险动作 (会被自动拒绝);" +
      "返回的 finalText 是子 agent 一次完整对话的最终输出 (不含工具调用细节,展开 SubagentBlock 才能看到)。" +
      "调用前用一句话告诉用户:'接下来让 [模型] 做 [事]'。",
    inputSchema: {
      type: "object",
      properties: {
        modelId: {
          type: "string",
          description:
            "要使用的模型 id,如 'claude-opus-4.7' / 'gpt-5.5' / 'doubao-2.0' / 'gpt-5.4-mini'。" +
            "可参考 model registry 的 specialty:code → claude-opus-4.7 或 gpt-5.5;" +
            "reasoning → claude-opus-4.6 或 gpt-5.5;general → doubao-2.0;" +
            "fast-cheap → gpt-5.4-mini。模型不可用时会自动 fallback 到同 group 的可用模型。",
        },
        userPrompt: {
          type: "string",
          description: "派发给 subagent 的具体任务描述 (相当于 user message)。要明确、聚焦、可执行。",
        },
        systemPrompt: {
          type: "string",
          description:
            "可选 system prompt,覆盖 subagent 的默认 worker 角色。一般保持默认即可;" +
            "需要给 subagent 注入特殊领域知识 (如 'you are a security reviewer') 时再用。",
        },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description:
            "可选工具白名单。空 (默认) = 继承 host 当前激活的全部工具。" +
            "需要严格限制 subagent 行为时填,如 ['get_table','list_fields'] 让它只能读不能写。",
        },
        maxRounds: {
          type: "number",
          description: "subagent 内部 tool loop 上限。默认 10,够大多数场景。",
        },
      },
      required: ["modelId", "userPrompt"],
    },
    handler: async (args, ctx?: ToolContext): Promise<string> => {
      if (!ctx?.spawnSubagent) {
        return JSON.stringify({
          error:
            "spawn_subagent 在当前上下文不可用(stdio MCP 调用不支持)。仅 host chat agent loop 内可用。",
        });
      }
      const modelId = String(args.modelId ?? "").trim();
      const userPrompt = String(args.userPrompt ?? "").trim();
      if (!modelId || !userPrompt) {
        return JSON.stringify({ error: "modelId 和 userPrompt 必填" });
      }
      try {
        const result = await ctx.spawnSubagent({
          modelId,
          userPrompt,
          systemPrompt: args.systemPrompt ? String(args.systemPrompt) : undefined,
          allowedTools: Array.isArray(args.allowedTools)
            ? (args.allowedTools as unknown[]).map((s) => String(s)).filter(Boolean)
            : [],
          maxRounds: typeof args.maxRounds === "number" ? args.maxRounds : undefined,
        });
        return JSON.stringify({
          runId: result.runId,
          success: result.success,
          finalText: result.finalText,
          // 让 host 知道 subagent 已结束,可基于 finalText 给用户呈现/继续工作流
          summary: result.finalText.length > 200
            ? result.finalText.slice(0, 200) + "…"
            : result.finalText,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `spawn_subagent failed: ${msg}` });
      }
    },
  },
];
