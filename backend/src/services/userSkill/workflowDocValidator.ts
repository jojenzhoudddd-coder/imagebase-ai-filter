/**
 * WorkflowDoc structural validator for UserSkill ingestion.
 *
 * 这不是运行时表达式求值（那是 services/workflow/safeEval.ts 的活），而是
 * **入库前的"结构 + 注入关键字"双重把关**。Agent 通过 create_skill /
 * save_workflow_run_as_skill 写入的 DSL，必须经过这个 validator 才能落库。
 *
 * 防御对象：
 *   1. 结构错误（rootNodeId 不在 nodes、节点循环引用未声明、未知 kind/type）
 *   2. 注入关键字（DSL 字符串字段中含 `eval(` / `Function(` / `process.exit`
 *      / `require(` / `__proto__` / `<script` 等）
 *   3. 资源滥用（节点数 > 50、单字段 > 32KB、对象嵌套 > 8 层）
 *
 * 不依赖运行时 evalExpression — 那个负责的是 ${trigger.payload.intent} 模板
 * 取值；这里负责的是"DSL 长得对不对、有没有藏猫腻"。
 */

import type {
  WorkflowDoc,
  WorkflowNode,
  TriggerNode,
  LogicNode,
  ActionNode,
} from "../workflow/types.js";
import { WORKFLOW_HARD_CAPS } from "../workflow/types.js";

/** 结构化错误，便于 Agent 修正。 */
export class WorkflowDocValidationError extends Error {
  constructor(
    message: string,
    public readonly nodeId?: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = "WorkflowDocValidationError";
  }
}

/** 危险关键字 — 出现在任意 DSL 字符串字段就拒收。 */
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\beval\s*\(/i, reason: "eval(...) 调用被禁止" },
  { pattern: /\bFunction\s*\(/i, reason: "Function(...) 构造器被禁止" },
  { pattern: /\bprocess\s*\.\s*(exit|kill|env|argv)/i, reason: "访问 process 全局被禁止" },
  { pattern: /\brequire\s*\(/i, reason: "require(...) 模块加载被禁止" },
  { pattern: /\bimport\s*\(/i, reason: "动态 import(...) 被禁止" },
  { pattern: /__proto__|prototype\s*\.\s*constructor/i, reason: "原型链操纵被禁止" },
  { pattern: /<script[\s>]/i, reason: "<script> 标签被禁止" },
  { pattern: /\bchild_process\b/, reason: "child_process 被禁止" },
  { pattern: /\bfs\s*\.\s*(read|write|unlink|rm|create)/i, reason: "fs 文件操作被禁止" },
];

const NODE_LIMIT = 50;
const STRING_FIELD_LIMIT = 32 * 1024; // 32KB
const MAX_DEPTH = 8;

const VALID_TRIGGER_SOURCES = new Set(["chat-message", "cron"]);
const VALID_LOGIC_TYPES = new Set(["sequence", "parallel", "loop", "if", "switch"]);
const VALID_ACTION_TYPES = new Set(["subagent", "mcp_tool", "skill"]);
const VALID_JOIN_STRATEGIES = new Set(["all", "any", "race"]);

// ─── Public entry ────────────────────────────────────────────────────────

/**
 * Validate a single WorkflowDoc. Throws WorkflowDocValidationError on the
 * first failure with `nodeId` + `field` populated when possible.
 *
 * 返回 normalized doc（剥掉无关字段，保证落库是干净的）。
 */
export function validateWorkflowDoc(raw: unknown, docIndex = 0): WorkflowDoc {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowDocValidationError(
      `workflowDocs[${docIndex}] 必须是对象`,
    );
  }
  const doc = raw as Record<string, any>;

  // 必填基础字段
  if (typeof doc.rootNodeId !== "string" || !doc.rootNodeId.trim()) {
    throw new WorkflowDocValidationError(
      `workflowDocs[${docIndex}].rootNodeId 必填且为非空字符串`,
    );
  }
  if (!doc.nodes || typeof doc.nodes !== "object" || Array.isArray(doc.nodes)) {
    throw new WorkflowDocValidationError(
      `workflowDocs[${docIndex}].nodes 必须是对象 (Record<id, node>)`,
    );
  }

  const nodes = doc.nodes as Record<string, unknown>;
  const nodeIds = Object.keys(nodes);
  if (nodeIds.length === 0) {
    throw new WorkflowDocValidationError(
      `workflowDocs[${docIndex}].nodes 不能为空`,
    );
  }
  if (nodeIds.length > NODE_LIMIT) {
    throw new WorkflowDocValidationError(
      `workflowDocs[${docIndex}].nodes 超过节点上限 ${NODE_LIMIT}`,
    );
  }
  if (!(doc.rootNodeId in nodes)) {
    throw new WorkflowDocValidationError(
      `workflowDocs[${docIndex}].rootNodeId "${doc.rootNodeId}" 不在 nodes 中`,
    );
  }

  // 深度 + 关键字扫描整个 doc
  scanForDangerousStrings(doc, "workflowDocs[" + docIndex + "]", 0);

  // 逐节点校验
  const validatedNodes: Record<string, WorkflowNode> = {};
  for (const id of nodeIds) {
    const node = nodes[id];
    validatedNodes[id] = validateNode(id, node, nodeIds);
  }

  // 引用完整性 — 任何 next/steps/branches/bodyNode 等指向必须存在
  for (const id of nodeIds) {
    const node = validatedNodes[id];
    const refs = collectNodeRefs(node);
    for (const ref of refs) {
      if (!(ref in nodes)) {
        throw new WorkflowDocValidationError(
          `节点 "${id}" 引用了不存在的节点 "${ref}"`,
          id,
        );
      }
    }
  }

  return {
    id: typeof doc.id === "string" ? doc.id : "",
    templateId: doc.templateId,
    rootNodeId: doc.rootNodeId,
    nodes: validatedNodes,
    variables:
      doc.variables && typeof doc.variables === "object" && !Array.isArray(doc.variables)
        ? doc.variables
        : undefined,
    createdBy: typeof doc.createdBy === "string" ? doc.createdBy : "",
    createdAt: typeof doc.createdAt === "number" ? doc.createdAt : Date.now(),
  };
}

/** Validate the entire workflowDocs array. */
export function validateWorkflowDocs(rawList: unknown): WorkflowDoc[] {
  if (!Array.isArray(rawList)) {
    throw new WorkflowDocValidationError("workflowDocs 必须是数组");
  }
  if (rawList.length > 5) {
    throw new WorkflowDocValidationError("workflowDocs 最多 5 个");
  }
  return rawList.map((d, i) => validateWorkflowDoc(d, i));
}

// ─── Internals ────────────────────────────────────────────────────────────

function validateNode(
  id: string,
  raw: unknown,
  _allIds: string[],
): WorkflowNode {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowDocValidationError(`节点 "${id}" 必须是对象`, id);
  }
  const node = raw as Record<string, any>;
  if (node.id !== undefined && node.id !== id) {
    throw new WorkflowDocValidationError(
      `节点 "${id}" 的 id 字段与 nodes key 不一致 (got "${node.id}")`,
      id,
      "id",
    );
  }
  const kind = node.kind;
  if (kind === "trigger") return validateTrigger(id, node);
  if (kind === "logic") return validateLogic(id, node);
  if (kind === "action") return validateAction(id, node);
  throw new WorkflowDocValidationError(
    `节点 "${id}".kind 必须是 "trigger" / "logic" / "action" (got "${kind}")`,
    id,
    "kind",
  );
}

function validateTrigger(id: string, n: Record<string, any>): TriggerNode {
  if (!VALID_TRIGGER_SOURCES.has(n.source)) {
    throw new WorkflowDocValidationError(
      `trigger 节点 "${id}".source 必须是 "chat-message" / "cron" (got "${n.source}")`,
      id,
      "source",
    );
  }
  if (typeof n.next !== "string" || !n.next) {
    throw new WorkflowDocValidationError(
      `trigger 节点 "${id}".next 必填`,
      id,
      "next",
    );
  }
  return {
    id,
    kind: "trigger",
    source: n.source,
    payload: n.payload,
    next: n.next,
  };
}

function validateLogic(id: string, n: Record<string, any>): LogicNode {
  if (!VALID_LOGIC_TYPES.has(n.type)) {
    throw new WorkflowDocValidationError(
      `logic 节点 "${id}".type 不合法 (got "${n.type}")`,
      id,
      "type",
    );
  }
  const out: LogicNode = { id, kind: "logic", type: n.type };
  if (n.type === "sequence") {
    if (!Array.isArray(n.steps) || n.steps.length === 0) {
      throw new WorkflowDocValidationError(
        `sequence 节点 "${id}".steps 必填非空数组`,
        id,
        "steps",
      );
    }
    out.steps = n.steps.map(String);
  } else if (n.type === "parallel") {
    if (!Array.isArray(n.branches) || n.branches.length === 0) {
      throw new WorkflowDocValidationError(
        `parallel 节点 "${id}".branches 必填非空数组`,
        id,
        "branches",
      );
    }
    if (n.branches.length > WORKFLOW_HARD_CAPS.MAX_PARALLEL_BRANCHES) {
      throw new WorkflowDocValidationError(
        `parallel 节点 "${id}".branches 超过 ${WORKFLOW_HARD_CAPS.MAX_PARALLEL_BRANCHES} 上限`,
        id,
        "branches",
      );
    }
    out.branches = n.branches.map(String);
    if (n.joinStrategy && !VALID_JOIN_STRATEGIES.has(n.joinStrategy)) {
      throw new WorkflowDocValidationError(
        `parallel 节点 "${id}".joinStrategy 必须是 all/any/race`,
        id,
        "joinStrategy",
      );
    }
    out.joinStrategy = n.joinStrategy ?? "all";
  } else if (n.type === "loop") {
    if (typeof n.bodyNode !== "string" || !n.bodyNode) {
      throw new WorkflowDocValidationError(
        `loop 节点 "${id}".bodyNode 必填`,
        id,
        "bodyNode",
      );
    }
    out.bodyNode = n.bodyNode;
    if (n.maxIterations !== undefined) {
      if (
        typeof n.maxIterations !== "number" ||
        n.maxIterations < 1 ||
        n.maxIterations > WORKFLOW_HARD_CAPS.LOOP_HARD_CAP
      ) {
        throw new WorkflowDocValidationError(
          `loop 节点 "${id}".maxIterations 必须是 1-${WORKFLOW_HARD_CAPS.LOOP_HARD_CAP}`,
          id,
          "maxIterations",
        );
      }
      out.maxIterations = n.maxIterations;
    }
    out.exitCondition = n.exitCondition;
    out.iteratorVar = typeof n.iteratorVar === "string" ? n.iteratorVar : "i";
  } else if (n.type === "if") {
    if (!n.condition || typeof n.condition !== "object") {
      throw new WorkflowDocValidationError(
        `if 节点 "${id}".condition 必填`,
        id,
        "condition",
      );
    }
    out.condition = n.condition;
    if (typeof n.thenNode !== "string" || !n.thenNode) {
      throw new WorkflowDocValidationError(
        `if 节点 "${id}".thenNode 必填`,
        id,
        "thenNode",
      );
    }
    out.thenNode = n.thenNode;
    if (n.elseNode !== undefined && typeof n.elseNode !== "string") {
      throw new WorkflowDocValidationError(
        `if 节点 "${id}".elseNode 必须是字符串`,
        id,
        "elseNode",
      );
    }
    out.elseNode = n.elseNode;
  } else if (n.type === "switch") {
    if (typeof n.switchOn !== "string" || !n.switchOn) {
      throw new WorkflowDocValidationError(
        `switch 节点 "${id}".switchOn 必填`,
        id,
        "switchOn",
      );
    }
    out.switchOn = n.switchOn;
    if (!Array.isArray(n.cases) || n.cases.length === 0) {
      throw new WorkflowDocValidationError(
        `switch 节点 "${id}".cases 必填非空数组`,
        id,
        "cases",
      );
    }
    out.cases = n.cases.map((c: any) => ({
      match: String(c.match ?? ""),
      node: String(c.node ?? ""),
    }));
    out.defaultNode = n.defaultNode;
  }
  if (n.next !== undefined) {
    if (typeof n.next !== "string") {
      throw new WorkflowDocValidationError(
        `logic 节点 "${id}".next 必须是字符串`,
        id,
        "next",
      );
    }
    out.next = n.next;
  }
  return out;
}

function validateAction(id: string, n: Record<string, any>): ActionNode {
  if (!VALID_ACTION_TYPES.has(n.type)) {
    throw new WorkflowDocValidationError(
      `action 节点 "${id}".type 不合法 (got "${n.type}")`,
      id,
      "type",
    );
  }
  const out: ActionNode = { id, kind: "action", type: n.type };
  if (n.outputAlias !== undefined) {
    if (typeof n.outputAlias !== "string") {
      throw new WorkflowDocValidationError(
        `action 节点 "${id}".outputAlias 必须是字符串`,
        id,
        "outputAlias",
      );
    }
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(n.outputAlias)) {
      throw new WorkflowDocValidationError(
        `action 节点 "${id}".outputAlias 必须是合法标识符`,
        id,
        "outputAlias",
      );
    }
    out.outputAlias = n.outputAlias;
  }
  if (n.type === "subagent") {
    out.subagentModel = typeof n.subagentModel === "string" ? n.subagentModel : undefined;
    out.systemPrompt = typeof n.systemPrompt === "string" ? n.systemPrompt : undefined;
    out.userPrompt = typeof n.userPrompt === "string" ? n.userPrompt : undefined;
    if (n.allowedTools !== undefined) {
      if (!Array.isArray(n.allowedTools)) {
        throw new WorkflowDocValidationError(
          `subagent 节点 "${id}".allowedTools 必须是数组`,
          id,
          "allowedTools",
        );
      }
      out.allowedTools = n.allowedTools.map(String);
    }
    if (n.maxRounds !== undefined) {
      if (typeof n.maxRounds !== "number" || n.maxRounds < 1 || n.maxRounds > 20) {
        throw new WorkflowDocValidationError(
          `subagent 节点 "${id}".maxRounds 必须是 1-20`,
          id,
          "maxRounds",
        );
      }
      out.maxRounds = n.maxRounds;
    }
    out.worktreeId = typeof n.worktreeId === "string" ? n.worktreeId : undefined;
  } else if (n.type === "mcp_tool") {
    if (typeof n.tool !== "string" || !n.tool) {
      throw new WorkflowDocValidationError(
        `mcp_tool 节点 "${id}".tool 必填`,
        id,
        "tool",
      );
    }
    out.tool = n.tool;
    if (n.args !== undefined) {
      if (typeof n.args !== "object" || Array.isArray(n.args)) {
        throw new WorkflowDocValidationError(
          `mcp_tool 节点 "${id}".args 必须是对象`,
          id,
          "args",
        );
      }
      out.args = n.args;
    }
  } else if (n.type === "skill") {
    if (typeof n.skill !== "string" || !n.skill) {
      throw new WorkflowDocValidationError(
        `skill 节点 "${id}".skill 必填`,
        id,
        "skill",
      );
    }
    out.skill = n.skill;
  }
  if (n.inputBinding !== undefined) {
    if (typeof n.inputBinding !== "object" || Array.isArray(n.inputBinding)) {
      throw new WorkflowDocValidationError(
        `action 节点 "${id}".inputBinding 必须是对象`,
        id,
        "inputBinding",
      );
    }
    out.inputBinding = n.inputBinding;
  }
  if (n.next !== undefined) {
    if (typeof n.next !== "string") {
      throw new WorkflowDocValidationError(
        `action 节点 "${id}".next 必须是字符串`,
        id,
        "next",
      );
    }
    out.next = n.next;
  }
  return out;
}

/** 收集节点引用的子节点 id（next / steps / branches / bodyNode / thenNode / elseNode / cases / defaultNode）。 */
function collectNodeRefs(n: WorkflowNode): string[] {
  const refs: string[] = [];
  if (n.kind === "trigger") {
    if (n.next) refs.push(n.next);
  } else if (n.kind === "logic") {
    if (n.next) refs.push(n.next);
    if (n.steps) refs.push(...n.steps);
    if (n.branches) refs.push(...n.branches);
    if (n.bodyNode) refs.push(n.bodyNode);
    if (n.thenNode) refs.push(n.thenNode);
    if (n.elseNode) refs.push(n.elseNode);
    if (n.cases) refs.push(...n.cases.map((c) => c.node));
    if (n.defaultNode) refs.push(n.defaultNode);
  } else if (n.kind === "action") {
    if (n.next) refs.push(n.next);
  }
  return refs.filter(Boolean);
}

/** 递归扫整个 DSL，对所有 string 字段做注入关键字 + 长度检查。 */
function scanForDangerousStrings(value: unknown, path: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new WorkflowDocValidationError(
      `${path} 嵌套层级超过 ${MAX_DEPTH}`,
    );
  }
  if (typeof value === "string") {
    if (value.length > STRING_FIELD_LIMIT) {
      throw new WorkflowDocValidationError(
        `${path} 字段超过 ${STRING_FIELD_LIMIT} bytes`,
      );
    }
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(value)) {
        throw new WorkflowDocValidationError(
          `${path}: ${reason}`,
        );
      }
    }
    return;
  }
  if (value === null || value === undefined) return;
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForDangerousStrings(v, `${path}[${i}]`, depth + 1));
  } else {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scanForDangerousStrings(v, `${path}.${k}`, depth + 1);
    }
  }
}
