/**
 * Workflow executor (PR4 Agent Workflow).
 *
 * Walks a `WorkflowDoc` (DSL JSON tree) and yields `WorkflowEvent` SSE events
 * + `SseEvent` events from any subagent it spawns. Caller (chatAgentService
 * tool dispatcher) is expected to forward both into the parent SSE stream.
 *
 * V1 (PR4) scope:
 *   - trigger / sequence / parallel / loop / if logic nodes
 *   - action node only `subagent` type (mcp_tool / skill deferred — host can
 *     just call those tools directly without workflow)
 *   - safe expression `condition` / `switchOn` (LLM-decide condition deferred)
 *   - Hard caps: MAX_TOTAL_NODE_VISITS=200, LOOP_HARD_CAP=10, MAX_PARALLEL=8
 *
 * Variable scope:
 *   - `ctx.scope[outputAlias]` filled by each action with `{finalText, runId,
 *     toolCallsCount, success}` (the spawnSubagent return shape)
 *   - `${alias.finalText}` template ref in inputBinding resolves against scope
 *   - `${trigger.payload.userMessage}` exposed for templates to read user msg
 *   - Loop iter exposed as `i` (or `iteratorVar`)
 */

import {
  WorkflowDoc,
  WorkflowNode,
  WorkflowContext,
  WorkflowEvent,
  WORKFLOW_HARD_CAPS,
} from "./types.js";
import { evalExpression, resolveTemplate } from "./safeEval.js";

interface SpawnSubagentFn {
  (opts: {
    modelId: string;
    systemPrompt?: string;
    userPrompt: string;
    allowedTools?: string[];
    maxRounds?: number;
    workflowNodeId?: string | null;
    worktreeId?: string | null;
  }): Promise<{ runId: string; finalText: string; success: boolean }>;
}

/**
 * V2.5 B7: LLM-decide condition. Used by `if` / `loop.exitCondition` /
 * `switch` when expression mode can't capture the semantic check (e.g.
 * "did the reviewer approve the design"). 用 cheap & fast model
 * (gpt-5.4-mini fallback to doubao) 评估,要求 LLM 输出 YES / NO 单 token。
 */
async function evalLlmCondition(
  prompt: string,
  scope: Record<string, any>,
  spawn: SpawnSubagentFn,
  preferredModel?: string,
): Promise<boolean> {
  // Resolve `${...}` placeholders inside the prompt body so LLM sees real
  // values not template syntax.
  const resolved = (await import("./safeEval.js")).resolveTemplate(prompt, scope);
  const sysPrompt =
    "你是一个 boolean 判断器。读完用户给的 prompt 后,只回复 YES 或 NO 一个单词,不要解释,不要标点。" +
    "如果 prompt 描述的条件成立 → YES;不成立 → NO;不确定时倾向 NO。";
  const userMsg = resolved;
  try {
    const result = await spawn({
      modelId: preferredModel ?? "gpt-5.4-mini",
      systemPrompt: sysPrompt,
      userPrompt: userMsg,
      maxRounds: 1,
      allowedTools: [], // 显式不让它调任何工具
    });
    const text = (result.finalText ?? "").trim().toUpperCase();
    return text.startsWith("YES");
  } catch {
    return false;
  }
}

interface WalkState {
  totalVisits: { count: number };
}

export async function* executeWorkflow(
  doc: WorkflowDoc,
  ctx: WorkflowContext,
  spawn: SpawnSubagentFn,
): AsyncGenerator<WorkflowEvent, void, undefined> {
  const startedAt = Date.now();
  yield { kind: "workflow_start", runId: doc.id, templateId: doc.templateId };

  const state: WalkState = { totalVisits: { count: 0 } };

  // V2.5 C8 heartbeat: 每 15s 检查一次最后一次 yield 时间,过 15s 没动静
  // 主动 push 一个 heartbeat 事件保活 SSE。完成 / 错误 / abort 时自动 cleanup。
  let lastEmit = Date.now();
  let stopped = false;
  const heartbeatQueue: WorkflowEvent[] = [];
  const heartbeatTimer = setInterval(() => {
    if (stopped) return;
    const idle = Date.now() - lastEmit;
    if (idle >= 15_000) {
      heartbeatQueue.push({ kind: "workflow_heartbeat", runId: doc.id, elapsedMs: Date.now() - startedAt });
      lastEmit = Date.now();
    }
  }, 5_000).unref();

  function* drainHeartbeat(): Generator<WorkflowEvent> {
    while (heartbeatQueue.length > 0) yield heartbeatQueue.shift()!;
  }

  try {
    const inner = walk(doc.rootNodeId, doc, ctx, spawn, state);
    for await (const ev of inner) {
      yield ev;
      lastEmit = Date.now();
      yield* drainHeartbeat();
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg === "WORKFLOW_ABORTED") {
      stopped = true;
      clearInterval(heartbeatTimer);
      yield { kind: "workflow_aborted", runId: doc.id, reason: "user-aborted" };
      return;
    }
    stopped = true;
    clearInterval(heartbeatTimer);
    yield { kind: "workflow_error", runId: doc.id, error: errMsg };
    return;
  }

  stopped = true;
  clearInterval(heartbeatTimer);
  yield* drainHeartbeat();
  yield {
    kind: "workflow_end",
    runId: doc.id,
    durationMs: Date.now() - startedAt,
  };
}

async function* walk(
  nodeId: string,
  doc: WorkflowDoc,
  ctx: WorkflowContext,
  spawn: SpawnSubagentFn,
  state: WalkState,
): AsyncGenerator<WorkflowEvent, void, undefined> {
  if (ctx.abortSignal?.aborted) {
    throw new Error("WORKFLOW_ABORTED");
  }
  if (++state.totalVisits.count > WORKFLOW_HARD_CAPS.MAX_TOTAL_NODE_VISITS) {
    throw new Error(`workflow exceeded ${WORKFLOW_HARD_CAPS.MAX_TOTAL_NODE_VISITS} node visits`);
  }
  const node = doc.nodes[nodeId];
  if (!node) throw new Error(`node ${nodeId} not found`);

  yield {
    kind: "workflow_node_start",
    runId: doc.id,
    nodeId,
    nodeKind: node.kind,
    nodeType: (node as any).type,
  };

  let nextId: string | undefined;
  let nodeOutput: any = undefined;

  if (node.kind === "trigger") {
    if (!ctx.trigger) ctx.trigger = { payload: node.payload };
    nextId = node.next;
  } else if (node.kind === "logic") {
    nextId = yield* walkLogic(node, doc, ctx, spawn, state);
  } else if (node.kind === "action") {
    nodeOutput = yield* walkAction(node, doc, ctx, spawn, state);
    nextId = node.next;
  }

  yield { kind: "workflow_node_end", runId: doc.id, nodeId, output: nodeOutput };

  if (nextId) {
    yield* walk(nextId, doc, ctx, spawn, state);
  }
}

async function* walkLogic(
  node: Extract<WorkflowNode, { kind: "logic" }>,
  doc: WorkflowDoc,
  ctx: WorkflowContext,
  spawn: SpawnSubagentFn,
  state: WalkState,
): AsyncGenerator<WorkflowEvent, string | undefined, undefined> {
  if (node.type === "sequence") {
    if (!node.steps?.length) return node.next;
    for (const step of node.steps) {
      yield* walk(step, doc, ctx, spawn, state);
    }
    return node.next;
  }

  if (node.type === "parallel") {
    if (!node.branches?.length) return node.next;
    if (node.branches.length > WORKFLOW_HARD_CAPS.MAX_PARALLEL_BRANCHES) {
      throw new Error(`parallel branches exceed cap ${WORKFLOW_HARD_CAPS.MAX_PARALLEL_BRANCHES}`);
    }
    // Run each branch as its own generator, drain events fairly via merge.
    for (let i = 0; i < node.branches.length; i++) {
      yield {
        kind: "workflow_branch_start",
        runId: doc.id,
        parentNodeId: node.id,
        branchIdx: i,
        totalBranches: node.branches.length,
      };
    }
    const generators = node.branches.map((b) => walk(b, doc, ctx, spawn, state));
    yield* mergeGenerators(generators, node.joinStrategy ?? "all");
    return node.next;
  }

  if (node.type === "loop") {
    if (!node.bodyNode) return node.next;
    const declared = node.maxIterations ?? WORKFLOW_HARD_CAPS.LOOP_DEFAULT;
    const cap = Math.min(declared, WORKFLOW_HARD_CAPS.LOOP_HARD_CAP);
    const iterVar = node.iteratorVar ?? "i";
    for (let i = 0; i < cap; i++) {
      yield {
        kind: "workflow_loop_iteration",
        runId: doc.id,
        loopNodeId: node.id,
        iter: i,
        maxIter: cap,
      };
      ctx.scope[iterVar] = i;
      yield* walk(node.bodyNode, doc, ctx, spawn, state);
      // exit condition checked AFTER body so an "exit-on-pass" is checked
      // against the just-written output.
      if (node.exitCondition) {
        const env = buildEnv(ctx);
        let cond = false;
        if (node.exitCondition.mode === "expression") {
          try {
            cond = Boolean(evalExpression(node.exitCondition.expr, env));
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            throw new Error(`loop exitCondition expression failed: ${errMsg}`);
          }
        } else if (node.exitCondition.mode === "llm") {
          // V2.5 B7: LLM judge. cond = LLM output startsWith "YES"
          cond = await evalLlmCondition(
            node.exitCondition.prompt,
            env,
            spawn,
            node.exitCondition.model,
          );
        }
        if (cond) break;
      }
    }
    return node.next;
  }

  if (node.type === "if") {
    if (!node.condition) return node.elseNode ?? node.thenNode;
    const env = buildEnv(ctx);
    let cond = false;
    if (node.condition.mode === "expression") {
      try {
        cond = Boolean(evalExpression(node.condition.expr, env));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`if condition expression failed: ${errMsg}`);
      }
    } else if (node.condition.mode === "llm") {
      cond = await evalLlmCondition(node.condition.prompt, env, spawn, node.condition.model);
    }
    const target = cond ? node.thenNode : node.elseNode;
    if (target) yield* walk(target, doc, ctx, spawn, state);
    return node.next;
  }

  if (node.type === "switch") {
    if (!node.switchOn) return node.defaultNode ?? node.next;
    const env = buildEnv(ctx);
    let value: any = "";
    try {
      value = evalExpression(node.switchOn, env);
    } catch {
      // fallthrough to default
    }
    const match = node.cases?.find((c) => String(value) === c.match);
    const target = match?.node ?? node.defaultNode;
    if (target) yield* walk(target, doc, ctx, spawn, state);
    return node.next;
  }

  return node.next;
}

async function* walkAction(
  node: Extract<WorkflowNode, { kind: "action" }>,
  doc: WorkflowDoc,
  ctx: WorkflowContext,
  spawn: SpawnSubagentFn,
  _state: WalkState,
): AsyncGenerator<WorkflowEvent, any, undefined> {
  if (node.type !== "subagent") {
    // V1 only supports subagent action. mcp_tool / skill deferred —
    // host can call those tools directly without workflow.
    return undefined;
  }
  if (!node.subagentModel) {
    throw new Error(`action ${node.id} missing subagentModel`);
  }
  const env = buildEnv(ctx);
  // Resolve model id (could itself be a template like "${user.preferredModel}").
  const modelId = resolveTemplate(node.subagentModel, env);

  const userPromptRaw = node.inputBinding?.userPrompt ?? node.userPrompt ?? "";
  const userPrompt = resolveTemplate(userPromptRaw, env);
  const systemPromptRaw = node.inputBinding?.systemPrompt ?? node.systemPrompt;
  const systemPrompt = systemPromptRaw ? resolveTemplate(systemPromptRaw, env) : undefined;

  // V2.6 C17: worktreeId 优先 inputBinding,然后 node 字段;字符串模板会被解析。
  const worktreeIdRaw = node.inputBinding?.worktreeId ?? node.worktreeId;
  const worktreeId = worktreeIdRaw ? resolveTemplate(worktreeIdRaw, env).trim() || undefined : undefined;

  const result = await spawn({
    modelId: modelId.trim() || "doubao-2.0",
    systemPrompt,
    userPrompt,
    allowedTools: node.allowedTools,
    maxRounds: node.maxRounds,
    workflowNodeId: node.id,
    worktreeId,
  });

  if (node.outputAlias) {
    ctx.scope[node.outputAlias] = result;
  }
  return result;
}

function buildEnv(ctx: WorkflowContext): Record<string, any> {
  return {
    ctx,
    scope: ctx.scope,
    trigger: ctx.trigger ?? {},
    workflow: ctx.workflow,
    user: ctx.user ?? {},
    ...ctx.scope, // Allow `${alias.foo}` shorthand without `scope.` prefix
  };
}

/**
 * Merge multiple async generators "fairly":poll each at the same rate.
 * V1 implementation — Promise.race on `next()` calls until all done.
 */
async function* mergeGenerators<T>(
  gens: AsyncGenerator<T, void, undefined>[],
  strategy: "all" | "any" | "race",
): AsyncGenerator<T, void, undefined> {
  if (gens.length === 0) return;
  if (gens.length === 1) {
    yield* gens[0];
    return;
  }

  // For all strategies we drain until at least one is done.
  // Strategy semantics:
  //   - all: keep draining all until done
  //   - any/race: stop after the first generator returns (others discarded)
  type GenState = {
    gen: AsyncGenerator<T, void, undefined>;
    done: boolean;
    pending: Promise<{ idx: number; result: IteratorResult<T> }> | null;
    idx: number;
  };
  const states: GenState[] = gens.map((g, idx) => ({ gen: g, done: false, pending: null, idx }));

  function refill(s: GenState) {
    if (s.done || s.pending) return;
    s.pending = s.gen.next().then((result) => ({ idx: s.idx, result }));
  }

  for (const s of states) refill(s);

  let aliveCount = states.length;
  let firstDone = -1;
  while (aliveCount > 0) {
    const racers = states
      .filter((s) => !s.done && s.pending)
      .map((s) => s.pending as Promise<{ idx: number; result: IteratorResult<T> }>);
    if (racers.length === 0) break;
    const winner = await Promise.race(racers);
    const s = states[winner.idx];
    s.pending = null;
    if (winner.result.done) {
      s.done = true;
      aliveCount--;
      if (firstDone < 0) firstDone = winner.idx;
      if (strategy !== "all") {
        // any/race — stop after first.
        // Drain remaining pending promises silently (don't await — let GC).
        return;
      }
    } else {
      yield winner.result.value;
      refill(s);
    }
  }
}
