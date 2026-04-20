# AI Filter 更新日志

## 格式说明
每条记录包含：日期、commit hash、改动类型（feat/fix/style/docs）、改动说明。

---

## 2026-04-20

### feat(phase1): OpenClaw-style Agent MVP（身份文件 + 三层 Prompt + 元工具 + 身份编辑 UI）

**分支**: `phase1/agent-mvp` · **commits**: `f05a2c7`, `fa348fb`, `f0e9da2`, `ddd3014`, `871339f`

分五天分别 ship，把原本"工作空间绑定、无身份、无记忆"的 Chat Agent 升级成"用户本人拥有、长期演进、可自我编辑"的 OpenClaw 风格 Agent。完整方案见 `docs/chatbot-openclaw-plan.md`。

- **Day 1 · Prisma Agent 模型**（`f05a2c7`）
  - `schema.prisma` 新增 `Agent` 表（userId/name/avatarUrl，`@@map("agents")`），User 上加 `agents Agent[]`
  - `Conversation` 加 `agentId String?` + FK（`onDelete: SetNull`）+ `@@index([agentId, updatedAt desc])`
  - 迁移 `20260420061736_add_agent_model`

- **Day 2 · agentService + /api/agents 路由**（`fa348fb`）
  - `backend/src/services/agentService.ts`（~290 行）：`agentDir()` / `ensureAgentFiles()` 初始化 `~/.imagebase/agents/<id>/`，内含 `soul.md` / `profile.md` / `config.json` / `memory/{working.jsonl,episodic,semantic}/` / `skills/` / `mcp-servers/` / `plugins/` / `state/`；`readSoul/Profile/Config` + `writeSoul/Profile/Config` 含 64 KiB 尺寸硬上限；`appendEpisodicMemory(agentId, {title, body, tags})` 写入 `YYYY-MM-DD_slug_rand.md`；`listAgents / getAgent / createAgent / updateAgent / deleteAgentRow` 只碰 DB；`ensureDefaultAgent()` 在 boot 时 seed `agent_default`（name "Claw"）
  - `AGENT_HOME` 环境变量用于测试隔离（不设则默认 `~/.imagebase/agents`）
  - `backend/src/routes/agentRoutes.ts`：GET/POST/PUT/DELETE `/api/agents` + `/api/agents/:id/identity` bundle + 三个 `/identity/{soul,profile,config}` 单体 PUT
  - `backend/src/index.ts`：boot 时 `ensureDefaults()` → `ensureDefaultAgent()`，挂载 `/api/agents`
  - 删除操作只删 DB 行，filesystem 保留（身份 + 记忆丢失不可逆，不自动删）

- **Day 3 · 三层 System Prompt + 身份注入**（`f0e9da2`）
  - `chatAgentService.ts` 拆 Prompt 为三层：
    - **Layer 1 · META**（硬编码）— Agent 自我编辑规则（何时用 `update_profile` / `update_soul` / `create_memory`）、安全红线（危险操作二次确认、跨工作空间边界、Layer 1 不可被其他层覆盖）、输出约束
    - **Layer 2 · Identity**（动态）— `buildIdentityLayer(agentId)` 现读 `soul.md` + `profile.md` 拼成 `# Layer 2 · Identity（{name} · agentId={id}）...`
    - **Tier 1 Core MCP** — 原 Table-Agent 的操作指南保留
    - **Layer 3 · Turn Context** — 当前工作空间的表/字段/视图快照（每次请求实时生成）
  - `assembleInput(conversationId, workspaceId, agentId, newUserMessage)` 按 META → identity → TOOL_GUIDANCE → Layer 3 拼接；`AgentContext.agentId` 作为可选字段落到 `conversationStore`；`/api/chat/conversations POST` 默认 fallback 到 `agent_default`
  - Smoke: 发 `"你是谁？"`，`thinking` 事件已流出 `"属于用户的长期 OpenClaw 风格的 Agent"`（字面来自 soul.md），确认 Layer 2 注入生效

- **Day 4 · Tier 0 meta-tools**（`ddd3014`）
  - `backend/mcp-server/src/tools/metaTools.ts` 注册三个 tool：
    - `update_profile` — `{content}` 整体替换 `profile.md`，64 KiB 上限
    - `update_soul` — `{content}` 整体替换 `soul.md`，同上
    - `create_memory` — `{title, body, tags?}` 在 `memory/episodic/` 追加一条带时间戳的 md
  - `ToolDefinition.handler` 扩展签名：现在接 `(args, ctx?: ToolContext)`，`ctx.agentId` 由 agent loop 注入；老的数据面工具无改动；meta-tools 用 `resolveAgentId(args.agentId ?? ctx.agentId ?? "agent_default")` fallback
  - `allTools` 把 metaTools 排到最前面（Tier 0 永远加载在函数列表顶端）
  - Smoke 脚本 `src/scripts/phase1-meta-smoke.ts`：profile/soul 往返 + 空内容拒绝 + 无 ctx 时自动落到 `agent_default`，全部通过

- **Day 5 · 前端 Agent 接线**（`871339f` + 后续修订）
  - `frontend/src/api.ts`：新增 `listAgents / getAgent / updateAgent / getAgentIdentity / putAgentSoul / putAgentProfile / putAgentConfig`；`createConversation(workspaceId, agentId?)` 增加第二参数
  - `frontend/src/components/ChatSidebar/index.tsx`：接新 `agentId?: string` prop（默认 `"agent_default"`），两处 `createConversation(workspaceId)` 调用改为 `createConversation(workspaceId, agentId)`
  - `frontend/src/App.tsx`：新增 `AGENT_ID = "agent_default"` 常量传给 `<ChatSidebar>`（单 Agent MVP，多 Agent picker 待后续）
  - **Phase 1 产品决策修订**：soul / profile 不对用户暴露为交互式 UI。ChatSidebar header 移除 IdentityIcon 按钮与 AgentIdentityModal 渲染；Modal 组件文件保留但不再被 import，作为 Phase 2+ 复用素材。用户只能通过与 Agent 对话读写身份（Agent 通过 Tier 0 元工具自编辑）。`IdentityIcon` 在 `icons.tsx` 中保留、i18n 的 `chat.agent.*` 键保留但不再被渲染层消费。

**本地 smoke 验证**:
- `curl /api/agents` → 返回 `agent_default / Claw`；`PUT /identity/profile` 写入后 filesystem 立刻可见
- `phase1-meta-smoke.ts` 跑通 profile/soul/memory 往返 + 空值拒绝 + fallback 路径
- 通过 `/api/chat/conversations` 发消息 → `thinking` 事件输出 soul.md 中的身份措辞，Layer 2 注入端到端验证
- `cd frontend && npx tsc --noEmit` 干净通过；后端 tsc 仅剩 `dbStore.ts` / `aiService.ts` 里几处预先存在的 `JsonValue` 强转告警（与 Phase 1 无关）

### feat: 支持 Add Record（工具栏 & 表格底部均可触发）

- **改动点**: `TableView`、`Toolbar`、`App.tsx`、`api.ts` 联动支持「点击 + 空白行 + 首列自动进入编辑」的典型录入流
- **详细说明**:
  1. **API**: `frontend/src/api.ts` 新增 `createRecord(tableId, cells)`，包装后端 `POST /api/tables/:tableId/records`，返回 201 + 完整 `TableRecord`（id + cells + 时间戳）。
  2. **TableView**: Props 新增可选 `onAddRecord?: () => Promise<string>` 返回新记录 id；`.add-record-btn` 的 onClick 绑定到本地 `handleAddRecordClick`，先 `await onAddRecord()` 再用返回的 id + `visibleFields[0].id` 进入 `editing` 状态并 `scrollIntoView`。`<tr>` 新增 `data-record-id` 属性用于定位滚动目标。`TableViewHandle` 补 `addRecord()` 方法通过 `addRecordClickRef` 暴露给父组件，让工具栏按钮可以复用同一逻辑。
  3. **App.tsx**: 新增 `handleAddRecord()`：调 `createRecord()` → 乐观追加到 `allRecords`（与 `handleRemoteRecordCreate` 用 id 去重，避免 SSE 回声导致重复行）→ 返回新 id。同时把 `() => tableViewRef.current?.addRecord()` 传给 `<Toolbar>`。
  4. **Toolbar**: 新增 `onAddRecord?: () => void` prop，绑定到 `.toolbar-add-record` 的 onClick。
  5. **验证**：两个入口都能在表格最底部插入空白行（行数 102 → 103 → 104），首列 `<input>` 立即 focus 进入编辑态，DOM 结构 `td.td-editing` + `activeElement.tagName === "INPUT"`。

### feat: Sidebar 新建菜单精简

- **改动点**: `Sidebar.tsx` 新增 `HIDE_CREATE_MENU_KEYS` 白名单过滤
- **详细说明**: 产品决策隐藏 6 项未完全就绪的入口（`template` / `form` / `cm_dashboard` / `cm_workflow` / `import` / `app`）。代码保留完整，仅在 `createMenuItems.filter()` 环节跳过这些 key，后续恢复只需从 Set 中移除对应 key 或清空 Set 即可。

### feat: CreateTablePopover 标题 icon 统一为 Table 紫色图标

- **改动点**: `CreateTablePopover.tsx` 新增 `TABLE_ICON` 常量（`#8D55ED` 紫色，镜像 Sidebar `CM_ICONS.table`），替换原 AI gradient 四芒星 icon
- **详细说明**: 用户从 Sidebar「+」菜单 →「数据表」进入 popover 时，标题 icon 现在与菜单项 icon 一致，形成视觉上的操作链路反馈。生成 / 创建中动画沿用原 `AI_ICON`（AI 四芒星渐变），区分状态。

### feat: Chat 工具卡片体验优化（title 间距 / 步骤标签 / 信息确认改版）

- **改动点**: `ChatSidebar/ChatMessage/{ToolCallCard,ToolCallGroup,ThinkingIndicator,ConfirmCard}.tsx` + `ChatSidebar.css` + i18n
- **详细说明**:
  1. **展开卡片 title 下 8px 间距** — `.chat-expand-card-body` 顶部 padding 从 4px 调整为 8px，思考 / 工具卡片展开后标题与正文之间不再粘连。
  2. **工具步骤状态文案** — 新增 i18n `chat.tool.step.{running,success,error,awaiting}` 与 `chat.tool.stepStart`，工具卡片展开时在每步开头明示「执行中…」「执行完成」「执行失败」「等待确认中」，减少用户对进度的猜测。
  3. **信息确认卡片增强** — 新增 `chat.confirm.skip` / `chat.confirm.start` 与 `chat.confirm.title` i18n，`ConfirmCard` 样式和按钮语义调整；文本式 二次确认保留（用户偏好，不走卡片拦截）。
  4. **ChatSidebar index**: 保留粘底滚动 + More 菜单 + 缓存逻辑不变，小幅调整以配合新组件。

### feat: 页面标题与描述改为 Table Agent

- **改动点**: `frontend/index.html` `<title>` 改为 `Table Agent · AI 智能多维表格`，并新增 `<meta name="description">`
- **详细说明**: 与产品定位升级一致（单纯 AI 筛选 → 对话式 Table Agent），浏览器 tab / 分享卡片 / 搜索引擎抓取都会展示新品牌名。

### feat: Chat 流式输出不再强制抢走用户滚动；刷新会话菜单加 icon

- **改动点**: `ChatSidebar/index.tsx` 增加 `stickToBottomRef` 粘底自动滚动 + "刷新会话" 菜单项加圆形箭头 icon
- **详细说明**:
  1. **流式输出尊重用户滚动** — 原本只要 `messages` 状态变化（每个 thinking/message/tool 事件都会触发），useEffect 就强制 `scrollTop = scrollHeight`，用户在模型吐字时想向上翻阅历史会被反复弹回底部，体验很差。改为：监听 `.chat-messages` 的 scroll 事件计算 `distanceFromBottom`，超过 24px 阈值就把 `stickToBottomRef.current` 翻为 false，auto-scroll 立刻停手；用户滚回底部附近后重新 sticky。用户点击发送或切换到新对话时强制 sticky=true，确保新一轮对话从底部开始。
  2. **刷新会话菜单加 icon** — 原 `DropdownMenu` 只显示 "刷新会话" 文字，比较单薄。给这一项加上已有的 `RefreshIcon`（16×16 圆形箭头），与其他下拉菜单视觉风格保持一致。

### fix: Chat Agent 工具调用重复执行（每次执行两次）

- **改动点**: `backend/src/services/chatAgentService.ts` 的 `callArkStream` 增加 `yieldedCallIds` Set 去重
- **详细说明**: ARK Responses API 在流结束时会通过 `response.completed` 事件一次性回传完整的 output 列表，其中包含所有已经在 `response.output_item.done` 中发出过的 `function_call` items。原代码用 `pendingCalls.values().some(e => e.callId === callId)` 来判断是否已发出，但 `output_item.done` 的 handler 会立即 `pendingCalls.delete(itemId)`，等 `response.completed` 做去重检查时 Map 早已被清空，每次都命中"未发出"分支导致同一个工具调用被 yield 两次。修复方式：引入独立的 `yieldedCallIds: Set<string>`，`output_item.done` 和 `response.completed` 两条路径都先查表再决定是否 yield，彻底杜绝重复。创建数据表、创建字段、批量写入记录等所有工具调用从"每次 2 次"恢复到"每次 1 次"。

### feat: Chat 对话持久化 + 欢迎页 & 刷新会话交互优化

- **改动点**: 对话存储迁移到 Postgres、欢迎页文案与排版调整、刷新会话入口改版
- **详细说明**:
  1. **对话持久化到 Postgres（Prisma）** — `backend/prisma/schema.prisma` 新增 `Conversation` 和 `Message` 两张表（含 `@@index([documentId, updatedAt(sort: Desc)])` 与 `@@index([conversationId, timestamp])`），迁移 `20260419160227_add_conversations_and_messages`。`backend/src/services/conversationStore.ts` 从内存 Map 重写为 Prisma 客户端：保留原公有 DTO 形状（string id、epoch ms timestamp、Message role / toolCalls JSON），通过 `toConversation()` / `toMessage()` 辅助把 Date → number ms；`appendMessage()` 用 `$transaction` 串联 message 插入 + messageCount 递增 + 自动标题。`chatRoutes.ts` 6 个 handler 改为 async + await。重启 backend / pm2 reload / tsx watch 重编后对话不再丢失。
  2. **Bug 修复：batch-create 生成唯一 id** — `backend/src/routes/tableRoutes.ts` 的 `POST /api/tables/:tableId/records/batch-create` 区分两种调用：撤销恢复（records 已含 id/createdAt/updatedAt）走原路径；Agent 批量写入（只含 cells）改为循环 `createRecord` 生成 cuid + 服务端时间戳 + 默认值 + autonumber 计数，返回 `records[]` 让 SSE 收到真实 id，避免 React key 碰撞导致列表只显示 0 条。
  3. **欢迎页文案：去掉 "new"** — 中文 `chat.empty.title` 改为 "你好，我是你的智能助手"，英文改为 "Hi, I'm your chatbot"。新增 `renderTitleWithCommaBreak()` 辅助：将标题按首个中英文逗号拆成两段，每段 `white-space: nowrap`，中间插 `<wbr>`，narrow 宽度下只能在逗号后换行，不会在词中间断开。
  4. **刷新会话改版：More menu + 二次确认** — 原刷新 icon 替换为 More（⋯）icon，点击弹出 `DropdownMenu`（仅一个"刷新会话"菜单项），选择后弹 `ConfirmDialog` 告知用户"刷新后会开始一个全新的空白会话，当前会话仍会保留在对话历史中"。欢迎页（messages 为空且非 streaming 状态）隐藏 More 按钮以避免无意义操作。新增 i18n: `chat.menu.more` / `chat.menu.refresh` / `chat.refresh.confirm.{title,message,ok,cancel}`。
  5. **欢迎页顶部间距** — `.chat-empty` margin-top 从 4px 调整为 28px，使 `.chat-empty-hero` 距离 `.chat-part` 顶部正好 80px（header 36px + chat-messages padding-top 16px + margin-top 28px = 80px）；修正 CSS 注释中关于 header 高度的错误描述。

---

## 2026-04-19

### feat: Chat Sidebar 前端缓存 + 智能提示词建议

- **改动点**: 4 项 Chat Sidebar 体验增强
- **详细说明**:
  1. **前端缓存（防刷新闪烁）** — 新增 `localStorage` key `chat_cache_v1:${documentId}`，首次挂载通过 `useState` 初始化器同步读取缓存的 `activeConvId + messages + contextHint`，无需等 `/conversations` 返回即可渲染上次对话。打开面板后后台再 revalidate，若服务端 404（例如 backend 重启）则清缓存并走常规 list/create 流程。缓存上限 100 条消息，streaming 标志在读取时被重置避免卡死动画。
  2. **工具卡片与文字间距 12px** — `MessageBlock` 现在返回 `.chat-msg-assistant-block` 包裹 div，内部 `gap:12px`（思考指示 + 文字 + 工具卡片），外层 `.chat-messages` 保持 28px 消息间距。
  3. **后台定时任务：智能提示词建议** — 新增 `backend/src/services/suggestionService.ts`，启动后 5s 跑首轮、每 10min 刷新，基于文档表/字段结构调 ARK 生成 3-5 条 `{label, prompt}`，附签名去重避免无变更时浪费 tokens，失败回落到默认包。新增 `GET /api/chat/suggestions` 及 `POST /api/chat/suggestions/refresh` 路由。前端 EmptyState 优先渲染动态建议，空/失败时回落到 i18n 预设；新增 `fetchChatSuggestions()` 客户端。
  4. **create_table 主字段指引** — `backend/mcp-server/src/tools/tableTools.ts` 的 `create_table` 工具描述强化为"⚠️ 必须用 update_field 改造默认主字段，不许重复 create_field 新增第一列"，handler 回传新字段 `primaryField { id, name, type }` 和 `note` 文本。`chatAgentService.ts` 系统提示词同步新增硬规则，明确创建复杂表的正确顺序：create_table → update_field 改主字段 → create_field 追加其余 → batch_create_records。

---

## 2026-04-17

### feat: 多表管理（新建、切换、拖动排序、删除）
- **改动点**: 同一 Document 下支持新建多个数据表，Sidebar 动态显示、切换、排序、删除
- **详细说明**:
  1. 后端增强：`dbStore.ts` 新增 `listTablesForDocument()`、`batchReorderTables()`、`generateTableName()`、`deleteTableCascade()` 函数。`createTable()` 创建 1 个默认 Text 字段 + 5 条空记录 + Grid 视图
  2. 文档级 SSE：`eventBus.ts` 新增 `DocumentChangeEvent` 通道，`sseRoutes.ts` 新增 `GET /api/sync/documents/:docId/events` 端点，支持 `table:create`、`table:delete`、`table:reorder`、`table:rename` 事件
  3. 前端 `App.tsx` 核心重构：`TABLE_ID` 常量替换为 `activeTableId` 状态 + `activeTableIdRef` ref，~30 处引用更新，新增 `switchTable()`、`handleCreateTable()`、`handleDeleteTable()` 回调
  4. 新增 `useDocumentSync.ts` Hook 监听文档级 SSE，同步 sidebar 表列表变化
  5. Sidebar 重构：动态表列表、原生 mouse 事件拖动排序（蓝线指示器）、"+新建" 下拉菜单（Figma 设计、分组显示、240px 宽度）、表项右键/more icon 删除（180px 菜单、ConfirmDialog 确认）
  6. `DropdownMenu.tsx` 扩展：`section` 分组、`suffix` 右箭头、`noop` 静默项、`width` 固定宽度、`position: "above"` 向上弹出

### feat: Sidebar 宽度可调
- **改动点**: 支持拖动 Sidebar 右侧边缘调整宽度
- **详细说明**: 拖拽 6px 热区，范围 120px–400px，宽度通过 localStorage `sidebar_width` 持久化

### fix: 新表默认列宽 280px
- **改动点**: 新建数据表的主字段（Text）默认列宽从 120px 调整为 280px
- **详细说明**: `TableView/index.tsx` 新增 `getDefaultColWidth(field)` 辅助函数，isPrimary 字段返回 280px

### fix: 删除表切换到上一个表
- **改动点**: 删除当前活跃表时自动切换到前一个表，而非第一个
- **详细说明**: `handleDeleteTable` 使用 `remaining[Math.max(0, idx - 1)]` 选择目标表

### fix: 切换表时表名闪烁
- **改动点**: 修复 sidebar 点击切换表瞬间表名短暂显示其他表名
- **详细说明**: `switchTable` 中 `setTableName` 移到 async fetch 之前同步设置

### fix: 默认表名数字前加空格
- **改动点**: 自动生成的重复表名数字序号前增加空格（「数据表 2」而非「数据表2」）
- **详细说明**: `dbStore.ts` 中 `generateTableName()` 模板改为 `${baseName} ${i}`

### fix: 新建菜单非功能项不关闭菜单
- **改动点**: 点击非功能选项（如"通过AI创建"等）不再触发菜单关闭
- **详细说明**: `MenuItem` 新增 `noop` 属性，`DropdownMenu` 中 noop 项点击跳过 `onSelect`/`onClose`

---

## 2026-04-15

### feat: 英文/中文国际化语言切换 (i18n)
- **commit**: `da3584c`
- **改动点**: 零依赖 React Context i18n 方案，支持英文/简体中文切换
- **详细说明**:
  1. 新增 `frontend/src/i18n/en.ts`、`zh.ts`、`index.ts`：LanguageProvider + useTranslation hook + t() 函数，130+ 翻译条目覆盖所有非用户数据 UI 文本
  2. 头像下拉菜单新增 Language 子菜单，悬浮展开，当前语言显示 checkmark
  3. localStorage `app_lang` 持久化，切换时 `window.location.reload()` 确保模块作用域常量（OPERATORS_BY_TYPE、DATE_VALUE_OPTIONS 等）使用新语言重新初始化
  4. 子菜单 CSS 修复：`left: calc(100% + 4px)` → `right: calc(100% + 4px)` 防止右边缘溢出

### fix: undo 后端不同步问题修复
- **commit**: `96d05aa`
- **改动点**: 修复 undo 操作前端生效但后端未同步的问题
- **详细说明**:
  1. `api.ts`：`updateRecord`/`deleteRecords`/`batchCreateRecords` 增加 `res.ok` 检查，后端 4xx/5xx 不再静默吞掉
  2. `performUndo`：所有后端调用改为 `await`，失败时回退前端状态并 toast 提示 "撤销失败，数据未能同步，请刷新页面"
  3. `executeDelete`：通过 `deletePendingRef` 追踪删除 Promise，`performUndo` 执行前先 await，防止竞态条件（undo 在删除未完成时触发导致 batchCreate 先于 batchDelete）
  4. `handleCellChange`/`executeClearCells`：后端失败时回退乐观更新 + toast 提示

### feat: 增加请求日志中间件
- **commit**: `c905156`
- **改动点**: 所有 API 请求增加结构化日志
- **详细说明**: `index.ts` 新增中间件，记录 method、path、clientId、请求体（mutation）、响应状态码、耗时、响应摘要。SSE 和 health 端点跳过详细日志

### feat: 实时数据同步（SSE）
- **commit**: `c241340`
- **改动点**: 实现多标签页和多用户实时数据同步
- **详细说明**:
  - 新增 `eventBus.ts`：Node.js EventEmitter 事件总线，按 tableId 作用域
  - 新增 `sseRoutes.ts`：SSE 端点 `GET /api/sync/:tableId/events?clientId=xxx`，30 秒心跳
  - `tableRoutes.ts`：13 个变更端点添加 `eventBus.emitChange()`
  - `api.ts`：导出 `CLIENT_ID` + `mutationFetch` 包装函数注入 `X-Client-Id` 头
  - 新增 `useTableSync.ts`：前端 SSE 订阅 Hook，防回声 + 断线重连全量同步
  - `App.tsx`：12 个远程事件处理函数，远程变更不入 undo 栈
  - Nginx 配置 SSE location block（`proxy_buffering off`）

### fix: 输入框图标顺序与 Loading 截断优化
- **commit**: `e373adb`
- **改动点**: FilterPanel AI 输入框有文本时，叉号(X)和麦克风(🎤)图标互换位置；Loading 动效省略号距输入框右边保持 12px 间距
- **详细说明**: 有文本输入后图标顺序调整为 ✕ → 🎤 → ↑，符合「先清除、再语音、最后发送」的操作优先级。LoadingDots 组件设置 `flex-shrink: 0` 防止压缩，`.fp-ai-loading-text` 增加 `padding-right: 12px`

### fix: LoadingDots 作为截断标识，移除重复省略号
- **commit**: `45a352d`
- **改动点**: Loading 状态文本过长时，移除 CSS `text-overflow: ellipsis` 静态省略号，改用 LoadingDots 动画直接作为截断符
- **详细说明**: 之前长文本截断会同时显示 CSS 静态省略号和 LoadingDots 动态省略号。修改为 `.fp-ai-loading-query` 只用 `overflow: hidden` 裁剪文字，LoadingDots 紧跟其后作为唯一截断指示器

### fix: Loading 文本过长时省略号截断
- **commit**: `13a0d0d`
- **改动点**: "Generating filter by ..." Loading 文本超长时用省略号截断
- **详细说明**: 将 Loading 文字部分包裹在 `.fp-ai-loading-query` span 中（`flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis`），LoadingDots 保持在外部作为 flex 兄弟元素

### fix: AI 筛选输入框长文本截断
- **commit**: `1a8a6f8`
- **改动点**: 输入框文本过长时单行截断显示，不换行
- **详细说明**: `.fp-ai-input` 添加 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`。`.fp-ai-loading` 和 `.fp-ai-loading-text` 添加 `min-width: 0` 支持 flex 子元素截断

---

## 2026-04-14

### fix: 清空行单元格英文文案
- **commit**: `e924ad9`
- **改动点**: 确认弹窗和 Toast 统一使用英文文案
- **详细说明**: 弹窗标题 "Clear Records"，正文 "Are you sure you want to clear all cells of N record(s)?"，确认按钮 "Clear"。Toast 显示 "Cleared N records"（区别于单元格清空的 "Cleared N cells"）。`executeClearCells` 增加可选 `toastLabel` 参数

### fix: 清空记录单元格中文文案 + 确认后复选框恢复未选中
- **commit**: `e101029`
- **改动点**: 初始中文文案实现 + 确认清空后复选框自动取消勾选
- **详细说明**: TableView 新增 `clearRowSelection()` imperative method，App.tsx 在 `handleConfirmDelete` 和 `handleClearRowCells`（无 deleteProtection 时）调用

### feat: 复选框+Delete 清空行单元格，右键删除行
- **commit**: `f880b9e`
- **改动点**: 区分两种删除行为——复选框选中行 + Delete 键清空单元格（受 Safety Delete 管控），右键删除行删除记录（受 Safety Delete 管控）
- **详细说明**: 
  - TableView 新增 `onClearRowCells` prop，键盘 handler Priority 1 改为收集选中行所有可编辑单元格并调用 `onClearRowCells`
  - App.tsx 新增 `handleClearRowCells`：deleteProtection 开启时弹确认框（type: "rowCells"），关闭时直接执行
  - ConfirmDialog 新增 `"rowCells"` 类型，独立文案
  - 拖选单元格 + Delete 仍通过 `onClearCells` 直接执行（不受 Safety Delete 管控）

### fix: 键盘 handler 使用 ref 防止闭包过期
- **commit**: `72faa89`
- **改动点**: `selectedRowIds` 和 `cellRange` 使用 ref 同步最新状态
- **详细说明**: 添加 `selectedRowIdsRef` 和 `cellRangeRef`，每次渲染同步 `current` 值。键盘事件 handler 从 ref 读取（而非闭包捕获值），消除 checkbox click 与 Delete keydown 之间的竞态条件。useEffect deps 移除 `selectedRowIds` 和 `cellRange`

### fix: 首次启动 seed mock 数据，后续启动不覆盖
- **commit**: `adec6bc`
- **改动点**: 服务器启动时检查表是否已存在，不重复 seed
- **详细说明**: `backend/src/index.ts` 中 `loadTable(mockTable)` 改为先调用 `getTable(mockTable.id)` 检查，已存在则跳过。解决每次部署/重启后用户数据被覆盖的问题

### feat: 右键单元格选区显示删除覆盖行
- **commit**: `bb4dae2`
- **改动点**: 在单元格选区范围内右键时，「删除记录」选项作用于选区覆盖的所有行
- **详细说明**: `handleRowContextMenu` 增加 `cellRange` 判断，收集选区内 `minRow ~ maxRow` 范围所有行 ID

### fix: 复选框 + Delete 键正常工作
- **commit**: `94512a6`
- **改动点**: 修复勾选复选框后 Delete 键不生效的问题
- **详细说明**: 键盘 handler 中 INPUT 标签检查改为 `target.type !== "checkbox"` 放行复选框。`handleRowCheckChange` 和 `handleHeaderCheckChange` 调用 `setCellRange(null)` 清除单元格选区

### feat: Delete 键删除选中行/清空选中单元格
- **commit**: `9017f85`
- **改动点**: Delete/Backspace 键行为——行选择态删除行（Safety Delete），单元格选择态清空单元格（无确认）
- **详细说明**: 键盘 handler 优先级：selectedRowIds > cellRange。行删除走 `onDeleteRecords`，单元格清空走 `onClearCells`

### fix: 单元格编辑和清空持久化到后端
- **commit**: `d6c7e4a`
- **改动点**: `handleCellChange` 和 `executeClearCells` 增加 `updateRecord` API 调用
- **详细说明**: 乐观更新后异步调用 `updateRecord(TABLE_ID, recordId, cells)`，解决编辑/清空后刷新数据丢失的问题

### feat: 单元格拖选、Delete 清空、双击编辑、Undo
- **commit**: `0dc091e`
- **改动点**: 完整的单元格交互体系
- **详细说明**:
  - `CellRange` 模型：mousedown 起点 → mousemove 4px 阈值拖选 → mouseup 确认
  - `<td>` 绑定 `data-row-idx` / `data-col-idx`，`elementFromPoint` 获取目标
  - 双击进编辑、单击已选中单元格再次点击进编辑（`wasAlreadySelected`）
  - `justCellDraggedRef` 防止拖选后误触编辑
  - UndoItem 新增 `"cellEdit"` 和 `"cellBatchClear"` 类型

### feat: Safety Delete 文档级持久化
- **commit**: `c0c3b04`
- **改动点**: 安全删除开关存储在 localStorage（key: `doc_delete_protection`），默认开启
- **详细说明**: TopBar 中 Toggle 控件绑定 `deleteProtection` 状态，写入时同步 localStorage

### feat: 多步撤销栈、批量字段操作、语音改进、Shift 选择
- **commit**: `eee19be` (via merge `484333b`)
- **改动点**: 完整的撤销系统 + 批量字段删除/恢复 + 语音 Grace Period + Shift+Click 行选择
- **详细说明**:
  - `undoStackRef` 栈最多 20 项，支持 records / fields / cellEdit / cellBatchClear 四种类型
  - 字段删除快照包含字段定义、单元格数据、视图配置、筛选条件
  - 语音停止后 800ms Grace Period 等待最后结果
  - Shift+Click 行选择范围

### feat: 记录删除与撤销 + 上下文菜单
- **commit**: `0fbac86`
- **改动点**: 右键行上下文菜单 + 记录删除 + Toolbar Undo 按钮
- **详细说明**: 右键菜单定位、删除确认、Toast Undo action

### feat: Toast 通知 + 精确日期选择器 + AI 筛选反馈
- **commit**: `9deaf77`
- **改动点**: Toast 组件系统、DatePicker 绝对日期、AI 筛选 loading/error 状态
- **详细说明**: `ToastProvider` + `useToast()` hook，Toast 支持 action 按钮

---

## 2026-04-13

### feat: 语音输入
- **commit**: `67b7548`, `0b079cd`
- **改动点**: AI 筛选输入支持语音输入（Web Speech API）
- **详细说明**: 麦克风按钮 + 长按空格 500ms 触发，zh-CN 识别，Grace Period 800ms

### feat: 字段配置面板
- **commit**: `e874f25`, `33af631`, `b2e1b4c`
- **改动点**: Customize Field 面板，支持拖拽排序、搜索（拼音）、隐藏/显示字段、点击定位
- **详细说明**: `FieldConfigPanel` + `pinyin-pro` 模糊搜索 + `scrollIntoView` 定位

### feat: 拼音模糊搜索 + Mock 数据扩展
- **commit**: `9995b9d`
- **改动点**: 筛选面板字段下拉支持拼音搜索，mock 数据扩展到更多字段

### feat: AI 筛选查询回显
- **commit**: `238e584`
- **改动点**: AI 生成完成后，查询文本保留在输入框中作为 placeholder

### fix: 视图设置跨重启保持
- **commit**: `f1856f2`
- **改动点**: fieldOrder、hiddenFields 持久化到后端，服务重启不丢失

### feat: Lookup 字段（Phase 0-2）
- **commit**: `4895195`, `5667e34`, `5cde1a8`
- **改动点**: Lookup 字段数据模型、计算引擎、前端配置 UI

### feat: PostgreSQL + Prisma 迁移
- **commit**: `312c043`
- **改动点**: 从内存存储迁移到 PostgreSQL + Prisma ORM
- **详细说明**: JSONB 存储 fields/views/cells，GIN 索引加速查询

### 初始提交
- **commit**: `e33c994`
- **改动点**: 项目初始化——AI Filter for Lark Base clone
- **详细说明**: Express 后端 + React 前端 + Volcano ARK API 集成，基础表格视图 + 筛选面板 + AI 筛选生成
