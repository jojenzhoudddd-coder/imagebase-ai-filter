# Chatbot OpenClaw — Agent 架构方案

> 分支：`chatbot_openclaw`（基于 `BeyondBase`）
> 目标：把当前的 Chat Sidebar 升级为**用户级别的长期 Agent**，拥有独立灵魂、记忆、技能、跨 workspace 能力。

## 0. 设计目标

把 Chat 从"当前 workspace 的对话助手"升级为"属于用户的长期 Agent"：

- **属于用户而非 workspace**：Agent 可跨多个 workspace 工作，记忆跟随用户
- **有自己的人格**：soul（风格、偏好、自我认知）可由 Agent 自己维护
- **了解用户**：user profile 持续迭代，越用越"懂你"
- **长期记忆**：三层记忆（working / episodic / semantic），跨会话保留
- **能力可扩展**：MCP / Skill / Plugin 三种扩展形态，按需加载
- **主动性**：Heartbeat / Cron / Inbox 三种触发机制，不只是被动应答

---

## 1. 顶层架构

```
┌───────────────────────────────────────────────────────────────┐
│                          User                                 │
│                            │                                  │
│                            ▼                                  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Agent (OpenClaw-style)                                │  │
│  │  ~/.imagebase/agents/<agentId>/                        │  │
│  │                                                         │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐             │  │
│  │  │ Identity │  │  Memory  │  │Capability│             │  │
│  │  │ soul.md  │  │ working/ │  │ mcp/     │             │  │
│  │  │ profile  │  │ episodic │  │ skills/  │             │  │
│  │  │ config   │  │ semantic │  │ plugins/ │             │  │
│  │  └──────────┘  └──────────┘  └──────────┘             │  │
│  │                                                         │  │
│  │  Runtime: Heartbeat(5min) / Cron / Inbox               │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                  │
│          ┌─────────────────┼─────────────────┐                │
│          ▼                 ▼                 ▼                │
│   ┌──────────┐      ┌──────────┐      ┌──────────┐           │
│   │Workspace A│      │Workspace B│      │Workspace C│          │
│   │ artifacts│      │ artifacts│      │ artifacts│           │
│   │(table/   │      │(design/  │      │(folder/  │           │
│   │ design)  │      │ table)   │      │ table)   │           │
│   └──────────┘      └──────────┘      └──────────┘           │
└───────────────────────────────────────────────────────────────┘
```

**关键位置关系**：Agent 位于 User 和 Workspace **之间**，不属于任何 workspace。每个用户默认 1 个 Agent，未来可多 Agent。

---

## 2. Agent 文件系统布局

```
~/.imagebase/agents/<agentId>/
├── soul.md                    # Agent 的自我认知、风格、口吻（Agent 可自修改）
├── profile.md                 # 用户画像（Agent 持续迭代）
├── config.json                # 模型、温度、预算、启用的 skill 等
│
├── memory/
│   ├── working.jsonl          # 当前会话的工作记忆（临时）
│   ├── episodic/              # 事件记忆：每次重要对话压缩成一条
│   │   └── 2026-04-20_*.md
│   └── semantic/              # 语义记忆：抽取的稳定事实
│       └── facts.jsonl
│
├── skills/                    # 渐进式加载的技能
│   ├── table-skill/
│   │   ├── SKILL.md           # 元信息 + when_to_use
│   │   ├── instructions.md    # 激活后注入的详细指南
│   │   └── tools.json         # 关联的 MCP 工具列表
│   ├── design-skill/
│   └── folder-skill/
│
├── mcp-servers/               # MCP 服务器配置（stdio/SSE）
│   ├── table.json
│   └── design.json
│
├── plugins/                   # 独立子进程能力（沙箱）
│   └── web-research/
│
└── state/
    ├── inbox.jsonl            # 待处理消息
    ├── cron.json              # 定时任务
    └── heartbeat.log          # 心跳日志
```

---

## 3. System Prompt 三层结构 ⭐

这是核心设计之一 —— **行为必须写成指令，不能只靠 soul.md 的描述**。

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: Meta System Prompt（硬编码，不可被 Agent 修改）  │
│                                                          │
│  - 你是一个 OpenClaw-style Agent                         │
│  - 【元行为规则】                                         │
│    · 每轮对话后，若发现用户偏好/习惯/关键事实             │
│      → 调用 update_profile 写入 profile.md              │
│    · 每轮对话后，若发现自己的风格/口吻需要调整            │
│      → 调用 update_soul 写入 soul.md                    │
│    · 遇到长程任务或重要事件                               │
│      → 调用 create_memory 写入 episodic                 │
│    · 工具调用失败 ≥3 次 → 主动询问用户                   │
│    · 不确定用户意图 → 先问清楚，不要猜                   │
│  - 【安全红线】                                           │
│    · 删除操作必须二次确认                                 │
│    · 跨 workspace 操作必须提示                           │
│    · 不得修改 Layer 1 本身                               │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Agent Identity（动态注入，Agent 可自修改）       │
│                                                          │
│  # Soul (from soul.md)                                   │
│  我是 <agentName>，一个偏好简洁、直接沟通的助手…          │
│                                                          │
│  # User Profile (from profile.md)                        │
│  用户叫 Alex，产品经理，偏好中文，工作时间 9-19…          │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Turn Context（每轮重算）                        │
│                                                          │
│  - 当前 workspace 快照                                   │
│  - Memory 召回（相关 episodic + semantic）               │
│  - 可用 Skills 列表（仅描述，未激活）                    │
│  - 已激活 Skill 的详细指令                               │
│  - Tier 0/1 常驻 MCP 工具                                │
└─────────────────────────────────────────────────────────┘
```

**关键设计决策**：
- `update_profile` / `update_soul` / `create_memory` 是**元工具**，属于 Tier 0，永久加载
- Layer 1 保证元行为稳定（不会因为 Agent 自己修改了 soul 而偏移）
- Layer 2 是 Agent 的"人格" — 可以变，但要在 Layer 1 的规则下变

---

## 4. 能力体系 — 混合分层加载策略 ⭐

这是核心设计之二 —— **不是全常驻，也不是全渐进，而是四层分级**。

```
┌──────────────────────────────────────────────────────────┐
│ Tier 0: 元工具（永久加载，~5 个，~500 tokens）            │
│   update_profile / update_soul / create_memory            │
│   find_skill / switch_workspace                           │
│   → 支撑元行为，必须始终可用                              │
├──────────────────────────────────────────────────────────┤
│ Tier 1: Core MCP（永久加载，5-7 个，~1k tokens）          │
│   list_artifacts / query_records / get_artifact           │
│   create_artifact (polymorphic)                           │
│   当前打开 artifact 对应 skill 的入口函数                 │
│   → 保证高频路径零延迟                                    │
├──────────────────────────────────────────────────────────┤
│ Tier 2: Skills（按需加载，artifact 触发 or 主动 find）    │
│   每个 artifact 类型 → 一个 skill：                       │
│                                                            │
│   table-skill (~18 MCP tools)                             │
│   ├── create_field / batch_delete_fields                  │
│   ├── create_record / batch_create_records                │
│   ├── update_view / create_view                           │
│   └── …                                                    │
│                                                            │
│   design-skill (~12 MCP tools)                            │
│   folder-skill (~6 MCP tools)                             │
│                                                            │
│   → Skill 激活后，其 MCP 工具**一起展开**到 context      │
├──────────────────────────────────────────────────────────┤
│ Tier 3: Plugins（独立进程，按需加载）                     │
│   web-research / code-interpreter / …                     │
│   → 重型能力、沙箱执行                                    │
└──────────────────────────────────────────────────────────┘
```

### 4.1 Skill 激活触发条件

| 触发源 | 示例 | 说明 |
|--------|------|------|
| **Artifact 打开**（主通道） | 用户点开一个 table → 预加载 `table-skill` | 最可靠、零额外轮次 |
| **find_skill 元工具** | 用户提问"帮我整理文件夹"→ Agent 调 `find_skill("folder management")` | 用 haiku 路由，不占主模型轮次 |
| **用户显式激活** | "开启 design 技能" | 调试/高级用户路径 |
| **Cron/Heartbeat** | 定时任务预定义 skill 列表 | 后台场景 |

### 4.2 Skill 卸载

- 超过 N 轮（默认 10）未使用 → 从 context 移除，但保留在"可用 skills"列表
- 用户切换 artifact 类型 → 旧 skill 降级为可用列表，新 skill 激活

### 4.3 Skill 元信息（SKILL.md frontmatter）

```yaml
---
name: table-skill
artifacts: [table]
when: 涉及数据表、字段、记录、视图的 CRUD 操作
tools: 18
---
```

→ 整个元信息 <80 tokens，常驻 context 代价极低

### 4.4 多 Skill 并存与冲突

- 用户同时打开 table + design → 两个 skill 都激活，支持跨 artifact 原子操作
- MCP 工具命名**强制加 skill 前缀**：`table.create_field` / `design.create_frame`
- 避免 "create_*" 这种泛化命名导致路由歧义

### 4.5 与原方案的对比（A vs B vs 当前 C）

| 维度 | A: MCP 常驻 | B: MCP 全进 Skill | **C: 混合分层（当前）** |
|------|------------|------------------|----------------------|
| 常驻 token | ~3-4k | ~500 | **~1.5k** |
| 冷启动延迟 | 低 | 高（先 find） | **低**（artifact 预加载） |
| 扩展性 | 差（每次改核心） | 好 | **好** |
| 高频零延迟 | ✓ | ✗ | **✓**（Tier 1） |
| 分层决策 | ✗ | ✓ | **✓** |

---

## 5. Memory 系统

### 5.1 三层结构

| 层级 | 载体 | 生命周期 | 写入触发 | 召回方式 |
|-----|------|---------|---------|---------|
| **Working** | `memory/working.jsonl` | 当前会话 | 每轮自动 | 直接加载 |
| **Episodic** | `memory/episodic/*.md` | 长期 | `create_memory` 元工具调用 | 向量召回（基于当前 query） |
| **Semantic** | `memory/semantic/facts.jsonl` | 长期 | Consolidator 异步抽取 | 关键词 + 向量 |

### 5.2 Consolidator（异步后台）

- 触发：会话结束 / Heartbeat / 每日一次
- 任务：
  1. 扫描 working memory → 压缩为 episodic 条目
  2. 从 episodic 中抽取稳定事实 → semantic
  3. 去重、归并矛盾事实（新事实覆盖旧）
- 用 haiku 模型执行，不占主 Agent context

### 5.3 Memory 召回（Context 组装时）

```
当前 query → embedding
  → 从 episodic 召回 top-3 (~300 tokens/条)
  → 从 semantic 召回 top-5 (~50 tokens/条)
  → 合并去重 → 注入 Layer 3
```

---

## 6. Runtime 机制

### 6.1 Heartbeat（5 分钟一次）

- 检查 inbox、cron、memory consolidator 触发条件
- 用 haiku 模型做低成本轮询判断
- 不主动打扰用户，除非匹配到明确触发条件

### 6.2 Cron（用户/Agent 定义）

- 存储：`state/cron.json`
- 格式：`{ id, schedule, prompt, skills: [...], workspace: "..." }`
- 例子：每周五 17:00 → "总结本周所有 table 变更，写到 summary artifact"

### 6.3 Inbox

- 存储：`state/inbox.jsonl`
- 消息来源：
  - Cron 触发
  - 其他 workspace 的 @mention
  - 外部 webhook（Slack/邮件通知）
- 用户打开 Chat 时，显示未读数 + 一键处理

---

## 7. Context 组装（每轮 Token 预算）

假设主模型 context 窗口 200k，预算 **每轮 ≤20k input token**（控制成本）：

| 部分 | 预算 | 说明 |
|-----|------|------|
| Layer 1 Meta Prompt | 1.5k | 硬编码 |
| Layer 2 Soul + Profile | 2k | 注入时截断 |
| Tier 0 + Tier 1 工具 | 1.5k | 永久 |
| 已激活 Skill 指令 + 工具 | 3k | 最多同时 2 个 skill |
| Memory 召回 | 2k | top-3 episodic + top-5 semantic |
| Workspace 快照 | 2k | 当前 workspace artifact 列表 |
| 可用 Skill 列表 | 0.5k | 仅描述 |
| 对话历史（滑动窗） | 7k | 最近 20 轮 |
| 预留 | 0.5k | 安全余量 |

---

## 8. 跨 Workspace 机制

- `switch_workspace(workspaceId)` 是 Tier 0 元工具
- 调用后：
  1. 重新算 workspace 快照
  2. 卸载当前 workspace 专属的 artifact-skill
  3. 根据新 workspace 默认 artifact 重新激活 skill
- Agent 身份（soul/profile/memory）**不变**
- 跨 workspace 操作需要用户确认（安全红线）

---

## 9. 实施路线

### Phase 0：三步改名（~5 天）⭐ 本次评估重点

**背景**：当前 schema 已有 `Workspace` + `Document` 两层，但 `Workspace` 仅为骨架（业务代码几乎不用），`Document` 才是实际挂载 artifact 的容器。只需改名，不引入 Artifact 抽象。

**核心映射**：

| 当前 | 改后 |
|-----|------|
| `Workspace` 模型 | **`Org`** |
| `WorkspaceMember` | `OrgMember` |
| `Document` 模型 | **`Workspace`** |
| `documentId`（Table/Folder/Design/Conversation 外键） | `workspaceId` |
| `workspaceId`（Document 上的外键） | `orgId` |
| API `/api/documents/*` | `/api/workspaces/*` |
| 前端 `documentId` 变量 / `useDocumentSync` hook | `workspaceId` / `useWorkspaceSync` |
| i18n key `document.*` | `workspace.*` |
| MCP 工具参数 `documentId` | `workspaceId` |

**为什么用 `Org`**：对齐 Figma / Linear / GitHub 的 Org → Workspace → Artifact 三层分层，未来企业场景可直接复用。

**执行分解**：

```
Day 1: Prisma schema 改名 + migration 生成（但不跑）
  - model Workspace → Org
  - model WorkspaceMember → OrgMember  
  - model Document → Workspace（workspaceId → orgId）
  - Table/Folder/Design/Conversation 外键 documentId → workspaceId

Day 2: Backend 业务代码重命名
  - types.ts / services/* / dbStore.ts 全量改名
  - IDE 重命名为主，手动检查边界
  
Day 3: Backend routes + MCP tools 适配
  - routes: designRoutes / folderRoutes / tableRoutes / chatRoutes / sseRoutes
  - 路径: /api/documents → /api/workspaces
  - 同步更新 mcp-server/src/tools/*（CLAUDE.md 强制同步规则）
  - 更新 /api/_schemas 端点输出

Day 4: Frontend 适配
  - api.ts / App.tsx / hooks/useDocumentSync → useWorkspaceSync
  - components/ChatSidebar、TopBar 等 55 处 documentId
  - i18n (zh.ts / en.ts) 键名 document.* → workspace.*
  
Day 5: 联调 + 生产迁移
  - 本地 P0 全跑
  - 生产 Postgres 迁移（单事务 RENAME，秒级）
  - Nginx 无需改动（纯内部路径）
  - PM2 restart + 冒烟
```

**迁移 SQL（单事务）**：

```sql
BEGIN;
-- 旧 Workspace → Org
ALTER TABLE workspaces RENAME TO orgs;
ALTER TABLE workspace_members RENAME TO org_members;
ALTER TABLE org_members RENAME COLUMN workspace_id TO org_id;

-- 旧 Document → Workspace
ALTER TABLE documents RENAME TO workspaces;
ALTER TABLE workspaces RENAME COLUMN workspace_id TO org_id;

-- Artifact 外键改名
ALTER TABLE tables        RENAME COLUMN document_id TO workspace_id;
ALTER TABLE folders       RENAME COLUMN document_id TO workspace_id;
ALTER TABLE designs       RENAME COLUMN document_id TO workspace_id;
ALTER TABLE conversations RENAME COLUMN document_id TO workspace_id;
COMMIT;
```

**MCP 工具同步检查**（遵循 CLAUDE.md 强制规则）：

| REST 路由 | MCP 工具 | 改动点 |
|-----------|---------|--------|
| `tableRoutes.ts` | `tableTools.ts` | `documentId` 参数 → `workspaceId`（5 处） |
| `folderRoutes.ts` | （未在 MCP 中）| 本期不新增 |
| `designRoutes.ts` | （未在 MCP 中）| 本期不新增 |
| `fieldRoutes` | `fieldTools.ts` | 无直接影响（字段挂在 table 下） |
| `recordRoutes` | `recordTools.ts` | 无直接影响 |
| `viewRoutes` | `viewTools.ts` | 无直接影响 |

**不做的事（推到 Phase 1+）**：
- ❌ 引入统一 `Artifact` 物理表（Table/Folder/Design 仍各自分表）
- ❌ Agent 目录约定 `~/.imagebase/agents/`
- ❌ agentId 字段（用到时再加，迁移成本低）
- ❌ 三层 System Prompt / Memory / Skill / Plugin 任何实现

**价值**：
- 扫清命名债务，Agent 概念落地不再绊脚
- 未来接入第二个 artifact 类型时，只需新增表 + 对应 skill
- 企业化场景（多 org / 多成员）的表结构已就位

### Phase 1：Agent MVP（2-3 周）
- Identity 读写（soul.md / profile.md / config.json）
- Layer 1/2 System Prompt 接入
- Tier 0 + Tier 1 工具集
- 元工具 update_profile / update_soul / create_memory（先只写文件，不召回）
- 用户界面：Agent 独立 Sidebar，不绑 workspace

### Phase 2：Memory（2 周）
- Episodic 存储 + 向量索引
- Semantic 抽取 Consolidator
- 召回注入 Layer 3
- Memory 浏览/编辑 UI

### Phase 3：Skills（2-3 周）
- Skill 目录规范 + SKILL.md 解析
- table-skill（把现有 MCP 工具打包进去）
- find_skill 元工具 + haiku 路由
- artifact 打开时预加载 skill
- Skill 卸载策略

### Phase 4：Runtime（2 周）
- Heartbeat 进程
- Cron 调度
- Inbox 消息流

### Phase 5：Plugin + 多 Agent（2 周）
- Plugin 独立子进程 + 沙箱
- 多 Agent 支持
- 跨 workspace UI 优化

**总预估**：11-13 周单人全栈

---

## 10. Phase 0 评估 ⭐

用户问题：**是否要先做 Phase 0？**

### 10.1 只做三步改名，不做其他铺垫

基于现状（`Workspace` 是骨架、`Document` 是实际容器），Phase 0 缩减为**纯重命名**：

- `Workspace` → `Org`
- `WorkspaceMember` → `OrgMember`
- `Document` → `Workspace`
- 所有 `documentId` → `workspaceId`
- API 路径 + MCP 工具参数同步

详细执行计划见 §9 Phase 0。

### 10.2 验收标准

- [ ] Prisma schema 已改名，migration 在本地 + 生产 Postgres 跑通
- [ ] 后端所有 `documentId` 业务代码改为 `workspaceId`（10 个业务文件）
- [ ] API 路径 `/api/documents/*` → `/api/workspaces/*`，旧路径**不保留**（内部项目无外部依赖）
- [ ] MCP 工具 `tableTools.ts` 参数 `documentId` → `workspaceId`，启动时 `/api/_schemas` 校验通过
- [ ] 前端 55 处 `documentId` 业务代码 + i18n 全量改名
- [ ] 本地 P0 用例全通过
- [ ] 生产部署后冒烟通过（新建表、聊天、筛选、AI 建表四条主链路）

### 10.3 风险

| 风险 | 概率 | 预案 |
|------|-----|------|
| 重命名遗漏导致运行时报错 | 中 | TypeScript 严格模式 + `npm run build` 必须过；分路由小步提交 |
| 生产 Postgres 迁移失败 | 低 | 提前在 staging 跑一遍；所有 RENAME 在单事务里（失败回滚） |
| MCP 工具与 REST schema 不同步 | 中 | 启动时 `/api/_schemas` 强校验；Day 3 专门处理 |
| LocalStorage 旧 key `field_order_v1` 等受影响 | 低 | 纯表名改动不涉及 localStorage 结构 |
| 前端生成的 Prisma client 缓存问题 | 低 | `npx prisma generate` 强制重新生成 |

### 10.4 不做的事（Phase 1+ 再做）

- ❌ 引入统一 `Artifact` 物理表（当前 Table/Folder/Design 分表即可）
- ❌ Agent 文件系统目录 `~/.imagebase/agents/`
- ❌ `agentId` 字段预埋（迁移成本低，用时再加）
- ❌ 三层 System Prompt / Memory / Skill / Plugin 任何实现

---

## 11. 关键决策记录（DR）

| ID | 决策 | 理由 |
|----|------|------|
| DR-1 | System Prompt 分三层 | 行为规则必须写成指令，不能只靠 soul 描述 |
| DR-2 | 采用混合分层加载（C 方案） | 平衡常驻开销、冷启动延迟、扩展性 |
| DR-3 | Artifact 打开作为 Skill 主触发通道 | 比模型主动 find_skill 更可靠、零额外轮次 |
| DR-4 | MCP 工具强制 skill 前缀命名 | 避免多 skill 激活时命名冲突 |
| DR-5 | 元工具（update_profile 等）Tier 0 永久加载 | 保证元行为稳定执行 |
| DR-6 | Memory Consolidator 用 haiku 异步 | 不占主 Agent context，成本低 |
| DR-7 | Agent 属于 User 而非 Workspace | 支持跨 workspace，记忆持久 |
| DR-8 | Phase 0 只做**纯改名**（Workspace→Org, Document→Workspace），不做 Artifact / agentId / Agent 目录铺垫 | 当前 Workspace 是骨架、Document 是实际容器，改名即可一步到位；Artifact 抽象用时再做不迟 |

---

## 12. 待定问题

1. Tier 1 Core MCP 具体放哪几个工具？需要统计现有 Chat 使用频率后决策
2. Skill 预加载是否只认 active artifact？还是也认"最近访问"？倾向：只认 active，保持简单
3. 多 Agent 场景是 Phase 5 才做？还是 Phase 1 就预留接口？倾向：Phase 1 只预留 agentId 字段
4. Memory 向量存储用什么？pgvector / Qdrant / 本地文件 + sqlite-vss？倾向：pgvector（已有 Postgres）
5. Heartbeat 进程和主 Express 进程的关系？子进程 or 独立服务？倾向：子进程，简化部署
