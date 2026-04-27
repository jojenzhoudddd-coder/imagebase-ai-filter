# Chatbot 多对话方案 (Multi-Conversation, V3.0)

> 落地范围:每个 ChatBlock 支持新建/切换/删除对话 + 同 conv 内并发 branch + 多 block 实时同步 + workflow 观测

## 1. 总览

### 使用场景

| # | 场景 | 行为 |
|---|---|---|
| 1 | New chat | 同一个 ChatBlock 内开新 conversation,继承 agent 全部身份(soul / profile / skills / tools / model picker),但 context + working memory 隔离 |
| 2 | Switch chat | 历史 conversation 列表,点击切换;每个 ChatBlock 自己保留 activeConversationId |
| 3 | Delete chat | 二次确认 → 删 conv + 删 per-conv working memory + toast → 自动建新 conv |
| 4 | Append while generating | 任何时刻可发,**用户视角统一**;后端按状态调度(idle 起 main / main inflight 起并发 branch / synth inflight 进 pendingQueue 等下一轮) |
| 5 | Multi-block sync | N 个 ChatBlock 看同一 conv,已发送/已收到内容实时同步;ChatInput 草稿不同步 |

### 核心架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (React)                        │
│                                                              │
│  ┌──── ChatBlock A ────┐    ┌──── ChatBlock B ────┐         │
│  │ activeConvId: c1    │    │ activeConvId: c1    │         │
│  │  + / list / ⋯ del  │    │  + / list / ⋯ del   │         │
│  │  ChatInput (草稿独) │    │  ChatInput (草稿独) │         │
│  │  对话流 (同步)       │←─-─│ 对话流 (同步)        │         │
│  └─────────┬───────────┘    └─────────┬───────────┘         │
│            │ POST /messages            │ /listen SSE         │
│            ▼                           ▼                     │
└────────────┼───────────────────────────┼─────────────────────┘
             │                           │
             ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Backend (Express + Prisma)                  │
│                                                              │
│  chatRoutes.POST /messages    chatRoutes.GET /listen         │
│        │                            │                        │
│        ▼                            ▼                        │
│   handleIncomingMessage     subscribeChat(convId, cb)        │
│        │                            │                        │
│        └──┬─────────────────────────┘                        │
│           ▼                                                  │
│   ┌──────────────────────┐                                   │
│   │  TurnRegistry        │ Map<convId, InflightTurn>         │
│   │  - mainBranch        │                                   │
│   │  - appendedBranches  │                                   │
│   │  - synthesisStarted  │                                   │
│   │  - pendingQueue      │                                   │
│   └──────────┬───────────┘                                   │
│              │                                               │
│              ▼                                               │
│   spawnSubagent (host model / branch model / synth model)    │
│              │                                               │
│              ▼                                               │
│   chatPubsub.publish(convId, ev) → 所有 listener             │
│                                                              │
│   状态持久化:                                                │
│   - Conversation / Message (Prisma)                          │
│   - SubagentRun(每 branch 一行,kind="main"|"branch"|"synth")│
│   - WorkflowRun(每 batch 一行,templateId="append-batch")    │
│   - ~/.imagebase/agents/<id>/memory/working/<convId>.jsonl   │
└─────────────────────────────────────────────────────────────┘
```

### 状态机

```
                user message (任意时刻,任意 block)
                          │
                          ▼
           persistUserMessage + 广播 message_persisted
                          │
              ┌───────────┼─────────────────┐
              ▼           ▼                 ▼
           [idle]?   [main inflight]?  [synth inflight]?
              │           │                 │
        startMainTurn  起 appendBranch  enqueue + turn_pending
              │           │                 │
              ▼           ▼            (用户看到 ThinkingIndicator)
        running 主线 + N append branches    │
              │                              │
              ▼ 所有 branch 完成              │
        synth_started                         │
              ▼                              │
        synth 流式输出                        │
              ▼ synth_finished               │
        idle (turn 结束)                      │
              │                              │
              └─ pendingQueue 非空? ─────────┘
                          │
                          ▼ pop 整组队列(first 当主 + rest 当 append)
                          │
                          ▼
                   重启 batch turn (递归)
```

## 2. 数据模型

### Prisma 字段增量

```prisma
model Conversation {
  id          String   @id @default(cuid())
  agentId     String
  workspaceId String
  title       String?
  // V3.0 NEW
  status      String   @default("idle")  // "idle" | "generating" | "synth-pending"
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model Message {
  id              String   @id @default(cuid())
  conversationId  String
  role            String   // "user" | "assistant" | "tool"
  content         String
  // V3.0 NEW
  branchTag       String?  // "main" | "appended" | "synthesis"
  parentMessageId String?  // synthesis msg 指向被合成的那条主线 user message
  seq             Int      // per-conv 单调递增,前端按此排序
}

model SubagentRun {
  // existing
  // V3.0 NEW (复用现有表加字段)
  kind            String?  // "main" | "branch" | "synth" | "external"  (V1 默认 "external" — host 直调的 spawn_subagent)
  branchId        String?  // 关联 InflightTurn 内部 branchId
  workflowRunId   String?  // 反向关联 WorkflowRun (append-batch 模板)
}
```

`status` 字段重启时 reset 为 `idle`(in-flight 不持久化,后端进程重启就丢了)。`seq` 由后端在 persistUserMessage / persistAssistantMessage 时基于 `(convId, max(seq) + 1)` 原子写。

### 文件系统

```
~/.imagebase/agents/<agentId>/memory/
  episodic/                         (跨 session 共享 — recall_memory 全局可查)
    2026-04-27_xxx.md
  working/                          (V3.0:per-conversation)
    <conversationId>.jsonl
    <conversationId>_2.jsonl        (compact 后不删旧的,只截断,留备份)
  working.jsonl.bak                 (一次性迁移产物,30 天后清理)
```

`compactWorkingMemory(agentId, convId)` 阈值 10 turn 不变,只读自己 convId 的 working,产出 episodic 加 `meta.conversationId` tag。

## 3. PR1 — 多对话 UI + 后端 CRUD 复核

### 后端

| Method | Path | 状态 |
|---|---|---|
| `GET /api/chat/conversations?agentId=&workspaceId=` | 列表,createdAt desc | 已存在,加 status 字段返回 |
| `POST /api/chat/conversations` | 建新 | 已存在 |
| `GET /api/chat/conversations/:id/messages` | 历史消息(含 branch+synth 关联) | 已存在,SubagentRun join 已在 V2.1 |
| `DELETE /api/chat/conversations/:id` | 删 + 删 per-conv working memory | 已存在,加文件清理 |

`GET conversations` 排序由 `updatedAt desc` 改为 **`createdAt desc`**(最新建的在最上)。

### 前端

`ChatBlock` 顶栏布局:

```
[Avatar] Smith's Agent · Claude 4.7 Opus       [+] [≡] [⋯] [×]
                                                |   |   |   └ close block (复用 BlockShell)
                                                |   |   └ more menu
                                                |   |     - Delete current chat
                                                |   |     - (model picker 现在已经在头部)
                                                |   └ all conversations
                                                |     popover list
                                                └ new chat in this block
```

**移除**:Refresh conversation 按钮 + 功能(等价于"`+` 新建后切到新建")。

**Delete**:
1. `[⋯]` menu → "Delete current chat"
2. ConfirmDialog
3. `DELETE /api/chat/conversations/:id`
4. 客户端立即 `POST /conversations` 起新 → 切到新 conv
5. toast "对话已删除"

**ChatBlock 状态持久化**:`canvasContext` 已有 `BlockState`,加新类型:

```ts
interface ChatBlockState {
  activeConversationId: string | null;
}
```

落进 `user.preferences.canvasLayout` 一起持久化(800ms debounce PATCH 已有)。

### Magic Canvas `+` 按钮

`MagicCanvas/AddBlockMenu.tsx` 选 chat 后:
1. 创建新 chat block(已有)
2. 同步 `POST /conversations` 起新 conversation
3. ChatBlockState.activeConversationId = 新 convId

## 4. PR2 — Per-conversation working memory

### `agentService.ts` API

```ts
// V3.0 path: ~/.imagebase/agents/<id>/memory/working/<convId>.jsonl
function workingMemoryPath(agentId: string, convId: string): string {
  return path.join(agentDir(agentId), "memory", "working", `${convId}.jsonl`);
}

export async function appendWorkingMemoryTurn(
  agentId: string, convId: string, turn: WorkingMemoryTurn
): Promise<void> { ... }

export async function readWorkingMemory(
  agentId: string, convId: string
): Promise<WorkingMemoryTurn[]> { ... }

export async function compactWorkingMemory(
  agentId: string, convId: string
): Promise<EpisodicMemory | null> {
  // 读 working/<convId>.jsonl,产出 episodic.md (tag: working-memory-compaction,
  // meta: { conversationId: convId }),截断 working 文件
}
```

### chatAgentService 接入

把所有 `agentId` 传入 working memory 的地方都改 `(agentId, convId)`:

- `recallMemories()` 不变(搜全部 episodic)
- 每轮结束 `appendWorkingMemoryTurn(agentId, convId, turn)`
- 每 10 轮触发 `compactWorkingMemory(agentId, convId)`

### 一次性迁移脚本

`backend/scripts/migrate-working-memory-per-conv.ts`:

```
1. 列所有 agent 目录
2. 对每个 agent:
   a. 读老 working.jsonl
   b. 按 turn 里的 meta.conversationId 分组
   c. 各自写到 working/<convId>.jsonl
   d. 没有 conversationId meta 的 → 写到 working/legacy_<timestamp>.jsonl
   e. 老 working.jsonl 改名 working.jsonl.bak (30 天后清)
3. dryRun + apply 两阶段
```

部署时:CI 跑 dryRun 报告影响 agent 数 + turn 总数;运维确认后 apply。

## 5. PR3 — Multi-block sync (passive listener SSE)

### 后端

新建 `services/chatPubsub.ts`:

```ts
type ChatEventCb = (ev: ChatEvent) => void;
const buses = new Map<string, Set<ChatEventCb>>();

export function publishChatEvent(convId: string, ev: ChatEvent): void {
  buses.get(convId)?.forEach((cb) => cb(ev));
}

export function subscribeChat(convId: string, cb: ChatEventCb): () => void {
  let set = buses.get(convId);
  if (!set) { set = new Set(); buses.set(convId, set); }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) buses.delete(convId);   // 防内存泄漏
  };
}
```

`chatRoutes.ts` 在每个 SSE 事件 yield 给主请求的同时,也调 `publishChatEvent(convId, ev)`。

新端点:

```ts
// GET /api/chat/conversations/:id/listen
router.get("/:id/listen", asyncHandler(async (req, res) => {
  res.writeHead(200, sseHeaders);
  res.write(`event: connected\ndata: {"convId":"${req.params.id}"}\n\n`);
  const off = subscribeChat(req.params.id, (ev) => {
    res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
  });
  req.on("close", off);
}));
```

### 前端

每个 ChatBlock:
- **发起方**(POSTed message,inflight 主请求)走老的 fetch SSE 流
- **旁观方**(其他 block 看同 convId)起一个 `EventSource("/listen")`,接收并 apply 到本地 `messages` state

为了避免发起方既走 fetch 又走 listen 接到双倍事件:
- 发起方在 POST 完成后**只**消费 fetch 流;不订阅 listen
- 旁观方**只**订阅 listen
- ChatBlock 通过 `inflightSessionId` 标记自己是不是发起方,二选一

## 6. PR4 — TurnRegistry + 多 branch + pendingQueue

### 数据结构

```ts
interface InflightTurn {
  convId: string;
  agentId: string;
  startedAt: number;
  workflowRunId: string;            // append-batch workflow 关联

  mainBranch: BranchState;
  appendedBranches: BranchState[];

  synthesisStarted: boolean;
  synthesisPromise?: Promise<{ messageId: string; finalText: string }>;

  /** synth 启动后再进来的 user message 缓存 */
  pendingQueue: PendingMessage[];

  abortController: AbortController;
}

interface BranchState {
  branchId: string;
  userMessageId: string;
  queryText: string;
  modelId: string;                  // 每个 branch 独立 model
  startedAt: number;
  status: "running" | "success" | "error" | "aborted";
  finalText?: string;
  errorMessage?: string;
  completion: Promise<{ branchId: string; finalText: string; success: boolean }>;
  subagentRunId: string;            // SubagentRun.id
}

interface PendingMessage {
  userMessage: Message;
  modelId: string;
}
```

### 入口逻辑

```ts
async function* handleIncomingMessage(convId, content, modelHint) {
  // 1. 解析模型选择
  // - 优先级: @ mention model > agent default model
  const mentionedModelId = extractModelMention(content);
  const branchModelId = modelHint
                     ?? mentionedModelId
                     ?? await getSelectedModel(agentId);

  // 2. persist user message + 广播
  const userMsg = await persistUserMessage({
    convId, role: "user", content, branchTag: undefined  // 等下面调度后再 patch
  });
  publishChatEvent(convId, { event: "message_persisted", data: { ...userMsg }});
  yield { event: "message_persisted", data: { ...userMsg }};

  const inflight = turnRegistry.get(convId);

  // ── Case A: idle → 起主线 ──
  if (!inflight) {
    yield* startMainTurn(convId, userMsg, branchModelId);
    return;
  }

  // ── Case B: synth 中 → 进 pendingQueue ──
  if (inflight.synthesisStarted) {
    inflight.pendingQueue.push({ userMessage: userMsg, modelId: branchModelId });
    publishChatEvent(convId, { event: "turn_pending", data: { messageId: userMsg.id, reason: "synth-in-progress" }});
    yield { event: "turn_pending", data: { messageId: userMsg.id, reason: "synth-in-progress" }};
    return;
  }

  // ── Case C: main inflight → 起 appended branch ──
  const branch = await startAppendedBranch(inflight, userMsg, branchModelId);
  publishChatEvent(convId, { event: "branch_started", data: { messageId: userMsg.id, branchId: branch.branchId, modelId: branchModelId }});
  yield { event: "branch_started", data: { ... }};
  // branch 内部流式 token 不 publish 出去,只走 SubagentRun 持久化
}
```

### Synth 触发 + pendingQueue 出列

```ts
async function startMainTurn(convId, userMsg, modelId): AsyncGenerator<SseEvent> {
  const turn = createInflight(convId, userMsg, modelId);
  turnRegistry.set(convId, turn);

  // 同时创建 WorkflowRun (append-batch)
  turn.workflowRunId = await createWorkflowRun({
    parentConversationId: convId,
    hostAgentId: agentId,
    templateId: "append-batch",
    docJson: buildAppendBatchDoc(turn),
    paramsJson: { hostModel: modelId },
  });

  // 主线 branch
  turn.mainBranch.completion = runHostAgentBranch(turn.mainBranch, /*流事件不广播*/);

  // 等所有 branch (主 + 期间追加的) 完成
  while (true) {
    const all = [turn.mainBranch, ...turn.appendedBranches];
    if (all.every((b) => b.status !== "running")) break;
    await Promise.race(all.filter((b) => b.status === "running").map((b) => b.completion));
  }

  // 启 synthesizer (流式 → publish + yield 给原请求)
  turn.synthesisStarted = true;
  publishChatEvent(convId, { event: "synth_started", data: { turnId: turn.workflowRunId, modelId }});
  yield { event: "synth_started", data: { ... }};

  yield* runSynthesizerStream(turn);
  publishChatEvent(convId, { event: "synth_finished", data: { ... }});
  yield { event: "synth_finished", data: { ... }};

  turnRegistry.delete(convId);

  // pendingQueue 出列 → 一次性起新 batch
  if (turn.pendingQueue.length > 0) {
    const queue = turn.pendingQueue;
    const main = queue[0];
    const appends = queue.slice(1);

    // 立刻把 turn_promoted 事件先发出去 (UI 转换 thinking → branch card)
    publishChatEvent(convId, { event: "turn_promoted", data: {
      messageId: main.userMessage.id, role: "main", modelId: main.modelId
    }});

    // 起新 turn (递归)
    const next = createInflight(convId, main.userMessage, main.modelId);
    for (const a of appends) {
      const ab = await startAppendedBranch(next, a.userMessage, a.modelId);
      publishChatEvent(convId, { event: "turn_promoted", data: {
        messageId: a.userMessage.id, role: "branch", branchId: ab.branchId, modelId: a.modelId
      }});
    }
    turnRegistry.set(convId, next);
    next.mainBranch.completion = runHostAgentBranch(next.mainBranch);
    yield* awaitTurnCompletion(next);  // 同样的等-合成-出列循环
  }
}
```

### Synth prompt(完整拼接,时间倒序)

```ts
function buildSynthesisPrompt(turn: InflightTurn): { systemPrompt: string; userPrompt: string } {
  const branchesNewestFirst = [
    ...turn.appendedBranches.slice().reverse(),
    turn.mainBranch
  ].map((b) => ({
    userQuery: b.queryText,
    fullReply: b.status === "error" ? `(此分支处理失败: ${b.errorMessage})` : (b.finalText ?? ""),
    errored: b.status === "error",
    timestamp: b.startedAt,
  }));

  return {
    systemPrompt: SYNTH_SYSTEM_PROMPT,   // 见下
    userPrompt: JSON.stringify({ branchesNewestFirst, orderingRule: "newest-first" }, null, 2),
  };
}

const SYNTH_SYSTEM_PROMPT = `你的任务是把多个并行 branch 的回复**完整拼接**给用户。

## 强约束 (违反则输出无效)
- 顺序:严格按 branchesNewestFirst 数组顺序输出 (新的在前)
- 内容:每个 branch 的 fullReply **完整保留,不要概要、不要删减、不要改写**
- 衔接:branch 之间用 markdown 分隔符,格式:
    ─── 关于「<userQuery 第一句>」 ───
    <fullReply 完整内容>
- 不加任何额外的总结、过渡语、自我发挥
- errored=true 的 branch 直接照抄 fullReply 的失败说明,不要美化

你不是在创作,只是在**按规则播报**。`;
```

Synth 模型 = 当时**主线**的 modelId(turn.mainBranch.modelId),不是动态读 `getSelectedModel`(避免 user 在 synth 启动那一刻刚切了 picker 引起模型不一致)。

### Per-branch model 解析

| 来源 | 优先级 |
|---|---|
| ChatInput 显式选(目前 PR1 没有这个 UI,V1 不做) | 1 |
| User content 里的 `@<model>` mention | 2 |
| Agent default(`getSelectedModel(agentId)`) | 3 |

```ts
function extractModelMention(content: string): string | null {
  // 匹配 [@xxx](mention://model/<id>?...)
  const re = /\[@[^\]]+\]\(mention:\/\/model\/([^)?]+)/;
  const m = content.match(re);
  return m ? decodeURIComponent(m[1]) : null;
}
```

POST body 不需要新字段,`content` 里就含 mention markdown。

## 7. PR5 — WorkflowRun 观测 + dynamic parallel stream

### Append-batch 模板

WorkflowRun 在 batch 启动时创建,doc 结构:

```ts
{
  templateId: "append-batch",
  rootNodeId: "n_trigger",
  nodes: {
    n_trigger: { kind: "trigger", source: "chat-message", next: "n_parallel" },
    n_parallel: {
      kind: "logic", type: "parallel",
      branches: [],   // 动态填充,不预知具体多少
      joinStrategy: "all",
      next: "n_synth",
    },
    n_main: {
      kind: "action", type: "external-await",   // 新 action type
      outputAlias: "main",
    },
    // n_branch_<i> 在 startAppendedBranch 时动态追加
    n_synth: {
      kind: "action", type: "subagent",
      subagentModel: "${hostModel}",
      systemPrompt: SYNTH_SYSTEM_PROMPT,
      inputBinding: { userPrompt: "${synthInput}" },
      outputAlias: "synthesis",
    },
  },
}
```

### `external-await` action type

`workflow/executor.ts` 加新类型:不真的 spawn,只是 await 一个外部传入的 promise。

```ts
async function* walkActionExternalAwait(
  node: ActionNode, ctx: WorkflowContext, externalPromises: Map<string, Promise<any>>
) {
  const promise = externalPromises.get(node.id);
  if (!promise) throw new Error(`external-await node ${node.id} 无外部 promise 注入`);
  const result = await promise;
  if (node.outputAlias) ctx.scope[node.outputAlias] = result;
  return result;
}
```

`runWorkflowExecutor(doc, ctx, spawn, externalPromises)` 多一个 `externalPromises` 参数,由 chatAgentService 注入 `mainBranch.completion` 等已经在跑的 promise。

### Dynamic parallel branches

`LogicNode.parallel.branches` 改成 stream:

```ts
type BranchesSpec = string[] | ParallelBranchStream;

interface ParallelBranchStream {
  current(): string[];        // 当前已加入的 branch nodeId 数组
  add(nodeId: string): void;  // 实时追加
  close(): void;              // 标记没有更多 child,executor 才能 join
  onAdd(cb: (id: string) => void): () => void;
}
```

executor 看到 stream 时:
1. 启动当前所有 branch
2. 监听 stream.add → 启动新 branch 跟进 join
3. 等 stream.close + 所有 branch 完成才 join

chatAgentService 在 `startAppendedBranch` 时 `branchesStream.add("n_branch_" + branch.branchId)`,在所有 branch 完成准备 synth 时 `branchesStream.close()`。

### WorkflowBlock 渲染

V2.x WorkflowBlock 已经能渲染节点 timeline + 点击跳 SubagentBlock。新增:
- 动态加入的 branch 节点实时出现在 timeline(已支持,nodeEvents 数组追加)
- WorkflowBlock 顶部 title 由 `workflow · append-batch` + `<N> branches` 显示
- synth 节点点击展开时显示拼接 prompt + 输出

### 完整事件链(chat 视角)

```
event: message_persisted   (user A)
event: branch_started      (n_main, model=claude-opus-4.7)
                            [SubagentBlock A 卡片出现]
event: message_persisted   (user B)
event: branch_started      (n_branch_xxx, model=gpt-5.5 — user @ mention 选了 GPT)
                            [SubagentBlock B 卡片出现]
... branch 内部流式不广播 ...
event: branch_finished     (n_main, success)
event: branch_finished     (n_branch_xxx, success)
event: synth_started       (model=claude-opus-4.7)
                            [synth 流式 assistant message 开始]
event: synth_message_delta * N
event: synth_finished      (messageId)
                            [对话流 settle]

[用户继续连发 → 进入下一组 batch,递归]
```

## 8. SSE 事件 schema

| event | 范围 | data |
|---|---|---|
| `connected` | 首次订阅 listener | `{convId}` |
| `message_persisted` | 发起方 + listener | `{messageId, role, content, branchTag, seq, createdAt}` |
| `turn_pending` | 发起方 + listener | `{messageId, reason: "synth-in-progress"}` |
| `branch_started` | 发起方 + listener | `{messageId, branchId, modelId, subagentRunId, workflowNodeId}` |
| `branch_finished` | 发起方 + listener | `{branchId, success, durationMs, errorMessage?}` |
| `turn_promoted` | listener | `{messageId, role: "main"|"branch", branchId, modelId}` (synth 完后批量发) |
| `synth_started` | 发起方 + listener | `{turnId, workflowRunId, modelId}` |
| `synth_thinking_delta` | 发起方 + listener | `{turnId, text}` |
| `synth_message_delta` | 发起方 + listener | `{turnId, text}` |
| `synth_finished` | 发起方 + listener | `{turnId, finalMessageId}` |
| `error` | 发起方 + listener | `{turnId?, branchId?, code, message}` |
| `done` | 发起方独有(请求结束标志) | `{}` |

`branch_thinking_delta` / `branch_message_delta` **只**走 SubagentRun 持久化,不进 SSE 事件流。

## 9. Edge cases 矩阵

| 场景 | 处理 |
|---|---|
| 主线 branch 失败(模型 fail / abort) | 主线 finalText = `"(主线失败: ...)"`,synth 拼时按 errored 分支处理;synth 仍跑 |
| Append branch 失败 | 同上,fullReply = 失败说明,synth 照拼 |
| Synth 失败 | 直接发 `error` 事件,turnRegistry.delete,前端把 user 消息标 `error`,允许手动 retry |
| 用户 stop 按钮 | abortController.abort() → 所有 branch + synth 取消;已 persist 的 user message 保留;assistant message 标 `aborted` |
| 用户 stop 后立刻发新 query | 等 stop 流程清理完(turnRegistry.delete)后正常起新 turn |
| 多 block 同时 send 同 conv | 第二个 send 走 listener 看到的 inflight 状态 → 进 batch 当 append branch;两个 block 都看到对方的 user message + branch card |
| 多 block 都断开 | chatPubsub Set 清空 → 自动从 Map 删除 (PR3 已含) |
| 后端进程重启,inflight 全丢 | conversation.status 重启时 reset 为 idle;消息持久化的部分已落库;前端 listener 重连后看到 inflight=null,thinking placeholder 自动消失 + assistant message 标 `aborted` |
| Pending queue 累积过多 | 软上限 50 条/conv,超出报错 "排队已满,请等当前回复完成";硬上限避免 OOM |
| 同 conv 跨 region | 多 region 时 chatPubsub 要走 Redis pubsub(目前 in-memory,Phase 0.5 上 Redis 后改) |

## 10. 测试用例(更新到 docs/test-plan.md)

### P0(必通过)

- [ ] new chat 按钮 → 起新 conv,context + working memory 都是空的
- [ ] 切到旧 conv → 历史消息正确加载,working memory 也回到该 conv 的状态
- [ ] delete current chat → 二次确认 → 删除 → toast → 自动建新 conv
- [ ] conversation 列表按 createdAt desc,新的在最上
- [ ] idle 状态发 query → 正常单 turn(无 branch / synth 包装)
- [ ] main inflight 时发新 query → branch card 出现 + 平行处理 + synth 汇总
- [ ] synth 中发新 query → user bubble 出现 + thinking placeholder + synth 完后整组 pop 起新 batch
- [ ] 同 conv 在 2 个 ChatBlock 打开 → A 发消息 → B 实时出现 user bubble + branch + synth
- [ ] ChatInput 草稿在 A 输入 → B 看不到(草稿不同步)
- [ ] @ mention 一个非 default 模型 → 该 branch 用 mention model,synth 用主线 default
- [ ] 主线模型在 ChatBlock 切换 picker 后发的 query → 走新模型,synth 也用新模型
- [ ] branch 失败 → synth 显式标注失败,不报全局错
- [ ] stop 按钮 → 所有 inflight 取消,清晰的 aborted 标记

### P1(打磨)

- [ ] 工作流 SubagentBlock 展开后能看到 branch 内部 thinking + tool call
- [ ] WorkflowBlock 渲染 batch 的 timeline + 节点点击跳对应 SubagentBlock
- [ ] working memory 迁移脚本 dryRun 报告准确
- [ ] 一个 conv 跑 50 turn 后 working memory 正确 compact 成 episodic
- [ ] 重启后端进程,前端 listener 重连,UI 不僵死
- [ ] 同 conv 在 3+ block 上看,延迟 < 200ms 同步

## 11. 排期

| Week | PR | 内容 |
|---|---|---|
| 1 | **PR1** | 多对话 UI(`+` / list / `⋯` delete)+ 后端 createdAt desc + per-block convId 持久化 |
| 1.5 | **PR2** | per-conv working memory + 迁移脚本(dryRun + apply) |
| 2 | **PR3** | passive listener SSE + chatPubsub + 多 block 同步 |
| 3 | **PR4** | TurnRegistry + 多 branch + pendingQueue + per-branch model + synth 完整拼接 |
| 4 | **PR5** | WorkflowRun(append-batch)+ external-await + dynamic parallel stream + WorkflowBlock |

总 ~4 周。

## 12. 配套文档更新

- `CLAUDE.md`:架构小节描述新增字段 + Multi-Conversation 流程
- `docs/changelog.md`:每个 PR 的发布记录
- `docs/test-plan.md`:P0 + P1 用例落入
- `.claude/skills/api-conventions.md`:`/api/chat/conversations/:id/listen` 端点规范
- `.claude/skills/ai-prompt-patterns.md`:Synth prompt 模板
