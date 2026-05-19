# Funature 营销推广与运营规划指南

> 产品名：Funature  
> 中文名：风车  
> 定位：面向未来的原生 AI OS  
> 核心对象：各行各业的超级个体  
> 核心承诺：把人、工作、家与 AI 串成一个可持续运转的个人操作系统。

## 1. 一句话定位

Funature 是一个面向未来的原生 AI OS，让超级个体只需提供 Idea、Taste 和 Table，就能和 AI 共同完成从想法、资料、分析、设计到可发布作品的完整闭环。

更适合对外传播的短句：

- Funature，让每个人拥有自己的 AI 原生操作系统。
- Funature，把想法、审美、数据和 AI 串成作品。
- Funature 风车：让自然语言成为生产力，让 AI 成为平权伙伴。
- 从 Idea 到 Workend，超级个体的 AI OS。

## 2. 命名叙事

Funature = Future + Nature。

Future 代表面向未来的新生产方式。未来的工作不再由人被动操作一堆软件完成，而是由人提出方向、判断审美、提供结构化事实，再由 AI 调度工具、生成内容、执行任务、沉淀资产。

Nature 代表自然力量与原生智慧。风车不是蛮力机器，而是把不可见的风转化为持续可用的能量。Funature 的产品精神也是如此：它不把 AI 当成一个外挂按钮，而是把 AI 作为贯穿工作、生活、创作的自然力量，嵌入系统结构中，让每个个体借助这股力量持续产出。

中文名“风车”同时连接两层含义：

- 面向未来的新能源：AI 是新生产力，风车把分散的自然能量转化为稳定输出。
- 古老的自然智慧：人类不是征服自然，而是理解规律、顺势而为。Funature 不是让人学习复杂软件，而是让系统理解人的意图。

## 3. 第一性原理

Funature 的产品方向、功能优先级和运营叙事都应从三个范式判断出发。

### 3.1 AI 会把今天人们做的工作做得更好

未来的工作流不是“人操作软件”，而是“人提供判断，AI 完成作品”。

Funature 把人的输入收敛成三类核心资产：

- **Idea**：人的想法、问题、判断、研究、叙事。
- **Taste**：人的审美、风格、偏好、视觉方向。
- **Table**：人的事实、结构、对象、数据关系。

当这三者被系统化后，AI 就能生成一个完整的 **Workend**：不是中间稿，不是待办列表，而是可以展示、发布、运行、复用的最终作品。

现有项目中已经能看到这条路径：

- Table 承载结构化数据、筛选、排序、字段、记录和视图。
- Idea 承载 Markdown 文档、Block、引用、附件和 AI 写入。
- Taste/Design 承载 SVG 设计画布和视觉风格分析。
- Demo 将 Idea、Taste 和 Table 变成可运行、可发布、可访问的前端作品。
- Agent 通过 Skills、Integrations、Habits、Knowledge 把这些对象串成连续工作流。

### 3.2 超级个体门槛越来越低，协作不再是生产力前置条件

更准确的对外表达不是“人和人的协作不重要”，而是：

> 协作会从生产力的前置条件，变成作品完成之后的分发、审阅和放大机制。

过去，复杂工作必须依赖团队，因为一个人缺少足够的执行能力、专业能力和工具熟练度。Funature 站在相反假设上：当 AI 能理解目标、调用工具、管理知识、持续执行，很多过去需要多人协作的工作会先由一个超级个体闭环完成，再按需要开放给他人参与。

这意味着产品不应优先做传统多人协同，而应优先强化：

- 个体的高带宽表达：自然语言、语音、图片、文档、表格、画布。
- 个体的长期记忆：Agent 的 Nature、Memory、Knowledge。
- 个体的外部能力：GitHub、Lark、Figma、自定义 CLI、Web、Vision。
- 个体的作品出口：Demo、分析报告、可发布链接、Workend Gallery。

### 3.3 AI 与人需要平权

这里的“平权”不是法律人格，而是产品结构上的平权：

- AI 不只是输入框里的助手，而是系统中的一等行动者。
- AI 能拥有身份、记忆、技能、习惯、知识和集成能力。
- AI 能读写同一套工作资产，而不是被限制在聊天记录里。
- 人与 AI 围绕同一张 Table、同一篇 Idea、同一个 Demo 协作，而不是在人类软件和 AI 软件之间来回复制。

现有代码中已经有对应基础：

- Agent 有 Nature tab，承载 soul、profile、memory。
- Agent 有 Models、Skills、Habits、Acknowledge、Integrations、Activities。
- 后端有长期身份文件、记忆、知识库、定时任务、活动日志、模型路由、MCP 工具和第三方集成运行时。
- Chat Agent 可以通过工具读写 Table、Idea、Taste、Demo、Knowledge、Workflow、Integrations。

因此，Funature 的核心不是“AI 功能”，而是 **AI 作为 OS 原生成员**。

## 4. 项目 Review 摘要

本次 review 覆盖了根目录文档、README、品牌指南、系统设计、上线清单、功能方案、前端组件、后端路由、Prisma 数据模型、MCP 工具/技能、Agent runtime、模型注册、集成运行时和设计资源。

关键事实：

- 仓库扫描到 591 个项目文件。
- Prisma 当前定义 27 个核心数据模型，覆盖 User、Agent、Workspace、Table、Idea、Demo、Knowledge、Agency、Integration 等。
- 后端 `routes/` 下有 23 个路由文件，包含认证、表格、Idea、Taste、Demo、Chat、Agent、Analyst、Knowledge、Admin、Integration 等模块。
- MCP/Agent 侧注册 20 个内置 skill，覆盖 Table、Idea、Taste、Analyst、Demo、Vibe Design、Vibe Coding、Workflow、Knowledge、Integration 等。
- 后端路由中扫描到 236 个 route handler 声明，说明产品已从单点功能演进为完整原型系统。

已经落地的产品资产可归为五层：

1. **Artifact OS**：Table、Idea、Design/Taste、Demo、Folder、Magic Canvas。
2. **Agent OS**：Nature、Models、Skills、Habits、Knowledge、Integrations、Activities。
3. **Action Runtime**：MCP tools、skill router、model router、workflow、subagent、cron、long task、confirmation flow。
4. **AI Production Engine**：AI 筛选/排序、DuckDB Analyst、领域分析、Vibe Demo、SVG to Demo、Vision、Web Search。
5. **Growth/Operations Base**：Auth、Admin、token usage、DailySnapshot、dark mode、i18n、上线 hardening checklist。

代码/文档证据索引：

- `README.md`：Funature 对外名称、Work/Home/Muse 三板块、Work 已实现能力。
- `docs/branding.md`：Funature 命名规范和历史内部名边界。
- `docs/design.md`：Table、AI 筛选、字段配置、Undo、安全删除等基础工作台设计。
- `backend/prisma/schema.prisma`：27 个核心模型，证明产品已具备 workspace、agent、artifact、knowledge、agency 等数据底座。
- `backend/src/index.ts`：后端 API 挂载面，覆盖 Table、AI、Chat、Agent、Demo、Analyst、Knowledge、Admin、Agency 等模块。
- `backend/mcp-server/src/tools/index.ts` 与 `backend/mcp-server/src/skills/index.ts`：Agent 工具分层、skill 激活、20 个内置 skill。
- `backend/src/services/chatAgentService.ts`：Agent tool loop、skill state、模型路由、确认流、活动 source、vision subagent 等核心运行时。
- `backend/src/services/modelRegistry.ts`：多模型、多模态、并发控制和 fallback 策略。
- `docs/agent-integration-plan.md`：GitHub/Lark/Figma/Custom CLI 集成和 sandbox 安全边界。
- `docs/analyst-skill-plan.md`：DuckDB Analyst、领域分析和报告物化路径。
- `docs/vibe-demo-plan.md`：Demo artifact、发布、SDK、capability guard 和 Workend 出口。
- `frontend/src/components/AgentBlock/index.tsx`：Agent Home 的 Nature、Models、Habits、Skills、Acknowledge、Integrations、Activities 七个面板。
- `frontend/src/components/MagicCanvas/index.tsx`：多 block 工作空间桌面。
- `docs/launch-checklist-v2.md`：正式上线前需要补齐的 RDS、Redis、S3、CDN、监控、安全和配额治理。

需要对外谨慎表述的边界：

- 当前真正完整落地的是 **Funature Work**。
- Home 与 Muse 是产品路线和品牌叙事的一部分，不应在投资材料中说成已完整上线。
- 生产级 10 万 DAU 架构已有 checklist，但当前状态仍需按上线清单补齐 RDS、Redis、S3、CDN、监控、安全、限频等。
- “协作不再重要”建议改写为“协作不再是生产力前置条件”，避免投资人误解为否定组织网络价值。

## 5. 产品架构叙事

Funature Work 的核心不是一组工具，而是一个 AI 原生工作空间。

### 5.1 四类作品对象

| 对象 | 用户语言 | 系统价值 | AI 价值 |
| --- | --- | --- | --- |
| Table | 数据、对象、项目、客户、任务 | 结构化事实源 | 可筛选、排序、分析、生成字段、驱动 Demo |
| Idea | 文档、想法、研究、方案 | 语义与叙事源 | 可续写、改写、引用、沉淀分析 |
| Taste | 设计稿、风格、画布、SVG | 审美与视觉源 | 可分析风格、生成设计、转为 Demo |
| Demo | 页面、工具、报告、应用 | 可运行作品出口 | 可由 AI 编译、预览、发布、读写真数据 |

这四类对象构成 Funature Work 的最小 OS：

- Table 是现实世界的结构。
- Idea 是人的思考。
- Taste 是人的审美。
- Demo 是作品的呈现。

### 5.2 Agent 是 OS 的行动层

传统软件的行动层是按钮、菜单和快捷键。Funature 的行动层是 Agent。

Agent 不只是回答问题，而是具备：

- **Nature**：身份、第一性、长期偏好。
- **Memory**：短期工作记忆与长期经验。
- **Skills**：按场景激活的能力包。
- **Habits**：定时执行的自我驱动任务。
- **Knowledge**：可检索、可沉淀、可复用的知识库。
- **Integrations**：连接 GitHub、Lark、Figma 和自定义 CLI。
- **Activities**：可追踪、可搜索、可归因的操作日志。

这让 Funature 的 AI 不是聊天窗口，而是能持续参与世界的操作主体。

### 5.3 Magic Canvas 是 OS 的桌面

Magic Canvas 把 Table、Idea、Demo、Agent 等 block 放在同一个可组合空间里。它适合承载未来的“个人 AI 操作系统桌面”：

- 一个 Table block 负责事实。
- 一个 Idea block 负责方案。
- 一个 Agent block 负责执行。
- 一个 Demo block 负责作品预览。
- 多个 block 通过 workspace 与 SSE 共享状态。

这比传统“左侧导航 + 单页面”的 SaaS 更接近 OS：用户不再打开一个功能，而是在一个工作场中组织对象和行动。

## 6. 竞争力与护城河

### 6.1 与聊天机器人不同

ChatGPT、Claude、Gemini 强在对话和推理，但大多数结果仍停留在文本或一次性文件。Funature 的差异是：AI 直接读写系统资产，并把结果变成可复用的 Workend。

关键差异：

- 不止生成答案，而是生成 Table、Idea、Taste、Demo。
- 不止对话记忆，而是 Agent identity、knowledge、habits、activities。
- 不止插件调用，而是 MCP/CLI integration 与 artifact 权限系统。

### 6.2 与 Notion、飞书、Airtable 不同

传统工作平台以人为中心，以协作为基本假设。AI 通常是嵌入式功能。Funature 以“人 + AI 平权工作”为基本假设，协作不是起点，个体闭环才是起点。

关键差异：

- Notion/飞书/Airtable 是协作工作台，Funature 是超级个体的 AI OS。
- 它们的 AI 多为编辑器能力，Funature 的 AI 是跨对象行动者。
- 它们强调 team workspace，Funature 强调 personal operating system，再向 team/marketplace 扩展。

### 6.3 与自动化平台不同

Zapier、Make、Lindy 等平台擅长连接任务，但通常缺少原生作品对象和可视化工作空间。Funature 不只是 automation，而是 automation + artifact + creation。

关键差异：

- 自动化平台触发流程，Funature 生成作品。
- 自动化平台连接工具，Funature 自己拥有 Table、Idea、Taste、Demo 四类核心资产。
- 自动化平台偏流程编排，Funature 偏个体生产系统。

### 6.4 与代码生成平台不同

Cursor、Replit、v0 等工具擅长生成代码或界面，但 Funature 的 Demo 是一个 workspace artifact，可以受 Table、Idea、Taste 驱动，并通过 SDK 读写真数据。

关键差异：

- Funature 的 Demo 不是孤立代码，而是 Workend 出口。
- Demo 可以从 Taste/SVG 转换，也可以从 Idea 和 Table 生成。
- 发布与权限由产品系统管理，而不是把用户丢进代码仓库。

### 6.5 护城河

Funature 的护城河来自四个累积飞轮：

1. **Artifact Graph**：用户的 Table、Idea、Taste、Demo 越多，AI 的上下文越强。
2. **Agent Memory**：Agent 越了解用户的 Nature、Taste、习惯和历史产出，越能成为专属 OS。
3. **Skill/Integration Ecosystem**：每接入一个外部工具，Funature 就更接近用户真实世界。
4. **Workend Gallery**：每个可发布作品都是传播资产，也是模板资产。

## 7. 投资人材料骨架

### 7.1 开场页

标题：Funature 风车  
副标题：面向未来的原生 AI OS  
一句话：让超级个体只需提供 Idea、Taste 和 Table，就能和 AI 一起完成可发布的 Workend。

### 7.2 问题

今天的工作软件仍然假设：

- 人需要学习复杂工具。
- 工作被拆散在文档、表格、设计、代码、聊天和自动化平台中。
- AI 只是附着在某个功能上的助手。
- 一个人想完成复杂作品，必须找更多人协作。

结果是：想法到作品之间仍然有巨大的执行鸿沟。

### 7.3 时代判断

未来 5 年，生产力会发生三次迁移：

- 从“会用软件的人”迁移到“能清楚表达想法和品味的人”。
- 从“团队协同优先”迁移到“超级个体闭环优先”。
- 从“AI 工具”迁移到“AI 原生 OS”。

### 7.4 解决方案

Funature 把人的输入抽象为 Idea、Taste、Table，把 AI 抽象为具备身份、记忆、技能、习惯和外部连接的行动者，最终输出可运行、可发布、可复用的 Workend。

### 7.5 产品展示页

建议按“从一句话到作品”展示：

1. 用户输入一个目标：例如“帮我做一个客户增长分析，并生成一个可分享的 dashboard”。
2. Agent 读取 Table，调用 Analyst 做聚合、趋势、分群。
3. Agent 写入 Idea，形成结论和结构化报告。
4. Agent 根据 Taste 生成视觉方向。
5. Agent 生成 Demo，并通过 SDK 读写真数据。
6. 用户发布 `/share/:slug`，形成 Workend。

### 7.6 为什么现在

- 大模型已经具备长上下文、工具调用、视觉理解、代码生成和结构化输出能力。
- 个人创作者、独立开发者、咨询顾问、小团队和企业内部超级个体正在增长。
- 传统协作软件的边际创新放缓，AI 原生 OS 仍处在早期窗口。
- MCP/CLI/外部工具生态正在让 Agent 从“聊天”进入“行动”。

### 7.7 商业模式

建议采用分层模型：

- **Free**：个人基础 workspace，限制 token、Demo 发布数、集成数。
- **Pro**：更高 token、更多模型、更多 Workend、自动化习惯、公开发布。
- **Team**：共享 workspace、审计、权限、模板、团队知识库。
- **Enterprise**：私有部署、SSO、合规、专属模型通道、内部 CLI/MCP 集成。
- **Marketplace**：模板、Skill、Integration、Workend 交易与分发。

### 7.8 核心指标

投资人应看到 Funature 不是普通 SaaS，而是一个能积累用户生产资产的系统。

建议指标：

- Activation：新用户 24 小时内创建 Table/Idea/Taste/Demo 的比例。
- First Workend：新用户首次生成并保存或发布 Workend 的时间。
- AI Action Rate：每个活跃用户每日由 Agent 执行的工具调用次数。
- Artifact Density：每个 workspace 平均 artifact 数。
- Reuse Rate：旧 Table/Idea/Taste 被新 Demo 或新分析引用的比例。
- Habit Retention：开启 Habits 的用户 7/30 日留存。
- Integration Depth：每个 Agent 平均启用第三方集成数。
- Publish Rate：Demo/报告/Workend 发布率。

## 8. 用户画像与场景

### 8.1 超级产品经理

输入：需求、竞品、用户反馈、数据表。  
输出：PRD、路线图、数据分析、交互 Demo、提案页面。

Funature 价值：

- 把需求整理成 Idea。
- 把用户反馈沉淀成 Table。
- 把竞品截图/SVG 转为 Taste。
- 把方案生成 Demo。

### 8.2 独立开发者 / Indie Hacker

输入：产品想法、用户列表、功能 backlog、设计参考。  
输出：MVP、落地页、运营 dashboard、用户研究报告。

Funature 价值：

- 一个人从想法到可运行原型。
- Demo 可以连接真实表格数据。
- Agent 可通过 GitHub/CLI 接入开发工作流。

### 8.3 咨询顾问 / 分析师

输入：客户数据、行业资料、访谈记录、财务/运营表。  
输出：分析报告、图表、洞察、交付型网页。

Funature 价值：

- DuckDB Analyst 提供确定性计算。
- 互联网、财务、金融领域 skill 降低专业分析门槛。
- 分析结果可写入 Idea 并生成可分享 Demo。

### 8.4 运营团队

输入：活动、用户分层、内容计划、转化数据。  
输出：活动页、运营报表、增长策略、自动化提醒。

Funature 价值：

- Table 管理活动和用户。
- AI 生成筛选、排序和分析。
- Demo 生成报名页/看板。
- Habits 定期复盘数据。

### 8.5 创作者 / 教育者

输入：课程大纲、资料、图片、案例、表格。  
输出：互动课件、学习报告、公开页面、知识库。

Funature 价值：

- Idea 管理知识。
- Taste 管理视觉风格。
- Demo 生成可交互展示。
- Knowledge 让 Agent 记住创作者的长期知识体系。

## 9. 官网与营销文案

### 9.1 首屏

H1：

Funature 风车

副标题：

面向未来的原生 AI OS。把 Idea、Taste、Table 交给 AI，生成属于超级个体的 Workend。

CTA：

- 开始创建我的 Workend
- 查看 Funature Work 演示

辅助说明：

Funature 把文档、表格、画布、可运行 Demo、Agent 记忆、技能、习惯和外部集成放进同一个工作空间。你负责想法、审美和判断，AI 负责执行、连接和生成。

### 9.2 功能区块

**Idea：把想法变成可执行上下文**  
Markdown、Block、引用、附件、AI 写入与实时同步，让每个想法成为 Agent 能理解和延展的资产。

**Taste：把审美变成系统输入**  
SVG 画布、视觉风格分析、设计稿转 Demo，让“我想要这种感觉”不再停留在口头描述。

**Table：把现实变成结构化事实**  
多维表格、字段、视图、筛选、排序、AI 问数和领域分析，让 AI 基于真实对象行动。

**Demo：把过程变成作品**  
AI 生成可运行前端应用，通过 Funature Demo SDK 读写真数据，并发布成可分享链接。

**Agent：不是助手，是 OS 成员**  
Nature、Memory、Skills、Habits、Knowledge、Integrations、Activities，让 AI 具备长期身份和行动能力。

### 9.3 社媒短文案

版本 A：

未来的工作不该是人在 20 个软件之间复制粘贴。  
Funature 正在做一个 AI 原生 OS：人提供 Idea、Taste、Table，AI 生成 Workend。  
一个人，也能完成过去一个团队才能完成的作品。

版本 B：

风车把风变成能量。  
Funature 把自然语言、审美和数据变成作品。  
这是给超级个体的 AI OS。

版本 C：

我们不想再做一个 AI 插件。  
我们想让 AI 成为操作系统里的平权成员：有身份、有记忆、有技能、有习惯、有工具、有作品。

## 10. 运营规划指南

运营目标不是单纯拉注册，而是让用户尽快完成第一个 Workend。Funature 的增长核心应围绕“作品生成”和“作品传播”设计。

### 10.1 北极星指标

建议北极星指标：

> 每周成功生成或发布的 Workend 数。

Workend 可以是：

- 一份 AI 生成并保存的分析报告。
- 一个连接真实 Table 的 Demo。
- 一个基于 Idea/Taste 的可分享页面。
- 一个由 Agent 定时生成的工作总结。

### 10.2 用户激活路径

新用户首次体验不应从空白聊天开始，而应进入一个“生成作品”的任务流：

1. 选择身份：产品经理、分析师、运营、创作者、独立开发者。
2. 输入目标：例如“做一个客户分析 dashboard”。
3. 导入或创建 Table。
4. 写入或生成一篇 Idea。
5. 选择或上传 Taste。
6. 让 Agent 生成 Demo 或报告。
7. 保存为 Workend。
8. 引导分享或发布。

激活目标：

- 10 分钟内创建第一个 artifact。
- 30 分钟内完成第一个 AI action。
- 60 分钟内保存或发布第一个 Workend。

### 10.3 运营节奏

**第 0 阶段：定位重塑**

- 统一对外品牌：Funature / 风车。
- 官网、README、产品内文案统一“AI 原生 OS”“Idea/Taste/Table/Workend”。
- 将早期 AI Filter 叙事降级为“起点故事”和“Table 能力”，不作为主品牌。

**第 1 阶段：设计伙伴**

目标用户：

- 独立产品人
- 创业者
- 咨询顾问
- 数据分析师
- 运营负责人
- 设计/开发复合型创作者

动作：

- 招募 20-50 个 design partners。
- 每人完成一个真实 Workend。
- 每个案例沉淀为 Case Study。
- 重点收集“过去需要几个人/几天，现在一个人多久完成”的对比。

**第 2 阶段：Workend Challenge**

活动主题：

- 24 小时，一个人，一个 AI，一个 Workend。
- 把一个想法变成一个可运行作品。
- 用 Funature 做一份能发布的分析报告。

运营机制：

- 每周一个主题。
- 用户提交公开 Demo/报告。
- 官方精选展示。
- 形成 Workend Gallery。

**第 3 阶段：模板化增长**

把高频场景做成模板：

- 客户增长分析 OS
- 产品需求管理 OS
- 创作者内容工作台
- 投资研究工作台
- 课程制作工作台
- 独立开发者 MVP 工作台

每个模板包含：

- 示例 Table
- 示例 Idea
- 示例 Taste
- 示例 Demo
- 推荐 Agent Skill
- 推荐 Integration

**第 4 阶段：生态与 Marketplace**

当 Workend 和 Skill 数量足够后，开放：

- Skill Marketplace
- Integration Marketplace
- Workend Template Gallery
- Industry Pack
- Creator Showcase

让增长从“官方运营”转向“用户作品传播”。

## 11. 内容运营矩阵

| 渠道 | 内容形式 | 目标 |
| --- | --- | --- |
| 官网 | 产品定位、案例、模板、投资叙事 | 承接流量与转化 |
| X/Twitter | build in public、短视频、before/after | 获取 early adopters |
| 小红书/即刻/公众号 | 超级个体故事、工作流拆解 | 建立中文市场认知 |
| B 站/YouTube | 从想法到 Workend 的完整演示 | 降低理解成本 |
| GitHub | 开源/技术透明度、开发日志 | 获取开发者信任 |
| Product Hunt | 国际启动发布 | 获取海外首批用户 |
| 社群 | Workend Challenge、模板共创 | 促活与留存 |

建议内容栏目：

- **一个人的公司**：展示超级个体如何完成团队级作品。
- **Workend 拆解**：拆解一个作品背后的 Idea、Taste、Table。
- **Agent 的一天**：展示 Habits、Integrations、Knowledge 的持续执行。
- **从截图到 Demo**：展示 Taste/SVG 转 Demo。
- **AI 问数实战**：展示 Analyst 对真实数据的分析。
- **Funature Build Log**：持续更新产品进展。

## 12. 30/60/90 天运营计划

### 0-30 天：定位与种子用户

目标：

- 统一品牌叙事。
- 做出 5 个高质量 demo case。
- 招募第一批 20-50 个 design partners。

动作：

- 更新官网首屏和 README。
- 制作 3 分钟产品演示视频。
- 产出 5 个模板 workspace。
- 建立用户访谈表与反馈收集表。
- 每周发布 2 篇 build log。

重点指标：

- 访客到注册转化。
- 注册到首个 artifact 转化。
- 首个 Workend 完成率。
- 用户访谈完成数。

### 31-60 天：场景打穿

目标：

- 打穿 2-3 个高价值场景。
- 形成可复用模板。
- 建立 Workend Gallery。

动作：

- 发起 Workend Challenge。
- 每周选择一个场景做直播/视频。
- 把优秀用户作品包装为案例。
- 完成 Pro 付费意愿调研。
- 对接 GitHub/Lark/Figma 典型场景。

重点指标：

- 每周 Workend 数。
- 模板使用率。
- Demo 发布率。
- 7 日留存。
- 集成启用率。

### 61-90 天：商业化验证

目标：

- 验证 Pro/Team 付费。
- 拿出投资人可读的增长与留存数据。
- 明确下一阶段产品路线。

动作：

- 上线 Pro waitlist 或早鸟计划。
- 给设计伙伴提供付费试点。
- 梳理 10 个深度案例。
- 推出模板包和行业包。
- 输出投资人 deck 与数据室材料。

重点指标：

- Pro waitlist conversion。
- 付费访谈中的愿付价格。
- 30 日留存。
- 人均 AI action。
- 人均 artifact 数。
- 人均 Workend 数。

## 13. 投资人沟通重点

投资人最需要理解的是：Funature 不是“又一个 AI 应用”，而是一个 AI 原生操作系统雏形。

建议强调：

- **宏观趋势**：AI 降低复杂工作的执行门槛，超级个体会爆发。
- **产品范式**：从 AI assistant 到 AI OS。
- **现有基础**：代码中已经存在 artifact、agent、tool、integration、demo publish、analyst、knowledge 等 OS 级模块。
- **差异化 wedge**：Work 板块先从真实生产力场景切入，再扩展 Home/Muse。
- **增长飞轮**：Workend 发布和模板复用天然带传播。
- **技术护城河**：MCP/CLI 运行时、Agent 长期身份、artifact graph、Demo SDK、DuckDB Analyst。

不建议在早期过度强调：

- 纯多人协作。
- 大而全的企业 OA。
- “替代所有软件”的绝对表达。
- Home/Muse 已经完成。

## 14. 产品路线建议

### 14.1 近期：把 Work 打穿

优先级：

1. Onboarding：首个 Workend 流程。
2. Demo 生成体验：更稳定的 build、预览、发布、案例。
3. Analyst 场景：把“问数 → 报告 → Demo”做成拳头链路。
4. Integration：GitHub/Lark/Figma 的高频闭环。
5. Workend Gallery：发布、展示、复制模板。

### 14.2 中期：强化 Agent 平权

优先级：

1. Agent Nature 的可解释编辑与可迁移。
2. Habits 的可视化编排。
3. Knowledge 的自动学习与主题管理。
4. Activities 的审计与复盘。
5. Skill Creator 的用户自定义能力。

### 14.3 长期：扩展 Home 与 Muse

Home 方向：

- 家庭日程、消费、健康、家务、旅行、教育、家庭知识库。
- 重点不是“智能家居控制”，而是家庭生活的 AI 原生上下文。

Muse 方向：

- 创意写作、视觉探索、音乐/视频生成、作品集、灵感库。
- 重点不是单点生成，而是从灵感到作品发布的创意 OS。

最终三板块：

- Work：生产力与商业作品。
- Home：生活与家庭系统。
- Muse：创意与表达系统。

## 15. 风险与应对

| 风险 | 表现 | 应对 |
| --- | --- | --- |
| 定位过大 | 投资人觉得“AI OS”太泛 | 用 Work 板块和 Workend 案例证明落地路径 |
| 功能过多 | 用户不知道从哪开始 | onboarding 聚焦“生成第一个 Workend” |
| Home/Muse 未完成 | 叙事和现实脱节 | 明确 Work 已实现，Home/Muse 是路线图 |
| “协作不重要”引发误解 | 被理解为反团队 | 改为“协作不再是生产力前置条件” |
| AI 平权表述敏感 | 被理解为法律/伦理争议 | 定义为产品结构中的一等行动者 |
| 生产级扩展不足 | 大规模上线风险 | 严格执行 launch checklist：RDS、Redis、S3、CDN、Sentry、限频、安全 |
| Demo 发布安全 | 可被滥用做钓鱼/外泄 | 强化 capability guard、CSP、发布确认、内容审计 |

## 16. 可直接使用的 Pitch

### 16.1 30 秒版本

Funature 风车是面向未来的原生 AI OS。我们相信未来超级个体只需要提供 Idea、Taste 和 Table，就能和 AI 一起完成过去需要一个团队才能完成的作品。Funature Work 已经把多维表格、文档、设计画布、可运行 Demo、Agent 记忆、技能、习惯和第三方集成放进同一个工作空间，让 AI 不再只是聊天助手，而是系统里的平权行动者。

### 16.2 2 分钟版本

今天的 AI 产品大多仍是聊天框，工作软件大多仍是人操作工具。Funature 的判断是：未来的工作流会变成“人提供想法、审美和结构化事实，AI 调用工具并完成作品”。所以我们把产品抽象成 Idea、Taste、Table 和 Demo 四类作品对象，再让 Agent 拥有 Nature、Memory、Skills、Habits、Knowledge 和 Integrations。用户不是在不同软件之间复制粘贴，而是在一个 AI 原生 OS 中让 AI 直接读写工作资产。第一阶段我们聚焦 Funature Work，服务产品经理、独立开发者、分析师、运营和创作者，帮助他们从一个想法生成可发布的 Workend。

## 17. 内部执行原则

1. 所有功能优先服务“首个 Workend”。
2. 所有 AI 能力必须能读写真实 artifact，避免只停留在聊天答案。
3. 所有品牌表达围绕 Future + Nature / 风车 / 超级个体 / AI OS。
4. 所有用户案例都要量化“过去需要多少人多久，现在一个人多久完成”。
5. 所有路线图都要明确：Work 已落地，Home/Muse 是未来扩展。
