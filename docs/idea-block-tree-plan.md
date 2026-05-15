# Idea Block Tree 技术方案

> 状态:设计中
> 作者:Claude Code
> 日期:2026-05-13
> 前置:PR6 (IdeaBlock 双轨已上线), PR8 (块级交互已上线)
> 目标:把 Idea 从"Markdown 字符串 + 派生 block 表"演进为"block tree 是 source of truth"

---

## 1. 背景与动机

### 1.1 当前架构

Idea 文档的 source of truth 是 `Idea.content`——一个 Markdown 字符串,存于 Prisma `Idea` 模型的 `content: String @default("")` 字段。

围绕这个字符串有三层派生结构:

```
Idea.content (source of truth)
  ├─ IdeaBlock 表 (PR6, 派生) ─ 每次 content 写入时 parseToBlocks() + syncBlocksForIdea()
  ├─ Idea.sections (派生) ─ 标题 slug 列表,供 @mention picker 使用
  └─ Mention 表 (派生) ─ mention://... 链接的反向索引
```

**写路径**:所有写操作(`PUT /api/ideas/:id`、`POST /write`、stream finalize)都接收完整 Markdown 字符串或 payload 片段,通过 `applyIdeaWrite()` 拼接出新的完整 `content`,然后在同一个 `$transaction` 里同步更新 `Idea.content` + `IdeaBlock` 表 + `Mention` 表 + `Idea.sections`。

**读路径**:前端 `IdeaEditor` 通过 `GET /api/ideas/:id` 拿到完整 Markdown 字符串,分发给 CodeMirror (Source 模式) 或 Tiptap (Preview 模式) 渲染。`GET /api/ideas/:id/blocks` 返回 block 列表供 Agent 定位。

### 1.2 痛点

| 痛点 | 具体表现 | 根因 |
|------|---------|------|
| **Preview 模式编辑低效** | 点击一个 block 后弹出 `<textarea>` 叠层编辑,提交时拼回整个 Markdown 再 PUT。UX 远不及 Notion 的原地编辑。 | block 不是 source of truth,每次编辑都要 string → parse → sync 全量 |
| **Source ↔ Preview 切换丢失状态** | Tiptap 的 Markdown 序列化与原始文本不完全一致(空行折叠、列表缩进),需要 `normalizeMd()` 比对来判断是否"真的改了" | 两个编辑器各持一份文本,互为转换 |
| **SSE 粒度粗** | `idea:content-change` 推送完整 `content` 字符串,多人同时编辑时最后写入者覆盖前者 | 没有 block 级 delta |
| **Agent 写入效率** | `applyIdeaWrite()` 的 anchor 机制依赖 heading slug 查找 + 正则匹配,对 HTML block / fenced code 边界有复杂 heuristic | 本质上是在字符串上做"伪结构化编辑" |
| **大文档性能** | 每次保存重新 `parseToBlocks()` 全文 + `syncBlocksForIdea()` diff 全部 block 行;1MB 文档有感延迟 | 写放大——改一个字也重写整棵树 |
| **CRDT 前置** | 未来要上 Yjs/CRDT 实时协作,必须以 block tree 为操作单元;flat string OT 复杂度不可控 | 没有结构化操作原语 |

### 1.3 目标

> **Block tree 成为 Idea 文档的 source of truth**。`Idea.content` 降级为"可重建的缓存",由 block tree 拼接而成。

阶段目标:
1. **PR-A**:后端 block 写 API 独立化,不再依赖 content 全量重写
2. **PR-B**:前端 Preview 模式切换为 block-based 编辑(每个 block 1:1 对应一个可编辑区域)
3. **PR-C**:SSE 推送 block 级 delta,Source 模式也改为 blocks → serialize → CodeMirror

---

## 2. 数据模型

### 2.1 现有 IdeaBlock 模型(已上线)

```prisma
model IdeaBlock {
  id        String   @id @default(cuid())
  ideaId    String
  order     Float        // fractional indexing
  type      String       // "heading" | "paragraph" | "list" | "code" | "quote" | "divider" | "html" | "table"
  content   String @db.Text  // 原始 Markdown 字节
  props     Json   @default("{}")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  idea Idea @relation(fields: [ideaId], references: [id], onDelete: Cascade)
  @@index([ideaId, order])
  @@map("idea_blocks")
}
```

### 2.2 演进后的模型

```prisma
model IdeaBlock {
  id        String   @id @default(cuid())
  ideaId    String
  // V2 新增:父 block(tree 结构),null = 顶层
  parentId  String?
  order     Float
  type      String
  content   String   @db.Text
  props     Json     @default("{}")
  // V2 新增:block 级版本号,用于乐观并发控制
  version   Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  idea   Idea       @relation(fields: [ideaId], references: [id], onDelete: Cascade)
  parent IdeaBlock? @relation("BlockTree", fields: [parentId], references: [id], onDelete: Cascade)
  children IdeaBlock[] @relation("BlockTree")

  @@index([ideaId, order])
  @@index([parentId, order])
  @@map("idea_blocks")
}
```

**变更说明**:

| 字段 | V1 (现状) | V2 (目标) | 说明 |
|------|-----------|-----------|------|
| `parentId` | 无 | `String?` | 支持嵌套 block(list item 下的段落、toggle 内容、column 子 block)。V1 阶段一律 `null`(flat list),PR-C 时开始使用 |
| `version` | 无 | `Int @default(0)` | 乐观并发——两个 tab 同时改同一 block 时,后者收到 409 conflict |
| `parentId` 索引 | 无 | `@@index([parentId, order])` | 查询某 block 的子 block |

### 2.3 Idea 模型的变化

```prisma
model Idea {
  id          String   @id @default(cuid())
  workspaceId String
  name        String
  parentId    String?
  order       Int      @default(0)
  // V2:content 降级为"缓存"字段,由 blocks 拼接而成。
  // 写入时不再从前端接收,而是后端从 blocks 重建。
  // 保留此字段是为了:
  //   1. Source 模式快速序列化(不需 N+1 查 block)
  //   2. 旧 API 兼容(GET /api/ideas/:id 仍返回 content)
  //   3. 全文搜索(Postgres full-text index)
  content     String   @default("")
  version     Int      @default(0)
  sections    Json     @default("[]")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  workspace   Workspace        @relation(...)
  attachments IdeaAttachment[]
  blocks      IdeaBlock[]

  @@index([workspaceId])
  @@index([parentId])
  @@map("ideas")
}
```

`Idea.version` 变为"文档级版本",每次任一 block 写入都 increment。`Idea.content` 在每次 block 写入的 `$transaction` 末尾由 `reassembleBlocks()` 重建。

### 2.4 Block 类型与 props schema

```typescript
// 共享类型定义:backend/src/schemas/ideaBlock.ts
// Route + MCP 共用(遵循 CLAUDE.md 的 shared schema 规则)

export type IdeaBlockType =
  | "heading"
  | "paragraph"
  | "list"
  | "code"
  | "quote"
  | "divider"
  | "html"
  | "table"
  | "image"       // PR10 拆出;V1 仍嵌在 paragraph 里
  | "toggle"      // PR10a
  | "callout"     // PR10b
  | "column"      // PR10c
  | "embed";      // PR10f

export interface HeadingProps {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  slug: string;
  text: string;       // 纯文本(不含 # 标记)
}

export interface ListProps {
  ordered: boolean;
  startsAt?: number;   // 有序列表起始数字
}

export interface CodeProps {
  language: string | null;
}

export interface TableProps {
  columns: number;
  hasHeader: boolean;
}

// 后续类型预留
export interface ToggleProps {
  summary: string;     // 折叠标题
  open: boolean;
}

export interface CalloutProps {
  icon: string;        // emoji or icon name
  variant: "info" | "warning" | "error" | "success";
}
```

### 2.5 排序策略:Fractional Indexing

现有 `order: Float` 已采用 fractional indexing。V2 继续沿用,但规范化:

```typescript
// backend/src/services/fractionalIndex.ts

/**
 * 生成介于 a 和 b 之间的中间值。
 * a < result < b。特殊值:
 *   a = null → 结果 < b
 *   b = null → 结果 > a
 *   a = null, b = null → 0
 */
export function midpoint(a: number | null, b: number | null): number {
  const lo = a ?? 0;
  const hi = b ?? (lo + 2);
  return (lo + hi) / 2;
}

/**
 * 当 float 精度不足时(连续 50+ 次 midpoint 插入),
 * 触发整个 sibling 列表的 re-index(0, 1, 2, ...)。
 * 阈值:两个相邻 order 差 < 1e-10。
 */
export function needsReindex(orders: number[]): boolean {
  for (let i = 1; i < orders.length; i++) {
    if (Math.abs(orders[i] - orders[i - 1]) < 1e-10) return true;
  }
  return false;
}
```

### 2.6 迁移策略

**现有数据完全兼容**——PR6 已经在每次写入时调用 `syncBlocksForIdea()` 生成 IdeaBlock 行。V2 的迁移只需:

1. **Prisma migration**:给 `IdeaBlock` 加 `parentId` + `version` 两个 nullable 列(现有行全部为 `null` / `0`,符合语义)
2. **无数据迁移**:现有 block 行的 `content` 拼接后 === `Idea.content`,天然满足新契约
3. **渐进切换**:旧写路径(`PUT /api/ideas/:id`)继续工作(接收整个 Markdown → 内部 parse → sync blocks → 重建 content);新写路径(`PATCH /api/ideas/:id/blocks/:blockId`)直接改单 block + 重建 content

```sql
-- Prisma migration (自动生成)
ALTER TABLE "idea_blocks" ADD COLUMN "parentId" TEXT;
ALTER TABLE "idea_blocks" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "idea_blocks_parentId_order_idx" ON "idea_blocks"("parentId", "order");
ALTER TABLE "idea_blocks"
  ADD CONSTRAINT "idea_blocks_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "idea_blocks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
```

---

## 3. API 变更

### 3.1 现有 API 保留(向后兼容)

以下 API 签名不变,行为不变:

| 端点 | 用途 | 兼容说明 |
|------|------|---------|
| `GET /api/ideas?workspaceId=` | 列表 | 不变 |
| `GET /api/ideas/:id` | 详情(含 content) | content 由 blocks 重建,结果一致 |
| `POST /api/ideas` | 创建 | 不变 |
| `PATCH /api/ideas/:id` | 重命名 | 不变 |
| `DELETE /api/ideas/:id` | 删除 | CASCADE 删 blocks |
| `PUT /api/ideas/:id` | 全量保存 content | **保留但标记 deprecated**;内部 parse → sync blocks → 重建 content 缓存 |
| `POST /api/ideas/:id/write` | anchor 写入 | 保留;内部 applyIdeaWrite → sync |
| `GET /api/ideas/:id/blocks` | 读 block 列表 | 不变 |

### 3.2 新增 / 增强的 block CRUD API

现有 PR8 已实现 PATCH/DELETE/MOVE,V2 增强并新增:

#### 3.2.1 `PATCH /api/ideas/:ideaId/blocks/:blockId` (增强)

```typescript
// 请求 body
interface PatchBlockBody {
  content?: string;        // 新的 Markdown 内容
  transformTo?: string;    // 类型转换
  props?: Record<string, unknown>;  // V2 新增:直接修改 props
  baseVersion?: number;    // V2 新增:乐观并发(block.version)
}

// 响应
interface PatchBlockResponse {
  id: string;
  blockId: string;
  version: number;       // idea.version
  blockVersion: number;  // block.version (V2 新增)
}
```

**V2 变更**:
- 支持 `baseVersion` 字段。若传入且与 `block.version` 不匹配,返回 409
- 写入时只重建 `Idea.content` 的变化区段(不再全量 parseToBlocks + diff)
- 返回值包含 `blockVersion`

#### 3.2.2 `POST /api/ideas/:ideaId/blocks` (V2 新增)

在指定位置插入新 block。

```typescript
// 请求 body
interface CreateBlockBody {
  type: IdeaBlockType;
  content: string;         // Markdown 内容
  props?: Record<string, unknown>;
  afterBlockId?: string;   // 插入到此 block 之后;null = 插入到开头
}

// 响应
interface CreateBlockResponse {
  id: string;              // 新 block 的 id
  order: number;
  ideaVersion: number;
}
```

**实现要点**:
1. 查找 `afterBlockId` 的 order 和下一个 sibling 的 order
2. 用 `midpoint()` 计算新 order
3. `$transaction`:create block → 重建 Idea.content → increment Idea.version → sync mentions

#### 3.2.3 `PUT /api/ideas/:ideaId/blocks/batch` (V2 新增)

批量更新多个 block(Agent 一次性改多段时用)。

```typescript
interface BatchBlockUpdate {
  operations: Array<
    | { op: "update"; blockId: string; content?: string; transformTo?: string }
    | { op: "delete"; blockId: string }
    | { op: "create"; afterBlockId?: string; type: string; content: string }
    | { op: "move"; blockId: string; toIndex: number }
  >;
}

// 响应
interface BatchBlockResponse {
  ideaVersion: number;
  results: Array<{ op: string; blockId: string; ok: boolean; error?: string }>;
}
```

所有操作在同一个 `$transaction` 内执行,任一失败则全部回滚。

### 3.3 SSE 事件变更

#### 3.3.1 Block 级 SSE 事件

新增以下事件类型,通过现有 `idea-change` SSE channel 发送:

```typescript
// idea:block-update — 某 block 内容/类型变更
{
  type: "idea:block-update",
  ideaId: string,
  clientId: string,
  timestamp: number,
  payload: {
    blockId: string,
    content: string,
    type: string,
    props: Record<string, unknown>,
    blockVersion: number,
    ideaVersion: number,
  }
}

// idea:block-create — 新 block 插入
{
  type: "idea:block-create",
  ideaId: string,
  clientId: string,
  timestamp: number,
  payload: {
    block: { id, order, type, content, props, version },
    afterBlockId: string | null,
    ideaVersion: number,
  }
}

// idea:block-delete — block 被删除
{
  type: "idea:block-delete",
  ideaId: string,
  clientId: string,
  timestamp: number,
  payload: {
    blockId: string,
    ideaVersion: number,
  }
}

// idea:block-move — block 顺序变更
{
  type: "idea:block-move",
  ideaId: string,
  clientId: string,
  timestamp: number,
  payload: {
    blockId: string,
    newOrder: number,
    ideaVersion: number,
  }
}
```

#### 3.3.2 兼容处理

保留 `idea:content-change` 事件——每次 block 级操作完成后,仍广播一次包含完整 `content` + `version` 的 content-change 事件。这样:
- 旧版 FE(未升级)仍能正常工作
- Source 模式可选择只监听 content-change(简单粗暴)

### 3.4 content 重建逻辑

block 级写入的 `$transaction` 内部:

```typescript
async function commitBlockMutation(
  tx: PrismaTx,
  ideaId: string,
  clientId: string,
): Promise<{ content: string; version: number }> {
  // 1. 读取所有 blocks(ordered)
  const blocks = await tx.ideaBlock.findMany({
    where: { ideaId, parentId: null },  // V1: flat; V2: 顶层
    orderBy: { order: "asc" },
  });

  // 2. 拼接 content
  const content = blocks.map(b => b.content).join("");

  // 3. 重建派生数据
  const sections = extractIdeaSections(content);
  const mentionRows = buildMentionRows(content, "idea", ideaId, workspaceId);

  // 4. 原子写入
  const updated = await tx.idea.update({
    where: { id: ideaId },
    data: {
      content,
      version: { increment: 1 },
      sections: sections as any,
    },
  });
  await tx.mention.deleteMany({ where: { sourceType: "idea", sourceId: ideaId } });
  if (mentionRows.length > 0) {
    await tx.mention.createMany({ data: mentionRows });
  }

  return { content: updated.content, version: updated.version };
}
```

---

## 4. 前端架构

### 4.1 整体状态管理

```typescript
// frontend/src/components/IdeaEditor/useBlockState.ts

interface BlockState {
  /** block id → block data */
  blocks: Map<string, IdeaBlock>;
  /** 有序 block id 列表(顶层) */
  order: string[];
  /** idea 级版本号 */
  ideaVersion: number;
  /** 当前聚焦的 block id */
  focusedBlockId: string | null;
}

type BlockAction =
  | { type: "LOAD"; blocks: IdeaBlock[]; ideaVersion: number }
  | { type: "UPDATE_BLOCK"; blockId: string; content: string; blockVersion: number }
  | { type: "CREATE_BLOCK"; block: IdeaBlock; afterBlockId: string | null }
  | { type: "DELETE_BLOCK"; blockId: string }
  | { type: "MOVE_BLOCK"; blockId: string; newOrder: number }
  | { type: "FOCUS"; blockId: string | null }
  | { type: "SYNC_CONTENT"; content: string; version: number }  // 从 SSE content-change
  | { type: "SYNC_BLOCK"; event: BlockSSEEvent }                // 从 SSE block-*
  ;

function blockReducer(state: BlockState, action: BlockAction): BlockState {
  // ... reducer 实现
}
```

### 4.2 Source 模式:blocks → Markdown → CodeMirror

Source 模式的工作流:

```
┌──────────────────────────────────────────────────────┐
│ blocks → reassemble → CodeMirror value                │
│                                                        │
│ 用户编辑 → onChange(newMarkdown) → debounce 600ms      │
│   → PUT /api/ideas/:id { content, baseVersion }        │
│   → 后端 parseToBlocks + syncBlocks + content cache    │
│   → SSE content-change → 其他 tab 收到                 │
└──────────────────────────────────────────────────────┘
```

**V2 不改变 Source 模式的核心流程**——仍然走全量 Markdown 保存。原因:
1. CodeMirror 的编辑粒度是字符级,不是 block 级
2. 用户在 Source 模式可能跨 block 边界编辑(删掉一个换行把两段合并)
3. 强行拆解会引入大量边界 case,ROI 低

Source 模式的改进仅限于:
- **初始化**:从 `blocks → reassemble()` 而非 `idea.content`,保证与 Preview 模式一致
- **保存回调**:继续用 `PUT /api/ideas/:id`,后端自动 sync blocks

### 4.3 Preview 模式:block-based 编辑

这是 V2 的核心改造。每个 block 映射为一个独立的可编辑区域:

```tsx
// frontend/src/components/IdeaEditor/BlockList.tsx

function BlockList({ ideaId, blocks, order, dispatch, streaming }: Props) {
  return (
    <div className="idea-block-list">
      {order.map((blockId) => {
        const block = blocks.get(blockId);
        if (!block) return null;
        return (
          <BlockRenderer
            key={blockId}
            block={block}
            streaming={streaming}
            onUpdate={(content) => handleBlockUpdate(blockId, content)}
            onDelete={() => handleBlockDelete(blockId)}
            onCreateAfter={(type, content) => handleBlockCreate(blockId, type, content)}
            onMove={(toIndex) => handleBlockMove(blockId, toIndex)}
          />
        );
      })}
    </div>
  );
}
```

```tsx
// frontend/src/components/IdeaEditor/BlockRenderer.tsx

function BlockRenderer({ block, onUpdate, onDelete, onCreateAfter, onMove, streaming }: Props) {
  switch (block.type) {
    case "heading":
      return <HeadingBlock block={block} onUpdate={onUpdate} />;
    case "paragraph":
      return <ParagraphBlock block={block} onUpdate={onUpdate} />;
    case "code":
      return <CodeBlock block={block} onUpdate={onUpdate} />;
    case "list":
      return <ListBlock block={block} onUpdate={onUpdate} />;
    case "quote":
      return <QuoteBlock block={block} onUpdate={onUpdate} />;
    case "table":
      return <TableBlock block={block} onUpdate={onUpdate} />;
    case "divider":
      return <DividerBlock block={block} />;
    case "html":
      return <HtmlBlock block={block} onUpdate={onUpdate} />;
    default:
      return <ParagraphBlock block={block} onUpdate={onUpdate} />;
  }
}
```

#### 4.3.1 单 block 编辑器

每个 block 使用一个轻量 Tiptap 编辑器实例:

```tsx
// frontend/src/components/IdeaEditor/blocks/ParagraphBlock.tsx

function ParagraphBlock({ block, onUpdate }: { block: IdeaBlock; onUpdate: (content: string) => void }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ /* 仅段落级标记:bold/italic/code/link */ }),
      Markdown.configure({ breaks: true, html: true }),
    ],
    content: block.content,
    onBlur: ({ editor }) => {
      const md = toMarkdown(editor);
      if (md !== block.content.trim()) {
        onUpdate(md + "\n");
      }
    },
  });

  // 从父级接收 SSE 更新
  useEffect(() => {
    if (!editor) return;
    if (editor.isFocused) return;  // 用户正在编辑,不打断
    editor.commands.setContent(block.content);
  }, [block.content]);

  return (
    <div className="idea-block idea-block-paragraph">
      <BlockHandle blockId={block.id} />
      <EditorContent editor={editor} />
    </div>
  );
}
```

**关键设计决策**:
- 每个 block 独立 Tiptap 实例,而非一个大 Tiptap 实例 + top-level node 映射
- 原因:独立实例的隔离性更好(一个 block 的 parse 错误不影响其他);更容易做虚拟化(viewport 外的 block 不初始化 editor)
- 代价:跨 block 选中(用户拖选多段)需要额外实现——通过 `SelectionManager` 统一处理

#### 4.3.2 Block 保存流程

```typescript
async function handleBlockUpdate(blockId: string, content: string) {
  // 1. 乐观更新本地状态
  dispatch({ type: "UPDATE_BLOCK", blockId, content, blockVersion: block.version + 1 });

  // 2. 调 API
  try {
    const res = await patchIdeaBlock(ideaId, blockId, { content });
    // 3. 用服务端版本号覆盖
    dispatch({ type: "UPDATE_BLOCK", blockId, content, blockVersion: res.blockVersion });
  } catch (err) {
    if (err.status === 409) {
      // 版本冲突:服务端有更新的内容,回退到服务端版本
      const latest = await fetchIdeaBlocks(ideaId);
      dispatch({ type: "LOAD", blocks: latest.blocks, ideaVersion: latest.version });
    }
  }
}
```

#### 4.3.3 Block 间导航

```typescript
// frontend/src/components/IdeaEditor/useBlockNavigation.ts

/**
 * 监听 block 编辑器的 ArrowUp/ArrowDown/Enter/Backspace
 * 在 block 边界时跳转到相邻 block。
 */
function useBlockNavigation(
  order: string[],
  focusedBlockId: string | null,
  setFocused: (id: string) => void,
) {
  // ArrowUp at block start → focus previous block at end
  // ArrowDown at block end → focus next block at start
  // Enter at block end → create new paragraph block after current
  // Backspace at block start (empty block) → delete + focus previous
}
```

### 4.4 useIdeaSync hook 变更

```typescript
// frontend/src/hooks/useIdeaSync.ts (V2)

export interface IdeaSyncHandlers {
  // 保留现有 handlers
  onContentChange?: (content: string, version: number) => void;
  onRename?: (name: string) => void;
  onStreamBegin?: (payload: IdeaStreamBeginPayload) => void;
  onStreamDelta?: (payload: IdeaStreamDeltaPayload) => void;
  onStreamFinalize?: (payload: IdeaStreamFinalizePayload) => void;

  // V2 新增:block 级事件
  onBlockUpdate?: (payload: {
    blockId: string;
    content: string;
    type: string;
    props: Record<string, unknown>;
    blockVersion: number;
    ideaVersion: number;
  }) => void;
  onBlockCreate?: (payload: {
    block: IdeaBlock;
    afterBlockId: string | null;
    ideaVersion: number;
  }) => void;
  onBlockDelete?: (payload: {
    blockId: string;
    ideaVersion: number;
  }) => void;
  onBlockMove?: (payload: {
    blockId: string;
    newOrder: number;
    ideaVersion: number;
  }) => void;
}
```

事件分发新增:

```typescript
case "idea:block-update":
  h.onBlockUpdate?.(p);
  break;
case "idea:block-create":
  h.onBlockCreate?.(p);
  break;
case "idea:block-delete":
  h.onBlockDelete?.(p);
  break;
case "idea:block-move":
  h.onBlockMove?.(p);
  break;
```

### 4.5 IdeaEditor 主组件变更

```tsx
// frontend/src/components/IdeaEditor/index.tsx (V2 概要)

export default function IdeaEditor({ ideaId, ... }: Props) {
  const [state, dispatch] = useReducer(blockReducer, initialState);
  const [mode, setMode] = useState<"source" | "preview">("preview");

  // 初始化:加载 blocks
  useEffect(() => {
    fetchIdeaBlocks(ideaId).then(res => {
      dispatch({ type: "LOAD", blocks: res.blocks, ideaVersion: res.version });
    });
  }, [ideaId]);

  // SSE 同步
  useIdeaSync(ideaId, clientId, {
    onContentChange: (content, version) => {
      if (mode === "source") {
        // Source 模式:直接更新 CodeMirror
        dispatch({ type: "SYNC_CONTENT", content, version });
      }
      // Preview 模式:忽略 content-change,走 block-* 事件
    },
    onBlockUpdate: (p) => dispatch({ type: "SYNC_BLOCK", event: p }),
    onBlockCreate: (p) => dispatch({ type: "SYNC_BLOCK", event: p }),
    onBlockDelete: (p) => dispatch({ type: "SYNC_BLOCK", event: p }),
    onBlockMove: (p) => dispatch({ type: "SYNC_BLOCK", event: p }),
    // ... streaming handlers 不变
  });

  // Source 模式:从 blocks 拼接 Markdown
  const sourceContent = useMemo(() => {
    return state.order.map(id => state.blocks.get(id)?.content ?? "").join("");
  }, [state.blocks, state.order]);

  return (
    <div className="idea-editor-panel">
      {/* topbar 不变 */}
      <div className="idea-editor-body">
        {mode === "source" ? (
          <CodeMirrorSource
            value={sourceContent}
            onChange={handleSourceChange}
            // ... 其他 props 不变
          />
        ) : (
          <BlockList
            ideaId={ideaId}
            blocks={state.blocks}
            order={state.order}
            dispatch={dispatch}
            streaming={streaming}
          />
        )}
      </div>
    </div>
  );
}
```

---

## 5. Agent / MCP 工具变更

### 5.1 现有工具保留

| 工具 | 变更 |
|------|------|
| `list_ideas` | 不变 |
| `get_idea` | 不变(content 由 blocks 重建,结果一致;blocks 列表已包含) |
| `create_idea` | 不变 |
| `rename_idea` | 不变 |
| `delete_idea` | 不变 |
| `append_to_idea` | 保留(内部走 `POST /write` → 后端自动 sync) |
| `insert_into_idea` | 保留 |
| `replace_idea_content` | 保留(但标记 deprecated) |
| `update_idea_block` | 增强:支持 `baseVersion` |
| `delete_idea_block` | 不变 |
| `move_idea_block` | 不变 |
| `begin_idea_stream_write` | 保留 |
| `end_idea_stream_write` | 保留 |

### 5.2 新增工具

```typescript
// backend/mcp-server/src/tools/ideaTools.ts (V2 新增)

{
  name: "create_idea_block",
  description:
    "在 idea 指定位置插入一个新 block。afterBlockId 指定插入位置(插到此 block 后面);" +
    "省略则插到文档开头。返回新 block 的 id 和 order。",
  inputSchema: {
    type: "object",
    properties: {
      ideaId: { type: "string" },
      type: { type: "string", enum: ["heading", "paragraph", "list", "code", "quote", "divider"] },
      content: { type: "string", description: "Markdown 内容(含标记)" },
      afterBlockId: { type: "string", description: "插入到此 block 之后;省略则插到文档开头" },
    },
    required: ["ideaId", "type", "content"],
  },
  handler: async (args) => {
    const res = await apiRequest(`/api/ideas/${args.ideaId}/blocks`, {
      method: "POST",
      body: {
        type: args.type,
        content: args.content,
        afterBlockId: args.afterBlockId || null,
      },
    });
    return toolResult(res);
  },
},

{
  name: "batch_update_idea_blocks",
  description:
    "批量操作 idea 的多个 block(update/delete/create/move)。所有操作在同一个事务内执行," +
    "任一失败全部回滚。适合 Agent 一次性重组文档结构。",
  inputSchema: {
    type: "object",
    properties: {
      ideaId: { type: "string" },
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["update", "delete", "create", "move"] },
            blockId: { type: "string" },
            content: { type: "string" },
            type: { type: "string" },
            afterBlockId: { type: "string" },
            toIndex: { type: "number" },
          },
          required: ["op"],
        },
      },
    },
    required: ["ideaId", "operations"],
  },
  handler: async (args) => {
    const res = await apiRequest(`/api/ideas/${args.ideaId}/blocks/batch`, {
      method: "PUT",
      body: { operations: args.operations },
    });
    return toolResult(res);
  },
}
```

### 5.3 Streaming Write 适配

`begin_idea_stream_write` 的底层实现 (`ideaStreamSessionService.ts`) **不需要改**。原因:

1. stream 写入依然是"在某个锚点插入一段文本"
2. `finalize()` 调用 `applyIdeaWrite()` → 产出新 content → `$transaction` 内写 content + sync blocks
3. block 表由 `syncBlocksForIdea()` 自动跟随

唯一改变:finalize 后额外广播 `idea:block-create` 事件(新增的 block),让 Preview 模式的 FE 能增量更新。

### 5.4 Mention 索引适配

`mentionIndex.ts` **不需要改**——它解析的是完整 Markdown content,而 `Idea.content` 仍然由 blocks 重建并持久化。Mention 的 diff + rebuild 逻辑在 `commitBlockMutation()` 里统一执行。

`idea-block` 类型的 mention (`mention://idea-block/<blockId>?idea=<ideaId>`) 已在 PR8 实现,V2 不需新增 mention 类型。

---

## 6. 迁移计划

### 6.1 PR-A:后端 block 写 API 独立化(5 天)

**目标**:block 级写入不再需要前端发送完整 Markdown。

**改动清单**:

1. **Prisma migration**:加 `parentId` + `version` 字段
2. **新增 `POST /api/ideas/:id/blocks`** (create block at position)
3. **新增 `PUT /api/ideas/:id/blocks/batch`** (批量操作)
4. **增强 `PATCH /api/ideas/:id/blocks/:blockId`**:支持 `baseVersion` 乐观并发
5. **`commitBlockMutation()`** 函数:block 级写入的统一事务逻辑(重建 content + sections + mentions)
6. **SSE 新事件**:在 `eventBus.emitIdeaChange()` 里新增 `idea:block-update/create/delete/move`
7. **MCP 新工具**:`create_idea_block` + `batch_update_idea_blocks`
8. **测试**:
   - block create/update/delete/move → `Idea.content` 拼接一致性
   - 乐观并发:两个并发 PATCH 同一 block,第二个收到 409
   - batch 事务:一个 op 失败全部回滚

**独立产品价值**:Agent 可以精确创建 / 编排 block,不再需要拼接完整 Markdown。

### 6.2 PR-B:前端 Preview 模式 block 编辑(6 天)

**目标**:Preview 模式从"整篇 Tiptap + textarea 叠层"切换为"每 block 独立编辑器"。

**改动清单**:

1. **`BlockList.tsx`**:block 列表渲染器
2. **`BlockRenderer.tsx`**:block 类型分发
3. **6 个 block 组件**:
   - `ParagraphBlock.tsx`:Tiptap inline editor(bold/italic/code/link)
   - `HeadingBlock.tsx`:单行编辑器 + level selector
   - `CodeBlock.tsx`:CodeMirror mini(语法高亮 + language picker)
   - `ListBlock.tsx`:Tiptap list editor
   - `QuoteBlock.tsx`:Tiptap blockquote editor
   - `TableBlock.tsx`:只读 table + 点击编辑(V2 不做 inline table editor)
4. **`BlockHandle.tsx`**:hover 显示 ⋮ 菜单(拖动 / 类型转换 / 删除 / copy link)——复用现有 PR8 的 hover + click 逻辑
5. **`useBlockNavigation.ts`**:Arrow / Enter / Backspace 跨 block 导航
6. **`useBlockState.ts`**:reducer 状态管理
7. **`IdeaEditor/index.tsx`**:Preview 模式分支切换到 `<BlockList />`
8. **`useIdeaSync.ts`**:新增 block 级 SSE handler
9. **移除**:
   - `TiptapPreview.tsx` 中的 `blockHoverClick` plugin(功能移入 BlockRenderer)
   - `editingBlock` overlay textarea(不再需要)

**独立产品价值**:Preview 模式变成 Notion 风格的原地编辑。

### 6.3 PR-C:SSE block delta + Source 模式对齐(4 天)

**目标**:多人编辑时,Preview 模式用 block 级 delta 而非 content-change。

**改动清单**:

1. **后端**:block 级写入后**不再广播 `idea:content-change`**(除非来自 Source 模式的 PUT /content)
2. **前端 Preview 模式**:只监听 `idea:block-*` 事件;收到时更新对应 block 的本地状态
3. **前端 Source 模式**:仍监听 `idea:content-change`(CodeMirror 需要完整文本)
4. **冲突处理**:
   - 两个 Preview 用户改不同 block → 各收到对方的 `block-update`,本地合并(无冲突)
   - 两个 Preview 用户改同一 block → 第二个收到 409 → 回退到服务端版本
   - 一个 Source + 一个 Preview → Source 的 PUT /content 触发 content-change + sync blocks + block-* 事件都发;Preview 用户看到增量更新
5. **测试**:两 tab 同时编辑不同 block,两边都看到对方的更新

**独立产品价值**:多人编辑体验从"最后写入者胜"升级为"block 级合并"。

---

## 7. 风险与权衡

### 7.1 Source 模式的 round-trip

**风险**:Source 模式保存时走 `PUT /content`(全量 Markdown) → 后端 parseToBlocks → sync blocks。如果 `parseToBlocks` 的解析结果与用户写的 Markdown 不完全对称(比如空行归属策略),block id 可能发生不必要的变动。

**缓解**:
- PR6 已验证 `parseToBlocks` 的 byte-stable 不变式(`blocks.map(b => b.content).join("") === input`)
- `syncBlocksForIdea()` 使用 content-based matching 保持 block id 稳定(已实现)
- Source 模式保存后,Preview 用户收到 `idea:content-change` → 重新 fetch blocks → 差异最小

### 7.2 大量 block 的性能

**风险**:一篇 1000 行文档可能产生 200+ 个 block。每次 block 写入都要 `findMany + reassemble + update idea.content`。

**缓解**:
- `Idea.content` 重建是纯字符串 concat,200 个 block 在 ~1ms 内完成
- mention rebuild 是 `O(content.length)` regex 扫描,与当前一致
- 数据库写入:一次 `UPDATE idea` + 一次 `deleteMany mention` + `createMany mention` = 3 条 SQL,与当前一致
- 若 block 数量 > 1000(极端场景),考虑:
  - 推迟 `Idea.content` 重建到读时(lazy materialization)
  - mention 增量 diff 而非全量重建

### 7.3 Tiptap 实例数量

**风险**:每个 block 一个 Tiptap 实例 → 200 个 block = 200 个 ProseMirror 实例 → 内存 + CPU。

**缓解**:
- **虚拟化**:只为 viewport 内的 block 创建 Tiptap 实例(~20 个),其他渲染为静态 HTML
- **实例池**:viewport 滚动时复用 Tiptap 实例而非销毁 + 重建
- **轻量化**:block 编辑器只加载该类型需要的 extension(段落不需要 table/code 扩展)

### 7.4 CRDT 前置

**关系**:block tree 是 CRDT 的前置条件,但本方案不引入 CRDT。

**V2 block tree 的设计已兼容 CRDT 路径**:
- 每个 block 有独立 `id` + `version` → 可直接作为 CRDT document 的 item id
- `order: Float` (fractional indexing) → 对应 Yjs `Y.Array` 的插入语义
- block 内容是 Markdown 字符串 → 可用 `Y.Text` 包裹实现字符级协作
- 跨 block 操作(split/merge)→ 需要 CRDT 事务,PR11 时设计

### 7.5 向后兼容

**旧 FE**:仍能通过 `GET /api/ideas/:id` 拿到 content + `PUT /api/ideas/:id` 保存。后端 sync 逻辑保证 block 表与 content 一致。

**旧 Agent 工具**:`append_to_idea` / `insert_into_idea` 仍工作(走 `POST /write` → `applyIdeaWrite` → sync blocks)。

**第三方集成**:Markdown import/export 不受影响(`Idea.content` 仍是完整 Markdown)。

---

## 附录 A:文件变更清单

### PR-A (后端)

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `backend/prisma/schema.prisma` | 修改 | IdeaBlock 加 parentId + version |
| `backend/src/routes/ideaRoutes.ts` | 修改 | 新增 POST /blocks, PUT /blocks/batch, 增强 PATCH |
| `backend/src/services/ideaBlockService.ts` | 修改 | 新增 commitBlockMutation, createBlock, batchUpdate |
| `backend/src/services/eventBus.ts` | 修改 | 新增 block 级事件类型 |
| `backend/src/routes/sseRoutes.ts` | 修改 | 转发 block 级事件 |
| `backend/mcp-server/src/tools/ideaTools.ts` | 修改 | 新增 create_idea_block, batch_update_idea_blocks |
| `backend/src/schemas/ideaBlock.ts` | 新增 | 共享 block 类型定义(route + MCP) |

### PR-B (前端)

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `frontend/src/components/IdeaEditor/index.tsx` | 修改 | Preview 模式分支切到 BlockList |
| `frontend/src/components/IdeaEditor/BlockList.tsx` | 新增 | block 列表渲染器 |
| `frontend/src/components/IdeaEditor/BlockRenderer.tsx` | 新增 | block 类型分发 |
| `frontend/src/components/IdeaEditor/blocks/ParagraphBlock.tsx` | 新增 | |
| `frontend/src/components/IdeaEditor/blocks/HeadingBlock.tsx` | 新增 | |
| `frontend/src/components/IdeaEditor/blocks/CodeBlock.tsx` | 新增 | |
| `frontend/src/components/IdeaEditor/blocks/ListBlock.tsx` | 新增 | |
| `frontend/src/components/IdeaEditor/blocks/QuoteBlock.tsx` | 新增 | |
| `frontend/src/components/IdeaEditor/blocks/TableBlock.tsx` | 新增 | |
| `frontend/src/components/IdeaEditor/blocks/BlockHandle.tsx` | 新增 | hover ⋮ 菜单 |
| `frontend/src/components/IdeaEditor/useBlockState.ts` | 新增 | reducer 状态管理 |
| `frontend/src/components/IdeaEditor/useBlockNavigation.ts` | 新增 | 跨 block 键盘导航 |
| `frontend/src/hooks/useIdeaSync.ts` | 修改 | 新增 block 级 handler |
| `frontend/src/api.ts` | 修改 | 新增 createIdeaBlock, batchUpdateIdeaBlocks |
| `frontend/src/components/IdeaEditor/TiptapPreview.tsx` | 移除 | 被 BlockList 替代 |

### PR-C (SSE 优化)

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `backend/src/routes/ideaRoutes.ts` | 修改 | block 写入时广播 block-* 而非 content-change |
| `frontend/src/components/IdeaEditor/index.tsx` | 修改 | Preview 只听 block-*,Source 只听 content-change |
| `frontend/src/hooks/useIdeaSync.ts` | 修改 | 条件分发逻辑 |

---

## 附录 B:API 端点完整列表(V2 后)

| 方法 | 路径 | 说明 | 版本 |
|------|------|------|------|
| GET | /api/ideas?workspaceId= | 列表 | V1 |
| POST | /api/ideas | 创建 | V1 |
| GET | /api/ideas/:id | 详情(含 content) | V1 |
| PUT | /api/ideas/:id | 全量保存 content (deprecated) | V1 |
| PATCH | /api/ideas/:id | 重命名 | V1 |
| DELETE | /api/ideas/:id | 删除 | V1 |
| POST | /api/ideas/:id/write | anchor 写入 | V1 |
| GET | /api/ideas/:id/blocks | 读 block 列表 | PR6 |
| PATCH | /api/ideas/:id/blocks/:blockId | 更新 block | PR8 (V2 增强) |
| DELETE | /api/ideas/:id/blocks/:blockId | 删除 block | PR8 |
| POST | /api/ideas/:id/blocks/:blockId/move | 移动 block | PR8 |
| **POST** | **/api/ideas/:id/blocks** | **创建 block** | **PR-A** |
| **PUT** | **/api/ideas/:id/blocks/batch** | **批量 block 操作** | **PR-A** |
| POST | /api/ideas/:id/stream/begin | 开启流式写入 | V2 |
| POST | /api/ideas/stream/:sessionId/end | 关闭流式写入 | V2 |
| POST | /api/ideas/:id/attachments | 上传附件 | PR5 |
