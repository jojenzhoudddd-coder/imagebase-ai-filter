# Chat Sidebar (Table Agent) — 实现方案

## Context

当前 AI 能力散落在三个独立的单次调用（AI 筛选、字段推荐、AI 建表），每个功能入口独立。用户希望通过**对话式交互**让 AI 代理完成所有数据表操作：新建/修改表、字段、记录、视图。

这不是简单地"再加一个 AI 功能"，而是把现有 API 能力**统一包装成模型可调用的工具**，由一个长程 Agent 在多轮对话中调度。关键变化：

1. **入口**：顶部工具栏新增四芒星按钮 → 打开右侧 Chat Sidebar（350px 宽）
2. **模型**：Seed 2.0 pro，启用深度 thinking，温度 0.1，流式输出
3. **工具层**：独立 MCP Server，通过 MCP 协议暴露 ~20 个工具（table/field/record/view CRUD）
4. **交互**：Figma 定义了 5 个状态（思考中 → 执行工具 → 二次确认 → 生成完成 → 错误）
5. **二次确认**：只对 delete 类操作弹出"确认"卡片
6. **持久化**：后端新增 conversations/messages 存储（内存 Map，后续可换 SQL）

**Figma 设计稿**：https://www.figma.com/design/mjPaINvCaKljXrqqnPQ63g/Table-Agent?node-id=6661-432600

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                       Frontend (React)                       │
│  ┌─────────────────┐   SSE    ┌──────────────────────────┐  │
│  │ ChatSidebar.tsx │ ◀──────▶ │ POST /api/chat/messages  │  │
│  │  - messages[]   │          │  (server-sent events)    │  │
│  │  - input        │          └──────────────────────────┘  │
│  │  - tool cards   │                      │                  │
│  │  - confirm card │                      ▼                  │
│  └─────────────────┘           ┌──────────────────────────┐  │
│                                 │   ChatAgentService       │  │
│                                 │  (Seed 2.0 pro, 0.1)    │  │
│                                 │  Multi-turn loop         │  │
│                                 └───────────┬──────────────┘  │
│                                             │ MCP Client (stdio)│
│                                             ▼                  │
│                                 ┌──────────────────────────┐  │
│                                 │   ai-filter-mcp-server   │  │
│                                 │   (independent process)  │  │
│                                 │   - 20+ table tools      │  │
│                                 │   - calls dataStore       │  │
│                                 └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**MCP Server 部署方式**：与 Express backend 同进程启动，通过 stdio 挂载为子进程（避免网络跨域、权限问题）。ChatAgentService 通过 `@modelcontextprotocol/sdk` 的 stdio transport 连接。

## Phase 1: MCP Server (独立进程)

### 1.1 新建 `backend/mcp-server/` 目录

```
backend/mcp-server/
  package.json                 # 独立依赖 @modelcontextprotocol/sdk
  src/
    index.ts                   # MCP Server 入口（stdio transport）
    tools/
      tableTools.ts            # table.create / rename / delete / list
      fieldTools.ts            # field.create / update / delete / batch
      recordTools.ts           # record.create / update / delete / query
      viewTools.ts             # view.create / update / delete / filter
    dataStoreClient.ts         # 通过 HTTP 调用主 backend API (轻量代理)
```

### 1.2 MCP 工具清单（20 个，完整 CRUD）

| 工具名 | 参数 | 说明 | Danger |
|-------|------|------|--------|
| `list_tables` | `documentId` | 列出所有数据表 | - |
| `get_table` | `tableId` | 获取表详情 + 字段 + 视图列表 | - |
| `create_table` | `name, documentId, language` | 创建空白表 | - |
| `rename_table` | `tableId, name` | 重命名 | - |
| `delete_table` | `tableId, documentId` | 删除表 | ⚠️ |
| `reset_table` | `tableId, fields[]` | 替换表结构 | ⚠️ |
| `list_fields` | `tableId` | 列出字段 | - |
| `create_field` | `tableId, name, type, config?` | 添加字段 | - |
| `update_field` | `tableId, fieldId, name?, type?, config?` | 修改字段 | - |
| `delete_field` | `tableId, fieldId` | 删除字段 | ⚠️ |
| `batch_delete_fields` | `tableId, fieldIds[]` | 批量删除字段 | ⚠️ |
| `query_records` | `tableId, filter?, sort?, limit?` | 查询记录 | - |
| `create_record` | `tableId, cells[]` | 新增记录 | - |
| `batch_create_records` | `tableId, records[]` | 批量新增 | - |
| `update_record` | `tableId, recordId, cells[]` | 修改记录 | - |
| `delete_record` | `tableId, recordId` | 删除记录 | ⚠️ |
| `batch_delete_records` | `tableId, recordIds[]` | 批量删除记录 | ⚠️ |
| `list_views` | `tableId` | 列出视图 | - |
| `create_view` | `tableId, name, fieldOrder?, hiddenFields?` | 新建视图 | - |
| `update_view` | `viewId, updates` | 修改视图（含筛选） | - |
| `delete_view` | `tableId, viewId` | 删除视图 | ⚠️ |

**关键设计**：
- 每个工具返回 **简洁 JSON**（模型友好），不暴露内部实现细节
- `Danger` 标记的工具在返回值中带 `requires_confirmation: true` 字段，Agent 层识别后改为发送 confirmation 事件而不是直接执行
- 工具内部调用 Express API（`http://localhost:3001/api/...`），保持与现有 eventBus 机制打通，前端其他客户端自动同步

### 1.3 MCP 工具与 REST API 的同步机制（自适配）

**核心约束**：MCP 工具是 REST API 的镜像，任何 API 参数/路径/返回值变更都必须同步到 MCP 工具，否则 Agent 会用错误的 schema 调用导致失败。

**单一数据源策略**：

1. **共享 Zod schema**：
   - 在 `backend/src/schemas/` 新建各资源的 Zod schema（`tableSchema.ts`, `fieldSchema.ts`, `recordSchema.ts`, `viewSchema.ts`）
   - REST 路由的 request validation 和 MCP 工具的 `inputSchema` 都 import 同一份 Zod schema
   - 参数变更时只需改一处，两边自动同步

2. **MCP 工具实现走 HTTP 调用主 backend**：
   - `mcp-server/src/dataStoreClient.ts` 封装 `fetch("http://localhost:3001/api/...")`
   - MCP 工具函数体就是 schema 映射 + HTTP 代理，不包含任何业务逻辑
   - 即使 backend 路由内部重构（只要 URL 和 body 不变），MCP 工具零改动

3. **命名镜像约定**（便于人工校验）：
   | REST 路由文件 | MCP 工具文件 | 映射 |
   |---|---|---|
   | `backend/src/routes/tableRoutes.ts` | `backend/mcp-server/src/tools/tableTools.ts` | 每个 `router.post/put/delete` = 一个工具 |
   | `backend/src/routes/fieldRoutes.ts` | `backend/mcp-server/src/tools/fieldTools.ts` | 同上 |
   | `backend/src/routes/recordRoutes.ts` | `backend/mcp-server/src/tools/recordTools.ts` | 同上 |
   | `backend/src/routes/viewRoutes.ts` | `backend/mcp-server/src/tools/viewTools.ts` | 同上 |

4. **开发时强约束（写入 CLAUDE.md）**：
   - 修改任何 `routes/*.ts` 必须同步检查同名 `mcp-server/tools/*.ts`
   - 新增 endpoint 要同步新增 MCP 工具
   - 删除 endpoint 要同步删除 MCP 工具
   - CI 可加一个简单脚本对比路由数量与工具数量，不一致则告警

5. **运行时校验**：
   - MCP server 启动时调一次主 backend 的 `GET /api/_schemas` (新增) 获取所有路由的 schema，和本地工具定义对比，不一致则启动失败
   - 这样即使忘了同步，也会在启动阶段立刻发现

### 1.4 进程管理

在 `backend/src/index.ts` 启动时 spawn MCP server 子进程：

```typescript
import { spawn } from "child_process";

if (process.env.NODE_ENV !== "test") {
  const mcpServer = spawn("npx", ["tsx", "mcp-server/src/index.ts"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  chatAgentService.attachMcpTransport(mcpServer);
}
```

## Phase 2: Chat Agent Service

### 2.1 新建 `backend/src/services/chatAgentService.ts`

参照 `aiService.ts` 的多轮 tool loop 模式，但使用：

- **Model**: `Seed2.0-pro` (需在 Volcano ARK 开通，endpoint 通过新增的 `SEED_MODEL` 环境变量配置)
- **Temperature**: 0.1
- **Thinking**: `{ type: "enabled", budget_tokens: 4096 }`
- **Stream**: true（**端到端流式**：Volcano 流式返回 → Agent 逐 chunk forward → 前端 SSE → UI token-by-token 渲染）
- **MAX_TOOL_ROUNDS**: 10（比 aiService 的 3 更多，因为 Agent 需要连续执行多步）

### 2.1.1 端到端流式链路（关键实现）

模型产生的每个 token 必须立即转发给前端，不做整段 buffer：

```
Volcano ARK SSE ──chunk──> Agent parser ──chunk──> Express res ──SSE chunk──> fetch reader ──setState──> React render
    (50~200ms/chunk)        (零等待转发)           (flush 关闭 buffer)          (逐 chunk 累加)        (逐 chunk 显示)
```

**关键实现点**：
1. `chatAgentService.ts` 用 `async function*` generator，每拿到一个 ARK delta chunk 立刻 `yield`
2. route handler 用 `res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)` + 不设 `Content-Length`
3. Express `setHeader("X-Accel-Buffering", "no")` + Nginx `proxy_buffering off`（已在 deployment.md 配好）
4. thinking 和 message 两个 event 分别独立流式：thinking 内容渲染成 "深度思考中..." 下的灰色小字流，message 内容渲染成主气泡
5. tool_start / tool_result 是**离散事件**（不流式），中间穿插
6. 前端 `ChatMessages.tsx` 为每个 message 维护一个 mutable draft buffer，每个 chunk `setMessages(prev => prev + chunk)` — 不等整段完才渲染

### 2.2 系统提示词结构

参照 `.claude/skills/ai-prompt-patterns.md` 的 6 个模式：

```
# 角色
你是飞书多维表格的智能助手 "Table Agent"，通过调用工具帮用户完成数据表操作。

# 核心规则
1. 用户用自然语言描述需求（如"创建 CRM 系统"），你拆解成多步骤，逐步调用工具完成。
2. 每次调用工具前，用自然语言简短说明正在做什么（"我来创建线索表"）。
3. 调用删除类工具前，必须先用自然语言征得用户同意，不能直接调用。
4. 工具调用失败时，说明原因并询问用户如何处理。
5. 完成后用 1-2 句总结。

# 工具使用策略
- 需要了解现状时先调 list_tables / list_fields / query_records
- 批量操作优先使用 batch_ 系列（减少轮次）
- 创建复杂表时：先 create_table（拿 tableId）→ batch create fields → batch create records

# 输出约束
自然语言段落 + 工具调用交错输出。不要用 Markdown 代码块。
```

### 2.3 核心 loop 伪代码

```typescript
async function* streamChat(conversationId, userMessage) {
  const history = await conversationStore.getMessages(conversationId);
  const messages = [systemPrompt, ...history, userMessage];
  let rounds = 0;

  while (rounds < 10) {
    const stream = await callSeed2ProStreaming(messages, mcpTools);
    
    for await (const event of stream) {
      if (event.type === "thinking") {
        yield { event: "thinking", data: event.text };
      }
      if (event.type === "text") {
        yield { event: "message", data: event.text };
      }
      if (event.type === "tool_call") {
        const tool = event.name;
        if (isDangerousTool(tool)) {
          yield { event: "confirm", data: { tool, args: event.args, message: "..." } };
          return;
        }
        yield { event: "tool_start", data: { tool, args: event.args } };
        const result = await mcpClient.callTool(tool, event.args);
        yield { event: "tool_result", data: { tool, result } };
        messages.push({ role: "assistant", tool_call: {...} });
        messages.push({ role: "tool", result });
      }
    }
    
    if (!hasToolCall) break;
    rounds++;
  }
  
  yield { event: "done", data: {} };
  await conversationStore.save(conversationId, finalMessages);
}
```

## Phase 3: Conversation Persistence & 上下文管理

### 设计原则

**对话以 document 为维度永久储存**：
- 一个 document（如 `doc_default`）对应**多条对话**（Conversation），用户可随时切换/新建
- 每条对话内部有**完整的消息历史**（Message[]），包括用户输入、AI 回复、思考、工具调用
- 关闭页面、换设备、刷新都不丢失（后端存储）

**上下文管理分三层**：
1. **System Context**（每次请求重新生成）：当前 document 的表结构快照（表名 + 字段列表 + 视图列表），帮助模型感知"现在有哪些表"
2. **Conversation Memory**（持久化）：完整历史消息，但发送给模型时做窗口裁剪 + 摘要压缩
3. **Turn Context**（单次请求内）：本次用户输入 + 工具调用中间结果

### 3.1 新建 `backend/src/services/conversationStore.ts`

内存 Map 结构（沿用项目 mockData 风格）：

```typescript
interface Conversation {
  id: string;                 // conv_uuid
  documentId: string;         // 所属文档，唯一键 (documentId, createdAt) 排序
  title: string;              // AI 根据首轮消息总结（调用 summarize 模型生成）
  summary?: string;           // 长对话的压缩摘要（超过 50 轮后生成）
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

interface Message {
  id: string;                 // msg_uuid
  conversationId: string;
  role: "user" | "assistant" | "tool";
  content: string;            // 纯文本
  thinking?: string;          // 深度思考文本（单独存，不喂给下一轮）
  toolCalls?: ToolCall[];     // assistant 消息可带工具调用
  toolResult?: any;           // tool 消息的结果
  timestamp: number;
}

interface ToolCall {
  callId: string;             // 用于前端确认回传匹配
  tool: string;
  args: Record<string, any>;
  confirmed?: boolean;        // 危险操作的确认状态
}

// 核心接口
class ConversationStore {
  listByDocument(documentId: string): Conversation[];
  create(documentId: string): Conversation;
  get(conversationId: string): Conversation | null;
  delete(conversationId: string): void;
  appendMessage(conversationId: string, msg: Omit<Message, "id"|"timestamp">): Message;
  getMessages(conversationId: string, limit?: number): Message[];
  updateSummary(conversationId: string, summary: string): void;
}
```

### 3.2 上下文组装策略（`buildContext()` 在 chatAgentService 中）

每次调用模型前，上下文由以下部分拼接：

```
[System Prompt] (静态角色定义 + 工具使用策略)
  +
[Document Snapshot] (动态) — 当前 document 的表/字段/视图 schema (JSON 格式)
  例: "当前文档包含 3 张表：
        - 项目管理 (tbl_001): 字段 [名称: Text, 负责人: User, 截止: DateTime, 状态: SingleSelect]
        - 客户管理 (tbl_002): ..."
  +
[Conversation Summary] (如果有) — 此前对话的压缩摘要
  +
[Recent Messages] (滑动窗口) — 最近 20 轮 user+assistant 消息
  +
[Current User Message]
```

**Document Snapshot 生成规则**：
- 调 `listTables → fields → views`，生成 ~500 tokens 的简洁 JSON
- 每次请求现算（因为表结构会被 agent 自己改）

**滑动窗口裁剪规则**：
```
如果 messageCount <= 20: 喂全部
如果 20 < messageCount <= 50: 喂 summary + 最近 20 条
如果 messageCount > 50: 触发异步压缩（提取关键事实到 summary），然后再喂 summary + 最近 20 条
```

**压缩方法**：异步调用 `generateSummary(olderMessages)`，把前 30 条压缩成 3-5 句"用户做过什么、表/字段变更历史"。压缩任务在对话空闲时 fire-and-forget。

### 3.3 API 路由 `backend/src/routes/chatRoutes.ts`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/chat/conversations?documentId=xxx` | 列出该文档的对话列表（按 updatedAt desc）|
| `POST` | `/api/chat/conversations` | 新建空对话（body: `{documentId}`，返回 conversationId）|
| `GET` | `/api/chat/conversations/:id/messages` | 获取对话完整消息列表（打开面板时拉取）|
| `DELETE` | `/api/chat/conversations/:id` | 删除对话 |
| `POST` | `/api/chat/conversations/:id/messages` | **SSE** — 发送用户消息，流式返回 agent 响应 |
| `POST` | `/api/chat/conversations/:id/confirm` | **SSE** — 用户确认/取消某个危险操作，继续流 |
| `POST` | `/api/chat/conversations/:id/stop` | 中止当前 streaming（设置 AbortController）|

### 3.4 SSE 事件 schema（参照 `.claude/skills/api-conventions.md`）

```
event: start       data: { messageId }
event: thinking    data: { text: "..." }
event: message     data: { text: "..." }
event: tool_start  data: { tool, args, callId }
event: tool_result data: { callId, result }
event: confirm     data: { callId, tool, args, prompt }
event: error       data: { code, message }
event: done        data: { messageId }
```

## Phase 4: Frontend — Chat Sidebar 组件

### 4.1 新建 `frontend/src/components/ChatSidebar/`

```
ChatSidebar/
  index.tsx                 # 主组件（350px 右侧固定）
  ChatHeader.tsx            # 顶部栏（标题 + 新对话/历史/关闭按钮）
  ChatMessages.tsx          # 消息列表
  ChatMessage/
    UserBubble.tsx         # 蓝色气泡 (bg #D1E3FF, radius 10)
    AssistantText.tsx      # 纯文本 (text #1F2329)
    ThinkingIndicator.tsx  # "深度思考中..." + 动画
    ToolCallCard.tsx       # 灰底卡片（工具图标 + 标签 + 目标 tag）
    ConfirmCard.tsx        # 确认卡片（带蓝色"确认"按钮 + "取消"按钮）
    ErrorCard.tsx
  ChatInput.tsx             # 输入框（Enter 发送，Shift+Enter 换行）
  ChatSidebar.css
```

### 4.2 状态管理（`App.tsx`）

```typescript
const [chatOpen, setChatOpen] = useState(false);
const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
const [conversations, setConversations] = useState<Conversation[]>([]);
```

### 4.3 顶部栏入口按钮

修改顶部区域新增按钮，图标复用 Sidebar `aiCreate` 的 gradient star SVG：

```tsx
<button className="topbar-btn ai-agent-btn" onClick={() => setChatOpen(!chatOpen)}>
  <FourPointStarIcon size={16} />
</button>
```

### 4.3.1 流式渲染实现细节

**消息数据结构**：
```typescript
type ChatMessage =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; 
      content: string;      // 累积的自然语言文本（边流边更新）
      thinking?: string;    // 累积的思考文本（边流边更新）
      toolCalls: ToolCall[]; // 穿插的工具调用（离散事件）
      streaming: boolean;   // 是否还在流式中（控制光标闪烁）
    }
```

**逐 chunk 更新模式**：
```typescript
// onMessage 回调：每收到一个文本 chunk
streamChatMessage({
  onMessage: (chunk) => {
    setMessages(prev => prev.map(m => 
      m.id === currentMsgId ? { ...m, content: m.content + chunk } : m
    ));
  },
  onThinking: (chunk) => {
    setMessages(prev => prev.map(m =>
      m.id === currentMsgId ? { ...m, thinking: (m.thinking || "") + chunk } : m
    ));
  },
  onToolStart: (call) => {
    setMessages(prev => prev.map(m =>
      m.id === currentMsgId ? { ...m, toolCalls: [...m.toolCalls, {...call, status: "running"}] } : m
    ));
  },
  onToolResult: (callId, result) => { /* 更新对应 toolCall 状态 */ },
  onDone: () => {
    setMessages(prev => prev.map(m =>
      m.id === currentMsgId ? { ...m, streaming: false } : m
    ));
  }
});
```

**性能优化**：
- 每 16ms (1 frame) 最多 flush 一次 state — 用 `requestAnimationFrame` 批量合并 chunk
- 长消息超过 1000 字后，只 diff 最后一段，避免整段重渲染（React 自动处理，但要保证 key 稳定）

### 4.4 SSE 客户端

新增 `frontend/src/api.ts` 中 `streamChatMessage()`，参照 `api.ts:321-371` 的 `generateFilter()` 流式解析模式：

```typescript
export function streamChatMessage(opts: {
  conversationId: string;
  message: string;
  onStart?: (messageId: string) => void;
  onThinking?: (text: string) => void;
  onMessage?: (text: string) => void;
  onToolStart?: (toolCall: ToolCall) => void;
  onToolResult?: (callId: string, result: any) => void;
  onConfirm?: (callId: string, prompt: string) => void;
  onError?: (code: string, msg: string) => void;
  onDone?: () => void;
  signal?: AbortSignal;
}): () => void;
```

### 4.5 删除操作确认流程

```
1. 用户："删除所有客户表"
2. Agent 调用 delete_table(customerTableId) → MCP 返回 requires_confirmation:true
3. Backend 发出 event: confirm, 挂起流
4. 前端显示 ConfirmCard：
   ┌──────────────────────────────────┐
   │ 即将删除数据表「客户管理」        │
   │ 此操作不可撤销                    │
   │        [取消]  [确认删除]         │
   └──────────────────────────────────┘
5. 用户点"确认删除" → POST /api/chat/conversations/:id/confirm { callId, confirmed: true }
6. Backend 恢复流，执行 delete_table，继续 agent loop
```

## Phase 5: i18n & 设计 Token

### 5.1 i18n 新增键

```
"chat.title": "Table Agent"
"chat.placeholder": "输入你的问题" / "Ask anything about your tables"
"chat.send" / "chat.stop" / "chat.newConversation" / "chat.history"
"chat.empty.title" / "chat.empty.subtitle"
"chat.thinking" / "chat.generating"
"chat.confirm.title" / "chat.confirm.ok" / "chat.confirm.cancel"
"chat.tool.create_table" / "chat.tool.create_field" / ...
```

### 5.2 设计 Token（来自 Figma）

```css
/* 新增到 docs/design-resources.md */
--chat-sidebar-width: 350px;
--chat-bubble-user-bg: #D1E3FF;
--chat-tool-card-bg: #F8F9FA;
--chat-tool-card-border: #DEE0E3;
--chat-text-title: #1F2329;
--chat-text-caption: #646A73;
--chat-primary: #1456F0;
--chat-shadow-ai: 0 12px 20px rgba(31,35,41,0.04), 0 8px 14px rgba(31,35,41,0.02);
```

## 文件变更清单

### 新建
| 文件 | 说明 |
|------|------|
| `backend/mcp-server/package.json` | MCP server 独立依赖 |
| `backend/mcp-server/src/index.ts` | MCP server 入口 (stdio transport) |
| `backend/mcp-server/src/tools/tableTools.ts` | 6 个 table 工具 |
| `backend/mcp-server/src/tools/fieldTools.ts` | 5 个 field 工具 |
| `backend/mcp-server/src/tools/recordTools.ts` | 5 个 record 工具 |
| `backend/mcp-server/src/tools/viewTools.ts` | 4 个 view 工具 |
| `backend/mcp-server/src/dataStoreClient.ts` | HTTP client 调用主 backend |
| `backend/src/services/chatAgentService.ts` | Agent loop + Seed 2.0 pro + MCP client |
| `backend/src/services/conversationStore.ts` | 对话/消息内存存储 |
| `backend/src/routes/chatRoutes.ts` | /api/chat/* 端点 |
| `frontend/src/components/ChatSidebar/index.tsx` | 主组件 |
| `frontend/src/components/ChatSidebar/ChatHeader.tsx` | |
| `frontend/src/components/ChatSidebar/ChatMessages.tsx` | |
| `frontend/src/components/ChatSidebar/ChatInput.tsx` | |
| `frontend/src/components/ChatSidebar/ChatMessage/UserBubble.tsx` | |
| `frontend/src/components/ChatSidebar/ChatMessage/AssistantText.tsx` | |
| `frontend/src/components/ChatSidebar/ChatMessage/ThinkingIndicator.tsx` | |
| `frontend/src/components/ChatSidebar/ChatMessage/ToolCallCard.tsx` | |
| `frontend/src/components/ChatSidebar/ChatMessage/ConfirmCard.tsx` | |
| `frontend/src/components/ChatSidebar/ChatSidebar.css` | 样式 |

### 修改
| 文件 | 改动 |
|------|------|
| `backend/src/index.ts` | 启动时 spawn MCP server 子进程 + 注册 chatRoutes |
| `backend/.env.example` | 新增 `SEED_API_KEY`, `SEED_MODEL` |
| `backend/package.json` | 新增 `@modelcontextprotocol/sdk` |
| `frontend/src/App.tsx` | 新增 chat 状态 + 右侧 Sidebar 容器 + 四芒星按钮 |
| `frontend/src/api.ts` | 新增 `streamChatMessage()` + 对话 CRUD 函数 |
| `frontend/src/i18n/zh.ts` / `en.ts` | 新增 `chat.*` 键 |
| `backend/src/types.ts` | 新增 `Conversation`, `Message`, `ToolCall` 类型 |
| `CLAUDE.md` | 更新架构说明 + 新增 MCP server 子进程信息 |
| `.claude/skills/api-conventions.md` | 新增 /api/chat/* 端点规范 |
| `.claude/skills/ai-prompt-patterns.md` | 新增 Seed 2.0 pro + thinking 配置说明 |

### 文档
| 文件 | 改动 |
|------|------|
| `docs/design.md` | 新增 "Chat Sidebar" 章节 |
| `docs/test-plan.md` | 新增 P0/P1 用例 |
| `docs/design-resources.md` | 新增 chat 相关色彩 token |
| `docs/changelog.md` | 记录本次发布 |

## 实现顺序

```
Week 1: Phase 1 (MCP Server)
  Day 1-2: mcp-server 脚手架 + 6 个 table/view tools
  Day 3-4: field/record tools + MCP inspector 手动测试

Week 2: Phase 2+3 (Agent Service + API)
  Day 1-2: conversationStore + chatRoutes (REST 部分)
  Day 3-5: chatAgentService + SSE 流 + MCP client 接入 + danger 确认流程

Week 3: Phase 4+5 (Frontend + i18n)
  Day 1-2: ChatSidebar 框架 + ChatInput + 基础消息渲染
  Day 3-4: ToolCallCard + ConfirmCard + ThinkingIndicator
  Day 5: 四芒星入口 + 动画 + i18n + 收尾

Week 4: 测试 + 文档 + 部署
```

总计 ~4 周（单人全栈）。

## 关键技术决策 & 权衡

### 为什么用独立 MCP Server 而不是内部 function tools？

- **+** 符合 MCP 协议标准，未来可被 Claude Code、Cursor、其他 MCP 客户端复用
- **+** 工具定义与 Agent 解耦，换模型（Claude → Seed → GPT）无需改工具
- **+** 符合用户明确选择
- **−** 多一个子进程，启动复杂度 +20%
- **−** stdio 序列化开销（实际 < 5ms/调用，可忽略）

### 为什么 MCP tools 内部走 HTTP 而不是直接读 dataStore？

- **+** 触发现有 `eventBus.emitChange()`，前端其他客户端自动 SSE 同步
- **+** 统一鉴权、日志、限流逻辑
- **−** 多一层 HTTP 开销（同机 localhost，< 2ms）
- 结论：正确性 > 微小性能

### 为什么 MAX_TOOL_ROUNDS=10？

- aiService 的 3 轮不够：创建 CRM 系统 = 3 table + 15 field + 15 record = 30+ 工具调用
- 10 轮 × 批量 API = 最多处理 ~60 次操作
- 硬上限防止死循环

### 为什么不持久化到数据库？

- 项目当前整体在内存存储（mockData.ts），对话记录保持一致风格
- 内存 Map 足够支撑演示场景
- 未来引入 PostgreSQL/SQLite 时一并迁移

## 验证方案

### P0 用例（必须通过）

1. **基础对话**：输入"你好" → 返回问候，不调用工具
2. **简单查询**：输入"列出所有数据表" → 调用 list_tables → 展示表名列表
3. **单步创建**：输入"创建一个项目管理表" → 调用 create_table → 新表出现在 Sidebar
4. **多步建表**：输入"帮我创建 CRM 系统，包含线索、客户、商机 3 张表，每张 5-8 个字段"
   - 触发 3 × create_table + 15-24 × create_field
   - 前端逐步显示 ToolCallCard
   - 最终 Sidebar 出现 3 张新表
5. **危险操作确认**：输入"删除客户管理表" → 弹 ConfirmCard → 点"确认"后删除
6. **确认取消**：上一步点"取消" → 操作不执行，流恢复
7. **中止生成**：连续操作中点"停止" → 流立即结束，已完成的操作保留
8. **记录操作**：输入"给产品表添加 10 条示例数据" → batch_create_records → 10 条新记录
9. **视图操作**：输入"为任务表创建一个只看我负责的视图" → create_view + update_view/filter
10. **对话历史**：切换到其他对话 → 消息正确渲染
11. **语言切换**：切换英文 → 系统提示词 + 前端文案切换，Agent 用英文回复
12. **错误恢复**：Seed API 超时 → ErrorCard 提示，支持重试

### P1 用例

13. 思考动画平滑过渡，不出现闪烁
14. 流式文字逐字出现（非整段 blob）
15. ToolCallCard 的工具图标与字段类型图标系统一致
16. 长对话（50+ 消息）滚动性能 OK
17. SSE 断线重连（刷新 conversation 重新拉取历史）
18. 多端同步：A 用户通过 Agent 创建表，B 用户的页面通过 eventBus 自动显示新表

### 手动测试命令

```bash
# 启动
npm run dev

# 测试 MCP server 独立运行
cd backend/mcp-server && npx tsx src/index.ts
# 另一个 terminal 用 MCP inspector 连接测试

# 观察 SSE 流
curl -N -X POST http://localhost:3001/api/chat/conversations/conv_xxx/messages \
  -H "Content-Type: application/json" \
  -d '{"message":"创建一张项目管理表"}'
```

## 风险 & 预案

| 风险 | 概率 | 预案 |
|------|------|------|
| Seed 2.0 pro API 不稳定/配额不足 | 中 | 保留切换到 Doubao/GPT 的配置项 |
| MCP stdio 协议调试困难 | 中 | 先写 mock client 跑通 agent loop，再接入真 MCP |
| Agent 无限循环卡死 | 低 | MAX_TOOL_ROUNDS=10 硬上限 + 前端 stop 按钮 |
| 批量操作太快触发 eventBus 风暴 | 低 | batch_ 系列工具内部合并为单个 event |
| 对话历史内存泄漏 | 中 | 每对话消息数上限 200，超出截断 |
