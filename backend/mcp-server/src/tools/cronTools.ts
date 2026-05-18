/**
 * Tier 0 cron meta-tools — let the Agent schedule / cancel / inspect its
 * own background tasks.
 *
 * Phase 4 Day 3. These tools let the Agent self-program recurring work:
 *   - "每周五 17:00 帮我总结这周的表结构变化" → schedule_task
 *   - "别再每天提醒我了" → cancel_task (after list_scheduled_tasks finds it)
 *
 * The underlying storage is `~/.imagebase/agents/<id>/state/cron.json`, the
 * same file the runtime heartbeat evaluates every 5 min (see
 * `backend/src/services/cronScheduler.ts`).
 *
 * These are **Tier 0** (always loaded) because they're cheap and the Agent
 * is unlikely to know ahead of time that the user wants to schedule things.
 * We keep the descriptions tight so the tool budget stays lean.
 */

import {
  addCronJob,
  removeCronJob,
  listCronJobs,
  parseCron,
  nextFireAfter,
} from "../../../src/services/cronScheduler.js";
import {
  ensureAgentFiles,
  readCron,
  writeCron,
  setHabitOverride,
} from "../../../src/services/agentService.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

const DEFAULT_AGENT_ID = "agent_default";

function resolveAgentId(args: Record<string, any>, ctx?: ToolContext): string {
  if (typeof args.agentId === "string" && args.agentId.trim()) return args.agentId.trim();
  if (ctx?.agentId) return ctx.agentId;
  return DEFAULT_AGENT_ID;
}

export const cronTools: ToolDefinition[] = [
  {
    name: "schedule_task",
    description:
      "把一条重复执行的任务写到你的 cron 表里。调用时机：用户要求你'每天/每周/每月…做某事'，或者你自己认为这件事值得定期回顾（例如周末复盘、每月清理陈旧记忆）。schedule 用标准 5 字段 cron 表达式（分 时 日 月 周），或别名 @daily / @weekly / @hourly / @monthly。prompt 是到期那一刻你自己将读到的任务描述——写得像给自己留的便签。**强烈建议同时填 displayName + description**：displayName 是 Habits tab 里卡片的短标题（≤12 字），description 是卡片下面那行小字（≤30 字概述这件事）；不填的话 UI 会把整段 prompt 灌进标题,体验极差。注意：这个工具**不会立刻执行**任何事，只是登记进 cron.json；真正触发由后台每 5 分钟一次的心跳去判断。",
    inputSchema: {
      type: "object",
      properties: {
        schedule: {
          type: "string",
          description:
            "cron 表达式，5 字段（分 时 日 月 周）或 @daily/@weekly/@hourly/@monthly/@yearly 别名。例：'0 17 * * 5' = 每周五 17:00；'@daily' = 每天 00:00。",
        },
        prompt: {
          type: "string",
          description: "到期时自己将读到的任务描述（完整指令），像给自己留的一张便签。",
        },
        displayName: {
          type: "string",
          description: "Habits tab 卡片显示的短标题，≤12 个字。例如：'每周表结构复盘' / '月度记忆清理'。强烈建议填写。",
        },
        description: {
          type: "string",
          description: "Habits tab 卡片标题下的小字说明，≤30 字概述这条 habit 在做什么。例如：'每周五下午 17:00 — 总结这周表结构变化'。强烈建议填写。",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "可选；执行时期望激活的 skill 名列表。",
        },
        agentId: {
          type: "string",
          description: "可选；默认写入当前 Agent 的 cron.json。",
        },
      },
      required: ["schedule", "prompt"],
    },
    handler: async (args, ctx) => {
      const agentId = resolveAgentId(args, ctx);
      if (!ctx?.workspaceId) {
        return JSON.stringify({ ok: false, error: "schedule_task 必须在当前 workspace 上下文内调用" });
      }
      const schedule = typeof args.schedule === "string" ? args.schedule.trim() : "";
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!schedule || !prompt) {
        return JSON.stringify({ ok: false, error: "schedule 和 prompt 都不能为空" });
      }
      const parsed = parseCron(schedule);
      if (!parsed) {
        return JSON.stringify({
          ok: false,
          error: `无法解析 cron 表达式: ${schedule}。请用 5 字段格式（分 时 日 月 周）或 @daily/@weekly 等别名。`,
        });
      }
      await ensureAgentFiles(agentId);
      const job = await addCronJob(agentId, {
        schedule,
        prompt,
        // 透传 UI 标题 / 描述 —— Agent 没填时存 undefined,前端会
        // fallback 到 deriveShortTitle(prompt) + 完整 prompt。
        displayName: typeof args.displayName === "string" && args.displayName.trim()
          ? args.displayName.trim() : undefined,
        description: typeof args.description === "string" && args.description.trim()
          ? args.description.trim() : undefined,
        type: "user",
        enabled: true,
        workspaceId: ctx.workspaceId,
        skills: Array.isArray(args.skills)
          ? args.skills.filter((s: unknown) => typeof s === "string")
          : undefined,
      });
      const next = nextFireAfter(parsed, new Date());
      return JSON.stringify({
        ok: true,
        jobId: job.id,
        schedule: job.schedule,
        nextFireAt: next ? next.toISOString() : null,
      });
    },
  },

  {
    name: "list_scheduled_tasks",
    description:
      "列出当前登记在 cron.json 里的所有定时任务。调用时机：用户问'我都定了哪些定时任务'，或者你在取消 / 修改任务前需要先找到任务 id。",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "可选；默认读取当前 Agent。" },
      },
    },
    handler: async (args, ctx) => {
      const agentId = resolveAgentId(args, ctx);
      const jobs = await listCronJobs(agentId, { workspaceId: ctx?.workspaceId ?? null });
      const now = new Date();
      return JSON.stringify({
        ok: true,
        workspaceId: ctx?.workspaceId ?? null,
        count: jobs.length,
        jobs: jobs.map((j) => {
          const parsed = parseCron(j.schedule);
          const next = parsed ? nextFireAfter(parsed, now) : null;
          return {
            id: j.id,
            schedule: j.schedule,
            prompt: j.prompt,
            workspaceId: j.workspaceId ?? null,
            skills: j.skills ?? [],
            lastFiredAt: j.lastFiredAt ?? null,
            nextFireAt: next ? next.toISOString() : null,
            parseError: parsed ? null : "invalid cron expression",
          };
        }),
      });
    },
  },

  {
    name: "cancel_task",
    description:
      "从 cron.json 删掉一条定时任务。调用时机：用户明确说'别再每天/每周…了'。调用前建议先 list_scheduled_tasks 找到正确的 jobId，不要靠猜。",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "要删除的 cron 任务 id。" },
        agentId: { type: "string", description: "可选；默认写入当前 Agent 的 cron.json。" },
      },
      required: ["jobId"],
    },
    handler: async (args, ctx) => {
      const agentId = resolveAgentId(args, ctx);
      const jobId = typeof args.jobId === "string" ? args.jobId.trim() : "";
      if (!jobId) return JSON.stringify({ ok: false, error: "jobId 不能为空" });
      const removed = await removeCronJob(agentId, jobId);
      return JSON.stringify({
        ok: removed,
        jobId,
        error: removed ? null : "找不到这个 jobId",
      });
    },
  },

  {
    name: "update_scheduled_task",
    description:
      "修改一条已有的定时任务。可以改执行时间（schedule）和开关（enabled）。用户自建的任务还可以改描述（prompt）/ 标题（displayName）/ 卡片说明（description），但系统 habit 的文本字段不可修改。调用时机：用户说'把 XX 改成每天 9 点' 或 '暂停 XX 习惯' 或 '把 XX 改名叫 YY'。调用前建议先 list_scheduled_tasks 确认 jobId。",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "要修改的 cron 任务 id。" },
        schedule: { type: "string", description: "新的 cron 表达式（可选）。5 字段或 @daily/@weekly 别名。" },
        prompt: { type: "string", description: "新的任务描述（可选,完整指令文本）。" },
        displayName: { type: "string", description: "新的 UI 标题（可选,≤12 字）。" },
        description: { type: "string", description: "新的卡片小字说明（可选,≤30 字）。" },
        enabled: { type: "boolean", description: "开关（可选）。true=启用, false=暂停。" },
        agentId: { type: "string", description: "可选；默认当前 Agent。" },
      },
      required: ["jobId"],
    },
    handler: async (args, ctx) => {
      const agentId = resolveAgentId(args, ctx);
      const jobId = typeof args.jobId === "string" ? args.jobId.trim() : "";
      if (!jobId) return JSON.stringify({ ok: false, error: "jobId 不能为空" });

      await ensureAgentFiles(agentId);
      const cronFile = await readCron(agentId);
      const job = cronFile.jobs.find((j: any) => j.id === jobId);
      if (!job) return JSON.stringify({ ok: false, error: "找不到这个 jobId" });

      const isSystem = job.type === "system";
      const updates: string[] = [];

      if (typeof args.schedule === "string" && args.schedule.trim()) {
        if (!ctx?.workspaceId) {
          return JSON.stringify({ ok: false, error: "habit schedule 必须在当前 workspace 上下文内修改" });
        }
        const parsed = parseCron(args.schedule.trim());
        if (!parsed) return JSON.stringify({ ok: false, error: `无效的 cron 表达式: ${args.schedule}` });
        await setHabitOverride(agentId, ctx.workspaceId, jobId, { schedule: args.schedule.trim() });
        updates.push(`schedule → ${args.schedule.trim()}`);
      }
      if (typeof args.prompt === "string" && args.prompt.trim()) {
        if (isSystem) {
          return JSON.stringify({ ok: false, error: "系统 habit 的内容不允许修改，只能修改执行时间和开关" });
        }
        job.prompt = args.prompt.trim();
        updates.push("prompt updated");
      }
      if (typeof args.displayName === "string" && args.displayName.trim()) {
        if (isSystem) {
          return JSON.stringify({ ok: false, error: "系统 habit 的标题不允许修改" });
        }
        job.displayName = args.displayName.trim();
        updates.push(`displayName → ${job.displayName}`);
      }
      if (typeof args.description === "string" && args.description.trim()) {
        if (isSystem) {
          return JSON.stringify({ ok: false, error: "系统 habit 的描述不允许修改" });
        }
        job.description = args.description.trim();
        updates.push("description updated");
      }
      if (typeof args.enabled === "boolean") {
        if (!ctx?.workspaceId) {
          return JSON.stringify({ ok: false, error: "habit enabled 开关必须在当前 workspace 上下文内修改" });
        }
        await setHabitOverride(agentId, ctx.workspaceId, jobId, { enabled: args.enabled });
        updates.push(`enabled → ${args.enabled}`);
      }

      if (updates.length === 0) return JSON.stringify({ ok: false, error: "没有传入任何要修改的字段" });

      await writeCron(agentId, cronFile);
      const effectiveSchedule = (typeof args.schedule === "string" && args.schedule.trim()) ? args.schedule.trim() : job.schedule;
      const effectiveEnabled = typeof args.enabled === "boolean" ? args.enabled : (job.enabled ?? true);
      const p = parseCron(effectiveSchedule);
      const nextFire = p ? nextFireAfter(p, new Date()) : null;
      return JSON.stringify({
        ok: true,
        workspaceId: ctx?.workspaceId ?? null,
        jobId,
        updates,
        schedule: effectiveSchedule,
        enabled: effectiveEnabled,
        nextFireAt: nextFire?.toISOString() ?? null,
      });
    },
  },
];
