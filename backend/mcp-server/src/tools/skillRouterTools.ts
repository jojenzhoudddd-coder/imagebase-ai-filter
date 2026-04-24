/**
 * Tier 0 skill-router tools — let the Agent browse, activate, and release skills.
 *
 * These are the **only** tools that appear by default alongside metaTools /
 * memoryTools when no skill is active. Everything else (field CRUD, record
 * CRUD, view CRUD…) lives inside Tier 2 skills and is only loaded after
 * activate_skill succeeds.
 *
 * Why three tools instead of a single "skill" verb?
 *   - The model benefits from small, single-purpose functions with obvious
 *     pre/post conditions. `find_skill` is read-only; `activate_skill` has
 *     a real side effect on the tools-list for next turn; `deactivate_skill`
 *     lets the agent clean up when it's done.
 *   - Eviction is still automatic after N unused turns (see chatAgentService),
 *     but the explicit verb lets the model proactively shrink context.
 *
 * Activation state is held in-memory per conversation inside
 * `chatAgentService.ts` (see `skillState`). That service passes a
 * mutation callback into these tools via ctx so we don't create a circular
 * import between the skills module and the MCP tools module.
 */

import { allSkills, skillsByName } from "../skills/index.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

export const skillRouterTools: ToolDefinition[] = [
  {
    name: "find_skill",
    description:
      "列出当前 Agent 可用的所有 Skill（显示名、描述、触发场景、工具数）。你默认只看得到 Tier 0/1 工具；当用户的请求需要写入/修改数据表、字段、记录、视图等操作时，先调 find_skill 看目录，再用 activate_skill 把需要的技能挂进来。",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (_args, ctx?: ToolContext) => {
      const active = new Set(ctx?.activeSkills || []);
      return JSON.stringify({
        ok: true,
        count: allSkills.length,
        skills: allSkills.map((s) => ({
          name: s.name,
          displayName: s.displayName,
          description: s.description,
          when: s.when,
          toolCount: s.tools.length,
          active: active.has(s.name),
        })),
      });
    },
  },

  {
    name: "activate_skill",
    description:
      "把一个 Skill 挂进本轮对话的工具表。调用后，下一轮模型就能看到并调用该 Skill 里的所有工具。典型用法：用户说要添加字段 / 创建记录 / 修改视图，你先 activate_skill({name:'table-skill'}) 再真正执行。重复激活是幂等的。",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "要激活的 Skill 名，如 'table-skill'（可先用 find_skill 查）",
        },
      },
      required: ["name"],
    },
    handler: async (args, ctx?: ToolContext) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) {
        return JSON.stringify({ ok: false, error: "missing skill name" });
      }
      const skill = skillsByName[name];
      if (!skill) {
        return JSON.stringify({
          ok: false,
          error: `unknown skill: ${name}`,
          available: allSkills.map((s) => s.name),
        });
      }
      // Mutate via callback — see chatAgentService attachSkillContext.
      ctx?.onActivateSkill?.(name);
      return JSON.stringify({
        ok: true,
        activated: skill.name,
        displayName: skill.displayName,
        newlyAvailableTools: skill.tools.map((t) => t.name),
        note:
          "Skill 已激活，新工具在本轮下一 round 立即可用。" +
          "不要停下来宣布就绪，也不要只回复一句确认——继续执行用户原请求：" +
          "立刻调用新工具或输出下一步产物。只有在用户请求本身就是问答时才可停。",
      });
    },
  },

  {
    name: "deactivate_skill",
    description:
      "把一个 Skill 从本轮对话的工具表移除（用于清理 context token）。例如用户切换话题、不再需要某类能力时调用。不是必需的——长时间未使用的 skill 会被自动卸载。",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "要卸载的 Skill 名",
        },
      },
      required: ["name"],
    },
    handler: async (args, ctx?: ToolContext) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) {
        return JSON.stringify({ ok: false, error: "missing skill name" });
      }
      ctx?.onDeactivateSkill?.(name);
      return JSON.stringify({
        ok: true,
        deactivated: name,
      });
    },
  },
];
