# Roadmap:Skill V1 之后

> 起点:2026-04-28,Skill Creator V1 已上线(DB-first,6 Tier 0 工具,85/89 测试通过)
> 范围:Skill V2 fs 化 + Idea 朝 Notion / 飞书文档级体验渐进迁移

## 总览

| PR | 内容 | 估时 | 阻塞下一个? | 单独产品价值 |
|---|---|---|---|---|
| **PR4-prep** | `BlobStorage` 抽象层(launch 切 S3 的对冲) | 1.5 天 | PR4 / PR5 | 无(架构投资) |
| **PR4** | Skill V2:fs 化(SKILL.md 双层结构,workflows 单独文件) | 5 天 | — | Agent 透明 / 可手编辑 / 可导出 |
| **PR5** | Idea attachment 管线(图 / SVG / PDF / 视频上传) | 3 天 | — | 立刻能贴图 |
| **PR6** | Idea schema 双轨:DB 多一张 `IdeaBlock` 表,写时 parse + 持久化 | 5 天 | PR7-PR10 | 后端层准备 block,FE 不变 |
| **PR7** | FE block 渲染:替换 react-markdown 整篇渲染,逐 block React 组件 + viewport 虚拟化 | 6 天 | PR8 / PR10 | 大文档不卡顿 |
| **PR8** | Block 级交互:hover ⋮ → 拖动 / 复制 link / 删除 / 转 toggle | 4 天 | — | **L2 落地**(Notion-style 交互) |
| **PR9** | Block 级评论(基于 Conversation + parentBlockId) | 4 天 | — | 真正的多人协作起点 |
| **PR10** | 富 block 类型:toggle / callout / column / inline-Table-view / equation | 6 天 / 类型 | — | **L3 落地**(Notion 富类型) |
| **PR11** | (可选)CRDT / Yjs:多人无锁实时协作 | 4-6 周 | — | **L4**(等 DAU > 100 再做) |

总计前 10 个 PR ≈ **6-8 周**(单人全栈,不算 PR11)。

---

## PR4-prep — `BlobStorage` 抽象层

**目标**:让所有"将来要切 S3 / OSS"的 fs 写入都从首日就走抽象。launch 时只需加 `S3Storage` 实现 + env 切换 + 跑迁移脚本,应用代码 0 改动。

**改动**:
- 新建 `backend/src/services/storage/blobStorage.ts`(interface)
- 实现 `LocalFsStorage`(`fs.promises` + stream)
- env 切换 `BLOB_STORAGE_BACKEND=local|s3` + `FUNATURE_HOME`（兼容旧 `IMAGEBASE_HOME`）
- 收口现有 7 处 `fs.*` 调用(`agentService` / `demoRoutes` / `tasteRoutes` / `analyst/*`),**两个例外**:`agent-worktrees/`(git worktree 必须本地 inode)+ `analyst/sessions/*.duckdb`(DuckDB 需本地 fs)
- 单元测试 LocalFsStorage

**收益**:launch.checklist 0.2 节从"改 7 处 fs 调用"降到"加一个 S3Storage 类 + 跑迁移脚本"。

**详见**:`docs/launch-checklist.md` Pre-Launch Prep 段。

---

## PR4 — Skill Creator V2:fs 化

**目标**:Skill 从纯 DB 模型升级为 **fs-first**,每个 skill 是一个目录:

```
~/.imagebase/agents/<agentId>/skills/<skillId>/
  SKILL.md                  # YAML frontmatter + Markdown body
  workflows/                # 单独文件,frontmatter manifest 列出
    0.json
    1.json
  references/               # (可选,V2 不强求)模板 / 示例
```

`SKILL.md`:

```markdown
---
id: cmoii785q00007ikdo79t0yuf
name: tech-research
description: 调研某个技术的最新进展并写入 idea
when_to_use: 用户说"调研 X 技术"/"了解最新 X"
triggers: [调研, research, 了解最新]
allowed_tools: [web_search, web_fetch, create_idea, append_to_idea]
workflows:
  - file: workflows/0.json
    title: bilingual-review
created_at: 2026-04-28T12:34:56Z
updated_at: 2026-04-28T12:34:56Z
---

## 流程
用户说"调研 X 技术"时:
1. web_search(X latest release notes, timeRange:"month")
2. ...
```

**改动**:
- 新建 `services/userSkill/skillFs.ts`:read/write SKILL.md(YAML frontmatter parse + Markdown body)+ workflows/*.json + manifest 同步
- Prisma schema:`UserSkill` → `UserSkillIndex { id, ownerType, ownerId, name, dirPath, enabled, invokedCount, lastInvokedAt }`(瘦索引)
- migration:把现有 DB 的 user skill row 全部下沉到 fs(读 promptFragment / workflowDocs / triggers / etc. → 拼成 SKILL.md + workflows/ → 写文件 → 删原行)
- userSkillStore + userSkillRegistry 改 fs-first(读 fs,DB 仅 index 用于 list / enable 状态)
- 6 个 Tier 0 工具改造:
  - `update_skill` 支持 frontmatter 字段级 patch + body anchor-based 编辑(类似 idea_write_anchor)
  - `read_skill(id)` 新增,返回完整 body + workflow manifest
  - 其它 4 个签名不变,内部走 fs
- 走 BlobStorage(PR4-prep 抽象层),fs 路径无 hardcode
- 回归测试 PR1-3 driver(`scripts/skill-pr{1,2,3}-test.ts`)

**测试**:新建 `skill-pr4-test.ts`,覆盖 SKILL.md round-trip / migration script / fs↔DB index 一致性 / anchor-based update。

**风险点**:migration 一次性,需要 dry-run + diff 校验。

---

## PR5 — Idea attachment 管线

**目标**:让 Idea 能贴图 / SVG / PDF / 视频。资产存 fs(走 BlobStorage),Markdown 主体存 URL 引用。Notion / 飞书 / Lark / GitLab 同款模式。

**改动**:
- 新建 Prisma `IdeaAttachment { id, ideaId, hash, mime, size, originalName, uploadedBy, createdAt }`
- 新建 `POST /api/ideas/:ideaId/attachments`(multipart):
  1. 校验 mime + size(image 10MB / SVG 1MB / PDF 20MB / video 100MB)
  2. SHA-256 hash → 存 `~/.imagebase/idea-attachments/<wsId>/<hash>.<ext>`(走 BlobStorage)
  3. 落 IdeaAttachment 行
  4. 返回 `{ url: "/api/idea-attachments/<filename>", id }`
- 新建 `GET /api/idea-attachments/:filename`:从 BlobStorage 流式返回,带 cache-control(公网 immutable,因为 hash 命名)
- FE IdeaEditor:加 paste / drop / 上传按钮,自动转 `![alt](url)` 写入 Markdown
- Agent 工具 `upload_to_idea(ideaId, base64, mime, name)`,让 Agent 也能贴图
- 删 idea 时 cascade:扫 IdeaAttachment.ideaId → 一一删 BlobStorage 对象 + 删 row
- Mention 不变(图片是资产,不是引用)

**测试**:上传 / 读取 / 流式 / cascade 删除 / size 上限 413 / mime sniff(防止 .exe 改后缀混进来)。

---

## PR6 — Idea schema 双轨:`IdeaBlock` 表

**目标**:不动 FE,**后端层把 Markdown 字符串和 block 行做双向同步**,为 PR7-PR10 的 block-based UI 铺路。

**改动**:
- 新建 Prisma `IdeaBlock`:
  ```prisma
  model IdeaBlock {
    id            String  @id @default(cuid())
    ideaId        String
    parentBlockId String?
    order         Float   // 用 float 方便插入(类似 Linear 的 fractional indexing)
    type          String  // "heading" | "paragraph" | "list" | "code" | "image" | "table" | "html" | ...
    content       String  // 这块的 Markdown / JSON
    props         Json    // 类型特有属性(如 heading level / language / image url)
    createdAt     DateTime
    updatedAt     DateTime
    @@index([ideaId, order])
    @@index([parentBlockId])
  }
  ```
- 写路径:`PUT /api/ideas/:id/content` 仍接收 Markdown,内部 `parseToBlocks(content)` → `Idea.content` 仍存(兼容旧客户端读)+ `IdeaBlock.deleteMany + createMany` 落库,跑在同一个 `$transaction` 里
- 读路径:旧 API `GET /api/ideas/:id` 仍返回 Markdown(unchanged);新增 `GET /api/ideas/:id/blocks` 返回 block 树
- Mention 改 per-block 索引:`Mention.targetId = "<ideaId>#<blockId>"`(blockId 永久稳定,`#<slug>` 在 heading 重命名时会失效)。同时迁移现有 mention rows
- 加测试:Markdown ↔ blocks round-trip 完整性(parse → blocks → 重新拼回 Markdown,应等价)

**FE**:不动。仍用 `react-markdown` 整篇渲染。这一步纯后端。

**收益**:留好升级口子,PR7 起 FE 可以渐进切 block 渲染,后端不再变。

---

## PR7 — FE block-renderer + viewport 虚拟化

**目标**:替换 `react-markdown` 整篇渲染,**每个 block 是独立 React 组件**,大文档自然不卡顿。

**改动**:
- 新建 `frontend/src/components/IdeaEditor/BlockRenderer/`:
  - `Heading.tsx` / `Paragraph.tsx` / `List.tsx` / `CodeBlock.tsx` / `ImageBlock.tsx` / `HtmlBlock.tsx` / `TableBlock.tsx` / `Divider.tsx` / `Quote.tsx`
  - 每个组件接收 `IdeaBlock` 行数据,自己渲染 + 内联编辑
- 主组件 `IdeaEditor` 改成 `blocks.map(b => <BlockRenderer block={b} />)`,加 `react-virtual` / `react-window` 视口虚拟化(只渲染可见的 block,长文档无压力)
- 从 `GET /api/ideas/:id/blocks` 拿数据(PR6 加的)
- 编辑保存:仍走 `PUT /content`(后端会重新 parse + 同步 blocks)。**但 FE 内部已经按 block 维护编辑状态**,为 PR8 铺路
- SSE `idea:content-change` 暂仍接收全文,PR9 / 后续优化为 block 级 delta

**收益**:
- 大文档(1MB+)滚动 / 编辑无卡顿
- 图片懒加载(IntersectionObserver)
- 数学公式 / 代码高亮 / table 等富类型独立组件,互不干扰

**测试用例**:写一篇 100 段 markdown,FE FPS / interaction 延迟达标。

---

## PR8 — Block 级交互(L2 落地)

**目标**:每个 block 悬浮显示 ⋮ 菜单,支持拖动 / 复制 link / 删除 / 类型转换。

**改动**:
- BlockRenderer 加 hover 状态,左边显示 `⋮` handle
- 拖拽:`@dnd-kit/sortable`,改 `block.order`(fractional indexing)
- 右键菜单 / ⋮ 菜单:`复制 block 链接`(`/idea/:ideaId#block-:blockId`,跳转时滚动到 block + 闪一下高亮)/ `删除` / `转 toggle / heading / quote`(同 type 转换)
- block-link 路由:`App.tsx` 解析 `#block-:id` query → focus 滚动 + 高亮
- Mention 选项里加"插入对某 block 的引用"(`mention://idea-block/<ideaId>/<blockId>`)
- Agent 工具 `update_idea_block(blockId, patch)` / `delete_idea_block(blockId)` / `move_idea_block(blockId, newPosition)`

**收益**:Notion 体验的最关键交互层。用户开始能"指向某段对话"而不是"指向整篇 idea"。

---

## PR9 — Block 级评论

**目标**:任一 block 可以挂评论,评论用现有 Conversation 模型。

**改动**:
- `Conversation` 加 `attachedToType String? + attachedToId String?`(`"idea-block"` + `<ideaId>#<blockId>`)
- IdeaEditor block 右侧 hover 显示气泡 `+`,点击开新 conversation 挂在这个 block 上
- IdeaEditor 顶栏 / 侧栏显示"X 个 block 有评论",过滤 / 跳转
- 已存在的 ChatSidebar 加 attachment context:聊天里能看到"用户正在 idea Y 的 block X 上评论",Agent 自动 load 那段 block 内容到 turn context
- SSE `comment:create / comment:resolve` 广播到看同一 idea 的所有客户端

**收益**:多人异步协作的关键能力。Notion 也是这套。

---

## PR10 — 富 block 类型(L3 落地)

**目标**:把 Notion 标志性的几个富类型补齐。可以拆成多个独立 PR,每个独立上线。

候选(按价值排序):

| 子 PR | 类型 | 估时 | 价值 |
|---|---|---|---|
| **PR10a** | Toggle / Collapsible | 2 天 | 长文 TOC 折叠,体验直接拉满 |
| **PR10b** | Callout(带 icon 的高亮卡片) | 1 天 | 强调 / 提示 / 警告语义 |
| **PR10c** | Column layout(2-3 列并排) | 3 天 | 富排版基础 |
| **PR10d** | Inline Table view(把 workspace 里的 Table artifact 嵌入 idea,带 filter / sort) | 6 天 | **打通 Idea + Table,差异化亮点** |
| **PR10e** | Equation / KaTeX block | 1 天 | 写技术 / 学术内容必备 |
| **PR10f** | Embed(YouTube / Figma / Tweet / 任意 URL → preview card) | 3 天 | 信息聚合 |
| **PR10g** | Synced block(同一段在多 idea 间同步,改 A 自动改 B) | 6 天 | Notion synced-block,高级用法但一旦上瘾就离不开 |

**建议**:先做 10a + 10b + 10d(toggle / callout / inline-Table),其它按需求迭代。

---

## PR11 — CRDT / Yjs(L4,选做)

**目标**:多人无锁实时协作。两个用户同时改同一段不冲突,自动合并。

**改动巨大**,简述方向:
- 引入 `yjs` + `y-prosemirror` / `y-tiptap`(看选哪套 editor)
- IdeaEditor 重写为 Yjs-aware editor,本地 doc 是 `Y.Doc`
- 后端加 op 同步层:WebSocket 协议替代当前 SSE(`y-websocket` 服务端)
- 持久化策略:每 N ops 或 N 秒 snapshot 一次到 DB,ops 走 op_log 表 append-only
- 离线编辑 + 联网自动 sync(CRDT 天然支持)

**何时做**:
- DAU > 100 且明确用户场景是"团队同时改一篇" → 立刻
- 否则:**别做**。维护成本巨大,产品价值在小团队不够明显

---

## 决策需要你拍的事

1. **PR4-prep 是否同意先做?**(必须先做,1.5 天)
2. **PR4 + PR5 顺序**?我建议 PR4 先,PR5 紧接,但你优先级反过来也行(图片功能用户能立刻感知到收益)
3. **PR6-PR10 的 block 改造,要不要按 sprint 节奏排进?** 还是先做 PR4 / PR5 看反馈,再决定 block 改造的时机?
4. **PR11 (CRDT) 何时讨论?** 我倾向等 DAU 数据再说,你呢?

---

## 时间线建议

| 月 | 内容 |
|---|---|
| **M1** | PR4-prep + PR4(Skill fs 化)+ PR5(Idea attachment)— Skill / 资产能力补齐 |
| **M2** | PR6 + PR7 — 后端 block 双轨 + FE block-renderer。FE 体验已经超过当前 |
| **M3** | PR8 + PR9 — 交互层 + 评论。Notion 体验 80%+ |
| **M4** | PR10a-c-d — 富 block 类型上线。Notion 体验 95%+ |
| **M5+** | PR10 余项 + 评估 PR11 |

5 个月走完前 10 个 PR(扣假期 / 临时插需求),做完后产品在 idea + skill 维度已经能正面对标 Notion / 飞书文档。

---

## 关键洞察(回顾)

1. **Skill 该 fs,Idea 不该**(已论证)。但**Idea 的图片该 fs**(走附件管线)
2. **Idea 现在的 single-TEXT 是天花板**,要走飞书级体验,**block-based 改造是必经之路**(不是可选)
3. **block 改造可以渐进**(PR6-PR10 拆分),不必一次性 4 周大改
4. **CRDT 别太早上**,小团队场景价值低、维护成本高
5. **抽象层早做不晚做**(PR4-prep 1.5 天,launch 时省一周改 fs 调用的时间)
