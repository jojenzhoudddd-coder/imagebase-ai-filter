# SVG → Demo 三路径并行方案

> 状态:Phase 0 实施中(2026-04-29)

把用户上传到 Taste 的 SVG 转换成可运行的 Vibe Demo,做到视觉上 100% 还原原图,并让 Agent 能在此基础上扩写交互逻辑。

## 0. 路径概览

| 路径 | 入口 | 后端 | 用时 | 保真度 | 成本 | 适用场景 |
|---|---|---|---|---|---|---|
| **A** MCP `create_demo_from_taste` | Agent 对话 | 服务端确定性转换 | 1-3s | 95%+ | 0 LLM 调用 | 大部分 Figma 导出 |
| **B** Taste UI "Make interactive" | 画布右键菜单 | 同 A 共用 | 1-3s | 95%+ | 0 LLM 调用 | 用户视觉操作入口 |
| **C** Workflow `svg_to_demo_faithful` | Agent 对话 / UI 二级菜单 | LLM 分段 + 并发 | 30-90s | 99%+ | ~$0.5-2 | 插画 / 像素级还原 |

**A 和 B 共用一个服务端 pipeline**,触发入口不同。C 是独立的 LLM 工作流,以 A 输出作为 baseline,LLM 只 refine 不正确的 chunks。三条路径最终都落到标准 `create_demo → write_demo_file → build_demo` 链路。

## 1. 共享基础设施

新建目录 `backend/src/services/svgToDemo/`,五个纯函数模块,**A/B/C 都依赖**:

### 1.1 `parseSvgTree.ts`
```ts
export interface SvgNode {
  id: string;          // 稳定 ID,sha1(path-index + tag + attrs)[:8]
  tag: string;         // svg / g / rect / path / text / ...
  figmaName?: string;  // 从 id 属性 / <title> 子节点抽
  attrs: Record<string, string>;
  bbox: [x, y, w, h];  // 计算出的边界框(累乘 transform)
  byteSize: number;    // 这个子树的字节数
  tokenEstimate: number; // byteSize / 4
  children: SvgNode[];
}
export function parseSvgTree(svg: string): SvgNode;
```
依赖 `@xmldom/xmldom`。bbox 自己计算(transform 链累乘 + path bbox 估算)。

### 1.2 `splitSvgTree.ts`
```ts
export interface SvgChunk {
  id: string;                    // chunk-001 ...
  rootNode: SvgNode;             // 这块 chunk 的子树根
  parentChain: string[];         // ["svg", "g.Header"] 给模型的语义上下文
  parentDefs: string[];          // 这块依赖的 <defs> 引用
  tokenEstimate: number;
  keepAsSvgIsland: boolean;      // path 含 cubic bezier / mask / filter → true
}
export function splitSvgTree(tree: SvgNode, opts: {
  maxChunkTokens: number;        // 默认 3000
  islandRules?: IslandRule[];
}): SvgChunk[];
```
贪心 DFS:沿 `<g>` 边界切,溢出就单独成块;`<defs>` 永不切;island 节点不递归进去切。

### 1.3 `svgConverter.ts`
```ts
export interface ConvertResult {
  html: string;
  css: string;
  dropped: { nodeId: string; reason: string }[];
  preservedSvgIslands: { nodeId: string; svgFragment: string }[];
}
export function convertSvgToHtml(node: SvgNode, opts: ConvertOpts): ConvertResult;
```
确定性规则映射表(无 LLM):

| SVG 节点 | HTML 输出 | 备注 |
|---|---|---|
| `<rect>` | `<div>` + `position:absolute; top/left/width/height; background; border-radius` | ✓ |
| `<circle>` `<ellipse>` | `<div>` + `border-radius: 50%` | ✓ |
| `<text>` (基础) | `<span>` + 字体 / 颜色 CSS | ✓ |
| `<text>` 含 `<tspan>` 多行 | 多个 `<span>` 或 `<div>` | ✓ |
| `<path>` 仅直线 (M/L/Z) | `<div>` + `clip-path: polygon()` | ✓ |
| `<path>` 含曲线 (C/Q/A) | **保留为 SVG island** | 标记 |
| `<linearGradient>` `<radialGradient>` | CSS `linear-gradient()` `radial-gradient()` | spread/units 部分丢失但可控 |
| `<filter>` 简单 (drop-shadow, blur) | CSS `filter:` | ✓ |
| `<filter>` 复杂 (feMerge / 多 stage) | **保留为 SVG island** | 标记 |
| `<mask>` `<clipPath>` 复杂 | **保留为 SVG island** | 标记 |
| `<image>` | `<img>` | ✓ |
| `<g transform>` | wrapper `<div>` + `transform: matrix(...)` | ✓ |
| `<use href>` | parseSvgTree 阶段就 inline 展开 | - |

输出 HTML 的层级跟 SVG 树严格对应,父子关系保留,这样 island 嵌入位置不会错。

### 1.4 `visualDiff.ts`
```ts
export async function renderSvgToPng(svg: string, viewBox: [x,y,w,h], opts?: { dpr?: number }): Promise<Buffer>;
export async function renderHtmlToPng(html: string, css: string, viewport: [w,h]): Promise<Buffer>;
export async function pixelDiff(a: Buffer, b: Buffer): Promise<{ ratio: number; problemBoxes: BBox[] }>;
```
- SVG → PNG: `@resvg/resvg-js`(纯 native,无浏览器,毫秒级)
- HTML → PNG: `puppeteer-core` + 装在 server 上的 Chrome,headless screenshot
- diff: `pixelmatch` + `pngjs`,加 anti-aliasing tolerance

`problemBoxes` 是 diff 区域的 bbox 列表,workflow 路径 C 的 retry 用这个回灌给模型当 hint。

### 1.5 `createDemoFromSvg.ts` (高层入口)
```ts
export async function createDemoFromSvg(input: {
  workspaceId: string;
  name: string;
  svg: string;
  sourceTasteId?: string;
  authorAgentId: string;
}): Promise<{
  demoId: string;
  filesWritten: string[];
  manifest: { elements: SimplifiedElement[] };
  droppedFeatures: string[];
}>;
```
内部:
1. parseSvgTree
2. splitSvgTree(maxChunkTokens=Infinity, 一整块走规则)
3. svgConverter 出 html / css / islands
4. 调 demoService.create 起 Demo
5. write_demo_file 写 `index.html`、`style.css`、空的 `script.js`
6. 把 droppedFeatures + manifest 一起返

A 和 B 都调这个。C 在内部也调它做 baseline,然后 LLM 只 refine 不正确的 chunks。

## 2. 路径 A: MCP 工具 `create_demo_from_taste`

### 2.1 工具定义
新建 `backend/mcp-server/src/tools/svgToDemoTools.ts`,挂在 `demoSkill` (Tier 2)。

```ts
{
  name: "create_demo_from_taste",
  inputSchema: { tasteId: string, name?: string },
  // 内部调 createDemoFromSvg
  // 返回 { demoId, manifestSummary, droppedFeatures, hint }
}
```

### 2.2 promptFragment 引导(挂在 demo-skill)
> 用户说"把 taste 做成 demo"时:
> - 默认走 `create_demo_from_taste`(快 + 确定性 + 95%+ 还原)
> - 用户明确要求"完全一致 / 像素级 / 100%还原" → 改激活 `svg_to_demo_faithful` workflow
> - 用户对画面有新增交互需求("点这个按钮弹窗") → 先 `create_demo_from_taste` 起底板,再 `write_demo_file` 加 script.js。manifest 里 element id 都是稳定的 `el-XXXX`,直接 `document.getElementById` 就行

## 3. 路径 B: Taste UI "Make interactive"

### 3.1 后端路由
新建 `backend/src/routes/svgToDemoRoutes.ts`:`POST /tastes/:tasteId/make-demo`,鉴权后调 `createDemoFromSvg`。

### 3.2 前端右键菜单
位置:`frontend/src/components/SvgCanvas/TasteContextMenu.tsx`(新建)
- 触发:SvgCanvas 里 taste 节点 onContextMenu
- 项目:`taste.makeDemo`("生成 Demo") / `taste.makeDemo.faithful`("生成 Demo (高保真)")
- 点击 → `api.makeDemoFromTaste(tasteId, {fidelity})` → 拿到 demoId → `navigateToArtifact({type:"demo",id})`
- 转换中 toast,完成后跳转
- droppedFeatures 显示在 toast 副标题

### 3.3 二级菜单触发 C
"生成 Demo (高保真)" 不直接 POST,而是给当前 chat conversation 注入"激活 svg_to_demo_faithful workflow"的系统消息,让 chat agent 跑 workflow,SSE 反馈进度。

## 4. 路径 C: Workflow `svg_to_demo_faithful`

### 4.1 Workflow DSL 加并发原语
位置:`backend/src/services/userSkill/workflowDocValidator.ts` + 对应 runner

新增 step 类型 `parallel`,只用在 loop 里:
```json
{
  "action": "loop",
  "iterate": "$chunks",
  "var": "chunk",
  "concurrency": 8,
  "steps": [...]
}
```

Validator:
- `concurrency` 是 1~16 整数
- 并发 loop 里的 step 之间不能有跨迭代依赖
- 不允许嵌套并发

### 4.2 Workflow runner 并发执行
信号量限流并发,每个迭代有独立子 ctx 避免共享变量竞争。每个 chunk 完成时通过 `LongTaskTracker.progress()` 上报 `{phase:"chunk", current, total}`,前端 ToolCallCard ProgressStrip 自动渲染。

### 4.3 Workflow Doc 主体

(完整 JSON 见 commit;关键 step 顺序:)
1. `parse_svg_tree` → tree
2. `split_svg_tree(maxChunkTokens=3000)` → chunks
3. `create_demo_from_svg_skeleton`(走路径 A)→ baseline demo
4. `loop concurrency=8 iterate=chunks`:
   - `visual_diff_chunk` → baselineDiff
   - if `baselineDiff.ratio < 0.02`: noop(baseline 已经够好)
   - else:
     - `model_call`(让 LLM 重新生成,带 problemBoxes 提示)
     - `write_demo_chunk`
     - `visual_diff_chunk` → afterDiff
     - if `afterDiff.ratio > 0.05`: 再 retry 一次
5. `stitch_demo_html`
6. `full_visual_diff` → finalDiff
7. `report` 给用户

triggers: `["100% 还原", "高保真 demo", "faithful svg", "像素级"]`

### 4.4 沉淀
通过 `save_workflow_run_as_skill` 第一次跑成后保存,挂到公共 system agent / 用 seed script 直接 insert。

## 5. 文件变更清单

### 新建
- `backend/src/services/svgToDemo/parseSvgTree.ts`
- `backend/src/services/svgToDemo/splitSvgTree.ts`
- `backend/src/services/svgToDemo/svgConverter.ts`
- `backend/src/services/svgToDemo/visualDiff.ts`
- `backend/src/services/svgToDemo/createDemoFromSvg.ts`
- `backend/src/services/svgToDemo/index.ts`
- `backend/src/services/svgToDemo/__tests__/*.test.ts`
- `backend/src/services/svgToDemo/__fixtures__/*.svg`(3 个测试用 fixture)
- `backend/src/scripts/svg-to-demo-smoke.ts`(本地 dev 脚本)
- `backend/src/routes/svgToDemoRoutes.ts`
- `backend/mcp-server/src/tools/svgToDemoTools.ts`
- `backend/src/services/userSkill/workflowRunner.ts`(如不存在)
- `backend/scripts/seed-svg-faithful-workflow.ts`
- `frontend/src/components/SvgCanvas/TasteContextMenu.tsx`
- `frontend/src/components/SvgCanvas/TasteContextMenu.css`

### 修改
- `backend/src/index.ts` 注册路由
- `backend/src/services/userSkill/workflowDocValidator.ts` 加 `concurrency` 校验
- `backend/mcp-server/src/skills/demoSkill.ts` tools + promptFragment
- `backend/mcp-server/src/tools/index.ts` 注册新工具
- `frontend/src/components/SvgCanvas/index.tsx` 接 onContextMenu
- `frontend/src/api.ts` `makeDemoFromTaste()`
- `frontend/src/i18n/zh.ts` / `en.ts` `taste.makeDemo*`
- `CLAUDE.md` 架构补充
- `docs/vibe-demo-plan.md` 链接此 plan
- `docs/changelog.md`

### 依赖
```bash
cd backend && npm i @xmldom/xmldom @resvg/resvg-js puppeteer-core pixelmatch pngjs
cd backend && npm i -D @types/pixelmatch @types/pngjs
```

### Prisma
本期**不需要 schema 改动**。后续可加 `Demo.sourceTasteIds[]` 做回链(优化项)。

## 6. 实施顺序

### Phase 0 - 基础设施(可独立验证) ✅ 进行中
1. 五个服务端工具 + 单测,fixture 用 3 个真实 Figma 导出 SVG
2. dev 脚本 `npm run svg-to-demo:test fixture.svg` 跑通 svg → html → png → diff
3. **验收**:简单 fixture diffRatio < 1%,中等 < 5%,插画 < 20%(主要曲线没转)

### Phase 1 - 路径 A + B(共享 backend)
4. createDemoFromSvg 高层入口
5. MCP `create_demo_from_taste`,接 demo-skill
6. `/api/tastes/:id/make-demo` route
7. 右键菜单 UI
8. **验收**:从 Taste UI 右键 → 跳转到 demo artifact,iframe 显示 + 跟原 taste 视觉接近

### Phase 2 - 路径 C(workflow + 并发)
9. Workflow DSL + runner 加并发支持(独立 PR + 单测)
10. 5 个辅助 MCP 工具(`visual_diff_chunk` / `write_demo_chunk` / `stitch_demo_html` / `full_visual_diff` / `noop`)
11. svg_to_demo_faithful workflow doc seed
12. ChatSidebar ToolCallCard 接 chunk 进度
13. **验收**:插画 fixture 跑完 finalDiff < 2%,< 60s,UI 进度条流畅

### Phase 3 - 打磨
14. UI 二级菜单接 workflow C
15. CLAUDE.md / vibe-demo-plan.md / changelog
16. P0 用例确认无回归
17. 部署

## 7. 风险 & 预案

| 风险 | 概率 | 预案 |
|---|---|---|
| puppeteer 在 prod 服务器启动慢 / 内存高 | 中 | Phase 0 用 resvg 单边渲染 + 像素 hash 比对(不需要双边渲染),只在 workflow 路径 C 用 puppeteer。Phase 1 路径 A/B 不需要 diff。 |
| LLM 并发 8 路打到 OneAPI rate limit | 中 | concurrency 默认 4,可配。runner 加 retry-on-429 + exp backoff。 |
| 复杂 SVG 切分时 `<defs>` 引用跨 chunk | 中 | splitSvgTree 算法保证 `<defs>` 跟着主用户 chunk + 复制到所有引用 chunk |
| Workflow runner 还没完整跑过并发 | 高 | Phase 2 单独立 PR 把并发跑通,不跟 svg-to-demo 绑定上线 |
| Stitch HTML 嵌套乱 / CSS 重名 | 中 | 每个 chunk 的 class 加前缀 `c{chunkId}__`,stitch 时只合并前缀冲突的 :root vars |
| UI 右键跟现有 SvgCanvas 事件冲突 | 低 | 现有 SvgCanvas 没有 onContextMenu |
| Taste 里 SVG 含 base64 内嵌图片 | 低 | 不处理,文档提示用本地 URL |

## 8. 产品文案

- **MCP A**(对话内默认):"我帮你把这个 taste 做成 demo 了 → 链接"
- **UI B**(右键菜单):"生成 Demo" 一键起;有偏差时菜单旁加 "(?)" 提示"如需高保真,改用 Agent 对话说 '把这个 taste 高保真 demo 化'"
- **Workflow C**:"这次会跑大概 1 分钟,逐块对照原图 diff 校验。生成中你可以做别的事,完成后我会通知。"
