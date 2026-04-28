/**
 * Tier 0 — User-Skill management tools (Skill Creator V1).
 *
 * 6 个工具,跟 update_profile / update_soul / create_memory 同级,任何对话都能调:
 *   - create_skill              新建一个用户级 skill (promptFragment / workflowDocs / toolWhitelist 任意一个非空)
 *   - list_my_skills            列出自己保存的 skill (含 enable / invokedCount / 资产摘要)
 *   - update_skill              局部 patch 一个 skill
 *   - delete_skill ⚠           删除(走危险确认流)
 *   - enable_skill              persistent enable/disable toggle (跨对话,跨 agent session)
 *   - save_workflow_run_as_skill 一键转存历史 WorkflowRun.docJson 为 skill
 *
 * **enable_skill vs activate_skill**:
 *   - activate_skill  (skillRouterTools): 当前对话内的运行时激活,内存状态,10 turns 自动驱逐
 *   - enable_skill    (本文件):           DB 里持久化的 boolean,关闭后所有对话不再触发
 *   两者正交。详见 docs/skill-creator-plan.md §6。
 */

import {
  createUserSkill,
  listUserSkills,
  getUserSkill,
  updateUserSkill,
  deleteUserSkill,
  toggleUserSkillEnabled,
  UserSkillValidationError,
  UserSkillNotFoundError,
  UserSkillNameConflictError,
  UserSkillPermissionError,
  type UserSkillRow,
} from "../../../src/services/userSkill/userSkillStore.js";
import { getWorkflowRun } from "../../../src/services/workflowRunStore.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

const DEFAULT_AGENT_ID = "agent_default";

function resolveAgentId(args: Record<string, any>, ctx?: ToolContext): string {
  if (typeof args.agentId === "string" && args.agentId.trim()) return args.agentId.trim();
  if (ctx?.agentId) return ctx.agentId;
  return DEFAULT_AGENT_ID;
}

/** Translate a UserSkill thrown error into a structured tool error JSON. */
function errToToolJson(err: unknown): string {
  if (err instanceof UserSkillValidationError) {
    return JSON.stringify({ ok: false, error: err.message, code: "VALIDATION", field: err.field });
  }
  if (err instanceof UserSkillNotFoundError) {
    return JSON.stringify({ ok: false, error: err.message, code: "NOT_FOUND" });
  }
  if (err instanceof UserSkillNameConflictError) {
    return JSON.stringify({ ok: false, error: err.message, code: "NAME_CONFLICT" });
  }
  if (err instanceof UserSkillPermissionError) {
    return JSON.stringify({ ok: false, error: err.message, code: "PERMISSION" });
  }
  return JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    code: "INTERNAL",
  });
}

/** Compact human-friendly asset summary for list_my_skills output. */
function buildAssetSummary(row: UserSkillRow): string {
  const parts: string[] = [];
  if (row.promptFragment) parts.push("promptFragment");
  if (row.workflowDocs && row.workflowDocs.length > 0) {
    parts.push(`${row.workflowDocs.length} 个 workflow`);
  }
  if (row.toolWhitelist && row.toolWhitelist.length > 0) {
    parts.push(`${row.toolWhitelist.length} 个白名单工具`);
  }
  return parts.join(" + ") || "(无资产)";
}

/** Compact dto for list output (Agent friendly — no raw workflowDocs). */
function rowToListDto(row: UserSkillRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    triggers: row.triggers,
    enabled: row.enabled,
    invokedCount: row.invokedCount,
    lastInvokedAt: row.lastInvokedAt?.toISOString() ?? null,
    assetSummary: buildAssetSummary(row),
    sourceWorkflowRunId: row.sourceWorkflowRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Get-detail dto (includes raw workflowDocs / promptFragment / toolWhitelist). */
function rowToDetailDto(row: UserSkillRow) {
  return {
    ...rowToListDto(row),
    promptFragment: row.promptFragment,
    workflowDocs: row.workflowDocs,
    toolWhitelist: row.toolWhitelist,
    sourceConversationId: row.sourceConversationId,
  };
}

export const userSkillTools: ToolDefinition[] = [
  // ─── create_skill ───────────────────────────────────────────────────────
  {
    name: "create_skill",
    description:
      "保存一个新的 user skill(用户自定义的可复用能力)。" +
      "三类资产至少一个非空:" +
      " promptFragment(注入 system prompt 的策略/术语); " +
      " workflowDocs(WorkflowDoc 数组,激活后变成 invoke_skill_workflow_<id>_<i> 工具); " +
      " toolWhitelist(激活时的工具白名单,V1 写库不消费)。" +
      '调用时机:用户说"以后我说 X 你就按这个流程"/"把刚才的流程存下来"。' +
      "name 唯一性以 owner 维度,同一 agent 不能重名。" +
      "保存后下一轮对话(任何对话)只要消息含 triggers 之一就会自动激活。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "skill 名(1-60 字符,不含 / 与首尾空格)" },
        description: {
          type: "string",
          description: "一句话描述,用户在 list 时看到。可选,默认为空。",
        },
        triggers: {
          type: "array",
          items: { type: "string" },
          description: "触发关键词数组(1-20 个非空字符串),用户消息含其一即自动激活",
        },
        promptFragment: {
          type: "string",
          description: "可选;注入 system prompt 的策略/术语片段(≤8KB)",
        },
        workflowDocs: {
          type: "array",
          description:
            "可选;WorkflowDoc 数组(≤5 个)。每个 doc 必含 rootNodeId + nodes。" +
            "保存前后端会用 safeEval 校验 DSL 结构 + 危险关键字。",
          items: { type: "object" },
        },
        toolWhitelist: {
          type: "array",
          items: { type: "string" },
          description: "可选;激活时允许的工具名白名单(V2 启用,V1 仅记录)",
        },
        agentId: { type: "string", description: "可选;默认当前 Agent" },
      },
      required: ["name", "triggers"],
    },
    handler: async (args, ctx) => {
      const ownerId = resolveAgentId(args, ctx);
      try {
        const row = await createUserSkill({
          ownerType: "agent",
          ownerId,
          name: String(args.name ?? ""),
          description: typeof args.description === "string" ? args.description : "",
          triggers: Array.isArray(args.triggers) ? (args.triggers as unknown[]).map(String) : [],
          promptFragment:
            typeof args.promptFragment === "string" ? args.promptFragment : null,
          workflowDocs: Array.isArray(args.workflowDocs)
            ? (args.workflowDocs as unknown[])
            : null,
          toolWhitelist: Array.isArray(args.toolWhitelist)
            ? (args.toolWhitelist as unknown[]).map(String)
            : null,
          sourceConversationId: ctx?.conversationId ?? null,
        });
        return JSON.stringify({
          ok: true,
          skill: rowToDetailDto(row),
          note:
            "已保存。下次对话只要消息含 triggers 之一就会自动激活;" +
            "现在对话也可以直接调 activate_skill('" +
            row.name +
            "') 立刻挂上。",
        });
      } catch (err) {
        return errToToolJson(err);
      }
    },
  },

  // ─── list_my_skills ────────────────────────────────────────────────────
  {
    name: "list_my_skills",
    description:
      "列出当前 Agent 自己保存的 user skill(分页一次性返回,V1 数量小)。" +
      "返回 id/name/description/triggers/enabled/invokedCount/lastInvokedAt/assetSummary。" +
      "需要看完整 workflowDocs / promptFragment 时配合 list 拿到 id 后,目前没有专门的 get,可以再调 update_skill 时把要看的字段读出来,或直接用 DB 工具。",
    inputSchema: {
      type: "object",
      properties: {
        onlyEnabled: {
          type: "boolean",
          description: "可选;true 时只返回 enabled=true 的 skill。默认 false,全集。",
        },
        agentId: { type: "string", description: "可选;默认当前 Agent" },
      },
    },
    handler: async (args, ctx) => {
      const ownerId = resolveAgentId(args, ctx);
      try {
        const rows = await listUserSkills({
          ownerType: "agent",
          ownerId,
          onlyEnabled: !!args.onlyEnabled,
        });
        return JSON.stringify({
          ok: true,
          total: rows.length,
          skills: rows.map(rowToListDto),
        });
      } catch (err) {
        return errToToolJson(err);
      }
    },
  },

  // ─── update_skill ──────────────────────────────────────────────────────
  {
    name: "update_skill",
    description:
      "局部修改一个已有 skill。只传想改的字段,其他保持不变。" +
      "改 workflowDocs 会重新跑 safeEval 校验,失败则整个 update 拒收。" +
      "name 改成与本 agent 已有 skill 重名时拒收。" +
      "改完后下一轮对话生效(当前已激活的 skill 仍按旧 DSL 跑完本轮)。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "要修改的 skill id" },
        name: { type: "string" },
        description: { type: "string" },
        triggers: { type: "array", items: { type: "string" } },
        promptFragment: {
          type: ["string", "null"],
          description: "传 null / 空字符串视为清空(但需保证至少一个资产仍非空)",
        },
        workflowDocs: {
          type: ["array", "null"],
          items: { type: "object" },
          description: "传 null / 空数组视为清空",
        },
        toolWhitelist: { type: ["array", "null"], items: { type: "string" } },
        enabled: { type: "boolean" },
        agentId: { type: "string", description: "可选;权限校验用" },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      const requireOwnerId = resolveAgentId(args, ctx);
      const id = String(args.id ?? "").trim();
      if (!id) return JSON.stringify({ ok: false, error: "id 必填", code: "VALIDATION" });
      const patch: Record<string, unknown> = {};
      if ("name" in args) patch.name = args.name;
      if ("description" in args) patch.description = args.description;
      if ("triggers" in args) patch.triggers = args.triggers;
      if ("promptFragment" in args) patch.promptFragment = args.promptFragment;
      if ("workflowDocs" in args) patch.workflowDocs = args.workflowDocs;
      if ("toolWhitelist" in args) patch.toolWhitelist = args.toolWhitelist;
      if ("enabled" in args) patch.enabled = args.enabled;
      try {
        const row = await updateUserSkill(id, patch as any, { requireOwnerId });
        return JSON.stringify({ ok: true, skill: rowToDetailDto(row) });
      } catch (err) {
        return errToToolJson(err);
      }
    },
  },

  // ─── delete_skill ⚠ ───────────────────────────────────────────────────
  {
    name: "delete_skill",
    danger: true,
    description:
      "⚠️ 删除一个 user skill(危险操作,需用户在 UI 确认卡片上点确认才会真正执行)。" +
      "不可撤销 — 关联的 workflowDocs / promptFragment / 使用统计全部丢失。" +
      "如果只是想暂时停用,改用 enable_skill(id, false)。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "要删除的 skill id" },
        agentId: { type: "string", description: "可选;权限校验用" },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      const requireOwnerId = resolveAgentId(args, ctx);
      const id = String(args.id ?? "").trim();
      if (!id) return JSON.stringify({ ok: false, error: "id 必填", code: "VALIDATION" });
      try {
        const existing = await getUserSkill(id);
        if (!existing) {
          return JSON.stringify({
            ok: false,
            error: `skill 不存在: ${id}`,
            code: "NOT_FOUND",
          });
        }
        if (existing.ownerId !== requireOwnerId) {
          return JSON.stringify({
            ok: false,
            error: "权限不足:此 skill 属于其他 owner",
            code: "PERMISSION",
          });
        }
        await deleteUserSkill(id, { requireOwnerId });
        return JSON.stringify({
          ok: true,
          deletedId: id,
          deletedName: existing.name,
          summary:
            `已删除 skill「${existing.name}」` +
            `(累计调用 ${existing.invokedCount} 次` +
            (existing.lastInvokedAt
              ? `,最近一次于 ${existing.lastInvokedAt.toISOString()}`
              : "") +
            ")。",
        });
      } catch (err) {
        return errToToolJson(err);
      }
    },
  },

  // ─── enable_skill ─────────────────────────────────────────────────────
  {
    name: "enable_skill",
    description:
      "持久化开关一个 skill。enabled=false 时该 skill 在所有未来对话都不会被触发匹配,但记录、" +
      "workflowDocs 都保留(随时可重新 enable)。这跟 activate_skill 不同 —— activate_skill 只在当前对话激活," +
      "下次对话默认重置;enable_skill 是跨对话的永久状态。" +
      '调用时机:用户说"这个 skill 触发太频繁,先关掉" / "恢复 X skill"。',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "要切换的 skill id" },
        enabled: { type: "boolean", description: "true=启用 / false=禁用" },
        agentId: { type: "string", description: "可选;权限校验用" },
      },
      required: ["id", "enabled"],
    },
    handler: async (args, ctx) => {
      const requireOwnerId = resolveAgentId(args, ctx);
      const id = String(args.id ?? "").trim();
      if (!id) return JSON.stringify({ ok: false, error: "id 必填", code: "VALIDATION" });
      if (typeof args.enabled !== "boolean") {
        return JSON.stringify({
          ok: false,
          error: "enabled 必须是 boolean",
          code: "VALIDATION",
        });
      }
      try {
        const row = await toggleUserSkillEnabled(id, args.enabled, { requireOwnerId });
        return JSON.stringify({ ok: true, skill: rowToListDto(row) });
      } catch (err) {
        return errToToolJson(err);
      }
    },
  },

  // ─── save_workflow_run_as_skill ────────────────────────────────────────
  {
    name: "save_workflow_run_as_skill",
    description:
      "把一次成功的 WorkflowRun.docJson 一键转存为 user skill,记录 sourceWorkflowRunId。" +
      '调用时机:刚跑完一次效果不错的 workflow,用户说"以后我说 X 都按这个跑"。' +
      "只接受 status='success' 的 run。" +
      '若不传 promptFragment,自动写入一段简短的"触发后调 invoke_skill_workflow_<id>_0"提示;' +
      "若不传 triggers,会拒收(关键词必须由你或用户给出,系统不猜测)。" +
      "host owner 必须匹配:只能转存自己 host 出来的 run。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "WorkflowRun.id" },
        name: { type: "string", description: "新 skill 的名字" },
        description: { type: "string", description: "可选" },
        triggers: {
          type: "array",
          items: { type: "string" },
          description: "触发关键词(必填,由你/用户提供)",
        },
        promptFragment: {
          type: "string",
          description: "可选;不传则系统自动生成简短引导",
        },
        agentId: { type: "string", description: "可选;权限校验用" },
      },
      required: ["runId", "name", "triggers"],
    },
    handler: async (args, ctx) => {
      const ownerId = resolveAgentId(args, ctx);
      const runId = String(args.runId ?? "").trim();
      if (!runId) {
        return JSON.stringify({ ok: false, error: "runId 必填", code: "VALIDATION" });
      }
      try {
        const run = await getWorkflowRun(runId);
        if (!run) {
          return JSON.stringify({
            ok: false,
            error: `workflow run not found: ${runId}`,
            code: "NOT_FOUND",
          });
        }
        if (run.status !== "success") {
          return JSON.stringify({
            ok: false,
            error: `只能转存 status=success 的 run,当前 status=${run.status}`,
            code: "VALIDATION",
          });
        }
        if (run.hostAgentId !== ownerId) {
          return JSON.stringify({
            ok: false,
            error: "权限不足:只能转存自己 host 的 run",
            code: "PERMISSION",
          });
        }
        if (!run.docJson || typeof run.docJson !== "object") {
          return JSON.stringify({
            ok: false,
            error: "run.docJson 缺失,无法转存",
            code: "VALIDATION",
          });
        }
        const promptFragment =
          typeof args.promptFragment === "string" && args.promptFragment.trim()
            ? args.promptFragment
            : `触发后,直接调用 invoke_skill_workflow_<skillId>_0 复跑此 workflow;` +
              `不需要重新让 LLM 生成 DSL。原始 templateId: ${run.templateId}。`;
        const row = await createUserSkill({
          ownerType: "agent",
          ownerId,
          name: String(args.name ?? ""),
          description: typeof args.description === "string" ? args.description : "",
          triggers: Array.isArray(args.triggers)
            ? (args.triggers as unknown[]).map(String)
            : [],
          promptFragment,
          workflowDocs: [run.docJson as any],
          sourceConversationId: run.parentConversationId,
          sourceWorkflowRunId: runId,
        });
        return JSON.stringify({
          ok: true,
          skill: rowToDetailDto(row),
          note:
            `已从 WorkflowRun ${runId} (templateId: ${run.templateId}) 转存为 skill「${row.name}」。` +
            `下次对话只要消息含 triggers 之一,你可以直接 invoke_skill_workflow_${row.id}_0 复跑。`,
        });
      } catch (err) {
        return errToToolJson(err);
      }
    },
  },
];
