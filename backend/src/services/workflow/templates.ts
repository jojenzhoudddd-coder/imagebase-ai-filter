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
      return buildConcurrentData(params);
    case "concurrent-code":
      return buildConcurrentCode(params);
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

/**
 * V2.5 B6 concurrent-data 真实现:
 *   trigger
 *     → action subagent (host model, "splitter") 把 userMessage 拆成 N 个独立子任务,
 *       要求输出 JSON `{tasks: [{title, brief}, ...]}`
 *     → action subagent (host model, "router") 读 splitter 的结果,逐项 dispatch
 *       到 N 个 worker subagent (用 host 模型,因为我们不预知任务类型)
 *     → action subagent (host model, "merger") 把所有 worker 的结果整合
 *
 * V2.5 限制:并行分支数固定 (默认 3) —— DSL workflow 不支持运行时动态创
 * 建节点(那需要执行器内嵌"再 build doc"逻辑,太重)。改成:splitter 拆
 * N 任务,workers 节点 fixed=3,每个 worker 取 splitter 结果中第 i 项跑。
 * 用户希望任务数 != 3 时,后续 V2.6+ 引入 dynamic-parallel 节点。
 */
function buildConcurrentData(p: TemplateParams): WorkflowDoc {
  const workerModel = p.hostModel || "claude-opus-4.7";
  const PARALLEL_N = 3;
  const branches: string[] = [];
  const nodes: WorkflowDoc["nodes"] = {
    n_trigger: {
      id: "n_trigger",
      kind: "trigger",
      source: "chat-message",
      payload: { userMessage: p.userMessage },
      next: "n_split",
    },
    n_split: {
      id: "n_split",
      kind: "action",
      type: "subagent",
      subagentModel: workerModel,
      outputAlias: "split",
      inputBinding: {
        systemPrompt:
          "你是任务拆分器。把用户的复杂任务拆成最多 " +
          PARALLEL_N +
          " 个互相独立可并行的子任务。每个子任务要清晰、可独立完成、不依赖其它任务的结果。" +
          "**只输出 JSON**,格式如下,不要解释:\n" +
          '{ "tasks": [ { "title": "...", "brief": "..." }, ... ] }',
        userPrompt: "${trigger.payload.userMessage}",
      },
      next: "n_parallel",
    },
    n_parallel: {
      id: "n_parallel",
      kind: "logic",
      type: "parallel",
      branches: [],
      joinStrategy: "all",
      next: "n_merge",
    },
    n_merge: {
      id: "n_merge",
      kind: "action",
      type: "subagent",
      subagentModel: workerModel,
      outputAlias: "summary",
      inputBinding: {
        userPrompt:
          "把以下并行 worker 的产出整合成一份连贯结果。要求:消除重复、关联交叉点、产出最终整体回复。\n\n" +
          Array.from({ length: PARALLEL_N }, (_, i) =>
            `### Worker ${i + 1}\n\${scope.worker_${i}.finalText}`,
          ).join("\n\n"),
      },
    },
  };
  for (let i = 0; i < PARALLEL_N; i++) {
    const id = `n_worker_${i}`;
    nodes[id] = {
      id,
      kind: "action",
      type: "subagent",
      subagentModel: workerModel,
      outputAlias: `worker_${i}`,
      inputBinding: {
        userPrompt:
          "执行以下子任务(从总任务的拆分结果第 " +
          (i + 1) +
          " 项中抽取):\n\n${scope.split.finalText}\n\n" +
          "只关注上面 JSON 里 tasks[" +
          i +
          "],按它的 brief 完成。如果该索引位无任务(总任务拆得少于 " +
          PARALLEL_N +
          " 个),回复 '无任务' 即可。",
      },
    };
    branches.push(id);
  }
  (nodes.n_parallel as any).branches = branches;
  return {
    id: p.runId,
    templateId: "concurrent-data",
    rootNodeId: "n_trigger",
    createdBy: p.hostAgentId,
    createdAt: Date.now(),
    variables: { userMessage: p.userMessage, parallelN: PARALLEL_N },
    nodes,
  };
}

/**
 * V2.6 B15 concurrent-code 模板:并行多 worktree 写代码 + 严格 merge。
 *
 * 拓扑(逻辑层面 — 实际 worktree 创建/merge 由 host 在执行此 template 前/
 * 后用 worktree-skill 工具完成,因为 DSL 不支持运行时动态分支数):
 *   trigger
 *     → action subagent(host, "splitter") 把任务拆成 N 模块,输出 JSON
 *       `{modules:[{title, brief, files: [...], worktreeId: ""}, ...]}`
 *       (host 在调 execute_workflow_template 之前就应该已经 create_worktree
 *        N 次,把 worktreeId 写进 splitter 的 JSON;splitter 仅做模块分配)
 *     → parallel(N=3 worker)各自在指定 worktreeId 内
 *       (read/write_worktree_file)写代码
 *     → action subagent(host, "merger")按 worktree 顺序 merge,冲突时
 *       resolve_conflicts_with_llm
 *
 * V1 限制:N 固定 = 3 与 concurrent-data 一致。Host 想要 N≠3 时 V1 用
 * compose_workflow 直接写 DSL。
 */
function buildConcurrentCode(p: TemplateParams): WorkflowDoc {
  const workerModel = "claude-opus-4.7"; // 代码场景固定 claude
  const PARALLEL_N = 3;
  const branches: string[] = [];
  const nodes: WorkflowDoc["nodes"] = {
    n_trigger: {
      id: "n_trigger",
      kind: "trigger",
      source: "chat-message",
      payload: { userMessage: p.userMessage },
      next: "n_split",
    },
    n_split: {
      id: "n_split",
      kind: "action",
      type: "subagent",
      subagentModel: p.hostModel,
      outputAlias: "split",
      inputBinding: {
        systemPrompt:
          "你是代码任务拆分器。把用户的代码任务拆成最多 " + PARALLEL_N +
          " 个独立模块,每模块对应一个已创建的 worktree。" +
          "**只输出 JSON**,格式:\n" +
          '{ "modules": [ { "title": "...", "brief": "...", "files": ["..."], "worktreeId": "wt_xxx" }, ... ] }\n' +
          "host 已在调用前 create_worktree 拿到 worktreeId 列表,你需要把它们公平分配给各模块。",
        userPrompt:
          "用户任务:${trigger.payload.userMessage}\n\n" +
          "已创建的 worktreeId 列表:${trigger.payload.worktreeIds}",
      },
      next: "n_parallel",
    },
    n_parallel: {
      id: "n_parallel",
      kind: "logic",
      type: "parallel",
      branches: [],
      joinStrategy: "all",
      next: "n_merge",
    },
    n_merge: {
      id: "n_merge",
      kind: "action",
      type: "subagent",
      subagentModel: p.hostModel,
      outputAlias: "merged",
      inputBinding: {
        systemPrompt:
          "你是代码合并管理者。按顺序对 split.modules 里的每个 worktree 执行:" +
          "git_status_worktree 验状态 → merge_worktree_into_main → 若 conflicts 则 resolve_conflicts_with_llm 后再次 merge → cleanup_worktree。" +
          "汇报每个 worktree 的最终状态(merged sha / 解决冲突数)。",
        userPrompt:
          "split 结果:${scope.split.finalText}\n\n" +
          "worker 结果:" +
          Array.from({ length: PARALLEL_N }, (_, i) => `\n### Worker ${i + 1}\n\${scope.worker_${i}.finalText}`).join(""),
      },
    },
  };
  for (let i = 0; i < PARALLEL_N; i++) {
    const id = `n_worker_${i}`;
    nodes[id] = {
      id,
      kind: "action",
      type: "subagent",
      subagentModel: workerModel,
      outputAlias: `worker_${i}`,
      allowedTools: ["read_worktree_file", "write_worktree_file", "git_status_worktree", "git_diff_worktree"],
      inputBinding: {
        systemPrompt:
          "你是代码 worker。在指派给你的 worktree 里完成模块。**只用 read/write_worktree_file/git_status_worktree/git_diff_worktree**,不要调其它工具。" +
          "完成后用 git_status_worktree 验证 + git_diff_worktree 总结你改了什么。",
        userPrompt:
          "你负责 split.modules[" + i + "]:\n${scope.split.finalText}\n\n" +
          "(从 JSON 里取 modules[" + i + "],用 worktreeId / files / brief 完成。" +
          "若该索引位无任务,回复 '无任务' 即可。)",
      },
    };
    branches.push(id);
  }
  (nodes.n_parallel as any).branches = branches;
  return {
    id: p.runId,
    templateId: "concurrent-code",
    rootNodeId: "n_trigger",
    createdBy: p.hostAgentId,
    createdAt: Date.now(),
    variables: { userMessage: p.userMessage, parallelN: PARALLEL_N },
    nodes,
  };
}

/**
 * V2.6 B5 cowork 真实现:多模态协作。
 *
 * 实际形态:
 *   trigger
 *     → parallel: text branch (claude/gpt 写文字) + image branch
 *       (nano-banana 生成图,V2.6 nano-banana available:false 时此分支
 *        会被 spawnSubagent fallback 到 doubao,生成"图像描述文本"作为
 *        占位 — 不会让整个 workflow 卡住)
 *     → host stitcher (host 模型) 拼装文字 + 图(占位)成多模态输出
 *
 * V2.6 限制:image-gen 真正可用要等 nano-banana 接入(B16);未接入前
 * cowork 体感上 ≈ "text + image-description" 双视角 brainstorm。
 */
function buildCowork(p: TemplateParams): WorkflowDoc {
  const textModel = "claude-opus-4.7";
  const imageModel = "nano-banana"; // V2.6: stub 时 spawnSubagent fallback
  return {
    id: p.runId,
    templateId: "cowork",
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
        next: "n_parallel",
      },
      n_parallel: {
        id: "n_parallel",
        kind: "logic",
        type: "parallel",
        branches: ["n_text", "n_image"],
        joinStrategy: "all",
        next: "n_stitch",
      },
      n_text: {
        id: "n_text",
        kind: "action",
        type: "subagent",
        subagentModel: textModel,
        outputAlias: "text",
        inputBinding: {
          systemPrompt:
            "你负责文字部分。基于用户需求产出主体文字内容(标题 + 段落,清晰、简洁、有结构)。",
          userPrompt: "${trigger.payload.userMessage}",
        },
      },
      n_image: {
        id: "n_image",
        kind: "action",
        type: "subagent",
        subagentModel: imageModel,
        outputAlias: "image",
        inputBinding: {
          systemPrompt:
            "你负责图像/视觉部分。基于用户需求生成插图描述或图像。" +
            "(nano-banana 暂未接入,fallback 到文字模型时,请输出『图像 prompt + 描述』,方便后续真生图替换)",
          userPrompt: "${trigger.payload.userMessage}",
        },
      },
      n_stitch: {
        id: "n_stitch",
        kind: "action",
        type: "subagent",
        subagentModel: p.hostModel,
        outputAlias: "summary",
        inputBinding: {
          userPrompt:
            "把以下文字部分和图像部分拼装成最终多模态产出。\n\n" +
            "### 文字\n${scope.text.finalText}\n\n" +
            "### 图像\n${scope.image.finalText}",
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
