/**
 * Tier 0 skill-router tools — let the Agent browse, activate, and release skills.
 *
 * These are the **only** tools that appear by default alongside metaTools /
 * memoryTools when no skill is active. Everything else (field CRUD, record
 * CRUD, view CRUD…) lives inside Tier 2 skills and is only loaded after
 * activate_skill succeeds.
 *
 * Why small, explicit router tools instead of a single "skill" verb?
 *   - The model benefits from small, single-purpose functions with obvious
 *     pre/post conditions. `find_skill` / `find_tool` are read-only;
 *     `activate_skill` has a real side effect on the tools-list for next
 *     round; `deactivate_skill` lets the agent clean up when it's done.
 *   - Eviction is still automatic after N unused turns (see chatAgentService),
 *     but the explicit verb lets the model proactively shrink context.
 *
 * Activation state is held in-memory per conversation inside
 * `chatAgentService.ts` (see `skillState`). That service passes a
 * mutation callback into these tools via ctx so we don't create a circular
 * import between the skills module and the MCP tools module.
 */

import { allSkills, skillsByName } from "../skills/index.js";
import type { SkillDefinition } from "../skills/types.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const CJK_RE = /[\u3400-\u9fff]/;

function clampLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(n), 1), MAX_LIMIT);
}

function normalizeText(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function tokenizeQuery(query: string): string[] {
  const raw = query
    .toLowerCase()
    .split(/[\s,，。.;；:：/\\|()[\]{}"'`]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const tokens = new Set<string>();
  for (const token of raw) {
    tokens.add(token);
    if (CJK_RE.test(token) && token.length > 2) {
      for (let i = 0; i < token.length - 1; i += 1) {
        tokens.add(token.slice(i, i + 2));
      }
    }
  }
  return [...tokens];
}

function scoreFields(
  query: string,
  tokens: string[],
  fields: Array<{ text: unknown; weight: number }>,
): number {
  const q = query.trim().toLowerCase();
  if (!q && tokens.length === 0) return 0;
  let score = 0;
  for (const field of fields) {
    const text = normalizeText(field.text);
    if (!text) continue;
    if (q && text.includes(q)) score += field.weight * 3;
    for (const token of tokens) {
      if (text.includes(token)) score += field.weight;
    }
  }
  return score;
}

function skillTriggerText(skill: SkillDefinition): string {
  return skill.triggers
    .map((pat) => (typeof pat === "string" ? pat : pat.source))
    .join(" ");
}

function scoreSkill(skill: SkillDefinition, query: string, tokens: string[]): number {
  return scoreFields(query, tokens, [
    { text: skill.name, weight: 30 },
    { text: skill.displayName, weight: 30 },
    { text: skill.description, weight: 18 },
    { text: skill.when, weight: 22 },
    { text: skillTriggerText(skill), weight: 12 },
    { text: skill.tools.map((t) => t.name).join(" "), weight: 10 },
    { text: skill.tools.map((t) => t.description).join(" "), weight: 5 },
  ]);
}

function scoreTool(
  tool: Pick<ToolDefinition, "name" | "description">,
  query: string,
  tokens: string[],
  ownerSkill?: SkillDefinition,
): number {
  return scoreFields(query, tokens, [
    { text: tool.name, weight: 34 },
    { text: tool.description, weight: 18 },
    { text: ownerSkill?.name, weight: 12 },
    { text: ownerSkill?.displayName, weight: 12 },
    { text: ownerSkill?.when, weight: 8 },
  ]);
}

export const skillRouterTools: ToolDefinition[] = [
  {
    name: "find_skill",
    description:
      "同等最高优先级能力检索入口（与 find_tool 等价优先）：按用户意图查找可激活 Skill，并返回匹配分数/推荐激活项。当前工具不足、需要写入/修改数据表/字段/记录/视图/文档/设计/分析/集成/工作区文件时，先调用 find_skill({query}) 或 find_tool({query})，再用 activate_skill 挂载需要的技能。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "用户意图或任务关键词，例如 '创建字段'、'写入 idea'、'运行 SQL 分析'。",
        },
        limit: {
          type: "number",
          description: "最多返回多少个 skill，默认 8，最大 20。",
        },
        includeTools: {
          type: "boolean",
          description: "是否返回每个 skill 的工具名摘要。默认 false，节省上下文。",
        },
      },
    },
    handler: async (args, ctx?: ToolContext) => {
      const active = new Set(ctx?.activeSkills || []);
      const availableSkills = ctx?.availableSkills ?? allSkills;
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const tokens = tokenizeQuery(query);
      const limit = clampLimit(args.limit);
      const includeTools = args.includeTools === true;
      const ranked = availableSkills
        .map((s, index) => ({
          skill: s,
          index,
          score: query ? scoreSkill(s, query, tokens) : 0,
        }))
        .filter((item) => !query || item.score > 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (active.has(a.skill.name) !== active.has(b.skill.name)) {
            return active.has(a.skill.name) ? -1 : 1;
          }
          return a.index - b.index;
        })
        .slice(0, limit);
      return JSON.stringify({
        ok: true,
        query,
        count: availableSkills.length,
        returned: ranked.length,
        skills: ranked.map(({ skill: s, score }) => ({
          name: s.name,
          displayName: s.displayName,
          description: s.description,
          when: s.when,
          toolCount: s.tools.length,
          active: active.has(s.name),
          score,
          activationPriority: score >= 80 ? "high" : score >= 30 ? "medium" : "low",
          nextAction: active.has(s.name)
            ? "skill already active; call its tools directly"
            : `activate_skill({ "name": "${s.name}" })`,
          ...(includeTools ? { tools: s.tools.map((t) => t.name) } : {}),
        })),
        note:
          ranked.length > 0
            ? "选择最高分且未 active 的 skill 后调用 activate_skill；active 的 skill 可直接使用其工具。"
            : "没有匹配到 skill；可换更具体的 query，或调用 find_tool 查具体工具名。",
      });
    },
  },

  {
    name: "find_tool",
    description:
      "同等最高优先级工具检索入口（与 find_skill 等价优先）：当当前上下文工具不足以完成用户请求、或不确定工具是否已加载时，按意图查找当前可直接调用的工具以及未加载 skill 中的工具。返回 canCallNow 和 nextAction；若工具在未激活 skill 内，先 activate_skill。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "用户意图或工具关键词，例如 '修改 workspace 名称'、'批量创建记录'、'调用 lark mcp'。",
        },
        limit: {
          type: "number",
          description: "最多返回多少个工具，默认 8，最大 20。",
        },
        includeLoadedTools: {
          type: "boolean",
          description: "是否搜索当前已加载工具。默认 true。",
        },
        includeSkillTools: {
          type: "boolean",
          description: "是否搜索未加载 skill 中的工具。默认 true。",
        },
      },
      required: ["query"],
    },
    handler: async (args, ctx?: ToolContext) => {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return JSON.stringify({ ok: false, error: "missing query" });
      }
      const limit = clampLimit(args.limit);
      const includeLoadedTools = args.includeLoadedTools !== false;
      const includeSkillTools = args.includeSkillTools !== false;
      const tokens = tokenizeQuery(query);
      const activeSkills = new Set(ctx?.activeSkills || []);
      const availableSkills = ctx?.availableSkills ?? allSkills;
      const loadedNames = new Set(ctx?.availableToolNames ?? []);
      const loadedSummaries = ctx?.availableToolSummaries ?? [];
      const toolOwners = new Map<string, SkillDefinition>();
      for (const skill of availableSkills) {
        for (const tool of skill.tools) {
          if (!toolOwners.has(tool.name)) toolOwners.set(tool.name, skill);
        }
      }

      const candidates = new Map<string, {
        name: string;
        description: string;
        danger?: boolean;
        canCallNow: boolean;
        ownerSkill?: SkillDefinition;
        score: number;
      }>();

      if (includeLoadedTools) {
        for (const tool of loadedSummaries) {
          const ownerSkill = toolOwners.get(tool.name);
          const score = scoreTool(tool, query, tokens, ownerSkill);
          if (score <= 0) continue;
          candidates.set(tool.name, {
            name: tool.name,
            description: tool.description,
            danger: tool.danger,
            canCallNow: true,
            ownerSkill,
            score,
          });
        }
      }

      if (includeSkillTools) {
        for (const skill of availableSkills) {
          for (const tool of skill.tools) {
            const score = scoreTool(tool, query, tokens, skill);
            if (score <= 0) continue;
            const existing = candidates.get(tool.name);
            const canCallNow = loadedNames.has(tool.name) || activeSkills.has(skill.name);
            if (existing) {
              existing.canCallNow = existing.canCallNow || canCallNow;
              existing.ownerSkill = existing.ownerSkill ?? skill;
              existing.score = Math.max(existing.score, score);
              continue;
            }
            candidates.set(tool.name, {
              name: tool.name,
              description: tool.description,
              danger: tool.danger,
              canCallNow,
              ownerSkill: skill,
              score,
            });
          }
        }
      }

      const matches = [...candidates.values()]
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (a.canCallNow !== b.canCallNow) return a.canCallNow ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, limit)
        .map((item) => {
          const ownerActive = item.ownerSkill ? activeSkills.has(item.ownerSkill.name) : false;
          return {
            name: item.name,
            description: item.description,
            danger: item.danger === true ? true : undefined,
            score: item.score,
            canCallNow: item.canCallNow,
            ownerSkill: item.ownerSkill
              ? {
                  name: item.ownerSkill.name,
                  displayName: item.ownerSkill.displayName,
                  active: ownerActive,
                }
              : null,
            nextAction: item.canCallNow
              ? `call ${item.name}`
              : item.ownerSkill
                ? `activate_skill({ "name": "${item.ownerSkill.name}" }) then call ${item.name}`
                : "tool is not loaded in the current context",
          };
        });

      return JSON.stringify({
        ok: true,
        query,
        returned: matches.length,
        loadedToolCount: loadedNames.size,
        searchedSkillCount: availableSkills.length,
        matches,
        note:
          matches.length > 0
            ? "优先直接调用 canCallNow=true 的工具；否则先激活 ownerSkill。"
            : "没有匹配到工具；可换更具体 query，或调用 find_skill 查能力包。",
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
      const availableSkillsByName = ctx?.availableSkillsByName ?? skillsByName;
      const skill = availableSkillsByName[name];
      if (!skill) {
        const availableSkills = ctx?.availableSkills ?? allSkills;
        return JSON.stringify({
          ok: false,
          error: `unknown skill: ${name}`,
          available: availableSkills.map((s) => s.name),
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
