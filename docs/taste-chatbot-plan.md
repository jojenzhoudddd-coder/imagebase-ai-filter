# Taste (SVG) × Chatbot 方案设计

## Context

当前 Chatbot 已经能读写 **Table** 和 **Idea**（通过 MCP Tier 0/1/2 架构 + Skill 渐进式披露），但对第三类 workspace artifact —— **Taste (SVG 设计图)** —— 还完全不可见。

本方案让 Chatbot：
1. 把 Taste API 全部镜像成 MCP 工具，按现有 tier 规范分层落位
2. 读取 workspace 下所有 taste 的 SVG 内容 + 每张图的**视觉设计风格 meta**（主题色、字号、间距、阴影等），meta 按"懒生成 + 后台预热"双轨产出
3. 生成 / 改写 SVG 并写回 taste 文件；每次写入后自动触发一次 auto-layout

---

## 术语对齐（已与用户确认）

**重要**：这里发生了一次产品定义的重名。

- **产品新语境**（用户期望的未来命名）：artifact 层叫 **Taste**，下级 SVG 单元叫 **Node**
- **代码/DB 现状**：artifact 层叫 **Design**，下级 SVG 单元叫 **Taste**

```
产品语境       代码/DB 语境
─────────      ─────────────
Taste      ≡   Design    (sidebar 顶层 artifact，id: des_xxx)
  └ Node   ≡     └ Taste  (1 张 SVG，id: tst_xxx)
```

**本期决策（方案 A，零重构）**：
- Prisma / routes / services / FE 组件 / MCP 工具 / mention URI 全部沿用现有 **Design/Taste** 命名
- 文档和对话里用户可能用 "Taste/Node" 表述；开发侧统一用 "Design/Taste"
- 全栈 rename（Design→Taste, Taste→Node）作为独立 issue 跟进，本次 plan 只记录不执行

**对本 plan 的具体影响**：
- Meta 生成粒度 = 每张 SVG 一份（= 每 Taste 一份 = 产品语境的每 Node 一份）
- MCP 工具命名 = `list_designs` / `list_tastes` / `get_taste` ...（代码名）
- Auto-layout 对象 = 一个 Design 下的所有 Taste（不递归进 SVG 内部 `<g>`/`<path>`）
- SVG 内部子元素粒度**不拆**，保留给未来 v3+ 讨论

---

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                          Chatbot                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Tier 1 (always-on, ~3 tools, 纳入 core MCP):       │   │
│  │    list_designs / list_tastes / get_taste            │   │
│  ├──────────────────────────────────────────────────────┤   │
│  │  Tier 2 (taste-skill, 触发词/显式激活后加载):        │   │
│  │    create_design / rename_design / delete_design⚠️  │   │
│  │    create_taste_from_svg / rename_taste              │   │
│  │    update_taste (移动/缩放) / delete_taste⚠️        │   │
│  │    auto_layout_design / batch_update_tastes          │   │
│  │    (replace_taste_svg 本期不实现：默认只追加)        │   │
│  └──────────────────────────────────────────────────────┘   │
│                        ↓ (via MCP stdio)                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  backend/mcp-server/src/tools/designTools.ts         │   │
│  │  backend/mcp-server/src/tools/tasteTools.ts          │   │
│  │  backend/mcp-server/src/skills/tasteSkill.ts         │   │
│  └──────────────────────────────────────────────────────┘   │
│                        ↓ (HTTP localhost)                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  backend/src/routes/designRoutes.ts (extended)       │   │
│  │  backend/src/routes/tasteRoutes.ts (extended)        │   │
│  │    + GET /tastes/:id/meta        (read meta)         │   │
│  │    + POST /tastes/:id/meta/regenerate (force refresh)│   │
│  │    + POST /designs/:id/auto-layout (grid layout)     │   │
│  │  backend/src/services/tasteMetaService.ts (new)      │   │
│  │  backend/src/services/autoLayoutService.ts (new)     │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1 · 数据模型

### 1.1 Prisma schema 扩展

`backend/prisma/schema.prisma` 在 `Taste` model 加三个字段：

```prisma
model Taste {
  // ... existing fields
  meta            Json?      // 设计风格结构化元数据（见下）
  metaGeneratedAt DateTime?  // meta 最近一次生成时间；null 表示从未生成
  svgHash         String?    // SVG 内容 SHA-256 前 16 位，作为 meta 缓存失效 key
}
```

**迁移**：`npx prisma migrate dev --name add_taste_meta` —— 三个字段都可空，现有 Taste 行全部 null，不需要数据回填。

### 1.2 Meta schema（TypeScript 类型，纳入 `backend/src/schemas/tasteSchema.ts`）

```typescript
export const TasteMetaSchema = z.object({
  // 颜色
  themeColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),        // 主色
  hoverColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),        // hover/active
  auxColors: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).optional(), // 辅助色
  // 排印
  fontFamily: z.string().optional(),
  fontSize: z.number().optional(),          // 单位 px
  lineHeight: z.union([z.number(), z.string()]).optional(),
  // 尺寸与间距
  padding: z.string().optional(),           // "12px 16px" 格式
  gap: z.string().optional(),
  borderRadius: z.number().optional(),      // px
  boxWidth: z.number().optional(),
  boxHeight: z.number().optional(),
  // 阴影
  shadow: z.string().optional(),            // "0 2px 8px rgba(0,0,0,0.08)"
  // 语义
  tags: z.array(z.string()).optional(),     // ["button", "primary", "cta"]
  description: z.string().max(200).optional(),
});
export type TasteMeta = z.infer<typeof TasteMetaSchema>;
```

Zod 双用：REST 返回值校验 + MCP 工具 inputSchema 来源（同现有 table/idea schema 做法）。

---

## Phase 2 · Meta 生成服务（懒生成 + 后台预热）

### 2.1 `backend/src/services/tasteMetaService.ts`

核心接口：

```typescript
// 同步生成 —— 阻塞，直到拿到 meta 或失败
generateMeta(tasteId: string): Promise<TasteMeta>

// 异步预热 —— fire-and-forget，背压队列控制并发
enqueueMetaGeneration(tasteId: string): void

// 读 meta，如果缺失且 syncIfMissing=true 则同步生成一次再返回
getMeta(tasteId: string, opts?: { syncIfMissing?: boolean }): Promise<TasteMeta | null>
```

### 2.2 Prompt 结构（结构化输出）

使用**当前 Agent 选中的模型**（`resolveModelForCall(agentId)` → `resolveAdapter(model).stream()`），JSON mode 强制结构化。模型不支持 JSON mode 时降级为"输出必须以 `{` 开头"的指令 + 事后解析：

```
你是一位资深 UI 设计系统分析师。分析以下 SVG 代码，提取其视觉设计风格。

【输出规则】
- 只输出一个 JSON 对象，不要任何解释、Markdown 代码块围栏
- 所有颜色用小写 hex (#aabbcc)
- 字号/圆角/边长用纯数字（px 单位，不带后缀）
- 识别不到的字段**省略**（不要用 null、空字符串占位）

【字段】
themeColor      主色调（出现频率最高的非灰/黑/白色）
hoverColor      推断的 hover 色（主色相近 ±10% 亮度）
auxColors       辅助色数组，最多 5 个
fontFamily      字体族名
fontSize        主文本字号
lineHeight      行高（number 或 "1.5" 这类倍数字符串）
padding         CSS padding 格式，如 "12px 16px"
gap             子元素间距
borderRadius    主容器圆角
boxWidth,boxHeight  主容器宽高
shadow          CSS box-shadow 字符串
tags            组件类型标签数组（button / card / modal / input / navbar 等）
description     一句话概括（≤ 40 字）

【SVG】
{svg_content}
```

- SVG 超过 8 KB 截断到前 8 KB（大部分样式信息集中在头部 defs + 前几组）
- 失败重试 1 次；两次失败写 `meta: null` + `metaGeneratedAt: now()` 标记"已尝试过"，避免每次读取都重试
- 日志写 `backend/logs/taste-meta-<gmt8date>.log`，和 `aiService.ts` 日志规范一致

### 2.3 生成时机

| 时机 | 行为 | 实现位置 |
|------|------|---------|
| 新建 taste（upload / from-svg / from-figma） | `enqueueMetaGeneration(tasteId)` —— 后台跑，HTTP 立即返回 | `tasteRoutes.ts` 三个 create handler 末尾 |
| MCP `get_taste(includeMeta:true)` | 若 meta 缺失 → 同步生成一次 | `tasteMetaService.getMeta({syncIfMissing:true})` |
| 用户手动"刷新 meta" | `POST /tastes/:id/meta/regenerate` 强制重生成 | 新 REST 路由 |

（注：本期不提供 SVG in-place 替换路径，写入只追加新 Taste，所以 meta 缓存失效只发生在 regenerate 显式触发时。）

### 2.4 背压队列

单进程内维护 `Set<pendingTasteIds>` + 最大并发 3：
- 队列满 → 新任务等待（不拒绝）
- OneAPI 限流 503 → 指数退避 1s/2s/4s，最多重试 1 次后放弃
- 进程重启丢失队列 —— 可接受（下次读取时懒生成兜底）

---

## Phase 3 · REST 路由扩展

所有新增路由遵循 `api-conventions.md`：`/api/designs/:designId/...`，`x-client-id` 头、`eventBus.emitChange()` 发 SSE。

### 3.1 新增端点

| 方法 | 路径 | 说明 | 返回 |
|------|------|------|------|
| GET | `/api/designs/:designId/tastes/:tasteId/meta` | 读取 meta，`?sync=1` 缺失时同步生成 | `{meta: TasteMeta \| null, generatedAt, status: "ready"\|"generating"\|"failed"}` |
| POST | `/api/designs/:designId/tastes/:tasteId/meta/regenerate` | 强制重生成 | `{meta: TasteMeta, generatedAt}` |
| POST | `/api/designs/:designId/auto-layout` | 对该 design 下所有 taste 跑 grid layout + 持久化 | `{updates: [{id,x,y}...], bounds: {width,height}}` |

### 3.2 SSE 事件扩展

`eventBus` 现已支持 `design:*` / `taste:*`，新增：
- `taste:svg-updated` —— SVG 内容被替换（前端重新 fetch inline）
- `taste:meta-updated` —— meta 生成完成（前端在后续 v2 右抽屉展示）
- `design:auto-layout` —— 批量位置更新（前端复用现有 `taste:update` 逻辑）

### 3.3 Auto-layout 后端化

当前 `computeGridLayout()` 只存在于 `frontend/src/components/SvgCanvas/index.tsx` L80–L152。我们把它 **整体搬迁** 到 `backend/src/services/autoLayoutService.ts`：

- Pure function：`computeGridLayout(tastes) → {updates, bounds}`，签名不变
- 单元测试（新增 `backend/src/scripts/auto-layout-smoke.ts`）对比前后端结果逐像素一致
- Frontend 继续导入本地副本 **（暂不删）**，只在 `POST /auto-layout` 路径走后端版本；等 MCP 完整上线稳定一个发布周期后再删前端版本，避免回滚困难

### 3.4 写入后的 auto-layout 钩子

用户要求："每次插入完成，主动进行一次 auto layout"。实现：

- `POST /tastes/from-svg` handler 末尾、`eventBus.emitChange()` 之前，调用 `autoLayoutService.computeGridLayout(allTastesInDesign)` 并 batch 更新位置
- 返回给 caller 的 taste 对象带上 auto-layout 后的新位置
- Frontend 已经订阅 `taste:update` → 位置自动同步

**例外**：upload（文件拖拽）和 from-figma 的时机保留现状 —— 那两个入口是**用户手动**触发的，auto-layout 会打断他们"精心摆放"的直觉。只有 MCP 路径和 from-svg 触发 auto-layout。

---

## Phase 4 · MCP 工具层

### 4.1 文件映射（严格镜像 REST）

| REST 路由文件 | MCP 工具文件 |
|---|---|
| `routes/designRoutes.ts` | `mcp-server/src/tools/designTools.ts` |
| `routes/tasteRoutes.ts` | `mcp-server/src/tools/tasteTools.ts` |

### 4.2 工具清单（11 个）

**Tier 1（always-on，放进 `tier1Tools`）**：

| 工具 | 参数 | 说明 |
|---|---|---|
| `list_designs` | `workspaceId` | 列出 workspace 下所有 design 概览（含 taste 数量） |
| `list_tastes` | `designId` | 列出某个 design 下的 tastes（name + 尺寸 + 有无 meta） |
| `get_taste` | `tasteId, includeSvg?, includeMeta?` | 取单个 taste 的元数据；可选带 SVG 原文 + meta（meta 缺失时同步生成） |

设计取舍：`get_taste` 的 `includeSvg` 默认 false，避免 Agent 把整份 SVG 塞进上下文；只在需要读 SVG 代码时显式传 true。meta 也可选是否返回。

**Tier 2（taste-skill.tools）**：

| 工具 | 参数 | Danger |
|---|---|:---:|
| `create_design` | `workspaceId, name, parentId?` | - |
| `rename_design` | `designId, name` | - |
| `delete_design` | `designId` | ⚠️ |
| `create_taste_from_svg` | `designId, svg, name?` | - |
| `rename_taste` | `designId, tasteId, name` | - |
| `update_taste` | `designId, tasteId, x?, y?, width?, height?` | - |
| `batch_update_tastes` | `designId, updates[]` | - |
| `delete_taste` | `designId, tasteId` | ⚠️ |
| `auto_layout_design` | `designId` | - |

**本期不提供**：`replace_taste_svg`（in-place 替换 SVG 内容）。写路径只追加新 Taste；需要改图时用 `delete_taste` + `create_taste_from_svg`。这样也避免了 meta 失效+重生成的额外复杂度。

**不纳入 MCP 的 REST 能力**（用户侧 only）：
- `POST /tastes/upload` —— 文件上传，Agent 无法构造 multipart
- `POST /tastes/from-figma` —— 需要 Figma 凭证和 URL 识别，Agent 调用链路太长，Phase 2+ 再考虑

### 4.3 工具 schema 同步规则

按 `CLAUDE.md` 第 "MCP Server 与 REST API 的同步规则" 段落：
- 新建 `backend/src/schemas/designSchema.ts` + `tasteSchema.ts`（Zod）
- REST handler 和 MCP tool 的 inputSchema 都 import 同一份
- `mcp-server/src/tools/index.ts` 的启动期校验（`GET /api/_schemas`）自动覆盖新工具

---

## Phase 5 · Taste Skill

### 5.1 `backend/mcp-server/src/skills/tasteSkill.ts`

```typescript
export const tasteSkill: SkillDefinition = {
  name: "taste-skill",
  displayName: "设计图操作",
  description: "创建/修改/删除 SVG 设计图，调整画布布局",
  artifacts: ["taste"],
  when: "用户想新建设计图、生成 SVG 组件、修改画布布局、或删除/重命名设计",
  triggers: [
    /(创建|新建|生成|画|做).*(组件|按钮|卡片|UI|设计|SVG|图形|界面)/i,
    /(替换|改|更新|重写).*(SVG|设计|图)/i,
    /(自动|重新|优化).*(布局|排列|位置)/i,
    /(删除|移除).*(design|taste|设计图)/i,
    // EN equivalents
    /(create|make|generate|draw).*(button|card|component|ui|svg|design)/i,
    /(auto.?layout|rearrange|reorganize).*(canvas|design)/i,
  ],
  tools: [
    createDesignTool, renameDesignTool, deleteDesignTool,
    createTasteFromSvgTool, renameTasteTool, updateTasteTool,
    batchUpdateTastesTool, deleteTasteTool, replaceTasteSvgTool,
    autoLayoutDesignTool,
  ],
};
```

注册点：`mcp-server/src/skills/index.ts` 的 `allSkills` 数组加入 `tasteSkill`。

### 5.2 System prompt 中的 skill catalog

现有 chatAgentService 在 Layer 2 ↔ Tool Guidance 之间注入 "skill catalog"：
```
- table-skill: 数据表操作 (19 tools) [✅ active]
- idea-skill: 灵感文档写入 (8 tools)
- taste-skill: 设计图操作 (10 tools)  ← 新增
```

Skill tools 数量由 `skillsByName[name].tools.length` 动态算出，无需硬编码。

---

## Phase 6 · 前端改动（最小化）

本期**不新增**前端 UI —— meta 数据只给 Agent 看，不在 SvgCanvas 上展示。前端只需 2 处小改动：

1. **`frontend/src/hooks/useTableSync.ts`**（或新建 `useDesignSync.ts`）订阅 `taste:svg-updated` → 触发 `fetchTaste` 重拉 inline SVG
2. **`frontend/src/components/SvgCanvas/index.tsx`** 在收到 `design:auto-layout` 事件时直接更新 `tastes` state（复用现有 drag 后同步的 reducer）

Meta 可视化（右抽屉展示主题色、组件类型标签等）放到 **P1 任务**，本期不做。

---

## Phase 7 · 文件变更清单

### 新建

| 文件 | 说明 |
|------|------|
| `backend/src/schemas/designSchema.ts` | Design Zod schema |
| `backend/src/schemas/tasteSchema.ts` | Taste + TasteMeta Zod schema |
| `backend/src/services/tasteMetaService.ts` | Meta 生成服务（prompt + 队列 + OneAPI 调用） |
| `backend/src/services/autoLayoutService.ts` | 从 frontend 搬迁的 computeGridLayout |
| `backend/mcp-server/src/tools/designTools.ts` | 3 个 design 工具 |
| `backend/mcp-server/src/tools/tasteTools.ts` | 7 个 taste 工具 |
| `backend/mcp-server/src/skills/tasteSkill.ts` | Skill 定义 |
| `backend/src/scripts/taste-meta-smoke.ts` | Meta 生成烟测 |
| `backend/src/scripts/auto-layout-smoke.ts` | Layout 前后端一致性检查 |

### 修改

| 文件 | 改动 |
|------|------|
| `backend/prisma/schema.prisma` | Taste model 加 `meta Json?` / `metaGeneratedAt DateTime?` / `svgHash String?` |
| `backend/src/routes/designRoutes.ts` | 新增 `POST /:designId/auto-layout` |
| `backend/src/routes/tasteRoutes.ts` | 新增 `PUT /:tasteId/svg` / `GET /:tasteId/meta` / `POST /:tasteId/meta/regenerate`；现有 `from-svg` handler 末尾触发 auto-layout + meta enqueue |
| `backend/src/services/eventBus.ts` | 新事件类型：`taste:svg-updated` / `taste:meta-updated` / `design:auto-layout` |
| `backend/mcp-server/src/tools/index.ts` | `tier1Tools` 加入 3 个 taste nav 工具 |
| `backend/mcp-server/src/skills/index.ts` | `allSkills` 加入 `tasteSkill` |
| `frontend/src/hooks/` | 订阅新 SSE 事件 |
| `frontend/src/components/SvgCanvas/index.tsx` | 响应 `design:auto-layout` 事件 |
| `CLAUDE.md` | 在"架构注释"段落加 taste-skill 说明 |
| `docs/design.md` | 新增 "Taste × Chatbot" 章节 |
| `docs/test-plan.md` | 新增 P0/P1 用例 |

---

## Phase 8 · 实现顺序（建议单人 2 周）

```
Week 1:
  Day 1  · Prisma migration + designSchema/tasteSchema + autoLayoutService 搬迁
  Day 2  · tasteMetaService（prompt + OneAPI 调用 + 队列）+ smoke 脚本
  Day 3  · REST 路由扩展（4 个新端点）+ eventBus 事件
  Day 4  · MCP tools：designTools + tasteTools + schema 同步校验
  Day 5  · tasteSkill + 注册 + triggers 覆盖测试

Week 2:
  Day 1  · 前端最小改动（SSE 订阅 + 自动布局响应）
  Day 2  · P0 用例全量跑通
  Day 3  · Meta 可视化 spike（如有时间，提前启动 P1）
  Day 4  · 文档 + changelog + deploy dry-run
  Day 5  · 线上发布 + 观察
```

---

## Phase 9 · 测试用例

### P0（发布必过）

1. **基础查询**：输入 "列出所有设计图" → Agent 调 `list_designs` → 返回 design 列表
2. **读 SVG 代码**：输入 "第一个按钮组件长什么样？" → Agent 调 `list_tastes` + `get_taste(includeSvg:true)` → 正确回显 SVG 片段
3. **读 meta**：输入 "这个卡片用的主题色是多少？" → Agent 调 `get_taste(includeMeta:true)` → meta 缺失则同步生成，返回 themeColor
4. **生成 SVG**：输入 "画一个蓝色 primary 按钮" → Agent 调 `create_taste_from_svg` → 新 taste 出现在画布，位置经过 auto-layout
5. **改写 SVG**：输入 "把刚才的按钮改成红色" → Agent 调 `replace_taste_svg` → 画布实时更新；meta 被标记待重生成
6. **删除确认**：输入 "删掉所有 modal 组件" → Agent 先 `list_tastes` 筛选 → 弹 ConfirmCard → 确认后 `delete_taste`
7. **后台 meta 预热**：上传一张 SVG → 5s 内后台 meta 生成完成（日志可见）
8. **auto-layout MCP**：输入 "重新排列一下这个 design 的画布" → Agent 调 `auto_layout_design` → 位置网格化
9. **auto-layout 隐式**：`create_taste_from_svg` 后画布所有 taste 自动 grid 排列（不需要 Agent 再调）
10. **skill 触发**：输入 "生成组件..." 类关键词 → `taste-skill` 自动激活（日志可见 `activate_skill` 事件）

### P1（产品体验）

11. Meta 生成失败 → 返回 null + `status: "failed"`，不影响 Agent 继续对话
12. 大 SVG（> 100 KB）meta 生成：截断到 8 KB 仍能输出主色调
13. 并发 10 张 SVG 同时 enqueue → 队列背压工作，无 503 风暴
14. 前端 SSE 订阅正常，A 端改 SVG → B 端画布自动刷新
15. Skill 空闲 10 轮后被驱逐（保持和 table-skill 一致的行为）

---

## 关键技术决策 & 取舍

| 决策 | 选择 | 理由 |
|------|------|------|
| 命名 | 方案 A：沿用代码名 Design/Taste | 零重构；产品语境的 Taste/Node 重命名作为独立 issue 跟进 |
| Node 粒度 | SVG 原子不拆（1 Taste = 1 整张 SVG） | 现有 DB / uploads 零改动 |
| Meta 存储 | Taste.meta JSONB | 查询不用 join，Prisma 原生支持 Json 类型 |
| Meta 生成时机 | 后台预热 + 懒生成兜底 | 体验好 + 成本可控；前端不需要 loading 态 |
| Meta 生成 model | **当前 Agent 选中的模型** (`resolveModelForCall(agentId)`) | 遵循用户偏好；doubao-2.0 作为 fallback 兜底 |
| Write 路径 | **只追加，不替换**：移除 `replace_taste_svg` | 用户明确要求；需要改图 = delete + create 两步 |
| Auto-layout 触发 | MCP 路径 + from-svg 隐式；upload/figma 保留手动 | 尊重用户手动摆放直觉；Agent 路径保证整洁 |
| Auto-layout 位置 | 搬到后端 | 前后端统一；MCP 能直接触发 |
| Skill 边界 | 单一 taste-skill 覆盖 design+taste | 二者强耦合（无 design 就没 taste），拆开会让 Agent 在两个 skill 间反复激活 |
| Meta 可视化 | 只给 Agent 用，FE 不展示 | 用户确认 P1 再加右抽屉展示 |
| SVG upload tool | 不暴露给 MCP | multipart 构造不现实；用户手动上传场景保留 |

---

## 风险 & 预案

| 风险 | 预案 |
|------|------|
| Meta 生成质量不稳定（主题色识别错） | Prompt 迭代 + 结构化输出 JSON mode；失败时 null 兜底不阻塞 |
| 模型生成的 SVG 不合法（丢失标签 / XSS 风险） | 复用 `tasteRoutes.ts` 现有 `sanitizeSvg()`，拒绝带 `<script>` / `onload` 的内容 |
| Auto-layout 把用户手动摆放的位置覆盖 | from-svg/MCP 触发时才隐式 layout；upload/figma 保留原行为 |
| Meta 队列打满 OneAPI 限流 | 并发上限 3 + 指数退避；极端情况下 meta 失败不影响主流程 |
| Taste 数量巨大时 `list_tastes` 上下文超长 | Tier 1 list 工具只返回摘要（id/name/尺寸/有无 meta），SVG 代码走 `get_taste(includeSvg:true)` 按需读 |

---

## 已确认的 4 个关键决定（2026-04-22 对齐）

1. **Node/Taste 定义**：SVG 原子不拆；代码沿用 Design/Taste（产品语境 Taste/Node 的 rename 记 issue，独立任务推进）
2. **Meta 可视化**：本期 FE 不展示，仅 Agent 可读（通过 `get_taste(includeMeta:true)`）
3. **写路径策略**：默认只追加（`create_taste_from_svg`），不提供 in-place 替换（`replace_taste_svg` 本期不实现）。改图走 `delete_taste` + `create_taste_from_svg` 两步
4. **Meta 生成模型**：用 **Agent 当前选中的模型**，通过 `resolveModelForCall(agentId)` 拿到，`resolveAdapter(model).stream()` 分发；不支持 JSON mode 的模型降级为输出约束 prompt
