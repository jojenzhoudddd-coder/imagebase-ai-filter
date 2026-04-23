# Analyst Skill（AI 问数）· 实现方案

> 让 Chat Agent 具备专业数据分析能力：用户用自然语言提问，Agent 识别意图后路由到 Analyst，按需查询 workspace 的 Table / Taste / Idea，走确定性计算引擎做数据加工、推理、分析，以结论 + 表格 + 图表的形式返回，高频出口是落地为 Idea 文档。
>
> 本文定稿于 2026-04-23。分 P1（基建）→ P2（核心）→ P3（图表）→ P4（领域 skill ×3）→ P5（打磨）五次发布，约 11 周单人工期。

---

## 0 · 核心定调（已与用户对齐）

| 决策点 | 结论 |
|---|---|
| 技术路线 | **混合路线**：~10 个高频快捷工具覆盖 80% 场景 + `run_sql` 兜底 |
| 计算引擎 | **DuckDB**（嵌入式列存，原生 PIVOT/UNPIVOT/CUBE，Parquet I/O） |
| 中间存储 | **同 DuckDB**——每个会话一个 `.duckdb` 文件，中间结果就是里面的命名表 |
| 数据一致性 | **Snapshot + 时点声明**；进入分析会话时对涉及的表做 parquet 快照 |
| 全表总结 | **纯聚合描述，不抽样**（`pandas.describe()` 风格，基于 DuckDB SUMMARIZE） |
| 大行数支持 | 10 万行为上限；DuckDB 引擎内部流式处理，对 Agent 透明 |
| Chat 展示 | **大小表一视同仁内联**，>100 行截断到前 20 行 + 强制声明真实行数，**引导对话物化** |
| 物化路径 | **只有对话**（"整理成文档" / "导出" 等意图词），无按钮无侧栏 |
| Result handle | 存在 `tool_result._resultHandle`（DuckDB 表名），Agent 从对话历史自然引用 |
| 高频出口 | **写入 Idea**（分析结论 + 表格 + 图表）；写入 Table 为低频 |
| 长任务 keepalive | 做成 chatbot 基建层：`tool_progress` + `tool_heartbeat` SSE 事件 |
| Skill 链式激活 | `softDeps`（保活）+ `_suggestActivate`（协作激活） |
| 领域分层 | 计算层 = 确定性函数；术语框架判断层 = prompt |
| 领域 skill 顺序 | 互联网 → 财务 → 金融（从标准化高到域知识深） |
| 字段歧义 | **严格策略**：关键字段含义不明时，Agent 必须先确认再算 |
| 图表 | **vega-lite** 客户端渲染（spec 协议），Idea 导出时预渲染 SVG 兜底 |
| 权限模型 | 不做 |
| 跨会话缓存 | V5 打磨期做；V1-V4 每会话独立 |

---

## 1 · 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Frontend (React)                              │
│  ┌──────────────────┐     SSE: tool_progress / tool_heartbeat /     │
│  │  ChatSidebar     │          message / tool_result / confirm      │
│  │  ├─ ChatTableBlock          (virtualized, 截断协议)               │
│  │  ├─ ChatChartBlock          (vega-lite client render)             │
│  │  └─ ToolProgressCard        (progress bar + elapsed time)         │
│  └──────────────────┘                                                │
└──────────┬──────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    ChatAgentService (in-process)                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Skill Router (Phase 3 + P1 extended)                          │  │
│  │    Tier 0: identity/memory/skill/cron      (~8 tools)          │  │
│  │    Tier 1: nav + analyst nav               (~12 tools)         │  │
│  │    Tier 2 (opt-in, by triggers/explicit):                      │  │
│  │      - table-skill / idea-skill / taste-skill    (既有)        │  │
│  │      - analyst-skill                             (P2 新增)     │  │
│  │      - internet-analyst-skill                    (P4 新增)     │  │
│  │      - accounting-analyst-skill                  (P4 新增)     │  │
│  │      - finance-analyst-skill                     (P4 新增)     │  │
│  │  softDeps:                                                     │  │
│  │    analyst-skill → [idea-skill, table-skill]                   │  │
│  │    internet/accounting/finance-skill → [analyst-skill]         │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────┬───────────────────────────────────────────────────────────┘
           │ (MCP in-process tool dispatch)
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     Analyst Runtime Layer                             │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  duckdbRuntime.ts                                               │  │
│  │    sessions: Map<conversationId, DuckDBConnection>              │  │
│  │    sessionDir: ~/.imagebase/analyst/conv_<id>.duckdb            │  │
│  │    attachSnapshot(tableId, parquetPath) → readonly source table │  │
│  │    createResultTable(handle, sql) → returns handle              │  │
│  │    previewResult(handle, limit) → rows                          │  │
│  │    describeResult(handle) → per-field stats                     │  │
│  │    runSQL(sql, inputs) → rows or handle                         │  │
│  │  snapshotService.ts                                             │  │
│  │    createSnapshot(tableId) → parquet at snapshots/<t>@<ts>.pq   │  │
│  │    resolveSnapshot(tableId, snapshotAt?) → path                 │  │
│  │    invalidateTable(tableId)                                      │  │
│  │  resultRegistry.ts                                              │  │
│  │    allocateHandle(type, meta) → "ducktbl_xxx"                   │  │
│  │    resolveHandle(handle) → {tableName, meta}                    │  │
│  │    sweepConversation(convId)                                    │  │
│  │  longTaskService.ts (chatbot 基建)                              │  │
│  │    progress(callId, {phase, pct?, msg})                         │  │
│  │    heartbeatTick(callId) — 无 progress 时定期发                 │  │
│  │    timeout handling                                              │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘

~/.imagebase/analyst/
  conv_<id>.duckdb              每会话一个 DB 文件
  snapshots/
    tbl_<id>@2026-04-23T10-15-02.parquet    表的时点快照
  cache/ (P5 启用)
    digest_<hash>.parquet       跨会话缓存（命中规避重算）
```

---

## 2 · 当前可复用资产

| 资产 | 位置 | 用途 |
|---|---|---|
| Skill 分层机制 | `mcp-server/src/tools/index.ts` + `skills/types.ts` | 直接加 analyst-skill + 三个领域 skill |
| Tier 0 meta-tools | `mcp-server/src/tools/{metaTools,memoryTools,skillRouterTools}.ts` | 保持不变 |
| Tool progress ctx | 现有 `ToolContext`（metadata pattern） | 扩展加 `progress(...)` callback |
| SSE chat 协议 | `chatAgentService.ts` streaming loop | 新增 `tool_progress` / `tool_heartbeat` 事件类型 |
| Idea 写入链路 | `ideaRoutes.ts` + `ideaWriteService.ts` + streaming begin/end | `write_analysis_to_idea` 直接复用 |
| Table CRUD | `tableRoutes.ts` + table-skill | `write_analysis_to_table` 复用 `create_table` + `batch_create_records` |
| 字段 description | `Field.description` 已存在 Prisma schema | 数据字典 V1 只做展示 + 引用，不新增存储 |
| ChatMessage 组件体系 | `ChatSidebar/ChatMessage/*.tsx` | 新组件按同一模式加 |
| Tool catalog in prompt | `chatAgentService.ts` 的 skill catalog 注入 | P1 扩展 softDeps + activate suggestion |

---

## 3 · 分层分配（完整视图）

```
Tier 0（always-on · meta）
  └─ 保持不变：identity / memory / skill_router / cron

Tier 1（always-on · workspace 导航）
  ├─ 既有：list_tables, get_table, list_ideas, get_idea,
  │         list_designs, list_tastes, get_taste,
  │         find_mentionable, list_incoming_mentions
  └─ P1 新增：list_snapshots, get_data_dictionary

Tier 2 · analyst-skill（P2，opt-in · 计算 + 分析）
  ├─ load_workspace_table / describe_result / preview_result
  ├─ filter_result / group_aggregate / pivot_result
  ├─ join_results / time_bucket / top_n
  ├─ run_sql                                    (兜底)
  ├─ write_analysis_to_idea                     (高频出口)
  └─ write_analysis_to_table                    (低频出口)
  softDeps: [idea-skill, table-skill]

Tier 2 · analyst-skill 扩展（P3，图表）
  └─ generate_chart                              (vega-lite spec)

Tier 2 · internet-analyst-skill（P4-a）
  ├─ cohort_analysis / retention_curve
  ├─ funnel_conversion / arpu_arppu
  └─ dau_mau_ratio
  softDeps: [analyst-skill]

Tier 2 · accounting-analyst-skill（P4-b）
  ├─ balance_sheet_summary / income_statement_summary
  ├─ cash_flow_summary / dupont_analysis
  ├─ current_ratio / quick_ratio / debt_to_equity
  └─ turnover_ratios
  softDeps: [analyst-skill]

Tier 2 · finance-analyst-skill（P4-c）
  ├─ irr / npv / wacc
  ├─ beta / sharpe_ratio / volatility
  ├─ cagr / max_drawdown
  └─ portfolio_returns
  softDeps: [analyst-skill]
```

**说明**：`run_sql` 属于 analyst-skill 而不是 Tier 1——虽然它理论上很强，但容易被 Agent 滥用当聚合工具的替代品，放在 Tier 2 强制先激活 analyst-skill，配合 prompt 引导"优先用专用工具，SQL 兜底"。

---

## 4 · 数据模型变更

### 4.1 零 Prisma schema 改动（重要）

**DuckDB 状态不进 Prisma**——它是 runtime 层的副产物，不是持久化业务数据。会话结束按保留策略清理。

| 状态 | 存储 | 生命周期 |
|---|---|---|
| DuckDB 会话文件 | `~/.imagebase/analyst/conv_<id>.duckdb` | 对话最后活跃 7 天后清理 |
| Parquet snapshot | `~/.imagebase/analyst/snapshots/` | 表未被任何活跃会话引用且 > 30 天 → 清理 |
| Result registry | DuckDB 会话内的 `_result_meta` 系统表 | 随会话文件 |
| Long-task state | 进程内 Map（`callId → TaskState`） | 任务完成即清 |

所有"持久化"的业务数据（idea / table）仍走 Prisma 原有路径。Analyst 的输出是调用 `write_analysis_to_idea`，这一步才真正落 Prisma。

### 4.2 新增 TypeScript 类型（`backend/src/schemas/analystSchema.ts`）

```typescript
export const ResultHandleSchema = z.string().regex(/^ducktbl_[a-z0-9]{12}$/);
export type ResultHandle = z.infer<typeof ResultHandleSchema>;

export const ResultMetaSchema = z.object({
  handle: ResultHandleSchema,
  duckdbTable: z.string(),                  // 实际表名
  sourceTableIds: z.array(z.string()),      // 溯源，用于 snapshot invalidation
  snapshotAt: z.string(),                   // ISO timestamp
  rowCount: z.number().int().nonnegative(),
  fields: z.array(z.object({
    name: z.string(),
    type: z.string(),                       // DuckDB 类型字符串
    sourceField: z.string().optional(),     // 原始表字段名
    description: z.string().optional(),     // 从数据字典继承
  })),
  producedBy: z.string(),                   // tool name
  producedAt: z.string(),
  description: z.string().optional(),       // Agent 可选注释
});

export const ChartSpecSchema = z.object({
  $schema: z.literal("https://vega.github.io/schema/vega-lite/v5.json"),
  data: z.object({ values: z.array(z.record(z.any())).optional(), name: z.string().optional() }),
  mark: z.union([z.string(), z.object({ type: z.string() }).passthrough()]),
  encoding: z.record(z.any()),
  title: z.string().optional(),
  width: z.union([z.number(), z.literal("container")]).optional(),
  height: z.union([z.number(), z.literal("container")]).optional(),
}).passthrough();  // vega-lite 规范太大，放宽
```

---

## 5 · 计算引擎：DuckDB Runtime

### 5.1 依赖选型

**`@duckdb/node-api`** 是官方 Node binding，N-API 绑定原生二进制，支持：
- 嵌入式同进程模式（无额外进程）
- 文件或内存数据库
- 原生 Parquet / CSV / Arrow I/O
- Prepared statement + 流式 fetch
- `PIVOT` / `UNPIVOT` / `SUMMARIZE` 语法

加到 `backend/package.json`。MCP server 不直连 DuckDB——所有计算工具仍走 HTTP 代理到主 backend，`backend/src/routes/analystRoutes.ts` 做实际调用。这样：
- 触发 eventBus（如果后续要实时广播结果状态）
- 日志统一
- MCP 工具保持"瘦代理"角色，和既有 table/idea 工具对称

### 5.2 Session 生命周期（`backend/src/services/analyst/duckdbRuntime.ts`）

```typescript
class DuckDBRuntime {
  private sessions = new Map<string, Session>();

  async getOrCreate(conversationId: string): Promise<Session> {
    if (!this.sessions.has(conversationId)) {
      const path = resolveSessionPath(conversationId);
      const db = await duckdb.open(path);
      const conn = await db.connect();
      await conn.run(`CREATE TABLE IF NOT EXISTS _result_meta (
        handle TEXT PRIMARY KEY, table_name TEXT, meta JSON, produced_at TIMESTAMP
      )`);
      this.sessions.set(conversationId, { db, conn, lastActiveAt: Date.now() });
    }
    const sess = this.sessions.get(conversationId)!;
    sess.lastActiveAt = Date.now();
    return sess;
  }

  async close(conversationId: string): Promise<void> { /* flush, close, delete from map */ }

  async attachSnapshot(conversationId: string, tableId: string,
                       parquetPath: string): Promise<string /* duckdb view name */> {
    // CREATE OR REPLACE VIEW src_<tableId> AS SELECT * FROM read_parquet('...');
    // Returns 'src_tbl_xxx'
  }

  async createResult(conversationId: string, sql: string,
                     sourceTableIds: string[], producedBy: string): Promise<ResultMeta> {
    const handle = generateHandle();                        // ducktbl_abcdef123456
    const tableName = `r_${handle.slice(8)}`;               // safe DuckDB identifier
    await conn.run(`CREATE TABLE ${tableName} AS ${sql}`);
    const stats = await describe(tableName);
    const meta = { handle, duckdbTable: tableName, sourceTableIds, ... };
    await conn.run("INSERT INTO _result_meta VALUES (?, ?, ?, ?)", [handle, tableName, JSON.stringify(meta), new Date()]);
    return meta;
  }

  async previewResult(conversationId: string, handle: string, limit = 20): Promise<Row[]> {
    const meta = await this.resolveHandle(conversationId, handle);
    return conn.all(`SELECT * FROM ${meta.duckdbTable} LIMIT ${limit}`);
  }

  // describeResult / runSQL / exportResultToParquet 类似
}
```

**空闲清理**：进程级 `setInterval` 每 10 min 扫 `sessions`，`lastActiveAt > 2h` 的 session close + 文件保留。`conv_*.duckdb` 文件按对话 `updatedAt` 超过 7 天的统一扫除。

### 5.3 核心工具实现思路（以 `group_aggregate` 为例）

```typescript
async function groupAggregateHandler(
  args: { handle: string, groupBy: string[], metrics: {field: string, op: string, as?: string}[] },
  ctx: ToolContext
) {
  const session = await runtime.getOrCreate(ctx.conversationId);
  const input = await runtime.resolveHandle(ctx.conversationId, args.handle);

  ctx.progress?.({ phase: "planning", msg: "构建聚合 SQL" });

  const groupCols = args.groupBy.map(quoteIdent).join(", ");
  const aggs = args.metrics.map(m =>
    `${m.op.toUpperCase()}(${quoteIdent(m.field)}) AS ${quoteIdent(m.as ?? `${m.op}_${m.field}`)}`
  ).join(", ");
  const sql = `SELECT ${groupCols}, ${aggs} FROM ${input.duckdbTable}
               GROUP BY ${groupCols} ORDER BY ${groupCols}`;

  ctx.progress?.({ phase: "computing", msg: "执行聚合" });
  const result = await runtime.createResult(
    ctx.conversationId, sql, input.sourceTableIds, "group_aggregate"
  );

  const preview = await runtime.previewResult(ctx.conversationId, result.handle, 20);
  ctx.progress?.({ phase: "finalizing", msg: "生成预览" });

  return {
    _resultHandle: result.handle,
    meta: result,
    preview: { rows: preview.slice(0, 20), truncated: result.rowCount > 20, totalRows: result.rowCount },
  };
}
```

每个计算工具返回三件套：`_resultHandle` + `meta` + `preview`。

---

## 6 · Snapshot 机制

### 6.1 快照粒度：**per-analysis-session**

进入 analyst-skill（首次调用 `load_workspace_table`）时触发快照。同一对话内后续调用 **复用同一份快照**，除非用户明确说"基于最新数据重新分析"→ Agent 调 `load_workspace_table(tableId, { refresh: true })` 触发新快照。

这个粒度的权衡：
- ✅ 多步分析结果相互一致（不会因为中间数据被改动而自相矛盾）
- ✅ 大表只快照一次，性能可接受
- ⚠️ 新鲜度稍弱——但 Agent 每次回复末尾 **强制声明"本次分析基于 2026-04-23 10:15 的数据快照"**，用户有感

### 6.2 Parquet 快照流程（`backend/src/services/analyst/snapshotService.ts`）

```
load_workspace_table(tableId) 被调用：
  1. snapshotAt = 当前时间戳
  2. 查询 Prisma：获取 tbl_<id> 全量 records（流式游标，避免 OOM）
  3. 流式写入 ~/.imagebase/analyst/snapshots/<tableId>@<snapshotAt>.parquet
     (用 parquet-wasm 或 Apache Arrow nodejs 绑定；DuckDB 也可以 COPY TO)
  4. runtime.attachSnapshot() 创建 DuckDB VIEW 指向这个 parquet
  5. 返回 handle，meta 带 sourceTableIds=[tableId], snapshotAt
```

**性能参考**（Prisma 流式 + DuckDB COPY）：
- 1 万行 ~1 s
- 10 万行 ~5-8 s（这段时间 Agent 要发 `tool_progress`）

**Snapshot 复用**：Agent 对同一 tableId 在同一对话内再次 `load_workspace_table`，runtime 查 `sessionScopedSnapshotMap.get(conversationId + tableId)`，有则跳过。

**失效策略**：
- 同会话内：除非显式 refresh，否则永不失效
- 跨会话：每个会话独立快照，互不干扰
- 磁盘清理：snapshot 文件超过 30 天且 mtime 没被访问 → cron 任务清

### 6.3 查询流程

对话任何轮次里，Agent 想加载一张表就调 `load_workspace_table`。DuckDB 里 attach 完 parquet 后，这张表在 DB 里是 `src_<tableId>` 视图，后续所有计算工具对它操作。

```sql
-- Agent 实际发出的 DuckDB 查询长这样：
CREATE TABLE r_abcdef123456 AS
SELECT date_trunc('month', order_date) AS month, SUM(amount) AS revenue
FROM src_tbl_xxx
WHERE status = 'paid'
GROUP BY 1 ORDER BY 1;
```

---

## 7 · 长任务 keepalive 协议（chatbot 基建）

### 7.1 SSE 事件扩展

```
// 现有
event: tool_start       data: { callId, tool, args }
event: tool_result      data: { callId, result }

// P1 新增
event: tool_progress    data: { callId, phase: "planning"|"computing"|"finalizing",
                                progress?: number /* 0-1 */, message: string,
                                elapsedMs: number }
event: tool_heartbeat   data: { callId, elapsedMs }
```

### 7.2 ToolContext 扩展

```typescript
export interface ToolContext {
  conversationId: string;
  agentId: string;
  activeSkills: string[];
  onActivateSkill?: (name: string) => void;
  onDeactivateSkill?: (name: string) => void;
  // P1 新增：
  progress?: (payload: ProgressPayload) => void;
  abortSignal?: AbortSignal;
}

interface ProgressPayload {
  phase: "planning" | "computing" | "finalizing";
  progress?: number;
  message: string;
}
```

### 7.3 Heartbeat 注入

`chatAgentService` 在工具执行包装器里：
- 工具开始 → 记录 `startedAt`
- 工具调用 `ctx.progress()` → 自动透传为 `tool_progress` SSE，**清零空闲计时**
- 工具 30 s 内没调 `progress` 也没 return → 注入 `tool_heartbeat` SSE（只为维持连接）
- 每 15 s 再注入一次 heartbeat 直到工具返回或超时
- 超过 `TOOL_TIMEOUT_MS = 180_000`（可配）→ abort + 返回 error

### 7.4 前端消费

`ChatSidebar/ChatMessage/ToolCallCard.tsx` 新增：
- `ToolProgressCard`：有 `progress` 时渲染进度条 + `message`；只有 heartbeat 时显示旋转 + 已耗时（"计算中 · 32s"）
- 生命周期：收到第一个 `tool_start` → 显示；收到 `tool_result` → 替换为结果展示

### 7.5 Nginx 配合

`/api/chat/` location 已有 `proxy_read_timeout 600s` + `proxy_buffering off`。heartbeat + progress 事件会持续刷新这个 timer，15s 间隔的 heartbeat 远低于 timeout。**无需改 nginx 配置**。

### 7.6 这不只是 analyst 受益

任何未来慢工具免费获得：
- 批量建表（500 字段）
- 复杂 SVG 生成
- 跨表大 JOIN
- 外部 API 调用（P4 金融 skill 可能要查利率）

---

## 8 · Skill 链式激活

### 8.1 `softDeps`（声明式依赖，解决驱逐）

```typescript
// backend/mcp-server/src/skills/types.ts 扩展
export interface SkillDefinition {
  name: string;
  // ... 既有字段
  softDeps?: string[];   // P1 新增
}

// analyst-skill 声明
export const analystSkill: SkillDefinition = {
  name: "analyst-skill",
  softDeps: ["idea-skill", "table-skill"],
  // ...
};
```

**语义**：`analyst-skill` 激活时，`idea-skill` 和 `table-skill` 的"上次使用轮次"视作刚刚更新，从而免于 10 轮闲置驱逐。但它们**不会自动加载为活跃**——只是保留激活权，等 trigger / explicit activate 真正拉起。

实现点（`chatAgentService.ts`）：
```typescript
function touchSoftDeps(activeSkills: string[], currentTurn: number,
                       skillStateByConv: Map<string, SkillState>) {
  for (const name of activeSkills) {
    const skill = skillsByName[name];
    for (const dep of skill.softDeps ?? []) {
      const state = skillStateByConv.get(dep);
      if (state) state.lastUsedTurn = currentTurn;  // 刷新活跃度
    }
  }
}
```

### 8.2 `_suggestActivate`（工具返回值里的协作激活）

```typescript
// 工具返回可带：
{
  _resultHandle: "ducktbl_xxx",
  meta: {...},
  preview: {...},
  _suggestActivate: [
    { skill: "idea-skill", reason: "用户可能想把分析写入文档" }
  ]
}
```

Agent loop 看到 `_suggestActivate` → 下一轮调用前调用 `activate_skill(name)` 的等效内部操作。这里**不需要模型亲自调**，是工具层协作。

### 8.3 新问题 & 回答

- **传递性**：`internet-skill.softDeps = [analyst-skill]`，`analyst-skill.softDeps = [idea, table]`——激活 internet 后 idea/table 是否保活？
  - **V1 只做一层**：internet 保活 analyst，不传递到 idea/table
  - 理由：二度依赖会导致"软激活图"扩大到整个 skill 图，驱逐逻辑变成图论问题，过度设计
  - 如果真实场景需要，P5 再升级

- **循环依赖**：两个 skill 互为 softDep？
  - 不允许，加载时静态校验（`skills/index.ts` 的启动期检查）

---

## 9 · 大表截断展示协议

### 9.1 Agent 输出硬规则（写入 `analyst-skill` 的 prompt 段）

```
## 结果展示规则（严格）

当你输出分析结果时：

1. 行数 ≤ 100：内联完整 Markdown 表格（对话组件会自动 virtualized）
2. 行数 > 100：
   a. 只写前 20 行 Markdown 表格
   b. 紧接一行声明："以上为前 20 行预览，完整结果共 N 行。"
   c. 紧接一行引导："如需导出为文档 / 继续分析 / 追加筛选，告知即可。"
3. 结果为标量或空：直接文字说明，不要画表
4. 永远不要为了装满"分析感"强行把聚合结果塞表格——能一句话说清就一句话

这些规则的目的是避免对话被大数据撑爆上下文。完整数据在 DuckDB 里，
通过 _resultHandle 随时可取。
```

### 9.2 前端 ChatTableBlock 组件

```typescript
interface ChatTableBlockProps {
  rows: Row[];           // Agent 传来的 rows 数组（可能是截断后的）
  columns: Column[];
  totalRows?: number;    // 可选，>rows.length 时显示截断说明
  resultHandle?: string; // 携带但不显示，给调试用
  footerNote?: string;   // 可选自定义 footer 文本
}
```

**渲染逻辑**：
- 行数 ≤ 10：普通 `<table>`
- 行数 10-100：`<table>` + `max-height: 400px; overflow-y: auto` + 表头 sticky
- 行数 > 100：同上 + footer 显示 "显示 20 / 共 N 行（通过对话获取完整结果）"

**列处理**：
- 列数 > 6：横向滚动，保留前两列 sticky（left: 0）
- 单元格超长：`text-overflow: ellipsis` + hover 显示完整值
- 数值列右对齐，文本左对齐

**不做**：
- 客户端排序 / 筛选（数据只是预览，完整操作走对话）
- 单元格编辑（这不是 TableView）

### 9.3 结果物化的对话识别

`analyst-skill` prompt 段增加意图词列表：
```
用户出现以下意图时，调用 write_analysis_to_idea(handle=最近的_resultHandle):
  - "整理/写成/生成 文档/报告/笔记"
  - "导出/落地"
  - "帮我保存这个结果"
  - "把这个 写下来 / 写到文档里"

用户出现以下意图时，调用 write_analysis_to_table(handle=最近的_resultHandle):
  - "存到新表/建个新表/落成表"
  - "做成一张新的数据表"

如果用户只是继续追问或分析，**不要主动**调用任何 write。
```

---

## 10 · 结果物化

### 10.1 `write_analysis_to_idea`（高频）

```typescript
{
  name: "write_analysis_to_idea",
  description: "将 Analyst 的分析结果落地为一篇新的 Idea 文档或追加到已有文档",
  inputSchema: {
    type: "object",
    required: ["handle", "narrative"],
    properties: {
      handle: { type: "string", description: "_resultHandle" },
      additionalHandles: { type: "array", items: { type: "string" },
                           description: "可选：额外附带的中间结果 handles" },
      chartSpecs: { type: "array", items: ChartSpecSchema,
                    description: "可选：附带的 vega-lite 图表 specs" },
      narrative: { type: "string", description: "Agent 生成的分析叙述（Markdown）" },
      ideaId: { type: "string", description: "可选：追加到已有 Idea；省略则创建新的" },
      title: { type: "string", description: "新 Idea 的标题；创建时必填" },
      workspaceId: { type: "string" },
    },
  },
}
```

**实现**：
```
1. 拉取 handle 的 preview（最多 N 行完整数据，N 可调；暂定 500 行内全量，>500 行用"结果规模太大，使用时可 query_result_by_handle 取"占位）
2. 生成 Markdown 内容：
   ```
   # <title>
   
   _本次分析基于 <snapshotAt> 的数据快照_
   
   ## 分析结论
   <narrative>
   
   ## 核心数据
   <Markdown 表格 based on preview>
   
   ## 完整图表（如有）
   <vega-lite code blocks>
   ```
3. 若 ideaId 为空 → POST /api/ideas 创建；否则 POST /api/ideas/:id/write (anchor: end)
4. 返回 idea mention markdown：`[@分析报告 ...](mention://idea/xxx)`，Agent 直接回贴到对话
```

### 10.2 `write_analysis_to_table`（低频）

```typescript
{
  name: "write_analysis_to_table",
  description: "将 Analyst 的分析结果落地为一张新的 workspace 数据表",
  inputSchema: {
    type: "object",
    required: ["handle", "tableName", "parentDocId"],
    properties: {
      handle: { type: "string" },
      tableName: { type: "string" },
      parentDocId: { type: "string" },
      fieldMappings: {
        type: "array",
        description: "可选：指定 DuckDB 列 → Table 字段类型映射；省略则自动推断",
        items: {
          type: "object",
          properties: {
            duckdbField: { type: "string" },
            tableFieldName: { type: "string" },
            tableFieldType: { type: "string", enum: ["Text","Number","DateTime","Checkbox","SingleSelect","MultiSelect"] },
          }
        }
      },
    },
  },
}
```

**实现**：
```
1. 读取 handle 的 schema，推断或应用 fieldMappings
2. DuckDB 列类型 → Table 字段类型映射：
   INTEGER/BIGINT/DOUBLE → Number
   VARCHAR → Text (或 SingleSelect 若基数低)
   TIMESTAMP/DATE → DateTime
   BOOLEAN → Checkbox
3. POST /api/tables 建表（带字段）
4. 批量读 DuckDB rows → batch_create_records 分批调用（每批 200 条）
   每批调 progress 回报
5. 超过 5 万行时拒绝并提示"结果过大，建议写入文档或下载 CSV"
   （P5 可做 CSV 导出，P2 不做）
```

---

## 11 · 图表（P3）

### 11.1 `generate_chart` 工具

```typescript
{
  name: "generate_chart",
  description: "为 Analyst 结果生成一个 vega-lite 图表 spec",
  inputSchema: {
    type: "object",
    required: ["handle", "chartType"],
    properties: {
      handle: { type: "string" },
      chartType: { type: "string", enum: ["bar", "line", "pie", "area", "scatter"] },
      x: { type: "string", description: "x 轴字段" },
      y: { type: "string", description: "y 轴字段" },
      series: { type: "string", description: "分组字段（用于多系列）" },
      title: { type: "string" },
    },
  },
}
```

**实现**：
```
1. 拉取 handle 的 preview（最多 1000 个数据点，超过则降采样）
2. 按 chartType 组装 vega-lite spec：
   - bar: {mark: "bar", encoding: {x: {field: x, type: "nominal"}, y: {field: y, type: "quantitative"}}}
   - line: {mark: "line", encoding: {x: {type: "temporal"}, y: {type: "quantitative"}, color: {field: series}}}
   - pie: {mark: "arc", encoding: {theta: {field: y, type: "quantitative"}, color: {field: x}}}
   - ...
3. 返回：
   { _chartSpec: vegalite_spec_object, description: "简短描述" }
```

Agent 拿到 `_chartSpec` 后，可以：
- 直接嵌在回复里（对话显示时前端识别 spec 渲染）
- 传给 `write_analysis_to_idea` 的 `chartSpecs[]`

### 11.2 Chat 内渲染（`ChatChartBlock.tsx`）

```typescript
interface ChatChartBlockProps { spec: VegaLiteSpec; }

// 用 vega-embed（~100KB gzipped）客户端渲染
// bundle 影响：vega + vega-lite 全量 ~400KB，只在首次加载图表时动态 import
// 动态导入：
const loadVegaEmbed = () => import("vega-embed").then(m => m.default);
```

### 11.3 Chat 流中的 spec 传递方式

**约定**：Agent 回复里用 fenced code block：
````markdown
下面是月度营收趋势：

```vega-lite
{"$schema":"...","mark":"line","encoding":{...},"data":{"values":[...]}}
```
````

前端 Markdown 渲染识别 `vega-lite` 语言的代码块，替换为 `<ChatChartBlock spec={parsedJSON} />`。

### 11.4 Idea 嵌入

`IdeaEditor/MarkdownPreview.tsx` 的 code-block handler 复用同一识别逻辑。Agent 写 Idea 时直接写同样的 fenced block，preview 自动渲染。

**预渲染 SVG 兜底**（P3 后半期）：导出 Idea 为 HTML/PDF 时，后端 `vega-lite → vega-node → SVG` 转换，保证静态环境也能看。

---

## 12 · 数据字典

### 12.1 V1：只做展示 + Agent 可读

- **字段描述**：`Field.description` 已存在。前端 TableView 里的字段右键菜单加 "编辑描述"。
- **Agent 可读**：`list_fields` / `get_table` 返回值已包含 description。analyst 激活时，prompt 段强调"优先使用字段 description 而非字段名判断含义"。
- **新工具** `get_data_dictionary(workspaceId)` → 返回该 workspace 下所有表的字段 + description，方便 Agent 一次性加载。放在 Tier 1。

### 12.2 严格字段确认策略

`analyst-skill` prompt 增加：
```
## 字段消歧义（严格）

在运行任何涉及金额、时间、主体、状态 的聚合前：
1. 若候选字段 ≥ 2 个且名字不明确（如 amount / amount_usd / net_amount），
   必须先用自然语言问用户："我看到有 X、Y、Z 三个字段，你指的是哪个？"
2. 若字段有 description 且能明确区分，直接按 description 使用，但在回复里声明
   "我使用的是 <字段名>: <description>"
3. 若 description 为空但字段名完全明确（如 order_id），无需确认

宁可多问一次，也不要选错字段静默给出错误结论。
```

### 12.3 V5 扩展：AI 自动推断字段描述

`propose_field_descriptions(tableId)` 工具：Agent 基于字段名 + 样本数据推断 description，返回给用户确认 → 批量 `update_field`。P5 时做。

---

## 13 · 领域 Skill 框架

### 13.1 三层结构（每个领域 skill 都遵循）

```
计算层：~5-15 个纯函数 MCP 工具
  （如 irr(cashflows) / dupont_analysis(revenue, net_income, assets, equity))
  └ 确定性，无 LLM 介入，单元测试覆盖率 100%

术语层：domain prompt 片段（skill 激活时注入 system prompt）
  └ "你熟悉 MoM / QoQ / YoY / CAGR / 同比环比 / cohort / 留存曲线 / ..."

模板层：1-2 个高层 orchestration 工具
  （如 run_cohort_analysis(tableId, userIdField, dateField, eventField))
  └ 内部串联多个基础工具 + 领域函数，给 Agent "一键能力"
```

### 13.2 示例：`internet-analyst-skill`

```typescript
export const internetAnalystSkill: SkillDefinition = {
  name: "internet-analyst-skill",
  displayName: "互联网数据分析",
  description: "DAU/MAU、留存、漏斗、ARPU 等互联网产品指标的专用计算与分析",
  artifacts: [],
  softDeps: ["analyst-skill"],
  when: "用户问题涉及互联网产品指标（日活/月活/留存/漏斗/分层/ARPU 等）时激活",
  triggers: [
    /(DAU|MAU|WAU|日活|月活|周活)/i,
    /(留存|retention|cohort|流失|churn)/i,
    /(漏斗|funnel|转化率)/i,
    /(ARPU|ARPPU|LTV)/i,
    /(分层|人群|user[_\s]?segment)/i,
  ],
  tools: [
    ...internetTools,  // cohort_analysis / retention_curve / funnel_conversion / arpu_arppu / dau_mau_ratio
  ],
};
```

### 13.3 计算层工具举例（互联网）

```typescript
// mcp-server/src/tools/domain/internetTools.ts

{
  name: "cohort_analysis",
  description: "基于用户行为数据计算 cohort 留存矩阵",
  inputSchema: {
    type: "object",
    required: ["handle", "userField", "eventDateField"],
    properties: {
      handle: { type: "string" },
      userField: { type: "string", description: "用户 ID 字段" },
      eventDateField: { type: "string", description: "行为日期字段" },
      cohortGranularity: { type: "string", enum: ["day", "week", "month"], default: "week" },
      periodsAhead: { type: "integer", default: 8, description: "观察期数" },
    },
  },
  handler: async (args, ctx) => {
    // 1. 从 handle 取出数据（DuckDB 视图）
    // 2. 计算每个用户的首次活跃 cohort
    // 3. 计算每个 cohort 在 period+1..+N 的回访用户数
    // 4. 生成矩阵结果表（新 handle）
    // 5. 返回 preview + _resultHandle + 建议的图表 spec
  }
}
```

### 13.4 Prompt 层举例（财务）

```
## 财务术语对齐

用户提到以下术语时，按下述理解：
  - "毛利率" = (revenue - cost_of_goods_sold) / revenue
  - "净利率" = net_income / revenue
  - "ROE"   = net_income / equity
  - "ROA"   = net_income / total_assets
  - "杜邦拆解" = ROE = 净利率 × 资产周转率 × 权益乘数

用户要求"三张表分析"时，至少覆盖：
  - 利润表关键行项
  - 资产负债表主要构成
  - 现金流量表净额

涉及标准比率但数据里只有部分科目时，优先使用 dupont_analysis / current_ratio 等
专用工具而不是自己手写 SQL。
```

### 13.5 三个 Skill 的优先级 & 顺序

| Skill | 优先级 | 难点 |
|---|---|---|
| **互联网** | 先做 | 指标最标准（GA/Mixpanel 级），用户基数最大 |
| **财务** | 其次 | 有国标（会计准则），公式确定 |
| **金融** | 最后 | 域知识最深，需行业基准，易出现"假装懂其实瞎扯" |

---

## 14 · 分期交付

| 版本 | 范围 | 工期 | 对外可见 |
|---|---|---|---|
| **P1** | 基建层：DuckDB runtime + snapshot service + `tool_progress/heartbeat` SSE 协议 + `softDeps` + 数据字典（字段 description 展示 + `get_data_dictionary`）+ `list_snapshots` | **2 w** | 无（纯基建） |
| **P2** | analyst-skill 核心：11 个工具（load / describe / preview / filter / group_aggregate / pivot / join / time_bucket / top_n / run_sql / write_analysis_to_idea / write_analysis_to_table） + 严格字段确认策略 + ChatTableBlock（virtualized）+ `_suggestActivate` 协作激活 | **3 w** | ✅ MVP 可用 |
| **P3** | 图表：`generate_chart` + `ChatChartBlock` + Idea 嵌入 + SVG 预渲染兜底 | **2 w** | ✅ 体验完整 |
| **P4** | 三个领域 skill，顺序 **互联网 → 财务 → 金融**，每个 1 w：5-15 计算函数 + 领域 prompt + 1-2 模板工具 | **3 w** | ✅ 专业度到位 |
| **P5** | 打磨：跨会话 parquet 缓存 + 失效 / AI 推断字段描述 / 大表 snapshot 性能优化 / analyst 自评分析质量 / CSV 导出 | **1 w** | ✅ 精品 |

**总计 ~11 周**（单人全栈）。

**关键依赖**：P1 → P2 → P3 必须顺序；P4 三个 skill 顺序推进但可选打乱；P5 任何时候可插。

---

## 15 · 文件变更清单（P1 + P2 范围）

### 新建

| 文件 | 说明 |
|---|---|
| `backend/src/services/analyst/duckdbRuntime.ts` | DuckDB 会话生命周期 + 资源管理 |
| `backend/src/services/analyst/snapshotService.ts` | Parquet 快照创建、复用、失效 |
| `backend/src/services/analyst/resultRegistry.ts` | `_result_meta` 表读写封装 |
| `backend/src/services/analyst/analysisTemplates.ts` | 写入 Idea 的 Markdown 模板 |
| `backend/src/services/longTaskService.ts` | `tool_progress` / `tool_heartbeat` 协议基建 |
| `backend/src/schemas/analystSchema.ts` | Zod schemas（ResultHandle / ResultMeta / ChartSpec） |
| `backend/src/routes/analystRoutes.ts` | `/api/analyst/*` REST（工具 HTTP 代理） |
| `backend/mcp-server/src/tools/analystTools.ts` | P2 核心 11 个工具 |
| `backend/mcp-server/src/tools/writeResultTools.ts` | write_analysis_to_idea / write_analysis_to_table |
| `backend/mcp-server/src/skills/analystSkill.ts` | SkillDefinition |
| `frontend/src/components/ChatSidebar/ChatMessage/ChatTableBlock.tsx` | 大小表虚拟滚动 |
| `frontend/src/components/ChatSidebar/ChatMessage/ChatTableBlock.css` | |
| `frontend/src/components/ChatSidebar/ChatMessage/ToolProgressCard.tsx` | 进度条 + heartbeat UI |

### 修改

| 文件 | 改动 |
|---|---|
| `backend/package.json` | 加 `@duckdb/node-api` |
| `backend/src/index.ts` | 启动时初始化 DuckDBRuntime + 启动清理 cron |
| `backend/src/services/chatAgentService.ts` | SSE 协议扩展；`softDeps` 激活逻辑；`_suggestActivate` 处理；结果展示 prompt 段；字段消歧义 prompt 段；TOOL_TIMEOUT + heartbeat 注入 |
| `backend/mcp-server/src/tools/index.ts` | Tier 1 白名单加 `get_data_dictionary` / `list_snapshots` |
| `backend/mcp-server/src/tools/tableTools.ts` | 新增 `get_data_dictionary` / `list_snapshots`（Tier 1） |
| `backend/mcp-server/src/skills/types.ts` | `SkillDefinition` 加 `softDeps` |
| `backend/mcp-server/src/skills/index.ts` | 注册 analystSkill；启动期校验 softDeps 无循环 |
| `frontend/src/api.ts` | 扩展 SSE 解析：`tool_progress` / `tool_heartbeat` |
| `frontend/src/components/ChatSidebar/ChatMessage/ToolCallCard.tsx` | 检测 progress events，切换到 ToolProgressCard |
| `frontend/src/components/ChatSidebar/ChatMessages.tsx` | Markdown 渲染时识别 result meta → 替换为 ChatTableBlock |
| `frontend/src/components/IdeaEditor/MarkdownPreview.tsx` | P3 时扩：识别 `vega-lite` 代码块 |
| `CLAUDE.md` | 架构章节新增 Analyst runtime 说明 |

### 文档

| 文件 | 改动 |
|---|---|
| `docs/design.md` | 新增 "AI 问数（Analyst Skill）" 章节 |
| `docs/test-plan.md` | 新增 P0/P1 用例 |
| `docs/changelog.md` | 每次发布记录 |
| `.claude/skills/ai-prompt-patterns.md` | 新增 analyst-skill prompt 结构模板 |

---

## 16 · P0 验证用例

### P1（基建）
1. **DuckDB 安装 smoke**：启动 backend，`duckdbRuntime.getOrCreate("test")` 成功建连
2. **Snapshot 创建**：10k 行测试表 `snapshotService.createSnapshot(tableId)`，生成 parquet 文件，读回一致
3. **Progress SSE**：mock 工具调用 `ctx.progress()` 三次，前端 ToolProgressCard 依次更新
4. **Heartbeat**：mock 30s 无 progress 的工具，前端 tool card 持续旋转不报错

### P2（analyst 核心）
5. **加载小表**：输入 "查看订单表有多少行" → Agent 调 `load_workspace_table` + `describe_result` → 返回行数 + 字段描述
6. **加载大表**：10 万行表 → snapshot 5-8 s 期间 progress 进度条正常滚动，结果正确
7. **聚合**：输入 "按月统计营收" → `group_aggregate` → 结果 12 行，内联表格
8. **透视**：输入 "按产品线和地区做透视，value 是销售额" → `pivot_result` → 矩阵正确
9. **大结果截断**：筛出 3000 行 → 前端显示前 20 行 + "显示 20 / 共 3000 行" footer
10. **对话物化到 Idea**：上面接一句 "整理成文档" → 创建新 Idea，标题合理，包含叙述 + 表格
11. **物化到 Table**：改为 "存到新表，叫 '异常订单'" → 创建新表 + 批量写记录
12. **字段消歧义**：表有 amount_usd / amount_cny，问 "销售额" → Agent 反问 "你指的是 USD 还是 CNY？"
13. **Snapshot 复用**：同一对话连续问 3 个分析问题 → 只有第一次创建 snapshot，后 2 次复用
14. **刷新快照**：问 "基于最新数据再跑一次" → Agent 用 `refresh:true` 重新 snapshot
15. **SQL 兜底**：问一个工具组合表达不出来的问题（如 window function）→ Agent 调 `run_sql` + 解释
16. **softDeps 保活**：analyst 活跃 15 轮没调 idea write → idea-skill 仍被保活（`lastUsedTurn` 不过期）
17. **_suggestActivate**：`write_analysis_to_idea` 返回值带 `_suggestActivate: [idea-skill]` → 下一轮 idea-skill 自动激活

### P3（图表）
18. **生成柱状图**：问 "画个月度营收趋势" → `generate_chart(chartType:line)` → 前端 ChatChartBlock 渲染
19. **写入 Idea 带图表**：接 "写成报告" → 新 Idea 内嵌图表，preview 渲染正常
20. **图表 SVG 预渲染**（P3 后半期）：Idea 导出 HTML 时，vega-lite 转为 SVG

### P4（领域 skill）
21. **互联网**：问 "算一下新用户 4 周留存" → internet-skill 激活 → `cohort_analysis` → 矩阵 + 图表
22. **财务**：问 "做个杜邦分析" → accounting-skill → `dupont_analysis` → 三因子拆解
23. **金融**：问 "这个项目 IRR 多少" → finance-skill → `irr` → 标量结果 + 解释

### P5
24. **跨会话缓存**：两个会话问同一张表的同一个聚合 → 第二次 < 100ms 响应（命中 parquet 缓存）

---

## 17 · 风险 & 预案

| 风险 | 概率 | 影响 | 预案 |
|---|---|---|---|
| DuckDB Node binding 版本不稳 / 原生编译失败 | 中 | 高 | 锁版本；CI 跑 smoke；部署脚本检查 `node --version` 与 `@duckdb/node-api` compat 矩阵 |
| 10 万行 snapshot 超时 | 中 | 中 | P1 就对 Prisma 流式 + DuckDB COPY 路径 benchmark；超过 30 s 走后台任务 + progress |
| Snapshot 磁盘撑爆 | 低 | 中 | 30 天 LRU 清理 + 软限额 10GB（超限拒绝新 snapshot 并提示用户） |
| DuckDB 会话并发损坏（多工具同时写同一 conn） | 中 | 高 | `duckdbRuntime` 内每会话一把 mutex；所有工具调用串行化；多读一写即可 |
| Agent 乱写 SQL 把 DuckDB 打挂 | 低 | 中 | `run_sql` 只允许 SELECT / CREATE TABLE AS（解析 AST 白名单）；禁 DELETE/DROP/ATTACH |
| write_analysis_to_table 50k 行卡死 | 中 | 中 | 硬限 5 万行，超过返回错误提示改用文档 |
| vega-lite bundle 太大影响首屏 | 中 | 低 | 动态 import，只在首次渲染图表时加载 |
| 领域 skill Prompt 注入引起 Agent 行为漂移 | 中 | 中 | 每个领域 skill 加独立 P0 用例；激活次数 > 阈值时做 A/B 对比测试 |
| 字段消歧义太啰嗦影响体验 | 中 | 低 | 通过 description 明确的直接走；description 空且字段名"相似度 > 0.6"才问 |
| softDeps 保活时间过长导致工具集膨胀 | 低 | 低 | softDeps 也有 30 轮硬上限，不是永久保活 |
| 模型选择错误字段静默给错 | 低 | 高 | 严格字段确认 prompt；"本次分析基于 <字段>" 强制声明；用户可复核 |

---

## 18 · 关键权衡记录

| 选择 | 原因 |
|---|---|
| DuckDB vs Polars / ClickHouse / SQLite | DuckDB = 列存 + 嵌入 + SQL + Parquet + PIVOT 一把梭；Polars 非 DB 状态缺缓存层；ClickHouse 太重；SQLite 不适合 OLAP |
| 计算走 MCP 工具 HTTP 代理 vs 直连 DuckDB | 与 table/idea 工具对称；日志统一；未来可能要 eventBus；2ms 开销可忽略 |
| Snapshot per-session vs per-question | per-session 保证多步分析一致；声明快照时点解决新鲜度 |
| 纯聚合全表总结 vs 聚合 + 代表样本 | 用户明确要纯聚合——不抽样；损失质化描述换取确定性 |
| 大表截断走对话 vs 按钮 | 对话统一 UX；规避 "按了不知道要落地 artifact" 的误操作；无需新 API endpoint |
| result handle 存对话历史 vs 独立 registry | 对话历史自带的 tool_result 就是天然的 handle 索引；Agent 翻历史即可 |
| run_sql 放 analyst-skill 而非 Tier 1 | 防滥用；强制先激活 analyst 意味着明确"进入分析模式"的 UX 契约 |
| softDeps 一层 vs 传递 | 一层足够；传递导致图论问题，V1 不做 |
| _suggestActivate 工具层 vs 模型自觉 | 工具层可靠，不依赖模型规则理解；保留模型自觉 fallback |
| 领域 skill 独立 vs 合并到 analyst | 独立 → prompt 膨胀可控 + 领域工具按需加载；合并 → Agent 每次都看一堆不相关的金融工具 |
| 图表 vega-lite vs ECharts | vega-lite 声明式 spec 更适合 LLM 生成；spec JSON 可直接持久化到 Idea |
| ChatTableBlock 不做排序/筛选 | 对话语境下数据只是预览；真要操作就物化成 Idea 或 Table |
| 跨会话缓存放 P5 | V1-V4 每会话独立已满足功能，缓存是优化非刚需 |
| 严格字段确认而非猜 | 静默猜错的代价远大于多问一次的成本 |

---

## 19 · 后续扩展占位（不在当前 plan 范围内）

- **Python sandbox runtime**：比 DuckDB 更强的脚本化分析（pandas/numpy/scikit-learn）；需要沙箱隔离 + 资源限额；P5 之后评估
- **外部数据源 connector**：金融 skill 接入利率/指数 API；会计 skill 接入汇率 API
- **数据字典 AI 自动推断**：P5 做单轮；完整版要支持增量更新 + 用户批准流
- **行级权限 / 字段级权限**：用户明确说不做，未来多用户场景再议
- **Analyst 结果订阅**：用户让分析"每周一跑一次" → cron + snapshot 自动刷新；P5 之后

---

## 20 · 实现顺序建议

```
P1 - Week 1
  Day 1-2: DuckDB Node 集成 + smoke；路由骨架
  Day 3-4: snapshotService + parquet 流式写入
  Day 5:   resultRegistry + 会话清理 cron

P1 - Week 2
  Day 1-2: longTaskService (progress/heartbeat SSE 协议 + chatAgentService 集成)
  Day 3-4: softDeps 激活逻辑 + 启动期校验
  Day 5:   数据字典 Tier 1 工具 + P1 P0 用例

P2 - Week 3
  Day 1-2: analystTools.ts (load / describe / preview / filter)
  Day 3-4: group_aggregate / pivot / join / time_bucket / top_n
  Day 5:   run_sql (SQL AST 白名单)

P2 - Week 4
  Day 1-2: writeResultTools (to_idea / to_table)
  Day 3-4: analystSkill 定义 + prompt 段 + _suggestActivate
  Day 5:   字段消歧义 prompt + P2 P0 用例

P2 - Week 5
  Day 1-3: ChatTableBlock (virtualized + 截断 footer)
  Day 4:   Markdown 渲染识别结果 meta 并挂载组件
  Day 5:   P2 整体联调 + 文档更新 + 上线

P3 - Week 6
  Day 1-2: generate_chart 工具 + vega-lite spec 生成
  Day 3-4: ChatChartBlock (动态 import + 渲染)
  Day 5:   Idea 嵌入图表（MarkdownPreview 扩展）

P3 - Week 7
  Day 1-2: 图表 SVG 预渲染（vega-node 服务端）
  Day 3-4: write_analysis_to_idea 整合图表 spec
  Day 5:   P3 P0 用例 + 上线

P4 - Week 8
  互联网 skill：cohort / retention / funnel / arpu / dau_mau

P4 - Week 9
  财务 skill：balance_sheet / income / cash_flow / dupont / ratios

P4 - Week 10
  金融 skill：irr / npv / wacc / beta / sharpe / volatility

P5 - Week 11
  跨会话缓存 + AI 推断字段描述 + CSV 导出 + 自评 + 性能优化
```

---

## 结语

这份方案的**核心赌注**是：Analyst 的价值 90% 来自"把 LLM 从计算器位置解放出来，让它只负责意图理解和结论表达"。DuckDB 就是那个让这件事成立的中间层——它既是计算引擎也是状态容器，把"几百个工具调用串起来凑出一个分析"的复杂度压缩到"每个工具写一个 SQL 再把结果 handle 传下去"的简单模型。

其他所有选择（snapshot 粒度、截断协议、softDeps、领域 skill 三层结构）都是为了让这个主干**不变形**。

验收标准：

- 用户说 "帮我分析一下订单数据，看看哪个地区最赚钱，然后写个报告" → Agent 用 4-6 轮工具调用完成，全程有进度反馈，最后生成一个可读的 Idea。
- 用户说 "对比 Q3 和 Q4 各产品线的杜邦指标变化" → 金融/财务 skill 自动激活，结论准确到每个拆解因子。
- 10 万行表上问 "谁是销冠" → 10s 内给出 top 10 + 简单图表。

这三件事做到，就是精品。

