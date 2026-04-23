# Vibe Demo（Vibe design + Vibe coding）· 实现方案

> 让 Chat Agent 具备生成 / 编译 / 部署 / 预览可运行前端代码的能力。最终产物是一类名为 **Demo** 的 workspace artifact，与 Table / Idea / Design 并列，支持独立 URL、发布到公开链接、直接读写所关联 Table 的真实数据。
>
> 本文定稿于 2026-04-23。分 V1（基建+核心）→ V2（修复 loop+代码查看）→ V3（精细化权限）→ V4（自定义域）→ V5（打磨） 共 5 次发布，约 10 周单人工期。

---

## 0 · 核心决策（已与用户锁定）

| 决策点 | 结论 |
|---|---|
| 产物形态 | **前端静态 bundle**（HTML + JS + CSS），V1 支持 `static` 和 `react-spa` 两种模板 |
| 运行环境 | **云端 iframe 预览** 为默认；导出 zip 作为 power user 路径；**不做 localhost/WebContainer**（留给未来 CS 产品） |
| 构建工具 | Backend **esbuild Node API**（已有 vite 链路复用），bundle React/TSX → JS |
| 发布机制 | **立即可用** `https://www.imagebase.cc/share/:slug`（同域），同文件 serve，**直读写活 Table / 读 Idea**（非 snapshot） |
| 数据访问 | **Demo 自带 SDK**（`window.ImageBase`）直连 workspace 内声明过的 Table **和** Idea |
| SDK · Table | **7 种记录级操作**（query / getRecord / describeTable / createRecord / updateRecord / deleteRecord / batch*）；schema 操作架构级封死 |
| SDK · Idea | **2 种只读操作**（listIdeas / readIdea）；写入不暴露（Idea streaming write 协议过于复杂，留在 V2+ 评估） |
| 权限粒度 | **per-resource capability 声明**：`{"tb12345678": ["query", "createRecord"], "ide12345678": ["readIdea"]}` |
| 发布二次确认 | 弹窗列出每张表 / 每份 Idea 暴露的能力 + 警告 "URL 不需登录即可访问" |
| URL 路由 | **所有 artifact 用可读长路径**：`/workspace/:wsId/{table,idea,design,demo,conversation}/:id` 内部；`/share/:slug` 公开 Demo |
| ID 格式 | **新 ID 统一**：`tb` / `ts` / `dg` / `dm` / `ide` / `ws` / `cv` / `ag` / `rc` / `fd` / `vw` 前缀 + **12 位数字**；存量数据不改（路由层兼容新旧格式） |
| 规模限制 | **不做硬上限**（prompt 层柔性引导单文件 ≤ 800 行 / 文件数 ≤ 10，build 实际超时 30s 作为物理兜底） |
| Vibe 分流 | **两个独立 skill** + **阶段化路由**：有设计意图先走 vibe-design（定稿 → token），再 vibe-coding 按 token 实现；无设计意图（"给我搭 CRM"）直接走 vibe-coding |
| 构建失败 | **Agent 自动 retry 最多 2 次**，失败后让用户介入 |
| 权限模型 | 架构边界（handler 不存在）+ 声明边界（capability 白名单）双层隔离 |
| 限流 | Per (demoId, IP, op-family) 滑动窗口：读 200/min · 写 30/min · 日 100k/10k 兜底 |
| 数据沙箱 | **V1 不做**，published demo 直连活数据；用户知晓 + 发布确认提示 + URL slug 12 位不可枚举 |

---

## 1 · 架构总览

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Frontend (React SPA)                          │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  React Router (V1 新引入)                                       │   │
│  │    /                                        → redirect          │   │
│  │    /workspace/:workspaceId                  → 首页              │   │
│  │    /workspace/:workspaceId/table/:id        → Table             │   │
│  │    /workspace/:workspaceId/idea/:id         → Idea              │   │
│  │    /workspace/:workspaceId/design/:id       → Design            │   │
│  │    /workspace/:workspaceId/demo/:id         → Demo（私有预览）  │   │
│  │    /workspace/:workspaceId/conversation/:id → Chat 对话         │   │
│  │    /share/:slug                             → 已发布 Demo（公开）│  │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  ┌────────────────────┐   ┌──────────────────────────────────────┐ │
│  │  ChatSidebar       │   │  DemoPreviewPanel                      │ │
│  │  ├ ToolCallCard    │   │  ├ Toolbar (build/publish/export)      │ │
│  │  ├ CodingFlowCard  │   │  ├ <iframe src="/api/demo/:id/"> ──┐  │ │
│  │  │  (新多步可视化) │   │  ├ DemoFileTree                    │  │ │
│  │  └ ...             │   │  └ BuildLogPanel                   │  │ │
│  └────────────────────┘   └────────────────────────────────────┼──┘ │
└──────────────────────────────────────────────────────────────┼─────┘
                                                                  │
                       ┌──────────────────────────────────────────┘
                       │
                       ▼  (fetch '/api/demo-runtime/:id/query' etc.)
┌──────────────────────────────────────────────────────────────────────┐
│                       Backend (Express)                               │
│                                                                        │
│  ┌────────────────────────────────────────────────────────────────┐│
│  │  /api/demo-runtime/:demoId/*  — 仅 7 种记录级 handler            ││
│  │   ├ POST   /query             (读)                              ││
│  │   ├ GET    /records/:id       (读)                              ││
│  │   ├ GET    /tables/:id/schema (读)                              ││
│  │   ├ POST   /records           (写，capability 门控)             ││
│  │   ├ PUT    /records/:id       (写，capability 门控)             ││
│  │   ├ DELETE /records/:id       (写，capability 门控)             ││
│  │   └ POST   /batch-*           (批量，同权限)                    ││
│  │   ⚠️ schema 级操作 (create_table / create_field) 压根不在此 ns  ││
│  └────────────────────────────────────────────────────────────────┘│
│                                                                        │
│  ┌────────────────────────────────────────────────────────────────┐│
│  │  /api/demos/*           /api/demo-build/*       /api/p/*         ││
│  │  Demo CRUD              esbuild 触发器          Published static ││
│  │  (私有)                 + 构建日志               (公开，无鉴权) ││
│  └────────────────────────────────────────────────────────────────┘│
│                                                                        │
│  ┌────────────────────────────────────────────────────────────────┐│
│  │  services/demo/                                                  ││
│  │   ├ demoFileStore.ts   — 读写 ~/.imagebase/demos/<id>/files/     ││
│  │   ├ demoBuildService.ts — esbuild Node API 封装                 ││
│  │   ├ demoSdkInjector.ts — SDK 脚本生成（根据 capabilities 裁剪）││
│  │   ├ demoPublishService.ts — 发布：copy → published/<version>/   ││
│  │   └ demoCapabilityGuard.ts — 每个 runtime 请求的权限检查核心   ││
│  └────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────┘

~/.imagebase/demos/<demoId>/
  files/                  # Agent 写的源码（authoritative）
    index.html
    app.tsx
    style.css
  dist/                   # 最近一次成功 build 的产物（私有预览 serve 的地方）
    index.html            # 注入了 <script src="/api/demo-runtime/:id/sdk.js">
    bundle.js
    assets/
  published/              # 发布快照，每次 publish 一个子目录
    1/                    # publishedVersion=1
    2/                    # publishedVersion=2（覆盖 publishSlug 指向）
  build.log
```

---

## 2 · 当前可复用资产

| 资产 | 位置 | 用途 |
|---|---|---|
| Skill 机制 | `mcp-server/src/skills/types.ts` (`softDeps`, `promptFragment`) | 直接给 demo-skill / vibe-* 用 |
| 长任务 SSE 协议 | `services/longTaskService.ts` | build 的 progress 事件 + 心跳复用 |
| eventBus workspace SSE | `services/eventBus.ts` | `demo:create/update/delete/build-status` 事件 |
| 数据字典 | `/api/analyst/dictionary` + `get_data_dictionary` 工具 | Agent 看 Table schema 生成 SDK 调用 |
| Prisma workspace tree | `/api/workspaces/:id/tree` | 加 `demos[]` 字段即可 |
| 快照基建（如果未来回归 snapshot） | `services/analyst/snapshotService.ts` | 发布快照兜底 |
| react-markdown + rehype | `frontend/src/components/ChatSidebar/ChatMessage/AssistantText.tsx` | Demo 的 error 展示、代码块等 |
| ConfirmDialog 模式 | `IdeaEditor` 删除确认 + `ConfirmCard` chat 里 | 发布确认弹窗复用 |
| Anthropic 官方 Skill 内容参考 | `.claude/reference/anthropic-skills/frontend-design.md` + `web-artifacts-builder.md` | vibe-design-skill 的 promptFragment 直接吸纳 |

**不可复用**：Analyst 的 DuckDB snapshot 不用（用户明确要活数据，不冻结）；Idea 的 streaming 写入协议可参考但不复用（Demo 不是单 Markdown doc）。

---

## 3 · URL 路由迁移（跨 artifact，V1 核心基建）

当前项目**整个 SPA 没有路由**，artifact 选中态全部在 `App.tsx` 内存里。"独立链接"这个需求压根没有现成基础，这是 V1 最大的工程风险。

### 3.1 引入 React Router

新增依赖：`react-router-dom@6.x`。

### 3.2 路由表

```
公开（无需登录）
  /share/:slug                              Demo 已发布快照（iframe from published/<current>/）

私有（workspace 内）
  /                                         → redirect /workspace/:defaultWorkspaceId
  /workspace/:workspaceId                   → WorkspaceHome（chat + 无 focus）
  /workspace/:workspaceId/table/:tableId    → TableView focused
  /workspace/:workspaceId/idea/:ideaId      → IdeaEditor focused
  /workspace/:workspaceId/design/:designId  → SvgCanvas focused
  /workspace/:workspaceId/demo/:demoId      → DemoPreviewPanel focused
  /workspace/:workspaceId/conversation/:conversationId → 特定对话
```

说明：
- 完整单词而非缩写（`table` / `idea` / `design` / `demo`）—— URL 直接可读，分享给同事时看一眼知道类型
- 所有 artifact 路径都在 `/workspace/:workspaceId/` 下面，便于未来加权限 / 多租户 middleware
- `/share/:slug` 是顶级独立命名空间，不带 workspace 信息（公开访问的人不需要知道内部组织结构）
- 没选 `/demo/:slug` 作为公开路径因为跟私有 `/workspace/.../demo/:id` 语义冲突；`/share/` 含义明确"这是分享出来的东西"

### 3.3 SPA 内部 navigation 改造

- `App.tsx` 的 `activeTableId` / `activeIdeaId` / `focusEntity` 等 state 改为从 URL 派生（`useParams`）
- Sidebar 的"点击切换"改为 `navigate()` 而非 `setActiveTableId`
- Chat 里的 mention chip 点击从 `focusEntity` 改为 `navigate()`
- 浏览器前进后退自动工作
- 刷新不丢选中
- 分享 URL 对方打开看到同样视图

### 3.4 FE 迁移检查清单

现有代码中这些地方需要重构：

| 位置 | 当前 | 改造后 |
|---|---|---|
| `App.tsx` state | `activeTableId` 等 5+ 个内存 state | `useParams` / `useMatch` |
| `Sidebar.tsx` 点击 | `onActiveTableChange?.(id)` | `navigate('/w/' + wsId + '/t/' + id)` |
| `useTableSync` 等 hooks | 依赖 activeTableId prop | 依赖 `useParams().tableId` |
| 对话回跳 | `focusEntity` state | URL 变更 |
| `ChatSidebar` 的 mention chip | `setFocusEntity` | `<Link to>` 或 navigate |

**估时：~1 周纯 FE 改造**。这不是新功能的代码，是先还的技术债。

### 3.5 Back-compat / migration

项目发布前没用户用，不用 URL 兼容旧链接。但注意 shared link / bookmark 场景要完整（V1 第一天就要能用）。

---

## 3.5 · ID 格式标准化（新）

### 3.5.1 前缀表

| 实体 | 前缀 | 例子 | 说明 |
|---|---|---|---|
| Table | `tb` | `tb123456789012` | 数据表 |
| Taste | `ts` | `ts123456789012` | SVG 图片（画布内图元） |
| Design | `dg` | `dg123456789012` | SVG 画布容器 |
| Demo | `dm` | `dm123456789012` | Vibe Demo artifact（本次新增） |
| Idea | `ide` | `ide123456789012` | Markdown 文档 artifact（**3 字符前缀是例外**） |
| Workspace | `ws` | `ws123456789012` | 工作空间 |
| Conversation | `cv` | `cv123456789012` | 对话会话 |
| Agent | `ag` | `ag123456789012` | Chat Agent 身份 |
| Record | `rc` | `rc123456789012` | Table 的行 |
| Field | `fd` | `fd123456789012` | Table 的字段 |
| View | `vw` | `vw123456789012` | Table 的视图 |

### 3.5.2 格式规则

- **前缀（2-3 字符）+ 12 位数字**（`[0-9]{12}`）
- 生成方式：随机 12 位数字 → 检查 DB 冲突 → 冲突则 retry（10^12 空间，百万记录碰撞概率 ~5×10^-7，retry 成本可忽略）
- 数据库层：所有 ID 列保持 `String @id`（跟现有 Prisma 约束兼容）

### 3.5.3 生成 helper

```typescript
// backend/src/services/idGenerator.ts
import { prisma } from "./dbStore";

const PREFIXES = {
  table: "tb", taste: "ts", design: "dg", demo: "dm",
  idea: "ide", workspace: "ws", conversation: "cv",
  agent: "ag", record: "rc", field: "fd", view: "vw",
} as const;

export async function generateId(
  kind: keyof typeof PREFIXES,
  existsCheck: (id: string) => Promise<boolean>,
): Promise<string> {
  const prefix = PREFIXES[kind];
  for (let i = 0; i < 5; i++) {
    const digits = Array.from({ length: 12 }, () =>
      Math.floor(Math.random() * 10)
    ).join("");
    const id = `${prefix}${digits}`;
    if (!(await existsCheck(id))) return id;
  }
  throw new Error(`id collision too many times for ${kind}`);
}
```

### 3.5.4 存量数据兼容

现有 table / idea / design 等记录的 ID 是 `cuid()` 格式（`cmo...`），**不改**。新建实体走新格式。

**路由层正则** 接受两种格式：
```typescript
// /workspace/:wsId/table/:tableId
const isNewFmt = /^tb\d{12}$/;
const isLegacyCuid = /^c[a-z0-9]{24,}$/;  // cuid
const isLegacyPrefixed = /^tbl_[a-z0-9]+$/;  // pre-cuid
```

所有三种都是合法 tableId。

### 3.5.5 应用范围

- **从本 V1 开始**所有新实体用新格式
- 影响的创建路径：`/api/tables` POST / `/api/ideas` POST / `/api/designs` POST / `/api/demos` POST / `/api/tables/:id/records` POST / `/api/tables/:id/fields` POST 等
- Prisma schema 的 `@default(cuid())` 改为移除，改手动生成传入

---

## 4 · 数据模型（Prisma 新增）

```prisma
model Demo {
  id                String    @id                  // 应用侧生成，格式 "dm" + 12 位数字
  workspaceId       String
  parentId          String?
  order             Int

  name              String
  template          String    @default("static")  // "static" | "react-spa"
  version           Int       @default(0)          // 源码版本，每次 write 自增

  // 数据访问声明 —— 发布时权限的唯一来源
  dataTables        String[]                       // ["tb123456789012", ...]
  dataIdeas         String[]                       // ["ide123456789012", ...]
  capabilities      Json                           // 见下方 §4.2
  // 默认值：dataTables=[], dataIdeas=[], capabilities={}

  // 构建状态
  lastBuildAt       DateTime?
  lastBuildStatus   String?                        // "idle" | "building" | "success" | "error"
  lastBuildError   String?

  // 发布状态
  publishSlug       String?   @unique              // 发布后生成，unpublish=null
  publishedVersion  Int?                           // 对应 published/<N>/ 目录
  publishedAt       DateTime?

  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  workspace         Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
  @@index([publishSlug])
  @@map("demos")
}
```

### 4.1 关于文件内容的存储位置

**文件不进 Prisma**，完全走 `~/.imagebase/demos/<demoId>/files/`。理由同 Analyst DuckDB / Agent identity / Idea streaming 的既有口径：
- 磁盘对大量小文件 IO 更优
- Prisma 存 TEXT 列超过几百 KB 查询效率骤降
- 文件 build 时需要被 esbuild 按路径 resolve —— Prisma BLOB 无法直接喂给 bundler

Prisma 只存"Demo 存在、名叫什么、version 几、有没有发布"这类元数据。

### 4.2 capabilities JSON schema

```typescript
type Capabilities = Record<string, Capability[]>;

type Capability =
  // Table 操作
  | "query"           // read-all with filter/sort/limit
  | "getRecord"       // read single by id
  | "describeTable"   // read schema (fields, types, options)
  | "createRecord"    // write new
  | "updateRecord"    // write existing
  | "deleteRecord"    // remove
  // Idea 操作（只读，V1 不支持写）
  | "listIdeas"       // list by workspace
  | "readIdea";       // read content + sections metadata
  // batch variants (batchCreate / batchUpdate / batchDelete) 共享对应单条 capability

// 示例 —— CRM 风格 Demo
{
  "tb123456789012": ["query", "createRecord", "updateRecord", "deleteRecord"],
  "tb234567890123": ["query"],              // 只读的一张字典表
  "ide123456789012": ["readIdea"]           // 一份产品调研 Idea 用作 Demo 的说明/header
}
```

**规则**：
- resourceId 不在 `dataTables` / `dataIdeas` → SDK 方法根本不会被生成 → 调不到
- resourceId 在 `dataTables` / `dataIdeas` 但 capability 不在列表里 → SDK 不生成对应方法 + 后端 403 兜底
- `query / getRecord / describeTable / readIdea / listIdeas` 默认总是开（Agent 在声明时自动加）
- `createRecord / updateRecord / deleteRecord` 必须 Agent 显式加，且发布时用户必须 review

---

## 5 · 文件系统布局 & 构建流水线

### 5.1 目录结构

```
~/.imagebase/demos/<demoId>/
  files/                         # Agent 写的源码（authoritative）
    index.html                   # 入口（必需）
    app.tsx                      # React 主组件（react-spa 模板）
    style.css
    public/
      logo.svg
  dist/                          # 最近一次成功 build 输出（私有预览 serve）
    index.html
    bundle.js                    # esbuild 产物
    bundle.css
    sdk.js                       # demoSdkInjector 生成
    (static assets)
  published/
    1/                           # 第 1 次发布时的快照（含 dist 内容）
    2/                           # 第 2 次发布
  build.log                      # 最近一次 build 输出 + stderr
  meta.json                      # 缓存的部分 Demo 元信息（快速启动时避免 Prisma 查询）
```

### 5.2 构建流水线

```
[Agent 写文件] write_demo_file(demoId, 'app.tsx', '...')
      ↓
[DB version++][文件落盘 files/app.tsx]
      ↓
[Agent 调] build_demo(demoId)
      ↓
[esbuild.build({
   entryPoints: ['files/app.tsx'],
   bundle: true,
   outdir: 'dist/',
   format: 'iife',
   target: 'es2020',
   jsx: 'automatic',
   plugins: [tailwindPlugin(), sdkInjectionPlugin(capabilities)],
   external: [],
   sourcemap: false,
   minify: true,
   loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'css' },
 })]
      ↓
[sdkInjector] 把 /dist/sdk.js 生成（按 capabilities 裁剪后的 SDK 代码）
      ↓
[patch files/index.html] 自动注入 <script src="./sdk.js"></script> 到 <head>
      ↓
[写 dist/index.html + bundle.js + sdk.js 等]
      ↓
[更新 Demo.lastBuildAt / status / error]
      ↓
[emitWorkspaceChange('demo:build-status')]
```

### 5.3 两种模板

**`static`** — 纯 HTML + CSS + JS，无 build：
- `files/index.html` 是入口
- `files/style.css` + `files/*.js` 直接 copy 到 `dist/`
- esbuild 只处理 JS 文件的 bundle（去 import chain）
- 适合 Vibe design 的落地页、纯视觉 Demo

**`react-spa`** — React + TypeScript：
- `files/index.html` 有 `<div id="root"></div>` + `<script src="./bundle.js">`
- `files/app.tsx` 是主组件
- esbuild bundle `app.tsx` → `dist/bundle.js`
- React + ReactDOM 从 CDN：`<script crossorigin src="https://esm.sh/react@18"></script>`（避免每个 Demo 都打 150KB React）
- Tailwind：CDN script `<script src="https://cdn.tailwindcss.com"></script>`（V1 简单方案，V3 可换 JIT）
- 适合 Vibe coding 的 CRUD app / dashboard

### 5.4 build 超时与资源限额

- esbuild 本身很快（< 1s 即便 200KB TSX），但奇葩 input 可能触发炸开
- 硬超时：**30s**（esbuild 的 `setTimeout` kill）
- 内存限额：Node 进程已有 default，不额外做
- 并发：同一 demoId 不允许并发 build（Promise lock，后来的等前面完成）
- 日志：stdout + stderr 落到 `build.log`，FE 可展示

### 5.5 build 失败自动 retry

Agent 的流程（V1）：

```
build_demo → 失败 → Agent 看 build.log 里的 error → 自动改代码 → build_demo
```

最多 **2 次自动 retry**，第 3 次仍失败 → 不再自动，回到对话让用户说怎么办。

这个逻辑在 **prompt 层**实现（demo-skill 的 promptFragment 写"build 失败最多自动 retry 2 次，之后问用户"），Agent 自律。**不做代码级强制**，因为：
- 模型可能在中途判断"算了这玩意儿没法修"主动停下来 —— 好事，别剥夺
- 强制 retry 会增加失败成本（每次 build 都是 Claude Opus 调用）

---

## 6 · Demo Runtime API —— 7 个 handler

### 6.1 Route namespace

**新 route**: `backend/src/routes/demoRuntimeRoutes.ts`

挂载：`app.use("/api/demo-runtime", demoRuntimeRoutes)`

```
# Table 记录级操作
POST   /api/demo-runtime/:demoId/query               body: {tableId, filter?, sort?, limit?}
GET    /api/demo-runtime/:demoId/records/:recordId?tableId=   (get single)
GET    /api/demo-runtime/:demoId/tables/:tableId/schema
POST   /api/demo-runtime/:demoId/records             body: {tableId, cells}
PUT    /api/demo-runtime/:demoId/records/:recordId   body: {tableId, cells}
DELETE /api/demo-runtime/:demoId/records/:recordId?tableId=
POST   /api/demo-runtime/:demoId/batch-create        body: {tableId, records[]}
POST   /api/demo-runtime/:demoId/batch-update        body: {tableId, updates[]}
POST   /api/demo-runtime/:demoId/batch-delete        body: {tableId, recordIds[]}

# Idea 只读操作
GET    /api/demo-runtime/:demoId/ideas                (list declared ideas)
GET    /api/demo-runtime/:demoId/ideas/:ideaId        (get content + sections)

# SDK 自身
GET    /api/demo-runtime/:demoId/sdk.js              (生成注入的 SDK)
```

**没有**：
- `POST /tables` (create_table) / `POST /:tableId/fields` (create_field) / `DELETE /tables/:id`
- `POST /ideas` / `PUT /ideas/:id/content` / `DELETE /ideas/:id`（Idea 写入不暴露）
- `GET /` (list all tables / ideas in workspace — 必须在 dataTables / dataIdeas 里声明过才能访问)
- 任何 agent / chat / workspace / storage / AI / design / taste / snapshot endpoint

**它们在这个 namespace 下不存在**，不是"返回 403"。请求会 404。

### 6.2 capability guard

共享 middleware：`demoCapabilityGuard(operation: Capability)`

```typescript
// backend/src/services/demo/demoCapabilityGuard.ts

type ResourceKind = "table" | "idea";

export function demoCapabilityGuard(
  op: Capability,
  kind: ResourceKind,
) {
  return async (req, res, next) => {
    const demoId = req.params.demoId;
    const resourceId =
      kind === "table"
        ? (req.body?.tableId || req.query?.tableId || req.params?.tableId)
        : (req.body?.ideaId || req.query?.ideaId || req.params?.ideaId);
    if (!resourceId) return res.status(400).json({ error: `${kind}Id required` });

    const demo = await store.getDemo(demoId);
    if (!demo) return res.status(404).json({ error: "Demo not found" });

    // 1. 声明隔离：resourceId 必须在 demo.dataTables / demo.dataIdeas 里
    const declaredList = kind === "table" ? demo.dataTables : demo.dataIdeas;
    if (!declaredList.includes(resourceId)) {
      return res.status(403).json({
        error: `Demo ${demoId} 未声明 ${kind} ${resourceId}`,
        hint: "Agent 需先调 update_demo_capabilities 把该 id 加入 dataTables/dataIdeas",
      });
    }

    // 2. capability 白名单
    const caps = demo.capabilities?.[resourceId] ?? [];
    if (!caps.includes(op)) {
      return res.status(403).json({
        error: `Demo ${demoId} 对 ${kind} ${resourceId} 未声明 ${op} 能力`,
        hint: "修改 capabilities 后重新发布",
      });
    }

    // 3. 已发布 demo 允许匿名访问；私有 demo 要求 workspace 成员
    // V1 项目尚无多租户，私有模式默认放行（同步已有 /api/tables/* 的鉴权基线）

    // 4. 资源的 workspace 必须 == demo.workspaceId（双重隔离）
    const resWs = kind === "table"
      ? await store.getTableWorkspaceId(resourceId)
      : await store.getIdeaWorkspaceId(resourceId);
    if (resWs !== demo.workspaceId) {
      return res.status(403).json({ error: "cross-workspace demo access denied" });
    }

    (req as any).demo = demo;
    next();
  };
}
```

每个 handler 用对应 op + kind 装饰：

```typescript
router.post("/:demoId/records",
  demoCapabilityGuard("createRecord", "table"),
  async (req, res) => {
    const { tableId, cells } = req.body;
    const rec = await store.createRecord(tableId, { cells });
    eventBus.emitChange({ type: "record:create", tableId, ...});
    res.json(rec);
  }
);

router.get("/:demoId/ideas/:ideaId",
  demoCapabilityGuard("readIdea", "idea"),
  async (req, res) => {
    const idea = await store.getIdea(req.params.ideaId);
    res.json({
      id: idea.id,
      name: idea.name,
      content: idea.content,        // Markdown
      sections: idea.sections,      // [{slug, title, depth, offset}]
      updatedAt: idea.updatedAt,
    });
  }
);
```

### 6.3 限流（防公开 demo 被滥用）

对 `/api/demo-runtime/:demoId/*` 用**滑动窗口 + 日兜底**：

| 维度 | 读（query/get/describe/listIdeas/readIdea） | 写（create/update/delete/batch*） |
|---|---|---|
| **每分钟滑动窗口** | 200 | 30 |
| **每日累计** | 100,000 | 10,000 |

实现：`express-rate-limit` 或同等 lib + 内存 Map（V1 单实例够用，未来上 Redis）。

### 6.4 rate limit 的 key

```
rateLimit.key = `${demoId}:${req.ip}:${opFamily}`
opFamily = "read" | "write"
```

Per (demoId, IP, opFamily) 分桶：
- 一个用户在一个 demo 里刷满不影响别的 demo
- 一个 demo 被多人共用不会互相吃配额
- 区分读写两个桶避免大量读把写的配额挤掉

超限返回 `429 Too Many Requests` + `Retry-After` header 告诉客户端多久可以重试。

### 6.5 限流数值的设计思路

- **读 200/min** 允许 Demo 合理 burst（首屏可能并发 fetch 10+ 张表 / 几份 Idea，算上分页每页 20 条，200 次足以覆盖）
- **写 30/min** 允许正常的表单提交节奏（正常人每 2 秒提交一次要连刷 60 秒才会触发），但挡住自动化撞库
- **日上限** 防止 24 小时低速持续滥用（比如爬虫每分钟 10 次跑一整天，日累计 14k，写桶会在 1k 次/天时封）
- 已发布 demo 的匿名访问和私有 demo 走同一限流策略。V3 可以引入"已发布 demo 按更低阈值"。

---

## 7 · Browser SDK (`window.ImageBase`)

### 7.1 SDK 生成策略：**动态按需生成**

`/api/demo-runtime/:demoId/sdk.js` 返回的 JS 内容根据 Demo 的 `capabilities` **动态裁剪** —— 只包含声明过的方法。生成时 inline 了 demoId，不需要 demo 代码手动配置。

### 7.2 SDK 骨架（完整实现）

```javascript
// /api/demo-runtime/:demoId/sdk.js 返回的内容示例
// 假设 Demo 的 capabilities = {
//   "tb123456789012": ["query", "createRecord"],
//   "ide123456789012": ["readIdea"]
// }

(function() {
  const DEMO_ID = "dm123456789012";
  const BASE = location.origin + "/api/demo-runtime/" + DEMO_ID;

  async function _req(method, path, body) {
    const r = await fetch(BASE + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    return r.json();
  }

  const SDK = {
    // === 以下方法根据 capabilities 动态生成 ===

    // Table 读（自动总是开）
    async query(tableId, options = {}) {
      return _req("POST", "/query", { tableId, ...options });
    },
    async describeTable(tableId) {
      return _req("GET", `/tables/${tableId}/schema`);
    },

    // Table 写（capabilities 里显式声明才出现）
    async createRecord(tableId, cells) {
      return _req("POST", "/records", { tableId, cells });
    },
    // updateRecord / deleteRecord / getRecord / batch* 未声明 → 不在对象里

    // Idea 读（capabilities 里显式声明才出现）
    async readIdea(ideaId) {
      return _req("GET", `/ideas/${encodeURIComponent(ideaId)}`);
    },
    // listIdeas 未声明 → 不出现

    // 元信息（只读，永远可用）
    get demoId() { return DEMO_ID; },
    get dataTables() { return ["tb123456789012"]; },
    get dataIdeas() { return ["ide123456789012"]; },
    get capabilities() {
      return {
        "tb123456789012": ["query","createRecord"],
        "ide123456789012": ["readIdea"]
      };
    },
  };

  window.ImageBase = Object.freeze(SDK);
  console.log(
    "%c[ImageBase SDK loaded]",
    "color:#1456F0;font-weight:bold",
    "demo=", DEMO_ID,
    "tables=", SDK.dataTables,
    "ideas=", SDK.dataIdeas,
    "capabilities=", SDK.capabilities,
  );
})();
```

**分析报告类 Demo 用例**（"基于 Idea 生成一份设计感的 HTML 分析报告"）：

```tsx
// Agent 生成的 app.tsx
import React, { useEffect, useState } from 'react';

export default function Report() {
  const [idea, setIdea] = useState(null);
  useEffect(() => {
    window.ImageBase.readIdea('ide123456789012').then(setIdea);
  }, []);
  if (!idea) return <div>加载中...</div>;

  // idea.content 是 Markdown，用 remark 或直接手写分段渲染
  // idea.sections 给出每个 ## 标题的 offset，便于"目录"导航
  return (
    <article>
      <h1>{idea.name}</h1>
      {/* 自由组合 typography / layout / visual */}
    </article>
  );
}
```

### 7.3 SDK 注入时机

- **构建时**：esbuild 的 `sdkInjectionPlugin` 在 `dist/` 目录生成 `sdk.js` 文件副本 + patch `index.html` 加 `<script src="./sdk.js">`
- **运行时**：iframe 加载 dist/index.html → 浏览器 fetch sdk.js → SDK 挂到 window
- **发布时**：published 快照复制时 sdk.js 一起复制

### 7.4 错误处理

SDK 里 `_req` 抛 Error，调用方（Agent 写的 Demo 代码）需要 try/catch。

Agent 的 promptFragment 里明确说："SDK 调用可能失败（权限、网络、校验），写代码时用 try/catch 处理。"

### 7.5 TypeScript 类型给 Agent

Agent 写 TypeScript 需要知道 SDK 形状。在 demo-skill 的 promptFragment 里嵌入**完整 SDK 类型定义**（~50 行），Agent 看到类型就能正确调用。

---

## 8 · 发布流程（Publishing）

### 8.1 `publish_demo` 工具的内部流程

```
1. Agent 调 publish_demo(demoId, slug?)
2. Backend: 验证 demo 存在 + 有 dist/（即 build 成功过）
3. 如果 Demo.publishSlug 为空：生成新 slug（12 字符 base62）
4. 如果已有 slug：复用（re-publish 同一 slug，但 publishedVersion++）
5. Backend: 复制 dist/ → published/<nextVersion>/
6. Backend: 更新 Demo.publishSlug, publishedVersion, publishedAt
7. 返回 slug + 公开 URL
8. emitWorkspaceChange("demo:publish")
```

### 8.2 公开路由 `/share/:slug`

`app.get('/share/:slug/*', demoPublicHandler)`:
- 找 `Demo WHERE publishSlug = :slug`
- 若无：404
- serve `published/<publishedVersion>/` 下的文件（index.html 默认）
- 响应头：
  - `Content-Security-Policy`（见 §13 安全）
  - `X-Robots-Tag: noindex, nofollow`（不想被搜索引擎爬）
  - `Cache-Control: public, max-age=300`（5min 缓存，re-publish 后刷新）

### 8.3 发布二次确认 UI

点击 chat 里"发布"按钮或 Agent 调 `publish_demo` 时，FE 弹窗：

```
┌─────────────────────────────────────────────────────┐
│  发布 Demo：「活动报名表」                             │
├─────────────────────────────────────────────────────┤
│  生成公开 URL：                                        │
│    https://www.imagebase.cc/share/xKp7QrS2mNt5  📋   │
│                                                        │
│  访问此 URL 的任何人（无需登录）将能：                  │
│                                                        │
│  📋 tb123456789012  报名记录                          │
│     ✓ 读记录    ✓ 新增记录                            │
│     ✗ 修改      ✗ 删除                                │
│                                                        │
│  📋 tb234567890123  反馈                              │
│     ✓ 读记录    ✓ 新增记录                            │
│     ✓ 修改记录  ✓ 删除记录                            │
│                                                        │
│  📄 ide123456789012  产品调研（说明文档引用）          │
│     ✓ 读内容                                           │
│                                                        │
│  ⚠️ 该 URL 不需登录即可访问。                          │
│  ⚠️ 访问者无法修改表结构、字段、或其他资源。            │
│                                                        │
│  [ 取消 ]  [ 编辑能力 ]  [ 确认发布 ]                 │
└─────────────────────────────────────────────────────┘
```

**编辑能力** 点击后进入 `DemoCapabilityEditor` 组件，用户可以逐个开关 per-table capability。

### 8.4 取消发布（unpublish）

`unpublish_demo(demoId)`:
- 清空 Demo.publishSlug + publishedVersion + publishedAt
- `published/` 目录**保留**（防止后悔 + 可作为历史备份）
- `/share/:slug` 立即 404
- 重新 publish 会生成**新的** slug（不复用旧 slug，避免泄漏继续生效）

### 8.5 slug 生成规则

**注意**：slug 和 ID 是不同的：
- **ID**（`dm123456789012`）是 Demo 的内部主键，12 位数字，可被用户看到但不会被分享
- **slug**（`xKp7QrS2mNt5`）是公开分享的短 token，设计目标是"不可枚举 + 不可猜测"，所以用 **12 位 base62 = `[a-zA-Z0-9]`**

slug 生成：
- 字符集：`[a-zA-Z0-9]`
- 长度：**12 位**（62^12 ≈ 3×10^21，>71 bit entropy）
- 冲突检测：DB unique 约束 + retry 一次（实际几乎不会冲突）

### 8.6 自定义域名（V4 才做）

V1 只支持 `/share/:slug`。V4 加能力：

```
Workspace.customDomain: "demo.user-company.com"  (optional)
Demo.customPath: "/app"  (optional, within the domain)
```

配合 nginx 的 SNI 动态上游（`map $ssl_server_name $backend {...}`）+ Let's Encrypt 自动签证。V4 再设计，V1 不碰。

---

## 9 · MCP 工具清单（demo-skill + 相关）

### 9.1 Tier 1（always-on · workspace 导航）

| Tool | Args | 用途 |
|---|---|---|
| `list_demos` | `workspaceId?` | Sidebar 列表（跟 list_tables 并列） |
| `get_demo` | `demoId` | 看 Demo 元数据 + 文件列表 + 最近 build 状态 |

### 9.2 Tier 2 · `demo-skill`（核心工具，~10 个）

| Tool | Args | Danger |
|---|---|---|
| `create_demo` | `workspaceId, name, template` | - |
| `rename_demo` | `demoId, name` | - |
| `delete_demo` | `demoId` | ⚠️ |
| `list_demo_files` | `demoId` | - |
| `read_demo_file` | `demoId, path` | - |
| `write_demo_file` | `demoId, path, content` | - |
| `delete_demo_file` | `demoId, path` | ⚠️ (仅删单文件) |
| `update_demo_capabilities` | `demoId, dataTables, capabilities` | - |
| `build_demo` | `demoId` | - |
| `publish_demo` | `demoId, slug?` | ⚠️ （因为会让数据公开） |
| `unpublish_demo` | `demoId` | - |

### 9.3 工具返回约定

- 写入类工具返回 `{ok:true, version}` 给 Agent（确认成功）
- `build_demo` 返回 `{ok, duration_ms, size_bytes, log_tail_200?}`；失败时 `{ok:false, error, log_tail_500}`（给 Agent 看 error 自己修）
- `publish_demo` 返回 `{ok, slug, url, publishedVersion}`

### 9.4 进度事件（复用长任务协议）

`build_demo` 分阶段：

```typescript
ctx.progress({ phase: "preparing", message: "读取文件..." });
ctx.progress({ phase: "bundling", message: "esbuild 打包..." });
ctx.progress({ phase: "injecting", message: "注入 SDK..." });
ctx.progress({ phase: "writing", message: "写 dist/..." });
```

`publish_demo` 类似：

```typescript
ctx.progress({ phase: "snapshotting", message: "快照 dist → published/" });
ctx.progress({ phase: "updating", message: "更新发布元数据..." });
```

FE 的 `ChatCodingFlowCard` 把 tool_progress 里的 phase 映射成步骤 label（详见 §11）。

---

## 10 · Skills 定义：demo + vibe-design + vibe-coding

### 10.1 `demo-skill` —— 底层工具 skill

```typescript
// backend/mcp-server/src/skills/demoSkill.ts

export const demoSkill: SkillDefinition = {
  name: "demo-skill",
  displayName: "Demo 代码生成 & 部署",
  description:
    "生成可运行的前端 Demo（HTML/React SPA），编译、预览、发布到公开 URL；通过 ImageBase SDK 读写 workspace 内声明的 Table 数据。",
  artifacts: ["demo"],
  softDeps: ["table-skill", "analyst-skill"],
  when:
    "当用户请求「做一个网页 / 页面 / 落地页 / dashboard / 小工具 / Demo」；" +
    "或要求把数据表做成可交互的 UI / 表单；或说 vibe design / vibe coding / 原型时激活。",
  triggers: [
    /(vibe|demo|原型|prototype)/i,
    /(做个|写一个|做一个|生成).*(网页|页面|落地页|表单|dashboard|看板|app|小工具|前端)/i,
    /(前端|HTML|CSS|JS|React|组件|UI).*(生成|写|做)/i,
    /(发布|部署|publish|deploy).*(demo|页面|原型|链接)/i,
  ],
  tools: [
    ...demoNavTools,           // list_demos, get_demo
    ...demoWriteTools,         // create/rename/delete/files/build/publish/unpublish/update_capabilities
  ],
  promptFragment: DEMO_SKILL_PROMPT,
};
```

**`DEMO_SKILL_PROMPT` 核心段落**：

```
## Demo 基本流程

1. create_demo(workspaceId, name, template) — template = "static" 或 "react-spa"
2. write_demo_file(demoId, path, content) 一个或多个
   - 推荐结构：files/index.html, files/app.tsx, files/style.css
   - React SPA 模板在 index.html 里已经有 <div id="root"> + bundle.js 引用
3. 如果要读写 Table 或读 Idea → update_demo_capabilities(demoId, dataTables, dataIdeas, capabilities)
   - dataTables 声明用到的 tableId 列表
   - dataIdeas  声明用到的 ideaId 列表（只读）
   - capabilities 是每个 resourceId 的能力白名单
4. build_demo(demoId) — esbuild 打包
   - 失败时读 log_tail_500 里的 error，自己修，最多 retry 2 次
5. Demo 可在 /workspace/:workspaceId/demo/:demoId 预览
6. 用户满意后：publish_demo(demoId) 生成公开 URL

## ImageBase SDK（生成 Demo 代码时使用）

注入在全局的 window.ImageBase。根据声明的 capabilities 动态生成。SDK 签名：

interface ImageBase {
  demoId: string;
  dataTables: string[];
  capabilities: Record<string, Capability[]>;

  // Table 操作
  query(tableId: string, options?: {filter?, sort?, limit?}): Promise<Record[]>;
  getRecord(tableId: string, recordId: string): Promise<Record>;
  describeTable(tableId: string): Promise<{fields: FieldSchema[], ...}>;
  createRecord(tableId: string, cells: Record<string, any>): Promise<Record>;
  updateRecord(tableId: string, recordId: string, cells: Record<string, any>): Promise<Record>;
  deleteRecord(tableId: string, recordId: string): Promise<void>;
  batchCreate(tableId: string, records: {cells}[]): Promise<Record[]>;
  // ...

  // Idea 操作（只读）
  listIdeas(): Promise<Array<{id, name, updatedAt}>>;
  readIdea(ideaId: string): Promise<{id, name, content: string, sections: Section[], updatedAt}>;
}

## 硬规则

- 生成 Demo 前必须调 describe_table 或 get_data_dictionary 了解字段类型
- 写代码要用 try/catch 包裹 SDK 调用
- 用户强调读写某张表时，capability 必须显式声明（默认 query 开，write 不开）
- **不要** 试图在 Demo 代码里调用 `/api/tables/...` 或其他系统 API——只能通过 window.ImageBase
- 规模建议：单文件 < 800 行，总文件 < 10 个。超了拆分或直接告诉用户"这个需求太大了拆分一下"
- Build 失败 retry 规则：最多自动 retry 2 次；第 3 次失败后问用户
- Publish 需用户确认（一般在对话里征求同意再调 publish_demo）

## 默认模板特征

- static：纯 HTML/CSS/JS。入口 files/index.html，自由引用 files/ 下其他文件
- react-spa：React 18 + TypeScript + Tailwind（CDN）。入口 files/app.tsx，esbuild 打包成 bundle.js
```

### 10.2 `vibe-design-skill` —— 视觉侧 overlay（阶段 1）

```typescript
// backend/mcp-server/src/skills/vibeDesignSkill.ts

export const vibeDesignSkill: SkillDefinition = {
  name: "vibe-design-skill",
  displayName: "Vibe Design（视觉 / UI 优先）",
  description:
    "当用户对页面**视觉 / 审美 / 风格**有明确表达时激活。负责设计阶段：提方向 → 定稿 → 移交 coding。纯功能需求（如「给我搭个 CRM」）不激活。",
  artifacts: ["demo"],
  softDeps: ["demo-skill", "taste-skill"],
  when:
    "用户提到「漂亮 / 好看 / 视觉 / 风格 / 设计感 / 落地页 / mockup / hero / 海报 / 编辑风 / 极简 / 复古 ...」等**明确的 design 意图**词时激活。仅仅说「做个工具」「搭个系统」不激活。",
  triggers: [
    /(漂亮|好看|视觉|美观|设计感|有质感|惊艳|高级感|精致)/,
    /(风格|调性|审美|氛围|品味)/,
    /(落地页|hero|banner|海报|封面|mockup|展示页|推广页)/i,
    /(极简|maximalist|retro|复古|未来|brutalist|奢华|玩具|editorial|杂志风)/,
  ],
  tools: [],  // 不带新工具，只带 promptFragment
  promptFragment: VIBE_DESIGN_PROMPT,
};
```

**`VIBE_DESIGN_PROMPT`**（吸纳 Anthropic frontend-design 的内容 + 加入阶段化路由）：

```
## 你是"设计阶段"负责人（Vibe Design）

### 阶段化工作流（严格遵守）

**阶段 1：方向提议**
用户表达设计意图后，你**不要直接写代码**。先用自然语言给出
3-4 个互不相同的美学方向选项，每个 2-3 行描述其特征：
- Typography（具体字体名 + 组合）
- Palette（主 2-3 色 + 辅色）
- Motion / Layout 核心特征
- 一句话的情绪关键词

让用户挑一个（或让 Agent 基于上下文推荐一个）。

**阶段 2：设计定稿（产出 design token）**
用户选定方向后，你写一个简短的"设计 token 声明"——**自然语言 + 少量代码片段**，
不 write_demo_file、不 build。格式：

```
## 设计定稿

**方向**：{你选的那个名字，如 "Brutalist 磁带朋克"}

**Typography**:
  - display: 'Orbitron', monospace
  - body: 'JetBrains Mono', sans
  - size scale: 基准 14px，大标题 72px/56px，不用中间档

**Palette** (CSS variables):
  --bg-primary: #0a0a0a
  --accent-1: #ff3366
  --accent-2: #00ff88
  --border: #ff336622

**Motion**:
  - 进场 stagger 120ms 间隔
  - hover: skew(-2deg) 150ms
  - 不用 fade，所有 transition 用 clip-path 或 translate

**Layout 原则**:
  - 对角线分割
  - 大号 display + 紧凑 body 反差
  - 禁用圆角，所有 border 直角 + 2px 重线
```

**阶段 3：移交 coding**
写完 token 后明确说一句："**设计定稿，交给 coding 阶段实现**"。
**不要**你自己 write_demo_file / build_demo —— 让 vibe-coding-skill 接手。

### 阶段例外
- 纯落地页 / 静态展示页（无需要功能交互）→ 你可以走完设计阶段后**直接 write_demo_file** 产出 HTML，不需要 coding skill 参与
- 用户已经给出明确设计 token（比如用品牌色表 + 字体名）→ 跳过阶段 1，直接阶段 2 产出 token

### Anthropic frontend-design 五个着力方向（执行阶段用）

**字体 Typography**
- ❌ 不要 Inter / Roboto / Arial / SF Pro 这类默认字体
- ✅ 用**有性格的字体**：display font 做大标题（Playfair / Orbitron / Bodoni / 汉仪字库）+ 干净 body font
- 网络字体通过 Google Fonts / Adobe Fonts 的 link 标签加载

**色彩 Color**
- 用 CSS variable 定义主题色
- 主色 + **尖锐**辅色 > 温吞均匀调色盘
- ❌ 禁紫白渐变；禁淡蓝白默认
- 考虑亮暗两套主题

**动效 Motion**
- 优先 CSS-only（keyframes、transition、transform）
- React 可用 Framer Motion
- 关注**高影响瞬间**：一次精心编排的页面加载 staggered reveal > 十个分散的 micro-interaction
- 用户滚动、hover 触发有意外感的过渡

**空间布局 Spatial**
- 打破默认网格，用不对称 / 对角流 / 重叠
- 大胆的**负空间** 或 **可控密度**，选一种极端不要中庸
- 不要所有元素都 centered

**背景 Backgrounds**
- 避免纯白 / 纯黑单色
- 考虑：渐变网格、噪点、几何图案、分层透明、戏剧阴影、装饰边框、自定义光标、颗粒 overlay
- 背景要和主题统一

### 反例清单（绝对不要）
- 居中泛滥（"所有元素都居中对齐"）
- 紫色渐变（"purple-to-blue hero section"）
- 统一圆角（"所有卡片都是 rounded-lg"）
- Inter 字体
- 三列九宫格 feature
- "Sign up free" CTA 按钮

### 每个生成都要不一样
NEVER 在不同次生成里用同一套 Space Grotesk / purple / Inter 套路。
每个 Demo 根据上下文产出独特组合。
```

### 10.3 `vibe-coding-skill` —— 逻辑侧 overlay（阶段 2）

```typescript
export const vibeCodingSkill: SkillDefinition = {
  name: "vibe-coding-skill",
  displayName: "Vibe Coding（交互 / 功能优先）",
  description:
    "负责 Demo 的实现阶段：把需求（或 vibe-design-skill 产出的 token）变成可运行代码。默认 Demo 场景激活。",
  artifacts: ["demo"],
  softDeps: ["demo-skill", "table-skill", "analyst-skill"],
  when:
    "用户要做功能 / 交互 / 工具 / CRM / dashboard / 看板 / 表单 / 查询界面时激活。" +
    "如果 vibe-design-skill 也激活，等其完成设计定稿再开始写代码。",
  triggers: [
    /(做一个|写个|搭一个|搭个|实现|生成).*(app|应用|工具|CRM|ERP|OA|看板|计数器|计算器|查询|筛选|系统|平台|管理|dashboard|Dashboard)/,
    /(CRUD|表单|submit|提交|增删改查|增加记录|修改记录|删除记录|登录|注册)/,
    /(按钮|交互|功能|流程|逻辑)/,
    /\b(vibe\s*coding|rapid\s*prototype)\b/i,
  ],
  tools: [],
  promptFragment: VIBE_CODING_PROMPT,
};
```

**`VIBE_CODING_PROMPT`**（React + TS + Tailwind 栈规范 + 阶段等待 + 数据接入模式）：

```
## 你是"实现阶段"负责人（Vibe Coding）

### 阶段化等待（如果 vibe-design-skill 也激活）

如果 vibe-design-skill 在本对话活跃，你**必须等它完成设计定稿**才开始写代码。
判断标准（任一）：
- 对话里 design skill 明确说了 "设计定稿，交给 coding 阶段实现"
- 对话里看到完整的 design token 声明（Typography / Palette / Motion / Layout 四项都有）
- 用户在看到 design skill 的方向后明确说 "OK / 好 / 按这个做"

在此之前：
- 不要 write_demo_file
- 不要 build_demo
- 自然语言回复 "等 design 阶段出定稿后我实现" 即可

看到定稿后：
- 严格用 token 里的字体 / 色值 / motion 规则
- 不要自己"改良"或加入默认的紫色渐变 / Inter 字体 / 默认圆角

### 只有你一个 skill 激活的情况

用户没表达设计意图（"给我搭个 CRM" / "做个 dashboard" 这类纯功能需求）→
- 直接按 coding 流程走，用**中性实用视觉**
- Tailwind 默认样式 + 克制留白 + 合适对比度
- 不主动搞风格化设计（不假装 design skill 的职责）
- 重点放在 CRUD 逻辑、错误处理、loading 状态、字段类型转换等 "it just works" 的层面

### 技术栈（参考 Anthropic web-artifacts-builder 约定）
- React 18 + TypeScript
- Tailwind CSS（CDN：<script src="https://cdn.tailwindcss.com"></script>）
- 状态管理：useState / useReducer 够用时不上 zustand / redux
- 请求：`fetch` + window.ImageBase SDK

### 数据接入流程（必须）
1. 写代码前先调 get_data_dictionary(workspaceId) 或 describe_table 了解字段
2. 决定要用哪些 tableId → 调 update_demo_capabilities 声明
3. 代码里用 window.ImageBase SDK 读写（不要硬编码假数据）
4. 写入类操作必须声明对应 capability（create/update/delete）

### CRUD 代码模式（example）
```tsx
import React, { useState, useEffect } from 'react';

function App() {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const rows = await window.ImageBase.query('tb123456789012', { limit: 100 });
        setRecords(rows);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSubmit(cells) {
    try {
      const r = await window.ImageBase.createRecord('tb123456789012', cells);
      setRecords([r, ...records]);
    } catch (e) {
      alert(e.message);
    }
  }

  // ... render
}
```

### 硬规则

- 所有 SDK 调用必须 try/catch
- loading / error / empty state 都要处理（别只画 happy path）
- 用户友好的错误提示（不是扔 stacktrace）
- 字段类型转换（Number / DateTime / SingleSelect 的 value 格式不同）
- 如果要写入，在 UI 里明确 CTA 文案 "提交" / "保存" / "删除"（不要默认动作）

### 反例
- 用硬编码的假数据代替真 SDK 调用
- 写"接下来你可以手动连接 API"——你就是来连的
- 忽略 error state 只画成功态
```

### 10.4 路由矩阵（两个 vibe skill 的协作）

**激活规则**：由各自 trigger regex 独立判断，可以同时激活。

**阶段化顺序**：由 promptFragment 强制约束——有 design 意图则先走 design 阶段，完成后 coding 接手。

| 用户输入 | 激活的 skill | 实际工作流 |
|---|---|---|
| "**给我搭一个 CRM**" | demo + **coding** | 跳过设计阶段，直接用中性 Tailwind + CRUD 实现 |
| "做个漂亮的 CRM" | demo + **design + coding** | design 先提 4 个方向 → 用户选 → design 产 token → coding 按 token 实现 |
| "做个好看的落地页" | demo + **design** | 设计阶段走完 → **design 自己 write_demo_file**（纯展示，coding 不参与） |
| "做个 dashboard 带用户登录" | demo + **coding** | 跳过设计，直接写代码 |
| "基于产品调研做个**有设计感**的 HTML 报告" | demo + **design + coding** | design 定 token → coding 调 `readIdea` 拿内容按 token 渲染 |
| "基于产品调研做个 HTML 报告" | demo + **coding** | 跳过设计，中性样式 + 调 `readIdea` 渲染 |

**设计意图不足时 design 不介入**——这就是 vibe-design trigger 设计得严的理由：
仅仅出现 "做个 / 写个 / 帮我做" 不触发；必须有 "漂亮 / 视觉 / 风格 / 落地页 / mockup" 等明确审美诉求的词才触发。

### 10.5 中途追加设计意图

用户可能在 coding 阶段进行中说 "这个界面太丑，能不能换个风格" → 触发 design-trigger → design-skill 补激活。

此时 design promptFragment 指导：基于**已有代码结构**提炼 / 修改 token，让 coding skill 按新 token **改造现有代码**（而非重写）。两个 skill 的 promptFragment 在这个 case 下需要协同——我们在 V2 期加入"协同规则"的明文指导，V1 先靠模型自然理解。

---

## 11 · Chat UI：ChatCodingFlowCard

### 11.1 动机

Demo 生成是一个多 tool-call 的序列（write_file × N + build_demo + optionally publish_demo）。用户体验上需要一个**聚合的多步流程卡**，而不是 N 个独立的 ToolCallCard。

### 11.2 协议扩展：`tool_group`

现有 SSE 事件：`tool_start` / `tool_progress` / `tool_heartbeat` / `tool_result`。

新增：
```
event: tool_group_start   data: { groupId, groupType: "demo-coding", steps: [{key, label, expectedTool}, ...] }
event: tool_group_step    data: { groupId, stepKey, stepStatus: "running"|"success"|"error", message? }
event: tool_group_end     data: { groupId, finalStatus: "success"|"error" }
```

Agent 在 demo-skill 触发时，开头先 yield 一个 `tool_group_start`，后续每个 tool call 映射到对应 step，最后 `tool_group_end`。

### 11.3 FE 组件：`ChatCodingFlowCard.tsx`

```tsx
<div className="chat-coding-flow-card">
  <header>
    <span className="flow-title">Demo 生成</span>
    <StatusPill status={overallStatus} />
  </header>
  <ol className="flow-steps">
    <Step status="success" label="编写代码" detail="写了 3 个文件：index.html, app.tsx, style.css" />
    <Step status="success" label="编译" detail="bundled in 1.2s, 48KB" />
    <Step status="running" label="部署中..." detail={<ProgressStrip />} />
    <Step status="pending" label="发布" />
  </ol>
  {finalStatus === "success" && (
    <footer>
      <LinkButton onClick={openPreview}>查看 Demo</LinkButton>
      <LinkButton onClick={openPublishDialog}>发布</LinkButton>
    </footer>
  )}
</div>
```

样式：继承 `chat-expand-card` 的基础样式；`.flow-steps` 垂直列表；每个 step 左侧 24px 图标（✓ / ◌ 动画 / ○ / ✗）+ 右侧 label/detail。

### 11.4 聚合逻辑

Chat 流处理：

```typescript
// 收到 tool_group_start → 创建 CodingFlowCard 占位 + 建立 groupId → steps 映射
// 后续所有 tool_start / tool_progress / tool_result 如果 belong to this group（按 callId prefix 或 tool name 匹配）→ 喂给对应 step
// 普通 ToolCallCard 只在 group 外的 tool calls 生效
```

Agent 侧：demo-skill 的 orchestrator 逻辑（内置在 Agent loop 的 skill hook 里）：激活 demo-skill 时自动 yield group_start，每个 demo-skill 工具调完后推 group_step，最后 group_end。

（V1 也可以简化做法：FE 按工具名识别，看到连续的 `write_demo_file` / `build_demo` / `publish_demo` 自动聚合成一组，不需要后端新 event type。V2 再把协议正式化。）

---

## 12 · Demo 预览面板（右侧 sidebar 或主区域）

### 12.1 `DemoPreviewPanel.tsx`

```
┌──────────────────────────────────────────────────────┐
│  ◄  Demo：活动报名表                                   │
│                         [ build ][ 预览 ][ 发布 ][ ⋮] │
├──────────────────────────────────────────────────────┤
│                                                        │
│   ┌────────────────────────────────────────────────┐  │
│   │  <iframe src="/api/demos/:id/preview"          │  │
│   │           sandbox="allow-scripts"               │  │
│   │           style="width:100%;height:600px">     │  │
│   └────────────────────────────────────────────────┘  │
│                                                        │
│   标签栏：[ 预览 ][ 文件 ][ 构建日志 ]                │
└──────────────────────────────────────────────────────┘
```

**顶栏**：
- 返回 workspace
- Demo 名称（双击改名）
- Build 按钮（手动触发 build_demo）
- 预览 按钮（刷新 iframe）
- 发布 按钮（→ PublishConfirmDialog）
- ⋮ 菜单（导出 zip / 复制链接 / 删除 ⚠️）

**iframe sandbox 属性**：`sandbox="allow-scripts allow-forms allow-popups"`。**不加** `allow-same-origin` —— 让 iframe 是独立 origin，即便代码有问题也偷不到主站 cookie。

### 12.2 文件树（V1 只读）

`DemoFileTree.tsx`：读 `files/` 目录内容，树形展示。点文件 → 右侧 `CodeViewer` 用 `react-syntax-highlighter` 或 `Shiki` 高亮。

V1 **不支持用户直接编辑**——保持 Vibe 体验（用户只通过对话驱动 Agent 改）。V2 可加"快速编辑"入口。

### 12.3 构建日志面板

显示最近一次 `build.log`。失败时自动展开，成功时默认收起。

---

## 13 · 安全加固

### 13.1 iframe sandbox（必做）

- `sandbox="allow-scripts allow-forms"` —— 脚本运行 + 表单提交
- **NOT** `allow-same-origin` —— 防止代码访问父页 document / cookies
- **NOT** `allow-top-navigation` —— 防止跳转主站
- **NOT** `allow-popups-to-escape-sandbox`

### 13.2 Content Security Policy

Demo preview 响应头（同时 published `/share/:slug` 响应头也用）：

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://cdn.tailwindcss.com https://esm.sh 'unsafe-inline';
  style-src 'self' https://fonts.googleapis.com 'unsafe-inline';
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data: blob: https:;
  connect-src 'self';
  frame-ancestors 'self';
```

`connect-src 'self'` 是关键——Demo 里任何 fetch 只能回到自家（即我们的后端）；无法偷偷 fetch 到 evil.com 把数据传走。

### 13.3 外部资源白名单（V3 做）

V1 信任 Agent 不写 `<script src="https://evil.com/x.js">`。V3 加：
- build 时检测 `<script src>` 是否在白名单（tailwindcss.com / esm.sh / fonts.googleapis.com 等）
- 不在白名单的 URL 拒绝 build

### 13.4 限流

详见 §6.3。每 demo 每 IP 每小时：读 1000 / 写 100。超限返回 429。

### 13.5 slug 不可枚举

12 位 base62 = 62^12 ≈ 3.2×10^21，暴力枚举不现实。

### 13.6 发布确认的教育作用

每次发布都展示清单 + 警告文案。让用户对"我在把这些数据暴露出去"有明确感知。

### 13.7 published demo 的操作日志（可选 V3）

所有 `/share/:slug` 下发生的 write 操作记到日志：`timestamp, demoId, slug, ip, op, tableId, recordId`。给管理员看谁在写数据。

### 13.8 恶意内容扫描（V5+）

Agent 生成代码 + 发布 URL → 理论上可以被用来搭公开钓鱼页面。V5 考虑加关键词过滤 / 域名检查（例如不让 HTML 里出现 `paypal.com` 跟 login 表单）。V1 不做。

---

## 14 · 文件变更清单（V1 范围）

### 新建 · Backend

| 文件 | 说明 |
|---|---|
| `backend/prisma/schema.prisma` (Demo model 追加) | 加 Demo model |
| `backend/src/schemas/demoSchema.ts` | Zod schemas（capabilities / files / publish） |
| `backend/src/routes/demoRoutes.ts` | `/api/demos/*` CRUD + 文件读写 |
| `backend/src/routes/demoRuntimeRoutes.ts` | `/api/demo-runtime/:id/*` 7 handler |
| `backend/src/routes/publicDemoRoutes.ts` | `/share/:slug/*` 静态 serve |
| `backend/src/services/demo/demoFileStore.ts` | `~/.imagebase/demos/<id>/` 文件读写 |
| `backend/src/services/demo/demoBuildService.ts` | esbuild Node API 封装 |
| `backend/src/services/demo/demoSdkInjector.ts` | 生成 sdk.js 内容 + 注入 index.html |
| `backend/src/services/demo/demoPublishService.ts` | 发布流程 |
| `backend/src/services/demo/demoCapabilityGuard.ts` | Express middleware |
| `backend/src/services/demo/demoCleanup.ts` | 过期发布清理 cron |
| `backend/mcp-server/src/tools/demoNavTools.ts` | Tier 1: list_demos, get_demo |
| `backend/mcp-server/src/tools/demoWriteTools.ts` | Tier 2: 10 个写工具 |
| `backend/mcp-server/src/skills/demoSkill.ts` | skill 定义 |
| `backend/mcp-server/src/skills/vibeDesignSkill.ts` | |
| `backend/mcp-server/src/skills/vibeCodingSkill.ts` | |
| `backend/src/scripts/demo-p1-smoke.ts` | P1 冒烟 |
| `backend/src/scripts/demo-p2-smoke.ts` | P2 冒烟 |

### 新建 · Frontend

| 文件 | 说明 |
|---|---|
| `frontend/src/router/` | React Router 配置 |
| `frontend/src/components/DemoPreviewPanel/` | 主组件 + 子组件 |
| `frontend/src/components/DemoPreviewPanel/DemoFileTree.tsx` | |
| `frontend/src/components/DemoPreviewPanel/DemoPublishDialog.tsx` | |
| `frontend/src/components/DemoPreviewPanel/DemoCapabilityEditor.tsx` | |
| `frontend/src/components/DemoPreviewPanel/CodeViewer.tsx` | |
| `frontend/src/components/ChatSidebar/ChatMessage/ChatCodingFlowCard.tsx` | |
| `frontend/src/components/Sidebar/DemoSidebarSection.tsx` | Demo 列表区块 |
| `frontend/src/hooks/useDemoSync.ts` | SSE 订阅 Demo 事件 |

### 修改 · Backend

| 文件 | 改动 |
|---|---|
| `backend/src/index.ts` | 挂新 routes + 启动 cleanup cron |
| `backend/src/services/eventBus.ts` | 加 demo:* workspace event types |
| `backend/mcp-server/src/tools/index.ts` | Tier 1 加 list_demos/get_demo |
| `backend/mcp-server/src/skills/index.ts` | 注册 3 个新 skill |
| `backend/src/services/chatAgentService.ts` | 新增 tool_group_start/step/end SSE 事件支持（或纯 FE 聚合） |
| `backend/package.json` | 加 `esbuild` 作为生产依赖（Vite dev deps 里有但 backend 直接跑需要显式依赖） |
| `backend/src/routes/chatRoutes.ts` | SSE 转发 tool_group_* 事件（如果选协议级方案） |
| `CLAUDE.md` | 架构章节加 Demo 说明 |

### 修改 · Frontend

| 文件 | 改动 |
|---|---|
| `frontend/src/App.tsx` | 从 state-driven 改为 URL-driven（大改） |
| `frontend/src/Sidebar.tsx` | 加 DemoSidebarSection；点击改 navigate |
| `frontend/src/api.ts` | Demo CRUD 客户端函数；tool_group SSE 解析 |
| `frontend/src/i18n/{zh,en}.ts` | Demo-related 新键 |
| `frontend/package.json` | 加 `react-router-dom@6` + syntax highlighter |
| `frontend/src/components/ChatSidebar/ChatMessage/ToolCallCard.tsx` | 群组匹配降级，让 group 范围内的 tool call 折叠 |

### 新建 · Docs

| 文件 | 说明 |
|---|---|
| `docs/vibe-demo-plan.md` | 就是本文 |
| 更新 `docs/design.md` | 新增 Vibe Demo 章节 |
| 更新 `docs/test-plan.md` | P0/P1 用例 |
| 更新 `docs/changelog.md` | 发版记录 |
| 更新 `.claude/skills/ui-frontend-design.md` | 可能合并 Vibe design 规范 |

---

## 15 · P0 验证用例

### P0 基础（V1）

1. **创建 static Demo**：输入"做一个静态落地页" → Agent 激活 demo-skill + vibe-design → `create_demo` → 写 index.html + style.css → `build_demo` → 预览面板显示
2. **创建 react-spa Demo**：输入"做一个 TODO list" → 创建 react-spa 模板 → 写 app.tsx → build → 预览 UI
3. **Demo 读 Table 数据**：输入"基于需求管理表做个看板" → Agent 调 `update_demo_capabilities(['tbl_requirements'], {'tbl_requirements': ['query']})` → 写 React 代码用 `window.ImageBase.query` → build → 预览里看到真实表的数据
4. **Demo 写 Table 数据**：输入"做一个报名表单" → Agent 创建/确认表 → 声明 `capabilities: {'tb123456789012': ['query', 'createRecord']}` → UI 有"提交"按钮 → 点击真写入 Table
5. **Schema 操作被拒**：浏览器 devtools 里调 `fetch('/api/demo-runtime/demoId/tables')` → 404（根本没这个路由）
6. **未声明能力被拒**：SDK 没 `deleteRecord` 方法；手写 fetch 调后端 DELETE 路由返回 403（capability guard）
7. **发布 Demo**：build 完 → `publish_demo` → 弹 PublishConfirmDialog 列出能力清单 → 确认 → 生成 slug → `/share/:slug` 可匿名访问
8. **Unpublish**：unpublish_demo → `/share/:slug` 立即 404
9. **URL 深链**：手动在地址栏敲 `/w/doc_default/m/:demoId` → 直接打开预览面板；刷新不丢选中
10. **跨 workspace 隔离**：Demo A 的 demoId + Demo B workspace 的 tableId → capability guard 返回 403
11. **build 失败 + 自动修复**：故意让 Agent 写出语法错误 → build_demo 返回 error → Agent 根据 log 修 → 再 build → 通过
12. **build 失败到顶**：连续 2 次修不好 → Agent 不再自动，转向用户描述错误
13. **SSE 事件**：chat 里看到 tool_progress 事件正常显示 phase："bundling", "writing"
14. **DemoPreviewPanel 内 iframe**：iframe sandbox attribute 正确；`allow-scripts` 但不 `allow-same-origin`
15. **ChatCodingFlowCard**：chat 里看到多步进度，步骤按 write → build → publish 依次完成

### P0 Vibe 差异化 / 阶段化路由

16. **纯 coding（无设计意图）**：输入 "给我搭一个 CRM" → vibe-coding-skill 激活，**vibe-design-skill 不激活** → 直接生成中性风格 + 功能完整的 Demo
17. **纯 design（无功能意图）**：输入 "做一个漂亮的落地页" → vibe-design-skill 激活 → 走完方向提议 + 定稿 token 后 **自己 write_demo_file**（coding skill 不介入） → 预览看到极端审美作品（非 purple 渐变 + Inter）
18. **design + coding 双阶段**：输入 "做个好看的 CRM" → 两个 skill 都激活
    - 第 1 轮：design 提 4 个方向，**不写代码**
    - 第 2 轮：用户选方向 → design 产 token → 明确说 "交给 coding 阶段"
    - 第 3 轮：coding 按 token 写代码 → build → 预览
19. **基于 Idea 的分析报告**：输入 "基于这份产品调研做一份有设计感的 HTML 报告" →
    - Agent 声明 `dataIdeas: ["ide..."]`、`capabilities: {"ide...": ["readIdea"]}`
    - design 先定风格 token
    - coding 按 token 写 React 代码，内部调 `window.ImageBase.readIdea(...)` 拿 Markdown 内容后渲染
    - 发布后 `/share/:slug` 任何人可以看
20. **中途加设计意图**：先 "做个 CRM" → coding 直接写 → 用户看了说 "能不能换个风格" → design 补激活 → design 基于现有代码 extract token + 说明改造方向 → coding 按 token 改

### P0 URL 路由改造

21. **Table URL**：`/workspace/doc_default/table/tb12345678` 直接打开那张表（兼容旧 cuid）
22. **Idea URL**：同上 for idea
23. **Design URL**：同上 for design
24. **浏览器后退**：在各 artifact 间切换后按后退键，正确回到上一个
25. **复制 URL 分享**：从 Demo 预览页复制 URL（内部），粘给同事打开看到一样的

### P0 ID 格式

26. **新建 Demo** → id 匹配 `^dm\d{12}$`
27. **新建 Record** → id 匹配 `^rc\d{12}$`
28. **ID 碰撞 retry**：mock 一次 collision → 第二次 generate 通过 → 实体成功创建
29. **旧格式兼容**：访问 `/workspace/doc_default/table/tbl_requirements`（旧 cuid 格式）仍然能打开

### P0 发布安全

30. **公开 URL 无登录访问**：未登录浏览器打开 `/share/:slug` → 直接看到 Demo UI
31. **限流（读）**：1 分钟内快速发 201 次读 → 第 201 次返回 429 + Retry-After
32. **限流（写）**：1 分钟内快速发 31 次写 → 第 31 次返回 429
33. **日兜底**：24h 单 IP 10001 次写 → 第 10001 次被封
34. **schema 操作拒绝**：手动 fetch `POST /api/demo-runtime/:id/tables`（创表）→ 404（route 不存在）
35. **未声明能力拒绝**：SDK 里没 `deleteRecord`；手动 fetch `DELETE /records/:id` 返回 403（capability 不在）
36. **Idea 写入被拒**：`POST /api/demo-runtime/:id/ideas` → 404（无此路由）

---

## 16 · 风险 & 预案

| 风险 | 概率 | 影响 | 预案 |
|---|---|---|---|
| URL 路由改造 regressions | 高 | 高 | V1 先把改造部分单独 feature flag；V1 smoke 只跑路由；上线 beta 小步走 |
| esbuild bundle 大模型生成代码失败率高 | 中 | 中 | retry 2 次 + 好的错误提示；prompt 里明确依赖规则（不能用 fs/path 等 Node-only） |
| Demo 发布 URL 被滥用成公开接口 | 中 | 高 | slug 12 位不可枚举；限流；发布确认教育；capability guard 严格 |
| published demo 数据泄漏 | 中 | 高 | capability 声明机制 + 发布确认 UI；不允许未声明的能力 |
| Demo 代码里 XSS 到父站 | 低 | 高 | iframe sandbox 不加 allow-same-origin；CSP 严格 |
| 单个 Demo 生成出 > 1MB bundle | 中 | 中 | build 日志展示 size；prompt 软引导；真超大的 OK 但体验降级 |
| Agent 频繁 delete_demo 误删 | 中 | 中 | delete_demo 是 danger 工具，二次确认；磁盘不立刻删，移到 `deleted/` 7 天后 cron 清 |
| 用户发布后 table schema 改了导致 demo 报错 | 高 | 中 | published demo 调用时返回错 → 代码里 try/catch → 用户看到 "字段不存在" → 触发重新生成 |
| iframe 太重导致主站慢 | 低 | 低 | lazy iframe（用户切到 demo panel 才加载） |
| React Router 和现有 SSE hook 冲突 | 中 | 中 | hook 改写：从 params 读 artifactId，useEffect deps 换掉 |
| Node 进程 ESBuild 泄漏子进程 | 低 | 中 | esbuild Node API 是同进程；有 bundle timeout；不 spawn 子进程 |
| Vibe 触发词冲突 | 中 | 低 | 两个 skill 同时激活是 OK 的，prompt 互补不冲突 |

---

## 17 · 分期交付

| 版本 | 范围 | 工期 |
|---|---|---|
| **V1**（4 周） | URL 路由全改造 + Demo Prisma + 文件系统 + esbuild + 7 runtime handler + SDK 注入 + 发布 + demo-skill + vibe-design-skill + vibe-coding-skill + 预览面板 + 文件树（只读） + ChatCodingFlowCard + 导出 zip + P0 用例 1-25 | ~4w |
| **V2**（2 周） | build 失败自动修复 loop 优化 + CodeViewer 高亮（Shiki） + 编辑 capabilities UI + 模板库扩展（加 "empty" + "landing" + "crud" 预设） + Demo @mention 支持 | ~2w |
| **V3**（1 周） | 外部资源白名单 + published demo 操作日志 + 每字段级 capability（V1 是表级） + build 性能指标 | ~1w |
| **V4**（2 周） | 自定义域名（nginx SNI + Let's Encrypt 动态） + published 使用统计 + Demo 版本历史 + 回滚 | ~2w |
| **V5**（1 周） | 恶意内容关键词扫描 + 性能优化（大 Demo 分包） + 文档打磨 + 若干边界修复 | ~1w |

**总计 ~10 周**单人全栈。

### 关键依赖链

- **V1 先做 URL 路由改造**（Week 1）→ 其他一切都 depend 它
- Demo 核心（file store + esbuild + SDK + publish）并行（Week 2-3）
- Skills + prompts + chat UI（Week 3-4）
- V2-V5 纯增量

---

## 18 · 关键权衡记录

| 选择 | 原因 |
|---|---|
| 云端 iframe 预览（不做 localhost） | Browser-Server 架构下 localhost 被 mixed content 策略堵死，未来 CS 产品再做 |
| 单进程 esbuild Node API | 已有 Vite 依赖；子进程隔离 overkill；30s 超时足够 |
| published 直读写活数据（不 snapshot） | 用户明确需求；CRM 场景不能只读 snapshot；牺牲安全性以换实用性，用 capability 机制缓解 |
| Per-table capability（不是全局） | 给"一张表读一张表写"这种合理场景空间；per-field 留给 V3 |
| SDK 架构级切分 schema ops | 比"白名单 filter"更安全：schema 级操作**根本没有 handler 代码存在** |
| 两个独立 Vibe skill + 共享底层 tools | 关注点分离；可同时激活；prompt 模块化；便于未来扩展第三种 skill（如 "Vibe animation"） |
| React + TS + Tailwind CDN（不 bundle） | 每个 Demo 不单独打 150KB React；CDN 缓存共用 |
| URL 路由是全 artifact 改造（不只 Demo） | 产品一致性；少做反而用户更困惑 |
| build 失败 2 次 retry 上限 | 保护 token budget；3 次仍失败大概率是需求本身有问题 |
| 不做硬文件数 / 行数限制 | 用户明确反对；物理限制（build 超时）当 floor 就够 |
| 不做 WebContainer / StackBlitz | 商用授权复杂；体验边际提升小；CS 产品形态更合适 |
| URL `/workspace/:id/{table,idea,design,demo}/:id` 可读长路径 | 分享时一眼知道类型；代价是 URL 长；比缩写更符合生产系统习惯 |
| Published 用 `/share/:slug` 而非 `/p/:slug` | 语义明确（这是分享出来的）；和私有 `/workspace/.../demo` 不冲突 |
| ID 格式 前缀 + 12 位数字（不是 base62） | 用户明确选择；数字纯粹可读；10^12 空间 retry 成本几乎为零；不和现有 cuid 冲突 |
| Idea SDK 只读（不暴露 write） | Idea streaming write 协议复杂；Vibe Demo 典型场景（分析报告 / 引用说明）只需要读 |
| 两个 vibe skill 的"阶段化"靠 prompt 而非 tool 级门控 | 灵活度 > 强制度；用户中途改主意不会被死锁；代价是依赖模型遵守 prompt 规则 |
| 限流单位改每分钟滑动窗口 + 日兜底 | 每小时太粗；滑动窗口对 burst 友好；日兜底封长期慢速滥用 |

---

## 19 · 后续扩展占位

- **V6：实时协作** — 多人同时编辑同一 Demo 文件；类似 Figma 的 cursor presence
- **V7：模型生成完后用户可修改代码** — DemoFileTree 加编辑能力，用户改后 auto-rebuild
- **V8：Demo 组合** — 一个 Demo 引用另一个 Demo 的组件（`import App from '../other-demo/app'`）
- **V9：Demo 版本 diff 视图** — 每次 Agent 改代码，UI 里看 diff
- **V10：CS 产品方向** — Electron / Tauri 壳内 true localhost；真 npm install；真全栈
- **V11：数据沙箱** — published demo 可选切到只读快照模式（用户勾选时打开）
- **V12：监控告警** — published demo 异常流量报警；恶意使用检测

---

## 20 · 实施建议（day-level，V1 四周）

```
Week 1 - URL 路由改造（先还技术债）
  Day 1-2: 引 React Router + 设计路由表
  Day 3-4: App.tsx / Sidebar / 相关 hook 从 state-driven 改为 URL-driven
  Day 5:   所有 artifact 的 deep link 验证 + mention chip 改 navigate

Week 2 - Demo 基建
  Day 1:   Prisma Demo model + migrate + 基础 REST CRUD
  Day 2:   demoFileStore + 文件系统布局 + capability schema
  Day 3:   esbuild Node API 集成 + 两种模板（static / react-spa）
  Day 4:   SDK 注入器 + `/api/demo-runtime/:id/sdk.js`
  Day 5:   7 个 demo-runtime handler + capability guard + workspace 隔离测试

Week 3 - Agent 侧
  Day 1-2: demo-skill（工具定义 + 基础 promptFragment）
  Day 3:   vibe-design-skill + vibe-coding-skill promptFragment 从 Anthropic 内容吸纳
  Day 4:   build 失败 retry 流程 + tool_group SSE 事件
  Day 5:   发布流程（snapshot + slug 生成 + /share/:slug serve）

Week 4 - Frontend
  Day 1-2: DemoPreviewPanel 框架 + iframe + 文件树（只读）
  Day 3:   ChatCodingFlowCard 组件 + SSE 消费
  Day 4:   PublishConfirmDialog + CapabilityEditor
  Day 5:   集成测试 + P0 用例全跑 + 文档更新 + 上线 beta
```

---

## 结语

Vibe Demo 是项目里**第一个不止"操作既有数据"而是"生成新运行物"的 Agent 能力**。Analyst 解决的是"LLM 给数据做计算"，Vibe 解决的是"LLM 给用户做界面"。两者合起来就能支撑"我想要个数据驱动的小工具 / 小 app"的完整场景。

关键赌注：
- **SDK 架构级切分**：让"schema 级操作完全不存在"而非"白名单过滤"，给未来的安全加固留了干净的边界
- **capability per-table 声明**：把公开 Demo 的权限暴露面压到能接受的范围
- **URL 路由 V1 先做**：虽然是个纯后悔债，但不做就没法谈分享

其他所有选择（esbuild / iframe / 导出 zip / 两 vibe skill）都是围绕这三个赌注的配套。

验收标准：

- 用户说 "做一个报名表单，连到需求表，带提交按钮" → 2 分钟内生成可用的 Demo，点发布后得到一个 URL，路径外的人打开能填写，提交后在需求表里看得到新记录。
- 用户说 "做一个漂亮的产品落地页" → 生成的东西**视觉上不 AI slop**，字体不是 Inter，配色不是紫白渐变。
- 用户说 "基于分析结果做个 dashboard" → analyst-skill 给出 handle，Agent 拿数据 → vibe-coding-skill 生成交互界面，绕开 analyst 数据的死胡同问题（先聚合再展示）。

这三件事做到，就是精品。
