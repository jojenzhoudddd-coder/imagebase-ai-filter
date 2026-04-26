/**
 * Workflow DSL types (PR4 Agent Workflow).
 *
 * 核心约束:
 *   - DSL 是 JSON 节点树,不是真代码 —— 安全性 / LLM 生成成功率高 / 易展示
 *   - root 必须是 trigger 节点
 *   - logic 节点 (sequence / parallel / loop / if / switch) 控制流向
 *   - action 节点 (subagent / mcp_tool / skill) 是产生效果的叶子
 *   - 表达式语言只支持取值 + 等于 / 不等 / and / or / not + length / includes / match,
 *     完全无 IO,acorn AST whitelist 防注入
 *
 * 上下文 ctx.scope 由 outputAlias 写入,后续节点用 ${alias.field} 模板引用。
 */

export type WorkflowNodeKind = "trigger" | "logic" | "action";

export interface BaseNode {
  /** Node id within the doc.nodes map. Unique per workflow. */
  id: string;
}

export interface TriggerNode extends BaseNode {
  kind: "trigger";
  source: "chat-message" | "cron";
  payload?: any;
  next: string;
}

export type LogicType = "sequence" | "parallel" | "loop" | "if" | "switch";

export interface LogicNode extends BaseNode {
  kind: "logic";
  type: LogicType;

  // sequence
  steps?: string[];

  // parallel
  branches?: string[];
  /** "all" wait every branch, "any" first wins, "race" 同 any */
  joinStrategy?: "all" | "any" | "race";

  // loop
  bodyNode?: string;
  /** Loop only — required for loop nodes;ignored elsewhere.默认 5,硬顶 10。 */
  maxIterations?: number;
  exitCondition?: WorkflowCondition;
  /** Variable name for current iteration index (defaults to "i"). */
  iteratorVar?: string;

  // if
  condition?: WorkflowCondition;
  thenNode?: string;
  elseNode?: string;

  // switch
  switchOn?: string; // 表达式,如 "${trigger.payload.intent}"
  cases?: Array<{ match: string; node: string }>;
  defaultNode?: string;

  /** What to run after this logic node (loop/parallel/sequence) finishes. */
  next?: string;
}

export type ActionType = "subagent" | "mcp_tool" | "skill";

export interface ActionNode extends BaseNode {
  kind: "action";
  type: ActionType;

  /** Where to put the action's output in `ctx.scope`. Subsequent nodes can
   *  reference it via `${alias.finalText}` etc. */
  outputAlias?: string;

  // subagent
  subagentModel?: string; // 必填或来自 inputBinding
  systemPrompt?: string;
  userPrompt?: string;
  allowedTools?: string[];
  maxRounds?: number;

  // mcp_tool
  tool?: string;
  args?: Record<string, any>;

  // skill (V1: just activate the skill before next round; rare standalone use)
  skill?: string;

  /** Templated input bindings:
   *    { userPrompt: "审查方案: ${draft.finalText}" }
   *  Resolved at execution time via `resolveTemplate(template, ctx.scope)`.
   *  Output of a node is `{...action result, finalText, runId, ...}` so
   *  binding by `${alias.finalText}` reads the subagent's output. */
  inputBinding?: Record<string, string>;

  next?: string;
}

export type WorkflowNode = TriggerNode | LogicNode | ActionNode;

export type WorkflowCondition =
  | { mode: "expression"; expr: string }
  | { mode: "llm"; prompt: string; model?: string };

/** Built-in templates. PR4 V1 ships review + brainstorm; cowork +
 *  concurrent-data are shells that compose the same primitives. */
export type WorkflowTemplate =
  | "review"
  | "brainstorm"
  | "cowork"
  | "concurrent-data";

export interface WorkflowDoc {
  /** workflow run id (assigned at execute time). */
  id: string;
  templateId?: WorkflowTemplate;
  rootNodeId: string;
  nodes: Record<string, WorkflowNode>;
  /** Variables seeded at start of run. Includes `trigger.payload` and any
   *  user-supplied parameters (e.g. for review: which model is reviewer). */
  variables?: Record<string, any>;
  createdBy: string; // host agent id
  createdAt: number;
}

export interface WorkflowContext {
  /** Mutable variable scope. Action nodes write to ctx.scope[outputAlias]. */
  scope: Record<string, any>;
  /** Workflow-level metadata for templates / safe-eval. */
  workflow: {
    runId: string;
    templateId?: WorkflowTemplate;
  };
  /** PR2 user mentions injected at construction. */
  user?: {
    message: string;
    hostModel: string;
    [key: string]: any;
  };
  /** Filled by trigger evaluation. */
  trigger?: {
    payload?: any;
  };
  /** AbortSignal so loops + subagent calls can bail. */
  abortSignal?: AbortSignal;
}

export type WorkflowEvent =
  | { kind: "workflow_start"; runId: string; templateId?: WorkflowTemplate }
  | { kind: "workflow_node_start"; runId: string; nodeId: string; nodeKind: WorkflowNodeKind; nodeType?: string }
  | { kind: "workflow_node_end"; runId: string; nodeId: string; output?: any }
  | { kind: "workflow_loop_iteration"; runId: string; loopNodeId: string; iter: number; maxIter: number }
  | { kind: "workflow_branch_start"; runId: string; parentNodeId: string; branchIdx: number; totalBranches: number }
  | { kind: "workflow_end"; runId: string; durationMs: number }
  | { kind: "workflow_error"; runId: string; error: string; nodeId?: string }
  | { kind: "workflow_aborted"; runId: string; reason: string };

/** Limits enforced by executor. */
export const WORKFLOW_HARD_CAPS = {
  /** Total node visits (each call to walkNode counts) — guards against
   *  pathological loops / cycles. */
  MAX_TOTAL_NODE_VISITS: 200,
  /** Max iterations any loop can declare. User can set lower via `maxIterations`
   *  but never higher. */
  LOOP_HARD_CAP: 10,
  /** Default loop count when not specified. */
  LOOP_DEFAULT: 5,
  /** Parallel branches per parallel node. */
  MAX_PARALLEL_BRANCHES: 8,
} as const;
