# Skill Creator + Workflow DSL 持久化 方案讨论稿

> 状态:讨论中,未排期
> 议题来源:用户问"workflow DSL 是否能持久化复用",自然延展到"用户级 skill 创建管理"
> 决策原则:把 workflow 复用吸收进更高维的 Skill 容器,而不是单独做 SavedWorkflow

---

## 1. 现状盘点

### 1.1 已经持久化的部分(WorkflowRun 表)

每次 workflow 跑完,完整 DSL 落在 `WorkflowRun.docJson`,跟下面这些字段一起存:

```prisma
model WorkflowRun {
  id              String
  templateId      String?  // "brainstorm" | "review" | "cowork" | "concurrent-data"
                           // | "concurrent-code" | "custom" | "append-batch"
  parentMessageId String
  parentConversationId String
  hostAgentId     String
  paramsJson      Json     // 触发时的参数 (hostModel / customDoc 等)
  docJson         Json     // ← 完整 DSL,nodes / rootNodeId / variables 都在
  status          String
  nodeEventsJson  Json     // 节点级 timeline
  startedAt       DateTime
  completedAt     DateTime?
  durationMs      Int?
  finalSummary    String?
  errorMessage    String?
}
```

`/api/admin/workflow-runs` 已经能列出所有 run,可以点开看任意一条的 DSL 长什么样。

### 1.2 没有的部分:用户级"模板库"

- ❌ "这个 workflow 跑得不错,存为我的模板,以后一键起" 的 UI
- ❌ "列出我所有保存的模板" 的入口
- ❌ "通过名字调起一个保存的模板" 的工具(MCP 也没有)
- ❌ Agent 自己说"我以前跑过一个类似的,我直接复用" 的能力

每次 Agent 想跑一个非内置模板的工作流,都要重新让 LLM 生成 DSL。

### 1.3 内置模板(`templates.ts`)

`buildBrainstorm` / `buildReview` / `buildCowork` / `buildConcurrentData` /
`buildConcurrentCode` 是写死的工厂函数,每次调用按参数生成新 DSL。这些**不是真正的"模板存储"**,改一行就要发版。用户没法改。

### 1.4 现有 Skill 系统(`mcp-server/src/skills/`)

```ts
interface SkillDefinition {
  name: string;             // "table-skill" / "analyst-skill"
  when: string;             // 自然语言触发条件描述
  triggers: string[];       // 关键词触发
  tools: ToolDefinition[];  // 这个 skill 激活后注入的工具集
  promptFragment?: string;  // 激活时拼进 system prompt 的术语/规则段
  softDeps?: string[];      // 依赖其他 skill (协作激活)
  artifacts?: string[];     // 关联的 artifact 类型
}
```

**当前限制**:全部硬编码在 backend 代码里。改一个 skill = 改 TS 文件 + 重新发版。
用户 / Agent 自己**没法新增**。

---

## 2. 核心洞察:Skill = Workflow 的超集

> "把 Agent 一段成功的工作流程封装成可复用的能力" —— 这就是 Skill 的本质。
> Workflow DSL 只是 Skill 内部能携带的资产之一。

不应该单独做 `SavedWorkflow`,而应该把 workflow 复用作为 Skill 的一种 **资产类型**纳入更高维的容器:

```
UserSkill (容器)
  ├── promptFragment   ← 系统指令片段 (策略 / 术语 / 规则)
  ├── workflowDocs[]   ← 一组 DSL (取代独立的 SavedWorkflow)
  ├── scriptHandlers[] ← 确定性代码处理器 (sandbox 跑;V2 才上)
  └── toolWhitelist[]  ← 激活时只让用这些 tool (限权)
```

**理由**:
1. 数据模型省一张表,工具命名空间统一
2. 用户认知简单(只有"我的 skill"一个概念)
3. Agent 调用统一(都通过现有 skill 触发机制,无新通路)
4. `promptFragment` 是 skill 的灵魂,workflowDocs / scriptHandlers 是它的"附件"
   — 这个分层自然
5. 单独做 SavedWorkflow 反而别扭 — workflow 跑出来要"保存"通常意味着希望"以后
   某种条件下重跑",这本质就需要触发器,就是 skill

---

## 3. 数据模型设计

### 3.1 Prisma `UserSkill` model

```prisma
model UserSkill {
  id          String   @id @default(cuid())
  ownerType   String   // "agent" | "workspace" | "global"
  ownerId     String   // agentId / workspaceId / null (global preset 用 null)
  name        String
  description String   @default("")
  triggers    Json     // string[] — 关键词数组

  // ── 三类资产 (任意组合,任意非空就是有效的 skill) ──
  promptFragment String? @db.Text
  workflowDocs   Json?   // WorkflowDoc[] (复用 services/workflow/types.ts 的类型)
  scriptHandlers Json?   // SkillScriptHandler[] (V2 启用)
  toolWhitelist  Json?   // string[] — 激活时只允许这些 tool

  // ── 来源溯源 ──
  sourceConversationId String?
  sourceWorkflowRunId  String?

  // ── 使用统计 (PR4 自动维护) ──
  enabled       Boolean  @default(true)
  invokedCount  Int      @default(0)
  lastInvokedAt DateTime?

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([ownerType, ownerId])
  @@index([enabled])
}
```

### 3.2 SkillScriptHandler 类型(V2 用)

```ts
interface SkillScriptHandler {
  id: string;
  name: string;       // "cleanColumn" / "summarizeBatch"
  description: string;
  code: string;       // JS / TS source
  signature?: {       // 可选,JSON-schema 描述输入输出
    input: any;
    output: any;
  };
}
```

---

## 4. 三类资产的协同(用户场景)

### 场景 A:纯策略 skill(只有 promptFragment)

> 用户:"帮我查一下 React 19 RC 状态,然后写成调研笔记"
> Agent: ... 跑了 web_search + read 4 个网页 + 写到 idea ... 完美
> 用户:"以后我说'调研 X 技术',你都按这个流程来"
>
> Agent 调 `create_skill`:

```json
{
  "name": "tech-research",
  "triggers": ["调研", "research", "了解最新"],
  "promptFragment": "用户说'调研 X 技术'时,你应该:\n1) web_search 最新 release notes\n2) web_fetch 官方 blog 和 changelog\n3) 总结到 idea 文档,引用源 URL",
  "toolWhitelist": ["web_search", "web_fetch", "create_idea", "append_to_idea"]
}
```

只有 promptFragment + toolWhitelist,没有 workflow,没有代码。

### 场景 B:含 DSL 的 skill

> 用户:"用 review 模板让 GPT 审一下 Claude 的方案"
> ... workflow 跑得不错 ...
> 用户:"以后默认用 GPT 5.5 review,review 完再让 doubao 翻译成英文"
>
> Agent 调 `create_skill`:

```json
{
  "name": "bilingual-review",
  "triggers": ["双语 review", "translated review"],
  "workflowDocs": [
    {
      "templateId": "custom",
      "rootNodeId": "n_trigger",
      "nodes": { "...": "DSL" }
    }
  ],
  "promptFragment": "触发后:用 invoke_skill_workflow(workflowDocs[0]) 跑;失败时降级到内置 review 模板。"
}
```

下次触发,Agent 自己 `invoke_skill_workflow(skillId, 0)` 起这个保存的 DSL。

### 场景 C:含确定性代码(V2 才做)

> 用户:"以后我说'清洗这一列',你就把空值替换成 N/A、统一日期格式 YYYY-MM-DD、去重"

```json
{
  "name": "column-cleaner",
  "triggers": ["清洗", "标准化"],
  "scriptHandlers": [
    {
      "id": "h1",
      "name": "cleanColumn",
      "code": "function clean(rows, fieldId) { return rows.map(r => ({ ...r, cells: { ...r.cells, [fieldId]: normalizeValue(r.cells[fieldId]) }})); function normalizeValue(v) { ... } }"
    }
  ],
  "promptFragment": "触发后:调 invoke_skill_handler(skillId, 'h1', { rows, fieldId })"
}
```

**这块要 sandbox**(在 isolated-vm 里跑,不让访问 fs / net / process)。

### 场景 D:三件套混合

```json
{
  "name": "weekly-report",
  "triggers": ["写周报", "周报"],
  "promptFragment": "周报格式:本周成绩 + 下周计划 + 风险...",
  "workflowDocs": [{ "...": "一个 brainstorm DSL,平行让 3 个模型出不同视角" }],
  "scriptHandlers": [{ "...": "把 3 个视角合成 markdown 表格的代码" }],
  "toolWhitelist": ["query_records", "create_idea", "append_to_idea"]
}
```

---

## 5. 与现有 Skill 系统集成(零侵入)

### 5.1 改 `mcp-server/src/skills/index.ts`

```ts
// before
export const allSkills = [tableSkill, ideaSkill, demoSkill, ...];

// after
export async function resolveAvailableSkills(
  agentId: string,
  workspaceId: string,
): Promise<SkillDefinition[]> {
  const builtin = allSkills;  // 内置不变
  const userSkills = await loadUserSkills({ agentId, workspaceId });  // 新加
  return [...builtin, ...userSkills.map(toSkillDefinition)];
}
```

### 5.2 `toSkillDefinition()` 适配器

把 UserSkill 适配成现有的 `SkillDefinition` 接口:
- `promptFragment` → 直接透传
- `workflowDocs[]` → 转成 `tools: [invoke_skill_workflow_<i>]` 工具(每个 doc 一个 wrapper tool)
- `scriptHandlers[]` → 同理转成 `invoke_skill_handler_<id>` 工具

```ts
function toSkillDefinition(us: UserSkill): SkillDefinition {
  const tools: ToolDefinition[] = [];

  // workflowDocs → invoke wrapper tools
  (us.workflowDocs ?? []).forEach((doc, i) => {
    tools.push({
      name: `invoke_skill_workflow_${us.id}_${i}`,
      description: `触发 user skill "${us.name}" 中的 workflow #${i}。${doc.title ?? ""}`,
      inputSchema: { type: "object", properties: { userMessage: { type: "string" } }, required: ["userMessage"] },
      handler: async (args, ctx) => {
        // 复用 ctx.executeWorkflow 路径,docJson 直传
        return ctx.executeWorkflow!({
          templateId: "custom",
          userMessage: String(args.userMessage),
          params: { customDoc: doc },
        });
      },
    });
  });

  // scriptHandlers → invoke wrapper tools (V2)
  // ...

  return {
    name: us.name,
    when: us.description,
    triggers: us.triggers,
    tools,
    promptFragment: us.promptFragment,
  };
}
```

**对现有的 Tier 0/1/2 + 触发逻辑零改动**。Agent 视角看,user skill 就是另一个普通 skill。

---

## 6. Agent 自助管理的 5 个 Tier 0 工具

跟 update_profile / update_soul / create_memory 同级,任何对话都能调:

| 工具 | 用途 |
|---|---|
| `create_skill(name, description, triggers, promptFragment?, workflowDocs?, scriptHandlers?, toolWhitelist?)` | Agent 写一个新 skill |
| `list_my_skills()` | 看自己有哪些 skill |
| `update_skill(id, patches)` | 改 skill |
| `delete_skill(id)` ⚠ | 删 |
| `enable_skill(id, enabled)` | 临时禁用,不删 |

**激活路径**(已有,零改动):
trigger 关键词命中 → skill 激活 → tools 注入 → promptFragment 拼进 system

**调用路径**(新增):
skill 激活后,Agent 看到 skill 提供的 `invoke_skill_workflow_<i>` /
`invoke_skill_handler_<id>` 工具,自己决定要不要调

---

## 7. 用户级 UI

### 7.1 V1 最低限度需要

```
/settings/skills
┌────────────────────────────────────────────┐
│ My Skills                          [+ New] │
├────────────────────────────────────────────┤
│ ⚙ tech-research                       ⋯   │
│   触发:调研 / research / 了解最新           │
│   含:promptFragment · 调用 23 次            │
│                                             │
│ ⚙ bilingual-review                    ⋯   │
│   触发:双语 review                          │
│   含:promptFragment + 1 workflow · 7 次   │
│                                             │
│ ⚙ column-cleaner                      ⋯   │
│   触发:清洗 / 标准化                        │
│   含:promptFragment + 1 handler · 12 次   │
└────────────────────────────────────────────┘
```

每条点开 = 详情页,可看/编辑/禁用/删除/查看历史调用。

### 7.2 V1 简化版

复用 `/api/admin/metrics` 的 dashboard 风格,做一个 read-only 列表 +
delete + enable toggle。create / edit 让 Agent 自己用 MCP 工具做,UI 不用做
(已经有了)。

---

## 8. 安全(scriptHandlers 风险)

`scriptHandlers` 是真代码,**最大风险点**。隔离方案:

| 等级 | 方案 | 你做 | 我做 |
|---|---|---|---|
| **MVP** | 不开放 scriptHandlers,只 promptFragment + workflowDocs。代码能力延后 | — | 直接禁用这字段 |
| **Phase 2** | 用 `isolated-vm` (V8 isolate) 沙箱:限内存 32MB / 限 CPU 5s / 无 fs/net/process | npm i isolated-vm | 写 sandboxRun helper |
| **Phase 3** | 真要"长程能调外部 API",改 worker thread + 白名单 fetch domain | — | 多 1 天 |

**推荐**:V1 砍掉 scriptHandlers,**只做 promptFragment + workflowDocs**。
这两个本身就够覆盖 80% 用户场景,且**完全不引入安全风险**:
- prompt 是文本(注入到 system prompt 的拼接,LLM 自己决定怎么用)
- DSL 经过 safeEval AST 白名单已经够安全(无 IO、无任意代码执行)

`scriptHandlers` 等真有人要再说。

---

## 9. REST endpoints(给前端 UI 用)

```
GET    /api/skills?scope=agent|workspace|global  列出
POST   /api/skills                              新建
PATCH  /api/skills/:id                          改
DELETE /api/skills/:id                          删
POST   /api/skills/:id/toggle                   enable/disable
POST   /api/skills/from-run/:runId              一键转存某次成功 run 的 DSL
GET    /api/skills/:id/invocations              使用历史(为后续做)
```

---

## 10. 落地排期

| Week | PR | 内容 |
|---|---|---|
| 1 | **PR1** | Prisma `UserSkill` model + migrations + `userSkillStore.ts` CRUD + 单测 |
| 1.5 | **PR2** | `resolveAvailableSkills()` 把 user skills 注入现有 skill registry + `toSkillDefinition()` adapter (workflowDocs → invoke_skill_workflow_<i> tools) |
| 2 | **PR3** | 5 个 Tier 0 MCP tools (`create_skill` / `list_my_skills` / `update_skill` / `delete_skill` / `enable_skill`) |
| 2.5 | **PR4** | 前端 `/settings/skills` 列表页(read-only + enable toggle + delete + 看详情) |
| 3 | **PR5**(可选)| 一键 "save as skill from current conversation":自动把当前对话最近的 successful WorkflowRun docJson + 一段 LLM 生成的 promptFragment 打包成 skill |

总 **~3 周**,scriptHandlers 暂不做。

---

## 11. 待你拍板的决策

### 11.1 scriptHandlers 是否纳入 V1
- **建议**:不要(安全成本高,80% 场景 promptFragment + DSL 已够)
- **如果做**:+1 周(isolated-vm 集成 + sandboxRun helper + 安全测试)

### 11.2 ownerType 默认级别
- **V1 选项 A**:只支持 "agent" 级(每个 agent 独立)
- **V1 选项 B**:同时支持 "agent" + "workspace"(团队共享)
- **V1 选项 C**:再加 "global" preset(系统预置一组精选 skill)

**建议**:V1 只 agent 级(最简单),V2 加 workspace 共享,V3 加 global preset

### 11.3 与 SavedWorkflow 的关系
- **结论**:**不再单独做 SavedWorkflow**。所有 workflow 复用诉求通过
  `UserSkill.workflowDocs` 字段满足。一个想"光存一个 DSL"的用户,就建一个
  `{ workflowDocs: [theDoc], promptFragment: null }` 的 skill。

### 11.4 UI 动手时机
- **V1 推荐**:Agent 用 MCP 工具自助创建/管理(零 UI 也能用),前端只做
  read-only list + enable/delete
- **V2**:加表单式"我的技能编辑器"页

---

## 12. 跟其他模块的交互

| 模块 | 影响 |
|---|---|
| `chatAgentService.ts` | `resolveActiveTools()` 改成调 `resolveAvailableSkills()` 拿合并后的 skill 列表;trigger 匹配走完整 list |
| `WorkflowRun` | 新增 `sourceSkillId` 字段?可选,用于反查"这次 run 是某个 skill 触发的"。V2 加 |
| `SubagentRun` | 不影响 |
| `executeWorkflow` (chatAgentService) | 不变,workflowDocs 通过 `params.customDoc` 传入 |
| `agentService.ts`(memory / soul / profile) | 不影响,UserSkill 是独立维度 |
| Tier 0 tool registry | 加 5 个新 tool,与现有 (update_profile / read_memory 等) 同级 |

---

## 13. 风险 + 不确定性

| 风险 | 缓解 |
|---|---|
| 用户疯狂建 skill,trigger 关键词大量重叠 → Agent 不知该激活哪个 | 触发匹配用 lowest-edit-distance + 最近 invokedAt 优先;UI 上提示冲突的 trigger |
| Skill 调用失败(workflow run 报错) | 自动 fallback 到 builtin skills(已有触发逻辑就支持降级) |
| 用户跨 agent 共享 skill | V2 上 ownerType="workspace" + UI 选择器解决 |
| Skill 累积太多导致 system prompt 撑爆 | trigger 匹配后**只激活前 3 个**(已有 lastUsedTurn 机制类似);skill 列表展示在 prompt 中也截断 |
| `promptFragment` 被 prompt injection 滥用(用户给 agent 注入恶意指令) | UserSkill 创建走 Agent 自己写(意味着用户已经"信任"自己的 agent),不允许第三方写;global preset 由系统人审 |
| `workflowDocs` DSL 校验 | createSkill 时跑 `safeEval` 白名单 + Schema 校验,无效拒收 |

---

## 14. 参考与启发

- **Notion AI Skills / Templates**:基于 prompt 的复用单元
- **Cursor Custom Modes / Rules**:.cursor/rules.md 风格的可重用 prompt 片段
- **Coze 工作流商店**:DSL 级别的复用 + 用户分享
- **OpenAI Custom GPTs**:整合 prompt + 工具白名单 + 知识库
- **Anthropic Computer Use Skills(2025-08 版)**:把"流程"封装成 skill

我们这个方案最接近 **Cursor Rules + Coze 工作流** 的混合体,叠加 Anthropic
Skills 的"只在 trigger 时激活"思想。

---

**讨论结论(待用户确认)**:

1. ✅ 不单独做 SavedWorkflow,workflow 复用归入 UserSkill 一并设计
2. ✅ V1 只做 promptFragment + workflowDocs,scriptHandlers 留 V2
3. ✅ V1 只做 agent 级 ownership,workspace / global 留 V2
4. ✅ 5 个 Tier 0 工具给 Agent 自助管理,前端 V1 仅 read-only
5. ⏸️ 排期未定 — 等用户确认开干信号
