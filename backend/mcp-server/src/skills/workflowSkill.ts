/**
 * V2.5 C1 workflow-skill —— host agent 调度多步协作的入口 skill。
 *
 * 把 list_workflow_templates / execute_workflow_template / compose_workflow /
 * spawn_subagent 这 4 个 Tier 1 工具(它们本来就 always-on)再封装成一个
 * 可激活 skill,主要价值是 promptFragment:用决策树告诉 host
 *   - 何时直接 spawn_subagent(单一子任务)
 *   - 何时跑模板 execute_workflow_template(已有的 4 模板覆盖)
 *   - 何时 compose_workflow 即兴生成 DSL(模板没有覆盖的场景)
 *
 * 触发关键词:让/help/想/计划 + review/审查/头脑风暴/brainstorm/parallel/
 * 并发/并行/cowork/协作。激活后自动 softDeps 把 table-skill / idea-skill /
 * taste-skill / demo-skill 一并保活,避免 workflow 跨工件操作时被驱逐。
 */

import type { SkillDefinition } from "./types.js";
import { subagentTools } from "../tools/subagentTools.js";
import { workflowTools } from "../tools/workflowTools.js";

export const workflowSkill: SkillDefinition = {
  name: "workflow-skill",
  displayName: "Workflow 调度",
  description:
    "多步协作 / subagent 编排 / 并发执行 / 审查循环 / 头脑风暴。" +
    "激活后让 host 在面对复杂任务时使用 4 个内置模板 + 自由 DSL 编排。",
  artifacts: [],
  when: "用户要求多 AI 协作 / 审查循环 / 头脑风暴 / 并行任务 / 自由编排多步骤流程时激活",
  triggers: [
    /让.*review/,
    /审查.*代码/,
    /审查.*方案/,
    /头脑风暴/,
    /集思广益/,
    /并行|并发|concurrent|parallel/,
    /cowork|协作开发/,
    /分.*步骤.*完成/,
    /先.*再.*然后/,
    /循环.*直到/,
    /workflow/,
    "review",
    "brainstorm",
    "delegate",
    "spawn",
  ],
  softDeps: ["table-skill", "idea-skill", "taste-skill", "demo-skill"],
  // 这些 4 工具本来就 Tier 1 always-on,但放进 skill.tools 数组让
  // resolveActiveTools 在激活 workflow-skill 时显式把它们标进 active list,
  // 让 prompt catalog 显示 ✅ 已加载。
  tools: [
    ...subagentTools,
    ...workflowTools,
  ],
  promptFragment: `# Active Skill · workflow-skill

## 决策树:何时用哪个工具

\`\`\`
用户任务复杂度?
├─ 单一子任务 (一次 LLM 就够,只是不是 host 自己模型)
│  └─ 直接 spawn_subagent({modelId, userPrompt})
│     例:"用 GPT-5.5 帮我审一下这段代码"
│
├─ 多步协作,匹配上 4 个内置模板
│  └─ list_workflow_templates → execute_workflow_template
│     例:
│       review → "Claude 写,GPT 审,循环到 PASS"
│       brainstorm → "3 个模型并行答同问题,host 汇总"
│       cowork → "并行多模态/多视角,host 拼接"
│       concurrent-data → "host 拆任务,N worker 并行,host merge"
│
└─ 模板覆盖不到 → compose_workflow({doc, userMessage})
   即兴写 DSL JSON。doc.nodes 里每个节点 kind ∈ {trigger, logic, action},
   logic.type ∈ {sequence, parallel, loop, if, switch},
   action.type 仅 subagent (V2 mcp_tool/skill action 暂未实现,直接调即可)。
   inputBinding 用 \${alias.field} 引用 ctx.scope。
\`\`\`

## 重要规则

1. **每次起 workflow / spawn_subagent 前,先用一句话告诉用户**:"接下来让 [模型] 做 [事]"
2. **循环必填 maxIterations**,默认 5,系统硬顶 10
3. **subagent 嵌套 ≤ 2 层**(host → sub1 → sub2,sub2 不能再起)
4. **subagent 调危险工具时会上抛你决议**(V2.4 三段确认):
   - 用户原指令明确授权 + workflow 设计内 → \`approve_subagent_danger\`
   - subagent 越界 / 与节点不符 → \`reject_subagent_danger\`
   - 涉及破坏性操作 + 你拿不准 → \`escalate_subagent_danger\`,在最终回复说明
5. **DSL 自由编排时**:
   - safeEval condition 支持 \`a === b\` / \`length(s) > 0\` / \`includes(s,"x")\` /
     \`match(s,"regex")\` / 三元 \`a ? b : c\` / 数组 \`[1,2,3]\`
   - 复杂语义判断用 \`{mode:"llm", prompt:"..."}\`,LLM 输出 YES/NO 决定
6. **不要把简单任务套 workflow** —— "帮我读这张表" 直接调 \`get_table\`,不要起 workflow
`,
};
