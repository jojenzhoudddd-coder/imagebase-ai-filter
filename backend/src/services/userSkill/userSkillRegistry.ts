/**
 * UserSkill registry — adapts persisted UserSkill rows into the runtime
 * `SkillDefinition` shape used by the chat agent loop.
 *
 * 职责：
 *   - `loadUserSkills(agentId)` 从 DB 拉所有 enabled user skill,转换并返回 SkillDefinition[]
 *   - `toSkillDefinition(row)` 单行适配:promptFragment 透传 + workflowDocs[i] → invoke_skill_workflow_<id>_<i> 工具
 *   - `parseInvokeWorkflowToolName(name)` 反向解析工具名为 {userSkillId, docIndex}（PR3 record invocation 需要用到）
 *
 * 设计要点：
 *   - 工具名形如 `invoke_skill_workflow_<userSkillId>_<docIndex>`,例如
 *     `invoke_skill_workflow_cmoihr2880000kdkd77rkwnri_0`
 *   - 每次 turn 重新 load,不缓存,避免 enable/update 后还吃旧状态
 *     （DB 已索引 ownerType+ownerId+enabled,query 是 O(log n)）
 *   - SkillDefinition.triggers 是 (string | RegExp)[] —— UserSkill.triggers
 *     只能存 string[]（DB 限制）,这里直接以字符串形式注入,触发匹配走
 *     `userMessage.includes(trigger)`,跟 builtin skill 同样语义
 *   - displayName 取 `name`（用户已用过的好名字），description 用 row.description
 *   - artifacts 默认空数组（V1 不参与 artifact-open 触发）
 *   - softDeps 不复用（V1 UserSkill schema 没这字段；如果 V2 加，再适配）
 *
 * 详见 docs/skill-creator-plan.md §5。
 */

import {
  listUserSkills,
  recordUserSkillInvocation,
  type UserSkillRow,
} from "./userSkillStore.js";
import { getUserSkillEnabledOverride } from "../agentService.js";
import type { SkillDefinition } from "../../../mcp-server/src/skills/types.js";
import type { ToolDefinition, ToolContext } from "../../../mcp-server/src/tools/tableTools.js";
import type { WorkflowDoc } from "../workflow/types.js";

const INVOKE_TOOL_PREFIX = "invoke_skill_workflow_";

/** Marker tag we attach to the SkillDefinition for traceability + UI labelling. */
export const USER_SKILL_TAG = "[user]";

/**
 * Build the SkillDefinition equivalent of a UserSkill row.
 *
 * The synthesized `tools[]` are *closures* capturing the userSkillId + docIndex
 * — calling the tool resolves the doc from the row's workflowDocs and dispatches
 * to `ctx.executeWorkflow({ templateId: "custom", params: { customDoc: doc } })`.
 *
 * `recordUserSkillInvocation()` is called fire-and-forget on success so the
 * `invokedCount` / `lastInvokedAt` columns track real usage.
 */
export function toSkillDefinition(row: UserSkillRow): SkillDefinition {
  const tools: ToolDefinition[] = [];
  const docs = row.workflowDocs ?? [];
  docs.forEach((doc, idx) => {
    const toolName = `${INVOKE_TOOL_PREFIX}${row.id}_${idx}`;
    const docTitle = doc.templateId ? ` [${doc.templateId}]` : "";
    tools.push({
      name: toolName,
      description:
        `触发用户自定义 skill「${row.name}」中的工作流 #${idx}${docTitle}。` +
        `该工作流由用户保存,不需要重复让 LLM 生成 DSL。` +
        `调用时只需把当前用户消息原样作为 userMessage 传入。`,
      inputSchema: {
        type: "object",
        properties: {
          userMessage: {
            type: "string",
            description: "传给该 workflow 的用户原始指令(将作为 trigger.payload.userMessage)",
          },
        },
        required: ["userMessage"],
      },
      handler: async (args, ctx?: ToolContext): Promise<string> => {
        if (!ctx?.executeWorkflow) {
          return JSON.stringify({
            error: `${toolName} 在当前上下文不可用 (stdio MCP 调用不支持 workflow 执行)`,
          });
        }
        const userMessage = String(args.userMessage ?? "").trim();
        if (!userMessage) {
          return JSON.stringify({ error: "userMessage 必填" });
        }
        // 取 doc 当下最新内容(如果用户在两次 invoke 之间 update_skill 改了 DSL,
        // 这里走的是创建闭包时 capture 的 row,不是最新 row;PR3 update_skill
        // 会改 row.workflowDocs,但当前 turn 的 SkillDefinition 已经创建,
        // 触发的还是旧 doc。这是预期行为——单次 turn 内 skill 的 DSL 视为 immutable)。
        try {
          const result = await ctx.executeWorkflow({
            templateId: "custom",
            userMessage,
            params: { customDoc: doc, userSkillId: row.id, userSkillName: row.name },
          });
          // 成功则递增使用计数 (fire-and-forget;失败不影响主流程)
          if (result.success) {
            void recordUserSkillInvocation(row.id);
          }
          return JSON.stringify({
            runId: result.runId,
            success: result.success,
            summary: result.summary,
            userSkillId: row.id,
            workflowIndex: idx,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return JSON.stringify({ error: `${toolName} failed: ${msg}` });
        }
      },
    });
  });

  return {
    name: row.name,
    sourceRef: { type: "skill", id: row.id },
    displayName: `${USER_SKILL_TAG} ${row.name}`,
    description: row.description || `用户自定义 skill: ${row.name}`,
    artifacts: [],
    when: row.description || `用户的"${row.name}"场景`,
    triggers: (row.triggers as (string | RegExp)[]) ?? [],
    tools,
    promptFragment: row.promptFragment ?? undefined,
  };
}

/**
 * Load all enabled user skills for the given agent. Returns SkillDefinition[]
 * suitable for merging into the runtime registry.
 *
 * V1: only `ownerType="agent"`. V2 will additionally pull `workspace` / `global`.
 */
export async function loadUserSkills(
  agentId: string,
  workspaceId?: string | null,
): Promise<SkillDefinition[]> {
  if (!agentId) return [];
  const rows = await listUserSkills({
    ownerType: "agent",
    ownerId: agentId,
  });
  const enabledRows: UserSkillRow[] = [];
  for (const row of rows) {
    const override = workspaceId
      ? await getUserSkillEnabledOverride(agentId, workspaceId, row.id)
      : undefined;
    if (override ?? row.enabled) enabledRows.push(row);
  }
  return enabledRows.map(toSkillDefinition);
}

/**
 * Reverse parse `invoke_skill_workflow_<id>_<i>` → `{userSkillId, docIndex}`.
 * Returns null on non-matching name. Used by chatAgentService to track
 * lastUsedTurn / softDep refresh per user skill on invocation.
 */
export function parseInvokeWorkflowToolName(
  toolName: string,
): { userSkillId: string; docIndex: number } | null {
  if (!toolName.startsWith(INVOKE_TOOL_PREFIX)) return null;
  const rest = toolName.slice(INVOKE_TOOL_PREFIX.length);
  // userSkillId is a cuid (alphanumeric, no underscores). docIndex is the trailing _N.
  const idx = rest.lastIndexOf("_");
  if (idx <= 0) return null;
  const userSkillId = rest.slice(0, idx);
  const docIndexStr = rest.slice(idx + 1);
  if (!/^\d+$/.test(docIndexStr)) return null;
  return { userSkillId, docIndex: Number(docIndexStr) };
}
