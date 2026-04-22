# Chatbot Idea 能力 · 实现方案

> 让 Table Agent 能读写 workspace 里的 Idea Markdown 文档，并主动生成跨 artifact 关联（@mention）。
> 本文定稿于 2026-04-22。分 v1 / v2 / v3 三次发布。

---

## 0 · 当前可复用资产

| 资产 | 位置 | 用途 |
|---|---|---|
| Idea REST 全套 | `backend/src/routes/ideaRoutes.ts` | MCP 工具直接镜像，不重写业务 |
| 乐观并发锁 | `PUT /api/ideas/:id` 的 `baseVersion` + 409 | MCP 写工具复用 |
| Idea 节标题提取 | `backend/src/services/ideaSections.ts` 的 `extractIdeaSections()` | Agent 的锚点定位依据；已持久化到 `Idea.sections` |
| Per-idea SSE | `/api/sync/ideas/:id/events`（事件 `idea:content-change` / `idea:rename`） | v2 流式写入的下行通道 |
| Mention Markdown 语法 | `[@label](mention://type/id?…)` | Agent 直接写这串字符就能生成 chip |
| Mention 搜索 REST | `GET /api/workspaces/:id/mentions/search` | `find_mentionable` 工具的底层 |
| 前端 IdeaEditor sanitize | `MarkdownPreview.tsx` 的 `rehype-sanitize` schema | HTML 白名单既定，Agent 输出走同一过滤器 |
| Skill 机制 + Tier 分层 | `mcp-server/src/tools/index.ts` + `skills/tableSkill.ts` | 完全对称拷一份 `idea-skill` |

---

## 1 · 分层分配（最终版）

```
Tier 0（always-on · meta）
  └─ 保持不变：identity / memory / skill_router / cron

Tier 1（always-on · workspace 导航 · 高频）
  ├─ list_tables, get_table           既有
  ├─ list_ideas, get_idea             v1 新增
  ├─ find_mentionable                 v1 新增（跨 artifact @ 候选搜索 + 预构建 mentionUri）
  └─ list_incoming_mentions           v1 新增（反向引用查询）

Tier 2 · idea-skill（opt-in · 写）
  ├─ create_idea / rename_idea / delete_idea        v1
  ├─ append_to_idea / insert_into_idea               v1
  ├─ replace_idea_content                             v1（danger）
  └─ begin_idea_stream_write / end_idea_stream_write  v2

Tier 2 · design-skill（预留）
  └─ TODO(v3+)：list_designs / get_design / taste 读写
```

**说明**：`find_mentionable` 返回值**包含 taste** 类候选（来自现有 REST），Agent 能生成 taste 的 @ chip；但**不提供 taste 详情读取**，那属于 v3+。

---

## 2 · 数据模型变更

### 2.1 新 Prisma 模型 `Mention`

```prisma
model Mention {
  id             String   @id @default(cuid())
  workspaceId    String

  // 引用方
  sourceType     String   // "idea"（v1 只此一种）
  sourceId       String

  // 被引用方
  targetType     String   // "view" | "taste" | "idea" | "idea-section"
  targetId       String   // idea-section 用 "<ideaId>#<slug>" 组合键

  // 渲染 / UI 提示
  rawLabel       String
  contextExcerpt String?  // mention 前后 ±40 字 Markdown

  createdAt      DateTime @default(now())

  @@index([workspaceId, targetType, targetId])
  @@index([sourceType, sourceId])
}
```

**为什么独立表而非 JSON 字段**：反向索引成本 <5ms；diff 写入逻辑集中一处；不同实体类型共用同一模式。

### 2.2 写入路径（`PUT /api/ideas/:id`）

```
parse(旧 content) → oldRefs
parse(新 content) → newRefs
added = newRefs - oldRefs
removed = oldRefs - newRefs

transaction:
  删除 Mention rows (sourceType=idea, sourceId=X, targetKey ∈ removed)
  插入 Mention rows (added) 含 contextExcerpt
```

### 2.3 删除路径

- **删除源**（idea）：`Mention(sourceType=idea, sourceId=X)` 级联 delete
- **删除目标**（被 @ 的 entity）：**保留** `Mention` 行作为失效引用的历史痕迹；UI 侧渲染"已失效链接"
- **反向查询**：`GET /api/mentions/reverse?type=X&id=Y&workspaceId=Z`

---

## 3 · MCP 工具（v1 完整清单）

### 3.1 Tier 1（4 个新工具）

| Tool | Args | 返回 |
|---|---|---|
| `list_ideas` | `workspaceId?` | `[{id, name, parentId, order, version, size, preview}]` |
| `get_idea` | `ideaId` | `{id, name, version, content, outline, updatedAt}` |
| `find_mentionable` | `workspaceId, query?, types?, limit?` | `[{type, id, label, ...typeFields, mentionUri, markdown}]` |
| `list_incoming_mentions` | `entityType, entityId, workspaceId` | `{count, refs: [{sourceType, sourceId, sourceName, rawLabel, contextExcerpt}]}` |

### 3.2 Tier 2 · `idea-skill`（6 个 v1 工具）

| Tool | Args | Danger |
|---|---|---|
| `create_idea` | `workspaceId, name?, parentId?, initialContent?` | — |
| `rename_idea` | `ideaId, name` | — |
| `delete_idea` | `ideaId` | ⚠️ |
| `append_to_idea` | `ideaId, content, baseVersion` | — |
| `insert_into_idea` | `ideaId, content, baseVersion, anchor` | — |
| `replace_idea_content` | `ideaId, content, baseVersion` | ⚠️ |

锚点 schema：

```ts
anchor: { type: "start" }
      | { type: "end" }
      | { type: "after-heading", slug }
      | { type: "before-heading", slug }
      | { type: "replace-section", slug }
```

### 3.3 写入实现策略

所有写工具 **都走 HTTP 代理到主 backend REST**（与 `tableTools.ts` 对称）。好处：触发 `eventBus.emitIdeaChange`，其他客户端自动同步；乐观锁路径一致；日志集中。

---

## 4 · HTML in Markdown（补丁 A）

### 4.1 Sanitize 白名单（既定，不扩宽）

- `defaultSchema.tagNames`（div/span/section/figure/figcaption/img/table/…）
- 自定义追加 SVG 标签集（`svg/g/path/rect/…`）
- `a.href` 允许协议：`mention://` / `http(s)` / `#` / `/` / `mailto:` / `tel:`

### 4.2 TOOL_GUIDANCE 新段

明确告诉 Agent：
- 允许：结构标签、文本格式、img、表格、SVG 子树
- 禁止：script / iframe / on* / javascript:
- 标题**必须用 Markdown `##`**（HTML `<h2>` 不进 outline）

### 4.3 锚点插入的 HTML-aware 边界

- 所有 anchor 只落在 Markdown 行边界（换行后）
- `replace-section`：不跨越以 `<div>` / `<section>` / `<figure>` 等独占一行的 HTML block 起点
- 同一 section 里嵌了 HTML block，replace 保 HTML 块原样，只换 Markdown 部分

---

## 5 · 关联对象（补丁 B）

### 5.1 `find_mentionable` 设计

薄代理 `/api/workspaces/:id/mentions/search`，REST 侧扩充返回字段：

```ts
// REST 响应增加：
{
  ...hit,
  mentionUri: "mention://view/tbl_001/view_all",
  markdown: "[@客户.全部](mention://view/tbl_001/view_all)"
}
```

Agent 零拼接：调用 → 拿 `markdown` 字段 → 贴到 idea content。

### 5.2 TOOL_GUIDANCE 新段

```
## 在 idea 里 @ 引用其他实体

首选：调用 find_mentionable(query) → 使用返回值的 markdown 字段直接粘贴。

支持的类型：
  - view          数据表视图
  - taste         设计品味标签（注意：可引用、但无法读取详情）
  - idea          其他笔记
  - idea-section  笔记的章节锚点

taste 说明：当前只能 @，如果用户要求分析 taste 内容（图片/描述），
告诉他暂不支持，后续会补。

格式兜底（只在 id 确定的前提下用）：
  [@label](mention://<type>/<ids>...)
```

### 5.3 架构占位（design-skill）

- `skills/index.ts`：`allSkills` 数组里加注释槽位
- `tools/index.ts`：Tier 分层注释里写 `design-skill ← TODO(v3+)`
- `find_mentionable` 返回值 schema 不预留 design 字段 —— taste 详情走 v3+ `get_design` 独立路径

---

## 6 · 反向引用与删除二次弹窗（补丁 C）

### 6.1 反向查询 REST

```
GET /api/mentions/reverse?type=view&id=tbl_001&workspaceId=ws_xxx&limit=20

→ {
  count: 3,
  refs: [
    {
      sourceType: "idea",
      sourceId: "idea_abc",
      sourceName: "产品调研笔记",
      rawLabel: "客户.待跟进",
      contextExcerpt: "…见 [@客户.待跟进](...) 的跟进情况…"
    },
    ...
  ]
}
```

### 6.2 前端 UI 侧删除流程

删除按钮点击 →
1. 预查 `/api/mentions/reverse`
2. 若 `count > 0`，用 references 变体 ConfirmDialog 展示：

```
删除「客户」数据表？

⚠️ 这张表被 3 个 idea 引用：
  · 产品调研笔记 — "…见 [@客户](...) 的跟进…"
  · 周会纪要 — "…@客户 新增商机…"
  · Q4 计划

删除后这些引用会变成失效的链接。

        [取消]    [仍然删除]
```

3. 若 `count === 0`，原有简单确认。

### 6.3 Agent 侧删除流程

- 所有 `delete_*` 工具 `danger: true`（既有）
- ChatAgentService 触发 `confirm` SSE 事件**前**预跑 `/api/mentions/reverse`，payload 加 `incomingRefs`
- 前端 `ConfirmCard` 渲染 references 列表（与 UI 侧同构）
- Agent 可以**主动**调 `list_incoming_mentions` 做风险评估，自行决定是否继续

---

## 7 · 流式写入（补丁 · v2）

### 7.1 Begin/End 括号协议

```
Agent text: "好的，我把调研结果写进《研究笔记》"
Agent tool_call: begin_idea_stream_write({ideaId, baseVersion, anchor})
  → {writeSessionId}
Agent text (被分流): "## 竞品分析\n\n1. A 公司..."
  - forward 给聊天 UI
  - 同时 push 到 ideaWriteSession → rAF 节流 broadcast idea:content-delta
Agent tool_call: end_idea_stream_write({writeSessionId, finalize:true})
  → 合并冲突 + PUT + broadcast idea:content-finalize
Agent text: "写完啦…"
```

### 7.2 兜底

- Agent 忘 end → `onDone` 自动 finalize
- 用户 stop → abort 路径 finalize(discarded)
- Provider error → finalize(discarded)
- 2 min 超时强制 finalize

### 7.3 前端 streaming 态

- 第一个 delta → 算 anchorOffset 进入 streaming 模式
- 每个 delta → splice 到 anchor 后，本地更新 content，禁 autosave
- finalize → 权威 content 覆盖，恢复 autosave
- 视图 soft-lock：streaming 期间 preview-only

---

## 8 · 发布节奏

| 版本 | 范围 | 工期 |
|---|---|---|
| **v1** | Tier 1 新工具（list_ideas / get_idea / find_mentionable / list_incoming_mentions）；idea-skill 原子写工具；Mention 表 + 写入 diff + 反向 API + 删除二次弹窗；snapshot 扩展；HTML-aware 边界；TOOL_GUIDANCE 补全 | **5 天** |
| **v2** | 流式 begin/end + SSE content-delta / content-finalize + 前端 streaming UI + 兜底 | **3 天** |
| **v3+** | design-skill（list_designs / get_design / taste 读写）；Mention 数据 backfill 脚本；反向引用 UI 面板 | **3 天** |

---

## 9 · 文件清单（v1 范围）

### 新建
- `backend/src/schemas/ideaSchema.ts`
- `backend/src/services/ideaWriteService.ts`（anchor 插入 + HTML-aware 边界，纯函数可测）
- `backend/src/services/mentionIndex.ts`（parseMentions + diff）
- `backend/src/routes/mentionReverseRoutes.ts`（反向查询）
- `backend/mcp-server/src/tools/ideaTools.ts`
- `backend/mcp-server/src/tools/mentionTools.ts`
- `backend/mcp-server/src/skills/ideaSkill.ts`
- `backend/prisma/migrations/<ts>_add_mention_table/`（自动生成）

### 修改
- `backend/prisma/schema.prisma`
- `backend/src/routes/ideaRoutes.ts`：PUT 写入时 diff Mentions；DELETE 级联清 `sourceType=idea, sourceId=X`
- `backend/src/routes/mentionRoutes.ts`：search 响应加 `mentionUri` + `markdown`
- `backend/src/services/chatAgentService.ts`：snapshot 加 idea 区块；TOOL_GUIDANCE 加 HTML + mention 段；danger confirm 前注入 incomingRefs
- `backend/mcp-server/src/tools/index.ts`：Tier 1 白名单加 4 个；design-skill 注释占位
- `backend/mcp-server/src/skills/index.ts`：注册 ideaSkill
- `backend/src/index.ts`：挂 `/api/mentions/reverse` 路由
- `frontend/src/api.ts`：`fetchIncomingMentions`
- `frontend/src/App.tsx`：delete handlers 预查反向引用
- `frontend/src/components/ConfirmDialog.tsx`：支持 references 列表
- `frontend/src/components/ChatSidebar/ChatMessage/ConfirmCard.tsx`：渲染 incomingRefs
- `CLAUDE.md`：分层描述更新

### 文档
- `docs/design.md`：新增 Chat Agent Idea 章节
- `docs/test-plan.md`：P0/P1 用例
- `docs/changelog.md`：发版记录

---

## 10 · 验证 P0 用例

1. **读列表**：list_ideas → 自然语言列表
2. **读全文**：get_idea → 基于全文摘要
3. **末尾追加**：append_to_idea → version +1、编辑器同步
4. **锚点插入**：insert_into_idea + after-heading → 精准节后插入
5. **整体重写**：replace_idea_content → danger 确认
6. **含 HTML 插入**：Agent 生成带 `<div class="callout">` 的内容 → preview 渲染正确
7. **@ 引用**：find_mentionable → 返回 markdown → Agent 粘贴进 insert → chip 可点跳转
8. **反向引用阻止误删**：删除表前弹出 references 列表（UI + Agent 同构）
9. **删除同步清 Mentions**：删 idea 后 Mention 表里对应 sourceId 行清空
10. **taste 限制声明**：Agent 被问 "这个 taste 是什么风格" → 正确说明无法读取

---

## 11 · 关键权衡

| 选择 | 原因 |
|---|---|
| Mention 独立表 vs JSON 字段 | 写放大、事务复杂度、反查索引成本均偏向独立表 |
| taste 只能 @ 不能读 | 本次聚焦 idea 主线，v3+ 再补 design-skill |
| HTML 白名单不扩宽 | Agent 走同一 sanitize 管道，XSS 面不变 |
| 写工具走 HTTP 代理 | 触发 eventBus 自动广播；与 tableTools 对称 |
| v1 不做 backfill | 新增 idea 保存自然写 Mention；老数据 v3 一起做 |
