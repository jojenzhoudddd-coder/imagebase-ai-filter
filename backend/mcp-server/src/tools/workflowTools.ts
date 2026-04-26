/**
 * Workflow MCP tools (PR4 Agent Workflow).
 *
 * Lets the host agent execute multi-step workflows by template name +
 * runtime params. Each template is a parameterised DSL factory that
 * orchestrates one or more `spawn_subagent` calls with logic glue
 * (sequence / parallel / loop / if / switch).
 *
 * V1 ships:
 *   - `execute_workflow_template(templateId, userMessage, params?)`
 *     执行内置模板(review / brainstorm / cowork / concurrent-data)。
 *     workflow_* events 流到前端 WorkflowBlock 实时展示进度。
 *   - `list_workflow_templates`
 *     列出可用模板 + 简介,host 选择前调用。
 *
 * V1 不实现:
 *   - `compose_workflow` (LLM 自由生成 DSL) —— 模型容易给出非法 DSL,
 *     先靠模板覆盖大部分场景。等真有需求再做。
 */

import type { ToolContext, ToolDefinition } from "./tableTools.js";

export const workflowTools: ToolDefinition[] = [
  {
    name: "list_workflow_templates",
    description:
      "列出可用的内置 workflow 模板 + 适用场景。host 选择模板前先调用。",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, _ctx?: ToolContext): Promise<string> => {
      return JSON.stringify({
        templates: [
          {
            id: "review",
            name: "Author + Reviewer 循环",
            description:
              "一个模型 (默认 Claude 4.7 Opus) 写方案,另一个 (默认 GPT-5.5) 审查;循环直到 reviewer 输出 PASS 或达到 maxIterations。" +
              "适合需要严谨检查的代码 / 方案 / 文档场景。",
            params: {
              authorModel: "string optional, default claude-opus-4.7",
              reviewerModel: "string optional, default gpt-5.5",
              maxIterations: "number optional, default 3, hard cap 10",
            },
          },
          {
            id: "brainstorm",
            name: "多视角头脑风暴 + 汇总",
            description:
              "多个不同模型并行回答同一问题,host 模型最后汇总分歧 + 综合建议。" +
              "适合开放性思考 / 集思广益 / 决策辅助。",
            params: {
              brainstormModels: "string[] optional, default [claude-opus-4.7, gpt-5.5, doubao-2.0]",
            },
          },
          {
            id: "cowork",
            name: "多模态协作 (V1 同 brainstorm)",
            description:
              "本应支持文本 + 图像生成同时输出再拼装,但 V1 nano-banana 未接入,fallback 为 brainstorm。",
            params: {},
          },
          {
            id: "concurrent-data",
            name: "并发任务 (V1 同 brainstorm)",
            description:
              "本应支持 host 拆任务派发给多 worker 再 merge,但 V1 splitter 未实现,fallback 为 brainstorm。",
            params: {},
          },
        ],
      });
    },
  },
  {
    name: "execute_workflow_template",
    description:
      "执行一个内置 workflow 模板。模板由 logic + action 节点组成,会依次/并行调起多个 subagent 完成任务。" +
      "相比直接 spawn_subagent,workflow 适合需要多步协作 (review 循环 / 头脑风暴汇总 / 并行处理) 的场景。" +
      "工作流执行过程中前端会实时显示 WorkflowBlock 节点进度。" +
      "调用前先用 list_workflow_templates 查看可用模板及参数。",
    inputSchema: {
      type: "object",
      properties: {
        templateId: {
          type: "string",
          enum: ["review", "brainstorm", "cowork", "concurrent-data"],
          description: "模板 id",
        },
        userMessage: {
          type: "string",
          description: "传给 workflow 的用户原始指令 (作为 trigger.payload.userMessage)",
        },
        params: {
          type: "object",
          description:
            "模板参数。review: {authorModel, reviewerModel, maxIterations}; brainstorm: {brainstormModels}",
        },
      },
      required: ["templateId", "userMessage"],
    },
    handler: async (args, ctx?: ToolContext): Promise<string> => {
      if (!ctx?.executeWorkflow) {
        return JSON.stringify({
          error: "execute_workflow_template 在当前上下文不可用 (stdio MCP 调用不支持)。",
        });
      }
      const templateId = String(args.templateId ?? "").trim();
      const userMessage = String(args.userMessage ?? "").trim();
      if (!templateId || !userMessage) {
        return JSON.stringify({ error: "templateId / userMessage 必填" });
      }
      try {
        const result = await ctx.executeWorkflow({
          templateId: templateId as any,
          userMessage,
          params: (args.params as Record<string, any>) ?? {},
        });
        return JSON.stringify({
          runId: result.runId,
          success: result.success,
          summary: result.summary,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `execute_workflow_template failed: ${msg}` });
      }
    },
  },
  {
    name: "compose_workflow",
    description:
      "由 host 即兴生成自由 workflow DSL JSON 然后立即执行,适合内置 4 模板覆盖不了的场景。" +
      "你给一个 doc 对象 (节点树 + 起始节点),executor 会按你的 DSL 跑。" +
      "DSL schema:\n" +
      "  doc = { rootNodeId, nodes: { [id]: Node } }\n" +
      "  Node = trigger | logic | action\n" +
      "    trigger = { kind:'trigger', source:'chat-message', payload?, next }\n" +
      "    logic   = { kind:'logic', type:'sequence|parallel|loop|if|switch', steps?|branches?|bodyNode?|maxIterations?|exitCondition?|condition?|thenNode?|elseNode?|switchOn?|cases?|defaultNode?, next? }\n" +
      "    action  = { kind:'action', type:'subagent', subagentModel, userPrompt|inputBinding{userPrompt}, outputAlias?, allowedTools?, maxRounds?, next? }\n" +
      "  Condition = { mode:'expression', expr:'...' } | { mode:'llm', prompt:'...', model? }\n" +
      "  inputBinding 内的 ${alias.field} 会从 ctx.scope 取值。\n" +
      "**安全 / 限制**: 总节点访问 ≤ 200, loop 最多 10, parallel ≤ 8 分支。subagent 危险动作走 V2.4 上抛协议。" +
      "失败时(schema 不合法 / 找不到节点 / 工具 unknown)会立即返回 error,host 应改 DSL 重试。",
    inputSchema: {
      type: "object",
      properties: {
        doc: {
          type: "object",
          description:
            "WorkflowDoc 对象。必含 rootNodeId + nodes 字段。runId 由后端分配,不要自己填。",
        },
        userMessage: {
          type: "string",
          description: "用户原指令 (作为 trigger.payload.userMessage)。所有 ${trigger.payload.userMessage} 模板引用此值。",
        },
      },
      required: ["doc", "userMessage"],
    },
    handler: async (args, ctx?: ToolContext): Promise<string> => {
      if (!ctx?.executeWorkflow) {
        return JSON.stringify({ error: "compose_workflow 在当前上下文不可用" });
      }
      const doc = args.doc as any;
      const userMessage = String(args.userMessage ?? "").trim();
      if (!doc || typeof doc !== "object" || !doc.rootNodeId || !doc.nodes) {
        return JSON.stringify({ error: "doc 必含 rootNodeId + nodes" });
      }
      if (!userMessage) {
        return JSON.stringify({ error: "userMessage 必填" });
      }
      // 简单 schema 校验:每个 node 必须有 id + kind
      const ids = Object.keys(doc.nodes);
      for (const id of ids) {
        const n = doc.nodes[id];
        if (!n || typeof n !== "object" || !n.kind) {
          return JSON.stringify({ error: `node ${id} 缺 kind 字段` });
        }
        if (!["trigger", "logic", "action"].includes(n.kind)) {
          return JSON.stringify({ error: `node ${id} kind 必须是 trigger/logic/action` });
        }
      }
      if (!doc.nodes[doc.rootNodeId]) {
        return JSON.stringify({ error: `rootNodeId ${doc.rootNodeId} 不在 nodes` });
      }
      try {
        // executeWorkflow 内部会用 buildTemplate 包一层,这里我们直接传
        // templateId="custom" + 在 params 里塞 doc。需要给 chatAgentService
        // 加 customDoc 支持(下面 V2.5 修改 executeWorkflow 实现)。
        const result = await ctx.executeWorkflow({
          templateId: "custom" as any,
          userMessage,
          params: { customDoc: doc },
        });
        return JSON.stringify({
          runId: result.runId,
          success: result.success,
          summary: result.summary,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `compose_workflow failed: ${msg}` });
      }
    },
  },
];
