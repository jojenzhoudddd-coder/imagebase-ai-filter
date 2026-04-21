# Idea（灵感）Artifact 方案

分支：`Artifact_idea`（从 `BeyondBase` 切出）

## 1. 目标

新增第三类 Workspace 实体 —— "灵感"（Idea，Markdown 文档），与 Table / Design(Taste 画布) 并列。v1 覆盖：

1. 侧边栏 New → "灵感"（zh）/ "Idea"（en）创建文档，名称重复自动加 ` N` 后缀
2. 单窗口 Markdown 编辑器：`Cmd/Ctrl + /` 切换源码 / 渲染
3. 防抖自动保存 + 工作区 / 实体双层 SSE 实时感知他人编辑（last-writer-wins + 版本号冲突）
4. 内容区左右各 60px 留白，自适应换行
5. `@` 唤起下拉菜单关联 table / field / record / taste；被 @ 实体蓝色 chip，点击跳转并高亮 / 选中

## 2. 数据模型

### Prisma
```prisma
model Idea {
  id          String   @id @default(cuid())
  workspaceId String
  name        String
  parentId    String?
  order       Int      @default(0)
  content     String   @default("")
  version     Int      @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
  @@index([parentId])
  @@map("ideas")
}
```
`Workspace` 增 `ideas Idea[]`。

### Mention 持久化格式
Markdown 原生链接：
```
[@label](mention://table/<id>)
[@label](mention://field/<id>?table=<tableId>)
[@label](mention://record/<id>?table=<tableId>)
[@label](mention://taste/<id>?design=<designId>)
```
- `id` 权威；label 渲染时按 id 反查实体最新名（有缓存），避免 rename 后失真
- 实体被删除：渲染灰态 + "已删除" tooltip
- 纯 Markdown，导出可降级为普通链接文本

## 3. 后端 API

### REST 路由（新文件 `backend/src/routes/ideaRoutes.ts`）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/ideas` | 创建；body `{name?, workspaceId, parentId?}` |
| GET | `/api/ideas/:id` | 详情（含 `content, version`） |
| PUT | `/api/ideas/:id` | 保存内容；body `{content, baseVersion}`；版本冲突 409 `{latest, conflict:true}` |
| PATCH | `/api/ideas/:id` | 重命名 / 移动 / 排序 |
| DELETE | `/api/ideas/:id` | 删除 |
| GET | `/api/workspaces/:id/mentions/search?q&types&limit` | @ 搜索 |

### Workspace Tree 扩展
`fetchWorkspaceTree` 返回追加 `ideas: IdeaBrief[]`（`IdeaBrief` = 不含 content 的元信息）。

### SSE
- Workspace 通道追加：`idea:create / idea:rename / idea:delete / idea:reorder / idea:move`
- 新增实体通道：`GET /api/sync/ideas/:id/events?clientId=`，事件：
  - `idea:content-change` `{content, version, clientId}`
  - `idea:rename` `{name, clientId}`

### apiMoveItem 支持 idea
`folderRoutes.ts` 的 move handler 加 `type === "idea"` 分支。

### dbStore 新增
- `generateUniqueIdeaName(workspaceId, base, excludeId?)` —— 复用 Design 的算法（`base`, `base 2`, `base 3`）

### MCP 镜像（Tier 2 `idea-skill`，延后至 Day 5；不阻塞 v1）
- `list_ideas / get_idea / create_idea / rename_idea / delete_idea / update_idea_content / search_mentions`
- `delete_idea` 标 `danger:true`

## 4. 协作一致性（保守方案，非 CRDT）

- PUT 携带 `baseVersion`
- 服务端发现 `current !== baseVersion` → 409 `{latest:{content,version}}`
- 前端根据"是否正在打字（最近 2s 有按键）"决定：
  - 空闲：静默用 latest 覆盖
  - 正在打字：弹提示"另一位用户更新了此文档" + `保留我的 / 加载最新`
- SSE 推 `idea:content-change` 采用同样策略

## 5. 前端

### 5.1 Sidebar
- `Sidebar.tsx` 中将原占位键 `doc` 改名为 `idea`；去掉 `noop: true`；接 `onCreateIdea` prop
- `TreeItemType` 增 `"idea"`
- `TreeView` 支持 idea 图标（复用 `CM_ICONS.doc`），active 判定、拖拽同 Design

### 5.2 IdeaEditor 组件（镜像 SvgCanvas topbar）

```
frontend/src/components/IdeaEditor/
  index.tsx          # 容器：mode、content、保存、SSE
  SourceMode.tsx     # <textarea> + caret @ 捕获
  PreviewMode.tsx    # react-markdown + rehype-raw + rehype-sanitize + mention-link plugin
  MentionPicker.tsx  # @ 浮层
  MentionChip.tsx    # 预览蓝 chip，onClick → navigateToEntity
  IdeaEditor.css
```

**Topbar 布局与 SvgCanvas 一致**（44px / InlineEdit 名称 / 右侧 actions）：
- 左：`InlineEdit` 名称（14px / 500 weight）
- 右：`源码 | 渲染` segmented + 分隔线 + 保存状态（saving / saved）+ 分隔线 + 溢出（…）
- 按钮：28px 高，transparent 背景，hover 填充，active 色主题色 light

**内容区**：`padding: 24px 60px`；`overflow-y: auto`；textarea 和 preview 均 `width: 100%`

**快捷键**：编辑器容器 `onKeyDown` 监听 `Cmd/Ctrl + /` 切 mode

### 5.3 自动保存
- `content` 变 → 防抖 800ms → PUT `/api/ideas/:id`
- sidebar 条目带小圆点标记未保存
- `beforeunload` 用 `navigator.sendBeacon` 强制 flush

### 5.4 Markdown 渲染栈
```
content
→ react-markdown
  + remark-gfm
  + rehype-raw
  + rehype-sanitize (白名单：svg / g / path / circle / rect / line / polygon / polyline / ellipse / defs / use / viewBox / width / height / fill / stroke 等)
  + 自定义 rehype-mention-links (识别 href="mention://..." 替换 <MentionChip>)
```
XSS 防御：strip `<script>`、事件属性、`javascript:` 协议。

### 5.5 MentionPicker
- `SourceMode` 的 textarea `onKeyDown` 捕获 `@`，记录 caret pixel 坐标（用 `getCaretCoordinates` 辅助函数）
- 防抖 150ms → GET `/api/workspaces/:id/mentions/search?q=&types=table,field,record,taste&limit=10`
- 按类型分组展示：表 / 字段 / 记录 / 图片
- Enter 插入 `[@label](mention://type/id[?table=|design=])`，光标落到 `)` 后

### 5.6 focusEntity 全局状态
```ts
type FocusEntity =
  | { type: "field";  id: string }
  | { type: "record"; id: string }
  | { type: "taste";  id: string };
```
- 由 MentionChip 触发 `navigateToEntity(ref)`：切 `activeItemType` / `activeTableId`，再 setFocusEntity
- TableView 监听 `focusEntity` → 滚动 + 列头 / 行高亮 1.5s
- SvgCanvas 监听 → `setSelectedId` + pan to center
- 触发后 1.5s 自动 clear，避免重复触发

## 6. 文件清单

### 新建
- `backend/prisma/migrations/<ts>_add_ideas/migration.sql`
- `backend/src/schemas/ideaSchema.ts`
- `backend/src/routes/ideaRoutes.ts`
- `frontend/src/hooks/useIdeaSync.ts`
- `frontend/src/components/IdeaEditor/index.tsx` + 5 个子组件 + CSS
- `docs/idea-artifact-plan.md`（本文件）

### 修改
- `backend/prisma/schema.prisma` + `Workspace.ideas`
- `backend/src/services/dbStore.ts`：`generateUniqueIdeaName`、`fetchWorkspaceTree` 含 ideas
- `backend/src/services/eventBus.ts`：`WorkspaceChangeEvent` 新增 idea:*；新增 `subscribeIdea / emitIdeaChange`
- `backend/src/routes/sseRoutes.ts`：idea 实体通道
- `backend/src/routes/folderRoutes.ts`：move 支持 idea
- `backend/src/index.ts`：挂 ideaRoutes
- `backend/src/types.ts`：`IdeaBrief / IdeaDetail / MentionSearchHit`
- `frontend/src/types.ts`：`TreeItemType` 加 `"idea"`，对应类型
- `frontend/src/api.ts`：六件套 + mention search + SSE 订阅
- `frontend/src/hooks/useWorkspaceSync.ts`：新 handlers
- `frontend/src/App.tsx`：`documentIdeas`、`handleCreateIdea`、`focusEntity`、`navigateToEntity`、`activeItemType === "idea"` 分支
- `frontend/src/components/Sidebar.tsx`：activate idea 入口
- `frontend/src/components/TreeView.tsx`：idea 支持
- `frontend/src/components/TableView/*`：接 focusEntity
- `frontend/src/components/SvgCanvas/index.tsx`：接 focusEntity
- `frontend/src/i18n/en.ts` / `zh.ts`：`sidebar.idea`、`idea.*`、`toast.createIdeaFailed`
- `CLAUDE.md`：架构段 + 文件清单 + MCP 同步表（idea 行留空，v1 延后）
- `docs/design.md` / `docs/test-plan.md` / `docs/changelog.md`

### 前端依赖
```
react-markdown ^9
remark-gfm ^4
rehype-raw ^7
rehype-sanitize ^6
```

## 7. 验证（P0）

1. 侧边栏 → New → 灵感，连点 3 次得到 "灵感"、"灵感 2"、"灵感 3"（en: Idea, Idea 2, Idea 3）
2. 重命名冲突：改为已占用名自动变 " N" 后缀
3. `Cmd/Ctrl + /` 切换源码 / 渲染
4. 输入 5s 后刷新，内容仍在
5. 浏览器 A/B 分别打开同一 Idea，A 编辑 → B 看到更新
6. A/B 同时编辑 → 后提交者收到 conflict UI
7. Markdown 基本语法正确渲染
8. 内嵌合法 `<svg>` 渲染；`<script>` 被 strip
9. `@项目` → 下拉命中表 / 字段 / 记录 / 图片；选中后源码插入 `[@x](mention://...)`
10. 预览 chip 点击：table → 切表；field → 切表 + 列头高亮；record → 切表 + 行高亮；taste → 切 Design + 选中该 taste
11. 拖入 Folder / 删除 / 语言切换默认名随之切

## 8. 风险

| 风险 | 预案 |
|---|---|
| @ 浮层 caret 定位错位 | 用 `textarea-caret-position` 库 / 小工具 |
| SVG 嵌入样式越界 | `.idea-preview svg { max-width:100% }` 兜底 |
| 协同编辑非 CRDT 丢字 | 文档里注明 Known Limitation；用户提示保留/加载最新 |
| Prisma 迁移没跑 | 部署 Checklist 加一条；CI preflight |
