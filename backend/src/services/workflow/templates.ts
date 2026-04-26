/**
 * Built-in workflow templates (PR4 Agent Workflow).
 *
 * Each template is a parameterised factory that produces a `WorkflowDoc`
 * given runtime params (which model is reviewer / how many brainstorm
 * branches / etc.). The host calls `execute_workflow_template` with
 * `{template, params}` — the executor walks the produced doc.
 *
 * V1 ships:
 *   - **review**: author (Claude) → reviewer (GPT-5.5) loop until PASS or maxIter
 *   - **brainstorm**: parallel(3 models on same prompt) → host summarise
 *
 * V1 deferred (PR4.1):
 *   - **cowork**: parallel(text producer + image-gen) → host stitch
 *   - **concurrent-data**: split → parallel(N workers) → host merge
 *
 * Template doc.id is generated at execute time;callers should pass `runId`.
 */

import { WorkflowDoc, WorkflowTemplate } from "./types.js";

interface TemplateParams {
  /** User's original message — seeded into trigger.payload + scope.user.message */
  userMessage: string;
  /** Host model id (the user's selected model in TopBar). */
  hostModel: string;
  /** Optional reviewer model override for review template. */
  reviewerModel?: string;
  /** Optional author model override for review template. */
  authorModel?: string;
  /** Optional models list for brainstorm. Defaults to host + 2 alternates. */
  brainstormModels?: string[];
  /** Loop max iterations override (subject to LOOP_HARD_CAP=10). */
  maxIterations?: number;
  /** Custom workflow runId. */
  runId: string;
  /** Host agent id. */
  hostAgentId: string;
}

export function buildTemplate(
  template: WorkflowTemplate,
  params: TemplateParams,
): WorkflowDoc {
  switch (template) {
    case "review":
      return buildReview(params);
    case "brainstorm":
      return buildBrainstorm(params);
    case "cowork":
      // V1 falls back to brainstorm shape (multi-model in parallel + host
      // summarise). The "image-gen" branch needs nano-banana接入(PR4.1).
      return buildBrainstorm(params);
    case "concurrent-data":
      // V1 falls back to brainstorm. Real "split + worker pool" needs PR4.1
      // splitter prompt + dynamic branch creation.
      return buildBrainstorm(params);
    default:
      throw new Error(`unknown template: ${template}`);
  }
}

function buildReview(p: TemplateParams): WorkflowDoc {
  const author = p.authorModel ?? "claude-opus-4.7";
  const reviewer = p.reviewerModel ?? "gpt-5.5";
  const maxIter = Math.max(1, Math.min(p.maxIterations ?? 3, 10));
  return {
    id: p.runId,
    templateId: "review",
    rootNodeId: "n_trigger",
    createdBy: p.hostAgentId,
    createdAt: Date.now(),
    variables: { userMessage: p.userMessage },
    nodes: {
      n_trigger: {
        id: "n_trigger",
        kind: "trigger",
        source: "chat-message",
        payload: { userMessage: p.userMessage },
        next: "n_loop",
      },
      n_loop: {
        id: "n_loop",
        kind: "logic",
        type: "loop",
        bodyNode: "n_seq",
        maxIterations: maxIter,
        exitCondition: {
          mode: "expression",
          // reviewer 输出里 PASS 标记则退出
          expr: "match(scope.review_result.finalText, '\\\\bPASS\\\\b')",
        },
      },
      n_seq: {
        id: "n_seq",
        kind: "logic",
        type: "sequence",
        steps: ["n_author", "n_reviewer"],
      },
      n_author: {
        id: "n_author",
        kind: "action",
        type: "subagent",
        subagentModel: author,
        outputAlias: "draft",
        inputBinding: {
          userPrompt:
            "请基于以下用户需求,产出/修订方案。\n\n" +
            "用户需求:\n${trigger.payload.userMessage}\n\n" +
            "上次审查反馈:${scope.review_result.finalText}",
        },
      },
      n_reviewer: {
        id: "n_reviewer",
        kind: "action",
        type: "subagent",
        subagentModel: reviewer,
        outputAlias: "review_result",
        inputBinding: {
          systemPrompt:
            "你是严苛的方案审查者。审查以下方案:" +
            "(1) 找出问题并简要列出;(2) 全部满意时输出 'PASS' (大写, 单独一行)。",
          userPrompt: "${scope.draft.finalText}",
        },
      },
    },
  };
}

function buildBrainstorm(p: TemplateParams): WorkflowDoc {
  // 默认用 host 模型 + claude-opus-4.7 + doubao-2.0 三个不同视角
  const models = p.brainstormModels ?? ["claude-opus-4.7", "gpt-5.5", "doubao-2.0"];
  const branches: string[] = [];
  const nodes: WorkflowDoc["nodes"] = {
    n_trigger: {
      id: "n_trigger",
      kind: "trigger",
      source: "chat-message",
      payload: { userMessage: p.userMessage },
      next: "n_parallel",
    },
    n_parallel: {
      id: "n_parallel",
      kind: "logic",
      type: "parallel",
      branches: [],
      joinStrategy: "all",
      next: "n_summary",
    },
    n_summary: {
      id: "n_summary",
      kind: "action",
      type: "subagent",
      subagentModel: p.hostModel,
      outputAlias: "summary",
      inputBinding: {
        userPrompt:
          "汇总以下来自多个不同 AI 的回答,提炼关键观点 + 标识分歧 + 给出综合建议。\n\n" +
          models
            .map((m, idx) => `### 视角 ${idx + 1} (${m})\n\${scope.brainstorm_${idx}.finalText}`)
            .join("\n\n"),
      },
    },
  };
  for (let i = 0; i < models.length; i++) {
    const branchId = `n_brainstorm_${i}`;
    nodes[branchId] = {
      id: branchId,
      kind: "action",
      type: "subagent",
      subagentModel: models[i],
      outputAlias: `brainstorm_${i}`,
      inputBinding: {
        userPrompt:
          "请用你独特的视角探讨以下话题,给出你最有信心的见解(简洁 100-200 字)。\n\n${trigger.payload.userMessage}",
      },
    };
    branches.push(branchId);
  }
  (nodes.n_parallel as any).branches = branches;
  return {
    id: p.runId,
    templateId: "brainstorm",
    rootNodeId: "n_trigger",
    createdBy: p.hostAgentId,
    createdAt: Date.now(),
    variables: { userMessage: p.userMessage, models },
    nodes,
  };
}
