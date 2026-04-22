# AI Filter 更新日志

## 格式说明
每条记录包含：日期、commit hash、改动类型（feat/fix/style/docs）、改动说明。

---

## 2026-04-22

### fix(taste/meta): 修复 meta 生成全链路两个 bug（路径编码 + missing-SVG 死循环）

**分支**: `BeyondBase` · **commits**: 待提交

本地验证 Taste meta 生成时发现两个阻塞问题，已连带修复：

1. **`readTasteSvg` URL 编码 bug（首次发布必 fix）**
   - 项目路径 `AI Filter Claude` 带空格，`new URL(import.meta.url).pathname` 会把空格保持为 `%20` 编码，直接拼进 `fs.readFile` → 永远拿 ENOENT
   - 结果：**所有 taste 的 meta 生成都静默失败**，`get_taste(syncMeta:true)` 全部返回 `status:"missing"`，`taste-meta-*.log` 完全没产生
   - Fix：改用 Node 官方 `fileURLToPath(import.meta.url)` + 复用 `__dirname` 常量（`tasteMetaService.ts`）

2. **SVG 文件丢失时死循环**
   - `readTasteSvg` 返回 null（文件被手动删除/磁盘缺失）时，旧代码直接返回 `{status:"missing", generatedAt:null}` 但**不写入 DB**，于是每次 `sync=1` 都把它当"从未尝试过"重新发起生成（又立即 null），浪费调用且日志 0 条
   - Fix：SVG 不可读时写一条 `persistMeta(tasteId, null, "")` sentinel（hash 空串，metaGeneratedAt=now），status 变 `"failed"`；Agent 拿到 failed 就不会再问。日志同时追加 `svg not readable (file missing on disk)` 可诊断。后续如果文件重新上传，hash 会天然 mismatch 触发重算

- **本次 root cause 调查（3 张历史图 SVG 消失）**：不是应用 bug，是一次 git stash 事故。Apr 20 19:33 开发者用 `git stash --include-untracked` 保存了 `uploads/`（当时 `.gitignore` 还没排除该目录），期间 App 上传了 3 张新 SVG；19:45 恢复 stash 时 3 张未追踪文件被清掉。同日 21:35 commit `d981026` 已将 `uploads/` 加入 `.gitignore`，该场景不会再复发。详情见本次会话调查报告
- **后续硬化建议（未包含在本次发布）**：把 `uploadsRoot` 从项目根迁到 `~/.imagebase/uploads/`（参照 `AGENT_HOME` 模式），从结构上杜绝 git 操作误伤。单独 issue 跟踪

---

### feat(taste/chatbot): Chatbot × Taste/Design MCP 工具接入，支持 Agent 操作画布

**分支**: `BeyondBase` · **commits**: 待提交

实现 `docs/taste-chatbot-plan.md` 全部 6 个 Phase，让 Chat Agent 能读写画布（Design）和 SVG 图片（Taste），并为每张 SVG 异步生成设计风格结构化 meta（主色/字体/间距/tags/description 等）。

- **Phase 1（数据层）**：Prisma migration `20260422114520_add_taste_meta` 给 Taste 加三列 `meta JSONB / metaGeneratedAt / svgHash`；新增 `backend/src/schemas/tasteSchema.ts` + `designSchema.ts`（Zod 单一数据源，REST + MCP 共用）；将 `computeGridLayout` 从 `frontend/src/components/SvgCanvas` 下沉到 `backend/src/services/autoLayoutService.ts`，前后端逐步向 BE 对齐
- **Phase 2（Meta 服务）**：`backend/src/services/tasteMetaService.ts` — 使用 Agent 当前选择的模型（`resolveModelForCall` → `resolveAdapter(model).stream()`）单次生成风格 meta，fire-and-forget 队列最多 3 并发 + 指数退避，日志落 `backend/logs/taste-meta-YYYY-MM-DD.log`。Prompt 按 `.claude/skills/ai-prompt-patterns.md` 的 6 段式（角色 → 输出约束最高优先级 → Schema → 类型规则 → 识别策略 → 降级规则 → 示例）撰写
- **Phase 3（REST）**：`POST /api/designs/:designId/auto-layout`（网格化摆放并广播 `design:auto-layout`）、`GET /api/designs/:designId/tastes/:tasteId/meta[?sync=1]`、`POST .../meta/regenerate`；3 个 Taste 创建路由（upload/from-svg/from-figma）统一 `enqueueMetaGeneration(taste.id)` 并发出 `taste:create`；update/delete 现在也会发 `taste:update` / `taste:delete` SSE 事件（之前只靠前端本地刷新，Agent 写入不会同步到其他客户端）
- **Phase 4（MCP 工具，11 个）**：
  - `backend/mcp-server/src/tools/designTools.ts` — `list_designs`（Tier 1 导航）+ `create_design` / `rename_design` / `delete_design`⚠️ / `auto_layout_design`（Tier 2 写入）
  - `backend/mcp-server/src/tools/tasteTools.ts` — `list_tastes` / `get_taste`（Tier 1 导航，`get_taste` 支持 `includeMeta` + `includeSvg`）+ `create_taste_from_svg` / `rename_taste` / `update_taste` / `batch_update_tastes` / `delete_taste`⚠️（Tier 2 写入）
  - `backend/mcp-server/src/tools/index.ts` Tier 1 扩充 `list_designs` / `list_tastes` / `get_taste`，保持小而窄
- **Phase 5（Skill）**：`backend/mcp-server/src/skills/tasteSkill.ts` 注册到 `skillsByName`，覆盖 ZH+EN 触发词（新建/删除/改名/移动/排版 × 画布/SVG/taste/design）。Agent 明确要改画布时自动激活
- **Phase 6（前端 SSE）**：新增 `frontend/src/hooks/useDesignSync.ts`，订阅 workspace channel 并按 `designId` 过滤；`SvgCanvas` 接入后，Agent 创建/移动/删除 Taste、meta 生成、自动排版都会实时反映到画布上，无需刷新
- **术语对齐**：当前代码保留 `Design`（容器）+ `Taste`（SVG）命名，`docs/taste-chatbot-plan.md` 术语对齐章节记录产品语境未来将重命名为 `Taste`（容器）+ `Node`（SVG）；迁移在单独 issue 中跟踪
- **验证**：`backend` + `backend/mcp-server` + `frontend` tsc --noEmit 通过（pre-existing aiService/dbStore 错误不相关）

---

### fix(idea/stream): 修复用户滚动识别在两类边界情况下失效

**分支**: `BeyondBase` · **commits**: 待提交

自测上一版的 4 条测试用例，发现两个真实 bug：

1. **用户在 effect 调度与 double-rAF 执行之间滚动 → 自动滚动仍然触发**
   - 上一版的 effect 在顶部同步检查 `streamFollowRef`，然后 schedule double rAF。如果用户在这之间滚动，handler 会把 follow 翻成 false，但 double rAF 的回调并不重新检查，仍然执行 auto-scroll，把用户刚滚的方向直接扳回来
   - Fix：在 double rAF 的回调里**再检查一次** `streamFollowRef`，和 `scrollTop += delta` 赋值前再检查一次（双保险）

2. **用户在同一帧内滚动 → 被我们的 programmatic scroll 事件"吞掉"**
   - 浏览器会把同一帧的多个 scroll 变化合并成一个 scroll 事件。如果用户在我们 `scrollTop += delta` 的同一帧手动滚动，coalesced 事件只有一个，`streamAutoScrollingRef` gate 会把它当成我们自己的 scroll 忽略掉，用户意图丢失
   - Fix：彻底放弃时间窗 flag (`streamAutoScrollingRef`)，改用 **scrollTop 值对比**：每次 auto-scroll 后记录 `lastAutoScrollTopRef = body.scrollTop`（post-clamp），handler 里比对 `Math.abs(body.scrollTop - lastAutoScrollTopRef) < 1` 区分"我们自己"vs"用户"。合并事件的 coalesced scrollTop 不匹配我们的目标，会被正确判为用户行为
   - 副作用：逻辑更简洁，不再需要双 rAF 清 flag

- **四条测试用例全部 trace 通过**：
  - 流式开始，从未滚动 → follow 保持 true，auto-scroll 事件自动被 scrollTop 比对吞掉
  - 用户往上滚 → scrollTop 对不上 → 识别为用户 → distFromBottom > 4 → detach
  - 用户往下滚但没到底 → 同上 → detach
  - 用户滚到最底部 → 识别为用户 → distFromBottom ≤ 4 → re-attach；下一个 delta 再次 auto-scroll

- **验证**：frontend `tsc --noEmit` 通过

---

### refine(idea/stream): 用户滚动优先级高于流式跟随

**分支**: `BeyondBase` · **commits**: 待提交

基于上一版 detach detection 的反馈，明确两条优先级规则：
1. 用户主动滚动优先级最高 —— 任何没有落在"最底部"的手动滚动都立即停掉自动跟随（不再是之前的"离底 < 200px 内都算跟随"）
2. 用户从未滚动 / 滚到最底部 → 继续跟随

- **`IdeaEditor/index.tsx`** `onScroll` handler：`distFromBottom <= 4` 才 re-arm follow，否则 detach。4px 的 epsilon 是为了容忍 Retina / 缩放下的 sub-pixel fractional scrollHeight，远低于一行高度不会误当成用户"故意停在半路"
- 自触发滚动的 `streamAutoScrollingRef` gate 改双 rAF 清除 —— 某些浏览器 `scrollTop` 赋值后的 `scroll` 事件是异步分派的，单 rAF 可能来不及 cover

- **验证**：frontend `tsc --noEmit` 通过

---

### fix(idea/stream): Agent 流式写入时光标/输出位置自动滚动跟随

**分支**: `BeyondBase` · **commits**: 待提交

用户反馈："流式输出有一个小问题，如果当前页面是打开的，则光标需要跟随输出的位置自动滚动定位"。Idea V2 流式写入期间 textarea 是 `readOnly`，现有的 `ensureCaretVisible()` 因为 focus 检查 (`document.activeElement !== ta`) 一直 no-op；新写入的文本直接落在 body 可视区之下，用户看不到 Agent 正在写什么。

- **`frontend/src/components/IdeaEditor/index.tsx`** 新增一对 effect：
  - 第一个 effect 在 `content + streaming + mode` 变化时触发：定位流式尾位 (`streamStartOffset + buffer.length`)，双 rAF 等 auto-grow + MarkdownPreview 重绘完成后测量 pixel rect。Source 模式走 mirror-div (`measureTextareaCaretRect`)；Preview 模式遍历 `[data-md-start]` 块找 tail 所在块。如果 tail 已滑出底部 margin（80px），nudge `bodyRef.scrollTop` 往下补
  - 第二个 effect 订阅 body 的 `scroll` 事件做 **detach detection**：用户手动往上滚离尾巴 > 200px 就把 `streamFollowRef` 翻成 false 停止自动跟随；滚回尾巴附近又翻回 true。自己触发的 auto-scroll 通过 `streamAutoScrollingRef` 标记屏蔽掉，避免"自己滚自己触发 detach"的误判
- 只往下滚不往上滚 —— 尊重用户滚上去读早期内容的意图
- `onStreamBegin` 每次重新 arm `streamFollowRef = true`，新的写入 session 都给一次 clean slate

- **验证**
  - frontend `tsc --noEmit`：通过
  - 预期行为：Agent 写长文档时，Source / Preview 两种视图下 body 都会跟着写入位置往下滚；用户手动滚上去读之前的内容，Agent 继续写但不再 yank 用户；用户手动滚回底部，自动跟随恢复

---

### fix(chat): confirm 暂停后工具卡片一直 "running" + 历史丢失

**分支**: `BeyondBase` · **commits**: 待提交

用户反馈：Chatbot 进入二次确认（删除类工具）的暂停状态时，当前工具卡片一直显示 running 的 spinner 不消失，下一轮同名工具看起来像在排队等待。审了代码+本地日志+线上日志，确认后端 SSE 流在 yield `confirm` 后就 `return` + `res.end()` 干净关闭（没有悬挂的连接），也没有跨 turn 的工具调用锁/队列 —— 单轮内的工具是顺序执行（OpenAI tool-use 协议本来就要求成对喂 `function_call` + `function_call_output`），但跨轮完全独立。"排队"是视觉错觉，真正的 bug 在两处：

- **前端：localStorage 缓存只清 `streaming` flag，不清 toolCall 里的 `status: "running"`**
  - `frontend/src/components/ChatSidebar/index.tsx` `readCache()`：增加一轮 `toolCalls.map` 把所有遗留的 `running` 翻成 `error`。刷新 / 切 tab / SSE 中断留下的半截 toolCall 会诚实地显示为失败，不再永久旋转
  - `handleStop()` 同步修：用户点 Stop 时除了清 `streaming` flag，还会把正在 running 的 toolCall 一并翻成 `error`

- **后端：`runAgent` hitConfirmation 分支直接 `return`，跳过 `appendMessage`**
  - `backend/src/services/chatAgentService.ts` 线路 971 之前的 return 会绕开 991-997 的 `convStore.appendMessage`，导致 confirm 暂停前已成功执行的工具调用 + `awaiting_confirmation` 占位条目 **都没入库**。加一次显式持久化，try/catch 包起来单独记 `append_message_failed` 事件以便排查
  - `resumeAfterConfirm` 之前从头到尾不写 DB，用户 Cancel / Confirm 后的工具结果在下次刷新后都会消失。两条路径都补上 `appendMessage`：Cancel 写一条带 "好的，已取消" 文案 + status=error 的 toolCall，Confirm 写一条带 success/error 的 toolCall

- **验证**
  - backend + frontend `tsc --noEmit`：touched files 全通过
  - 语义：Confirm 暂停状态下刷新页面 → 历史保留 `awaiting_confirmation` 卡片；用户 Cancel → 追加 "已取消" 文案 + error 卡片；用户 Confirm → 追加 success 卡片
  - 极端：SSE 中途断开 → 刷新后 running 卡片变为 error（而不是永远转圈）

---

### feat(design): Taste 支持粘贴 SVG 源码直接生成预览

**分支**: `BeyondBase` · **commits**: 待提交

补齐 Design 画布添加 SVG 的第三条通道（此前只有"上传文件"和"从 Figma 导入"）：用户可以在任何地方复制一段 SVG 源代码，直接 ⌘V/Ctrl+V 粘到画布上，自动生成一个 Taste 预览。

- **后端：新 endpoint + body 限制放宽**
  - `backend/src/routes/tasteRoutes.ts` 新增 `POST /api/designs/:designId/tastes/from-svg`，接受 `{svg, name?}` JSON 体。复用现有的 `parseSvgDimensions`（viewBox / width+height → 尺寸）、`findEmptyPosition`（画布上找不重叠的落点）、`uniqueTasteName`（重名自动加后缀）
  - `<svg` 预检不通过返 400，>5 MB 返 413；通过则写到 `uploads/svgs/{designId}/paste-{ts}-{rnd}.svg`，`source` 字段新增枚举值 `"paste"`（Prisma schema 的 `source` 本就是 `String`，无需迁移）
  - `backend/src/index.ts` 把 `express.json()` 的 body 限制从默认 100 KB 提到 10 MB。Figma 导出的 SVG 经常超过 100 KB（嵌入位图 blob + 大段 path），此前会被 body-parser 直接 413 吞掉、永远到不了我们的 handler

- **前端：API client + 画布集成**
  - `frontend/src/api.ts` 新增 `createTasteFromSvg(designId, svg, name?)`，与 `importFigmaSvg` 错误处理风格一致（解析服务端 `error` 字段，fallback 到通用文案）
  - `frontend/src/components/SvgCanvas/index.tsx`：
    - `handleSvgPaste(rawSvg)` 统一处理 — 低成本 `<svg[\s>]` 识别 → POST → 乐观 `setTastes` + `setSvgContents`（用已有的 `sanitizeSvg` 清掉 script / on* / javascript: href 后 inline 渲染）。失败时 toast 展示服务端返回的真实 error message
    - 文档级 `paste` 事件监听，当焦点在 INPUT / TEXTAREA / contenteditable 时跳过（让 Figma URL 输入框、重命名输入框、Chat Sidebar、IdeaEditor 保留原生粘贴），画布 `hidden` 时也跳过
    - Topbar 新增 "Paste SVG" 按钮（剪贴板图标），走 `navigator.clipboard.readText()`；若浏览器阻止（Safari / 不安全上下文 / 权限拒绝），toast 提示用 ⌘V/Ctrl+V 直接粘贴
  - i18n 新增 7 个 `design.pasteSvg*` 键（中英对齐）

- **验证**
  - backend `tsc --noEmit`：touched files 全通过（dbStore.ts 原有 Prisma JSON 类型错误无关）
  - frontend `tsc --noEmit` + `vite build`：通过（CSS 95.94 KB / JS 1,015.64 KB）
  - P0 手动：从 Figma 复制 frame 对应 SVG → 切到 Design → ⌘V → Taste 立即出现在画布左上空位，尺寸自动从 viewBox 提取；复制非 SVG 文本 → 无反应（不触发请求）；在 Figma URL 输入框里 ⌘V → 正常填入 URL 不触发 SVG 粘贴

---

### feat(agent): Idea 流式写入协议 (begin/end bracket + live editor splice)

**分支**: `BeyondBase` · **commits**: 待提交

长文档写入从"生成整段 → 一次 append"优化为"开流 → 边写边渲染 → 显式关流"。解决两个问题：(1) 大段内容一次性 tool call 往返太慢；(2) 用户看不到写作过程，像黑盒。

- **后端：内存会话 + Anchor 偏移计算**
  - `backend/src/services/ideaStreamSessionService.ts`（新）：`IdeaStreamSession` 维护 `sessionId / ideaId / baseVersion / baseContent / anchor / startOffset / buffer / conversationId / clientId / timer`。三个 Map：`sessions` 按 sessionId 查，`ideaToSession` 确保"一个 idea 一次只能有一个活会话"（二次 begin 会 evict 前者），`conversationToSessions` 用于整轮 sweep
  - `computeStartOffset(content, anchor)` 把 anchor 翻译成 baseContent 里的绝对字符偏移：`position:end → content.length`，`position:start → 0`，`section:X, mode:append → bodyEnd`，`mode:after/replace → bodyStart`。fenced code 感知（`` ``` `` / `~~~`），标题正则和 `extractIdeaSections` 共用
  - 2 分钟空闲超时 `unref()`-ed auto-abort，防止 Agent crash 后编辑器锁死
  - `begin` / `pushDelta` / `finalize({commit})` / `abort(reason)` / `abortByConversation(convId, reason)` / `isIdeaLocked(ideaId)` / `attachConversation(sessionId, convId)`（MCP 走 HTTP 所以会话开到之后再绑定 conversation）

- **后端：REST + eventBus + concurrency lock**
  - `ideaRoutes.ts` 新增 `POST /:ideaId/stream/begin` + `POST /stream/:sessionId/end`（MCP 子进程通过 HTTP 打进来）；`PUT /:ideaId/content` 在开工前先 `ideaStream.isIdeaLocked(ideaId)`，有活会话就回 `423 Locked {sessionId}`，防止人类 autosave 覆盖 Agent 的流式写入
  - `eventBus.IdeaChangeEvent.type` 联合类型扩到 5 个：`idea:content-change | idea:rename | idea:stream-begin | idea:stream-delta | idea:stream-finalize`。per-idea SSE route 无需改动，新事件自动走相同通道
  - `finalize({commit:true})` 在一个 `prisma.$transaction` 里跑 update content + deleteMany mentions + createMany mentions + `version: {increment: 1}`，再广播 `idea:stream-finalize` 带权威 finalContent + newVersion；同时补发一次 `idea:content-change` 让其它 tab 也刷
  - `finalize({commit:false})` / `abort()` 不动 DB，广播 `discarded:true` + `baseContent` 让 FE 回滚

- **MCP 工具**
  - `backend/mcp-server/src/tools/ideaTools.ts` 新增 `ideaStreamTools`：`begin_idea_stream_write(ideaId, baseVersion, anchor)` → 返回 `{sessionId, startOffset, _stream:{mode:"begin", sessionId, ideaId}}`；`end_idea_stream_write(sessionId, finalize)` → 返回 `{ok, newVersion?, discarded, _stream:{mode:"end", sessionId}}`。`_stream` marker 让 chatAgentService 不用硬编码工具名就能识别开关流
  - 打包进 `ideaSkill.tools`（和原有 ideaWriteTools 并列）

- **chatAgentService：text_delta 拦截 + 失败兜底**
  - 每个 turn 初始化 `activeStreamSessionId: string | null`
  - 看到 tool_result 里带 `_stream: {mode: "begin"}`：`activeStreamSessionId = sessionId` + 调 `ideaStream.attachConversation(sessionId, conversationId)` 把会话挂到本对话
  - `text_delta` 事件：如果 `activeStreamSessionId` 非空，`ideaStream.pushDelta(id, ev.text)`，**不**追加到 `accumulatedText`、**不** yield `message` 事件 —— 内容只出现在编辑器里，聊天气泡只看得到 tool-call 卡片
  - 看到 tool_result 带 `_stream: {mode: "end"}`：清 `activeStreamSessionId`
  - 三个兜底清理位点：① 进入确认暂停（`hitConfirmation` return 前）→ `abort(id, "confirmation-pause")`；② tool 执行循环里 abortSignal fire → `abort(id, ...)`；③ 正常 turn-end（ round loop 跑完后）→ 若 `activeStreamSessionId` 还在说明 Agent 忘了调 end，`abort(id, "turn-ended-without-end-call")`

- **前端：`useIdeaSync` + `IdeaEditor` 流式渲染**
  - `useIdeaSync` 的 `IdeaSyncHandlers` 加三个回调：`onStreamBegin / onStreamDelta / onStreamFinalize`，SSE dispatcher 新 case 转发
  - `IdeaEditor/index.tsx` 加流式状态：`streaming: boolean` + 三个 refs（`streamBaseRef` 快照开流时的内容 / `streamStartOffsetRef` 锚点偏移 / `streamBufferRef` 累积 delta）+ `streamSessionIdRef`
    - `onStreamBegin`：取消挂起的 autosave timer、清 `dirtyRef`、存快照 + offset、清 buffer、`setStreaming(true)`
    - `onStreamDelta`：追加到 buffer，`setContent(base.slice(0, off) + buffer + base.slice(off))`。只会 `setContent` 一次 per delta，靠 ref 累积避免 React 批量渲染拖慢高频 chunk
    - `onStreamFinalize`：用服务器权威 `finalContent` 覆盖本地（applyIdeaWrite 可能加了换行，会和朴素 splice 差几字符）、`versionRef = newVersion`、清所有流式状态、`setStreaming(false)`
  - `scheduleSave` 头一行 early-return 如果 `streamSessionIdRef.current` 非空 —— 流式期间 autosave 彻底停
  - `textarea` 加 `readOnly={streaming}` + `.idea-editor-textarea-streaming` class（淡蓝渐变背景 + `cursor: progress`）让用户一眼看出在"被写入"
  - 状态栏新增 `idea.streaming` 文案（"Agent 正在写入…" / "Agent writing…"），在 streaming 时抢占 save-status

- **架构决策**
  - 会话放内存而非 Prisma：会话生命周期 < 2 分钟，后端重启 FE 会 SSE 断线 → 重连 → 从 DB 重拿内容，流式结果直接丢失是正确的降级
  - 本地 splice 不保证与 applyIdeaWrite 结果字节一致（后者会补前后换行），finalize 时用服务器内容整体覆盖，对齐差异
  - 一 idea 同时只能一个会话（二次 begin kicks first），不支持交错写入，简化心智模型
  - 危险工具确认暂停时强制 abort 流式会话：用户等待确认期间不该锁编辑器

---

### feat(agent): Idea MCP 工具 + @mention 反向索引 + 删除二次确认

**分支**: `BeyondBase` · **commits**: 待提交

把 Chat Agent 的能力从"只能改表"扩展到"也能改灵感文档 + 跨 artifact @引用"，并给 delete 类操作加上"将变成死链"的 2-step 确认。

- **后端：Mention 反向索引表**
  - 新增 Prisma `Mention` model（`backend/prisma/schema.prisma`）：composite PK `sourceType+sourceId+targetType+targetId+targetKey`，外加 `(workspaceId, targetType, targetId)` 和 `(sourceType, sourceId)` 两个索引用于反查 + 写侧删除。不用 FK CASCADE（Idea→Mention→Idea 形成循环），改为路由层在事务里显式清理
  - 新 migration `20260422074409_add_mention_table` 已 apply；`npx prisma generate` 重新生成 client

- **后端：Mention 解析 & 事务性 diff**
  - `backend/src/services/mentionIndex.ts`（新）：正则扫 Markdown `[label](href)`，跳过 fenced code；href 必须是 `mention://` 才入表。`normalizeHref` 把 `mention://idea-section/slug?idea=X` 展平成复合 key `X#slug`；`buildContextExcerpt` 取 mention 左右各 80 字符上下文，把链接语法归一到 `@label`
  - `buildMentionRows(content, sourceType, sourceId, workspaceId)` 去重 + 附第一次出现的 excerpt，直接给 Prisma `createMany` 用
  - `ideaRoutes.ts` `PUT /:ideaId/content` 和新加的 `POST /:ideaId/write` 都走同一个 `prisma.$transaction`：update 内容 → deleteMany old rows → createMany new rows → 重抽 sections；`DELETE /:ideaId` 事务里清掉 source=此 idea ∪ target=此 idea ∪ `target startsWith "${id}#"`（idea-section 复合键），防幻影引用

- **后端：Anchor-based idea 写入**
  - `backend/src/services/ideaWriteService.ts`（新）：`applyIdeaWrite(currentContent, anchor, payload) → {content, description, range}`
  - `anchor` 是 `oneOf: {position: "end"|"start"} | {section: slug, mode: "append"|"prepend"|"replace"}`
  - HTML 感知：先 `computeHeadingRanges` 对齐 `extractIdeaSections`，然后 `skipPastOpenBlocks` 跳过未闭合的 fenced code 和 block-level HTML 容器（div / section / article / aside / header / footer / figure / blockquote / pre / table 系列 / ul / ol / details / summary），再 `ensureSurroundingNewlines` 防 Markdown 粘连
  - anchor 找不到 section 时扔结构化错误 `Available sections: …`，模型能根据回显重试

- **后端：新增 Reverse lookup API**
  - `backend/src/routes/mentionReverseRoutes.ts`（新）：`GET /api/mentions/reverse?workspaceId&targetType&targetId&limit` → `{refs: IncomingMentionRef[], total}`，`sourceLabel` 用 `prisma.idea.findMany({id: {in: ideaIds}})` 一次解析
  - `mentionRoutes.ts` 的 `/api/mentions/search` 给每个 hit 附 `mentionUri` + `markdown` 字段（view / taste / idea / idea-section），模型可直接拼 chip 链接

- **MCP：Idea 工具 + 跨 skill mention 工具**
  - `backend/mcp-server/src/tools/ideaTools.ts`（新）：拆成 `ideaNavTools`（Tier 1：`list_ideas` / `get_idea`）和 `ideaWriteTools`（Tier 2：`create_idea` / `rename_idea` / `delete_idea ⚠️` / `append_to_idea` / `insert_into_idea` / `replace_idea_content ⚠️`）。`ANCHOR_SCHEMA` 用 JSON-Schema `oneOf` 约束 position 或 section+mode
  - `backend/mcp-server/src/tools/mentionTools.ts`（新）：`find_mentionable`（workspace+q+types+limit）+ `list_incoming_mentions`（workspace+targetType+targetId+limit）。两个都是 Tier 1，写 idea 时不用激活 skill 就能拿到可引用的实体列表
  - `backend/mcp-server/src/skills/ideaSkill.ts`（新）：只打包 `ideaWriteTools`，trigger 覆盖"写/新增/新建/创建/追加/插入/补充 × 灵感/文档/idea/章节" + 英文等价。design/taste write skill 占位留到 v3+
  - `backend/mcp-server/src/tools/index.ts` 的 `TIER1_NAMES` 扩到 6 个：`list_tables / get_table / list_ideas / get_idea / find_mentionable / list_incoming_mentions`
  - `backend/mcp-server/src/dataStoreClient.ts`：`HttpOptions.method` 加上 `"PATCH"`（Idea rename 要用）

- **后端：chatAgentService 集成**
  - `buildWorkspaceSnapshot` 新增 "## 灵感文档 (Ideas)" 分区，每条列 id / name / updatedAt，用共享 pg pool 只拉元信息不拉 content
  - Tool guidance 新增两段："灵感文档（Ideas）写入与 @ 引用" 和 "@ 引用的反向关系与删除安全"
  - `fetchIncomingRefsForConfirm(toolName, args, workspaceId)`：当 danger tool 有目标映射（今天只有 `delete_idea → idea:{ideaId}`）时，发 confirm 事件前 localhost 调 `/api/mentions/reverse` 预取 refs，直接 inline 到 SSE `confirm` event 的 `incomingRefs` 字段，前端零额外 round trip

- **前端：两处 "Dead links" 提示 UI**
  - `frontend/src/api.ts` 新增 `IncomingMentionRef` 类型 + `fetchIncomingMentions()` + `PendingConfirm.incomingRefs?`
  - `frontend/src/components/ChatSidebar/ChatMessage/ConfirmCard.tsx`：confirm card body 下挂一个可滚的 refs 列表（最多 6 行 + "…还有 N 条" 脚注），用的是 backend 预取的 `incomingRefs`
  - `frontend/src/components/ConfirmDialog/index.tsx`：组件签名加 `references?: ConfirmReference[]` + `referencesTotal?: number`，与 ConfirmCard 同一套截断规则
  - `frontend/src/App.tsx`：`handleDeleteItem` 的 `type === "idea"` 分支改成开一个带 refs 的 ConfirmDialog，打开时先 `fetchIncomingMentions(WORKSPACE_ID, "idea", id)` 拉 refs，再展示。用户点确认才真正 `apiDeleteIdea`
  - i18n 新增 `confirm.refsTitle / confirm.refsMore / confirm.deleteIdeaTitle / confirm.deleteIdeaMsg / chat.confirm.refsTitle / chat.confirm.refsMore`（中英）

- **验证**
  - backend `tsc --noEmit`：只剩 dbStore.ts / aiService.ts 原有的 Prisma JSON 类型错误（与本次无关），touched files 全通过
  - frontend `tsc --noEmit` + `vite build`：通过（CSS 95.83 KB / JS 1.01 MB）
  - P0 手动：`创建一个"灵感"文档叫"路线图"` / `在路线图里追加一段关于 Q2 的内容` / `帮我查一下有哪些文档引用了"路线图"` / `删除路线图`（弹 ConfirmDialog 显示引用列表，点确认才删）

### feat(chat): Agent 名称 + 模型下拉精简 + idea 光标跟随 + topbar 对齐

**分支**: `BeyondBase`（合入 `beyond`）· **commits**: 待提交

一次集中修整 chat sidebar 和 idea 编辑器的视觉/体验细节：

- **Chat Sidebar Agent 名称**（新）
  - Header 左上角新增 Agent 名称标题（14px / 500，复用 `.idea-editor-topbar-name` / `.svg-canvas-topbar-name` 样式语言，不是按钮胶囊）
  - 双击进入 `InlineEdit` 原地改名；blur / Enter 提交到 `PUT /api/agents/:id`，失败回退到服务端状态
  - 新增 Tier 0 meta-tool `update_agent_name`（`backend/mcp-server/src/tools/metaTools.ts`）：用户在对话里说 "把你改名叫 X / 以后你就叫 X" 时，模型通过此工具写同一条 DB 记录。对话结束时 `ChatSidebar` bump `agentRefreshToken`，标题自动 re-fetch，不用刷新
  - 默认名：`${USER_NAME}'s Agent`（默认 "Quan"）。`ensureDefaultAgent()` 对历史 "Claw" 做一次性迁移
- **Chat Sidebar topbar 对齐 artifact**：高度改为 44px（与 `.idea-editor-topbar` / `.svg-canvas-topbar` 一致），所有元素垂直居中，去掉 18px 上下 padding
- **模型下拉精简**：去掉厂商分组标题（原来 Anthropic / OpenAI / Volcano 三级 section）——每个模型名称本身已经带厂商（"Claude 4.7 Opus" / "GPT-5.4" / "Doubao 2.0 pro"），section header 是冗余的；保留原有 Anthropic → OpenAI → Volcano 的排序优先级
- **移除 `claude-sonnet-4.6`**：上游 whitelist 状态不稳定，直接从 `modelRegistry.MODELS` 删除；老存档里选了 Sonnet 4.6 的 Agent 会走同组 fallback 自动解析到 Opus 4.7 / 4.6，不覆盖用户偏好
- **Idea 编辑器光标跟随滚动**：textarea 自增长、外层 `.idea-editor-body` 是滚动容器，浏览器原生「keep caret in view」失效。新增 `measureTextareaCaretRect`（ZWSP marker + mirror div，兼容 end-of-text 位置）+ `ensureCaretVisible()`，在 auto-grow effect、`onKeyUp`、`onMouseUp` 三处触发，48px margin 外自动滚 body。只在 textarea focus 时生效，SSE 远端更新不抢读者滚动位置

### feat(agent): Chat Agent 多模型切换（6 模型白名单 + 可用性探测 + 智能回退）

**分支**: `model-switcher`（从 `Artifact_idea` 切出）· **commits**: 待提交

把 Chat Sidebar 的单一 `seed2.0-pro` 升级为 6 模型白名单的实时切换。默认切到 `claude-opus-4.7`，用户可从对话头的胶囊按钮在 Anthropic Claude / OpenAI GPT / Volcano Doubao 三组之间挑选，失败/限流时自动回退到同家族兄弟或终极兜底 `doubao-2.0`，但不覆盖用户偏好 —— 下一轮模型恢复后自动切回。

- **后端**
  - 白名单（`backend/src/services/modelRegistry.ts`）：`doubao-2.0`（ARK，Volcano）+ `claude-opus-4.7` / `claude-opus-4.6` / `claude-sonnet-4.6` + `gpt-5.4` / `gpt-5.4-mini`（后五个经 OneAPI 代理）。每个模型声明 `provider / group / displayName / capabilities{thinking, toolUse}`
  - `resolveModelForCall(agentId)` → `{requested, resolved, usedFallback}`：读 agent config，404/不可用时按同组 → `FALLBACK_MODEL_ID` 级联回退。配置不动，下次可用自动恢复
  - 异步探测（`startModelProbe()`）：10 分钟周期调用 OneAPI `/v1/models` 刷新可用集、校验 `ARK_API_KEY`。`index.ts` 在 `RUNTIME_DISABLED!=="1"` 时启动，`SIGINT/SIGTERM` 优雅停止
  - Provider 适配器（`backend/src/services/providers/`）：
    - `types.ts`：`ProviderAdapter` 接口 + 归一化 `ProviderStreamEvent`（`text_delta | thinking_delta | tool_call_done | done | error`）
    - `arkAdapter.ts`：ARK `/api/v3/responses` 流式抽离自 `chatAgentService`，保留 Doubao 深度思考配置
    - `oneapiAdapter.ts`（新）：根据 `model.group` 双线路 —— anthropic 走 OneAPI 的 `/v1/messages`（Anthropic 原生协议，启用 `thinking.budget_tokens`，temperature 强制 1.0），openai 走 `/v1/chat/completions`（GPT-5 的 `reasoning_content` 流式映射为 thinking_delta）。处理 Anthropic 的 system split、user/assistant 交替约束、tool_use / tool_result 块对应；OpenAI 的 `tool_calls[]` by index 累积到 `finish_reason`
    - `index.ts`：side-effect `registerProviderAdapter` 注册两个适配器
  - `chatAgentService.ts`：循环去除 ARK 硬依赖，改为每轮 `resolveModelForCall` + `resolveAdapter(model).stream(...)`；SSE 事件不变
  - `agentService.ts`：`DEFAULT_CONFIG.model` 翻到 `claude-opus-4.7`；新增 `getSelectedModel / setSelectedModel`；`LEGACY_MODEL_ALIASES` 把老存档里的 `seed2.0-pro` 静默迁移到 `doubao-2.0`
  - `agentRoutes.ts`：`GET /api/agents/models` 返回 `{models, defaultModelId}`（`available` 三态 coerce 成 boolean —— 未探测时默认 `false`）；`GET|PUT /api/agents/:agentId/model` 读写选择，校验白名单并返回 `{selected, resolved, usedFallback}`。`/models` 路由声明在 `/:agentId` 之前防止 Express 把 "models" 当成 agentId
  - `.env.example` / `.env`：新增 `ONEAPI_BASE_URL` / `ONEAPI_API_KEY`

- **前端**
  - `api.ts`：新增 `ModelCapabilities / ModelSummary / AgentModelSelection` 类型 + `listModels() / getAgentModel(agentId) / setAgentModel(agentId, modelId)`
  - `components/ChatSidebar/ChatModelPicker.tsx`（新）：胶囊按钮显示当前模型 displayName + 胶囊 V 字。点击打开 DropdownMenu，按 provider 家族 section 分组（Anthropic → OpenAI → Volcano），当前项 `✓`、不可用项 `offline` 灰态、待同步项 `…`。open 时每 60s 静默重拉列表 + 选择；`streaming` 时整体 disabled 防止半途换模型导致工具循环乱掉。若当前落在回退模型，按钮文案显示 `selected → resolved`
  - `components/ChatSidebar/index.tsx`：header 挂 `<ChatModelPicker agentId open disabled={streaming}/>`
  - `components/ChatSidebar/ChatSidebar.css`：header `justify-content` 改 `space-between`；新增 `.chat-model-picker-btn / -label / -chevron / -suffix / -unavailable`（12px / 24px 高 / max-width 180px 省略号）

- **Edge cases**
  - OneAPI 对 Claude `thinking_delta` 做了文本剥离（只转发 `signature_delta`）—— 适配器在 thinking 块 `content_block_start` 时主动 emit 一个空 `thinking_delta`，保证 UI 的"深度思考中…"指示器照常亮起，即使 thinking 正文还留在服务端
  - 用户 config 里存了个已下架模型 → resolveModelForCall 自动降级但 config 不动，next turn 模型恢复后自动切回
  - ARK / OneAPI 任一 API key 缺失 → 影响对应家族但 `doubao-2.0` 作为兜底仍可用
  - 流式过程中 availability 翻转 → picker 下次轮询刷新，当前请求不打断
  - 老对话 config 中残留 `seed2.0-pro` → `LEGACY_MODEL_ALIASES` 静默迁移到 `doubao-2.0`

- **验证**
  - backend `tsc --noEmit` 通过；frontend `tsc --noEmit` + `vite build` 通过（CSS 94KB / JS 1MB）
  - 双链路端到端烟测：Claude Opus 4.7 回答一道数学题正常流式 + 思考指示器起来；GPT-5.4 带工具调用 `list_tables` 流式推进并触发 `reasoning_content`
  - 探测正确性：5 分钟内 6 模型 `available` 收敛，`claude-sonnet-4.6`（管理员禁用）保持 `false`；`setAgentModel` 写入假模型名 → 400 拒绝
  - 回退路径：手动把 config 写成已离线模型 → `resolveModelForCall` 正确返回 `usedFallback:true, resolved.id: "doubao-2.0"`，下一轮写回 `available:true` 后自动恢复

### fix(agent): OpenClaw 在 Claude 模型上不认自己的 soul / 思考指示器乱亮 / 用户消息重发

Day 5 逐模型做一致性验证时发现三个问题，一并修掉：

1. **OneAPI Claude Code 系统覆盖（最严重）** —— `oneapi.iline.work` 代理把 Claude 路由到 Claude Code SDK，SDK 会在请求前注入自己的 ~2000 token 的 "You are Claude Code, Anthropic's official CLI…" system，**完全覆盖我们送进 `system` 字段的 Layer 1/2/3 内容**。现象：切到 Claude 4.7/4.6 问"你是谁" / "你的 soul 是什么"，一律回答"我是 Claude Code"，完全不认 soul.md，还会误触发 `update_soul` 把 soul 改成 "placeholder" 之类自救文案。直接 curl 复现：`system="你叫 Claw"` → Claude 仍然自称 Claude Code，`input_tokens=2060`（明显被前缀塞了东西）。修复：`oneapiAdapter.streamAnthropic` 不再设 `body.system`，改把整段 system 内容包成 `user: "<持久系统指令>…</持久系统指令>"` + `assistant: "明白，我会严格遵循以上系统指令。"` 的 bootstrap 对，再接真实 messages。OneAPI 不改 message 内容，身份安全落地。GPT-5 分支无需此改动（OpenAI channel 正常认 system）
2. **用户消息重发** —— `assembleInput` 调用前先 persist 了 user message，导致 sliding window 再读一次 + 函数末尾又 push 一次，Claude 收到两段一模一样的 user text，既浪费 token 也可能被误解为重复提问。修复：把 persist 挪到 `assembleInput` 之后
3. **"Analyzing your request" 指示器语义错位** —— 之前的 `thinkingActive = streaming && !hasAnswer` 会在整个思考期都保持"正在分析你的请求"文案，导致非 thinking 模型也一直显示这个字样，用户误以为模型在做无意义的等待。修复：重新定义为 `waitingForFirstResponse = streaming && !hasThinking && !hasAnswer && !hasAnyToolCall`，作为纯粹的"送出 → 第一个 token 到达"的等候桥；`thinkingCollapsed` pill 只在真有 thinking 文本时出现

- **根因诊断脚本**（留作 dev helper，不打进生产构建）
  - `backend/src/scripts/day5-model-smoke.ts`：逐模型创建新对话跑一句"请用一句话…"，统计 thinking / message / tool 事件数 + 首字延迟
  - `backend/src/scripts/day5-openclaw-smoke.ts`：逐模型追问 soul，grep 真实 soul.md 的关键词是否出现在回复里
  - `backend/src/scripts/day5-adapter-trace.ts`：绕过 HTTP 直接跑 `adapter.stream()`，看原始事件序列
- **验证**
  - 修复后再跑 OpenClaw smoke：6 个可用模型全部回复里都能找到 soul 关键词（doubao / 4.7 / 4.6 / GPT-5 / GPT-5-mini）
  - 用户 intro 测试：Claude 4.7 先前答"我是 Claude Code"，修复后答"我是 Claw，你的长期 Agent…"
  - frontend 思考指示器手动验证：doubao（无 thinking）首字到达立刻消失；Claude thinking 中无 "Analyzing" 字样、只有 collapsed 思考条

---

## 2026-04-21

### feat(artifact): Idea（灵感）Markdown doc 作为第三类工作区实体

**分支**: `Artifact_idea`（从 `BeyondBase` 切出）· **commits**: 待提交

把 Workspace 从"只有表和 Taste 画布"扩展到三类实体 —— 加入可自由书写的 Markdown 文档，并通过 `@mention` 让文档与表 / 字段 / 记录 / Taste 互相链接。

- **后端**
  - `backend/prisma/schema.prisma` 新增 `Idea` model（`workspaceId / name / parentId / order / content / version`），`Workspace.ideas` 反向关系，迁移文件 `20260421030344_add_ideas`
  - `backend/src/routes/ideaRoutes.ts`：`POST/GET/PATCH/DELETE /api/ideas` + `PUT /api/ideas/:ideaId` 保存内容。走 version 乐观并发 —— 请求带 `baseVersion`，若已过期返回 `409 {conflict:true, latest:{content, version}}`，前端接受远端版本并给 toast 提示。所有 async handler 用 `asyncHandler` 包装，避免 Prisma FK / 未知错误直接冒泡成 unhandled rejection 把 node 进程打挂（烟测 FK 违规真的挂过一次，补了守卫）
  - `backend/src/routes/mentionRoutes.ts`：`GET /api/mentions/search?workspaceId=&q=&limit=` 工作区内模糊搜索表 / 字段 / 记录 / Taste，按类型分组排序
  - `backend/src/services/eventBus.ts` 扩展 `WorkspaceChangeEvent` 联合类型加 `idea:create/rename/delete/reorder`；新增 `emitIdeaChange(ideaId, event)` 为每个 Idea 维护独立频道（`content` / `rename`）
  - `backend/src/routes/sseRoutes.ts` 新增 `/api/sync/ideas/:ideaId/events` 频道，编辑器挂载后实时拿到他人编辑
  - `backend/src/routes/folderRoutes.ts` 删除文件夹时级联处理 idea（与 table / design 同策略）
  - 名称去重：创建时若同 `workspaceId` 下已有同名 idea，自动加 ` N` 后缀（与 table 一致）

- **前端**
  - 依赖新增：`react-markdown ^10.1`、`remark-gfm ^4.0`、`rehype-raw ^7.0`、`rehype-sanitize ^6.0`
  - `frontend/src/components/IdeaEditor/` 新建五文件：
    - `index.tsx` 主编辑器：`Cmd/Ctrl + /` 切源码 / 渲染；debounce 600ms 自动保存；`versionRef` 乐观并发；服务端返回 `conflict:true` 时接受远端版本并 toast 提示；卸载时 flush 挂起的保存；挂载 `useIdeaSync` 跟随他人编辑
    - `MarkdownPreview.tsx` 渲染管线：`remark-gfm` + `rehype-raw` + `rehype-sanitize`，schema 放行内联 SVG 全套标签与属性，`protocols.href` 加入 `mention`；`components.a` 识别 `mention://` href 将 `<a>` 换成 `<button class="idea-mention-chip idea-mention-chip-{type}">`
    - `MentionPicker.tsx` @ 弹层：150ms 防抖查询、按类型分组、`position:fixed` 贴 caret、document 级 keydown 捕获 ↑↓ / Enter / Tab / Esc 保持 textarea 焦点
    - `mentionSyntax.ts` 纯 Markdown 链接语法 `[@label](mention://type/id?table=...&design=...)` 的构造 / 解析
    - `IdeaEditor.css` 样式：顶栏 44px + 28px 按钮（对齐 SvgCanvas）、正文 `padding:24px 60px 80px 60px`、chip 蓝色 `rgba(20,86,240,0.08)` + 4px 圆角
  - `frontend/src/hooks/useIdeaSync.ts`：复用 EventSource 模板，`onContentChange` / `onRename` 回调；mid-typing（saveTimerRef active）时跳过外部覆盖
  - `frontend/src/App.tsx` 扩展：`documentIdeas` state、`ideaItems` 拼进 `sidebarItems`、新增 `handleCreateIdea / handleDeleteItem(idea) / handleMoveItem(idea) / handleRenameSidebarItem(idea)`；新增 `focusEntity` state 和 `handleNavigateToEntity(target)` 处理 mention chip 点击（table / field / record / taste 路由）；`useWorkspaceSync` 订阅四个 idea 事件；渲染分流 `activeItemType === "idea"` → `<IdeaEditor>`
  - `frontend/src/components/Sidebar.tsx` New 菜单移除 `doc` 的 `noop:true`，新增 `onCreateIdea` prop + 拖拽类型集合扩展
  - `frontend/src/components/TreeView.tsx` 添加 `IDEA_ICON`（doc 16×16）+ 所有 `type` union 加 `"idea"`
  - `frontend/src/i18n/{zh,en}.ts` 新增 `idea.loading/source/preview/toggleHint/saving/saved/unsaved/offline/empty/mentionEmpty/mentionTable/mentionField/mentionRecord/mentionTaste` + `toast.createIdeaFailed/ideaConflict`

- **文档**
  - `docs/idea-artifact-plan.md` 完整方案：数据模型 / API / SSE / Mention 语法 / UI 规范 / 7 个 P0 用例

- **Edge cases**
  - 名称碰撞 → 自动后缀（同 table）
  - 多端协同 → workspace 级 SSE 维护侧栏列表，实体级 SSE 推送正文
  - 竞态保存 → 乐观锁 + last-writer-wins + 推送 latest 给客户端
  - Markdown 内嵌 SVG / HTML → rehype-sanitize 白名单放行（`<script>` 和 `on*` 仍被剥离）
  - Mention 导出降级 → 纯 Markdown 语法，无渲染器时仍是人类可读链接
  - 实体删除后 chip → 按设计渲染灰态 + "已删除"（渲染层已具备，文案以 tooltip 形式处理）

- **已知 defer**
  - focusEntity 路由已通到 state 层，但 TableView / SvgCanvas 的滚动定位 + 高亮动画消费尚未实现（P1）
  - MCP 工具对 Idea 的暴露延后（方案 §v1 延后）
  - `@mention` picker 位置用 `linesBefore * 22` 近似估算，后续接 `textarea-caret-position` 精调

- **验证**
  - frontend `tsc --noEmit` 通过；`vite build` 通过（bundle 978.85 kB）
  - backend `curl` 烟测：创建 3 篇灵感名称去重正确（`灵感 / 灵感 1 / 灵感 2`）；`v=0 → v=1 → v=2` 正常；stale `baseVersion=0` 正确拒绝并返回 latest；mention 搜索 5 条命中；DELETE 清理成功

---

## 2026-04-20

### feat(phase4 day2+day3): Cron 调度 + 定时触达 Inbox + Agent 自登记定时任务 + 前端未读徽章

**分支**: `phase3/skills` · **commits**: 待提交

Day 1 把"每 5 分钟能稳定 tick"这件事做稳了，Day 2+3 把第一个有用的行为塞进去——**Agent 能定时给自己发消息**，用户也能在顶栏看到未读红点。

- **Day 2 · Cron 解析器 + 调度器**
  - 新增 `backend/src/services/cronScheduler.ts`（零依赖）：
    - `parseCron(expr)`：支持 5 字段 `minute hour dom month dow` 和 `@hourly / @daily / @weekly / @monthly / @yearly` 别名；支持 `*` / 列表 `9,17` / 区间 `1-5` / 步进 `*/15`；不合法输入返回 `null`（**绝不抛错**——cron 写错了不能把心跳打挂）
    - `cronMatches(parsed, date)`：字段逐个比对，Vixie-cron 的 "day OR" 语义保留——当 dom 和 dow 都被限制时，任一命中即算匹配
    - `nextFireAfter(parsed, from, {limitMinutes = 2y})`：从 `from + 1 minute` 开始逐分钟搜，绝不返回 `from` 本身，走到上限返回 `null`
    - `evaluateCron(agentId, now)`：核心算子。baseline = `lastFiredAt ?? now-1h` 防止新登记的 job 被回放触发；每个到期 job 最多触发一次，写一条 `InboxMessage{source:"cron", meta:{cronJobId, schedule, workspaceId?, skills?}}` 并 bump `lastFiredAt`；非法表达式写 `skipped.invalid-expression` 不抛错
    - CRUD helpers `addCronJob / removeCronJob / listCronJobs`：写入前先 `parseCron` 校验
  - `backend/src/index.ts` 把 `evaluateCron` 作为 heartbeat 的 `onTick`：每 5 分钟跑一次，触发的 job 列表塞进 heartbeat.log 的 `details.cronFired`，方便回溯

- **Day 3 · Inbox / Cron REST + Tier 0 定时工具 + 前端未读徽章**
  - `backend/src/routes/agentRoutes.ts` 新增运行时状态端点：
    - `GET /api/agents/:id/inbox[?unread=1&limit=N]` → `{messages, unreadCount}`
    - `POST /api/agents/:id/inbox/:msgId/ack` → 原子回写（`.tmp + rename`），已读消息再调一次返回同一条不抖
    - `GET / POST / DELETE /api/agents/:id/cron`：创建前 400-validate cron 表达式
    - `GET /api/agents/:id/heartbeat?tail=N`（默认 50）
  - `backend/mcp-server/src/tools/cronTools.ts` 新增三个 Tier 0 MCP 工具，Chat Agent 每轮都看得到：
    - `schedule_task { schedule, prompt, workspaceId?, skills? }` —— 让 Agent 自己登记"每周五 17:00 帮我总结本周表结构变化"；返回 `{ok, jobId, nextFireAt}`
    - `list_scheduled_tasks` —— 列出当前所有定时任务，带 `nextFireAt` 和 `parseError` 标记
    - `cancel_task { jobId }` —— 删除；找不到 id 返回 `{ok:false, error}` 而不是抛
    - 工具描述写得像"给自己留的便签"（"注意：这个工具**不会立刻执行**任何事，只是登记进 cron.json"），减少模型误调
  - `frontend/src/components/TopBar.tsx` 四芒星按钮右上角加红色未读徽章（`#F54A45`，`min-width 14px`，9+ 截断），`title` 也带未读数
  - `frontend/src/components/TopBar.css` 新增 `.topbar-agent-btn { position: relative }` + `.topbar-agent-badge` 定位/字号
  - `frontend/src/App.tsx` 每 30s 轮询 `/api/agents/agent_default/inbox?unread=1&limit=1`，chat 打开/关闭时也刷一次，传 `agentUnreadCount` 到 TopBar

- **`backend/src/scripts/phase4-runtime-smoke.ts` 扩展到 18 个断言**
  - Day 2 新增：parseCron 合法 + 非法、Vixie OR 语义、`nextFireAfter` 总向前、`addCronJob` 拒绝 garbage、`evaluateCron` 同 `now` 调两次第二次 no-op、异常 job 不抛、heartbeat+evaluateCron 端到端落 `cronFired`
  - Day 3 新增：`ackInboxMessage` unread→read、二次 ack 仍返回同条但 unread 不变、未知 id 返回 null、`inboxUnreadCount` 反映 ack 状态；`schedule_task` 校验并返回 `nextFireAt`、非法表达式返回 `{ok:false}` 不抛、`list_scheduled_tasks` 对坏 job 标 `parseError`、`cancel_task` 幂等（第二次返回 `{ok:false, error}`）
  - 结果：✅ `Phase 4 Day 1+2+3 smoke: PASS`
  - Phase 2、Phase 3 的旧 smoke 脚本回归无影响

**设计取舍**：
- **为什么零依赖手写 cron 解析**？我们只需要 5 字段 + 几个别名，`cron-parser` 这类包会带 `luxon` / `moment` 进来（~100KB + 一堆 peer deps），而这个解析一个小时就能写完、50 行 + 测试覆盖全。生产环境对 cron 语义要求不高（多是 `@daily` / `@weekly`）。
- **为什么 `baseline = lastFiredAt ?? now - 1h`**？新登记的 job 如果没有这个兜底，第一次 evaluate 就会扫到所有过去的触发点（比如 `@daily` 会回放 365 次），把 inbox 冲垮。给个 1 小时的回溯窗口够宽容（cron 最密也就每分钟一次），又不会批量回放。
- **为什么 inbox ack 用 `.tmp + rename`**？inbox.jsonl 是 append-only 到最后需要**整体重写**才能改字段；直接改文件中途崩溃就丢数据。`fs.rename` 在同一 fs 里是原子的，写到一半宕机 `.tmp` 可以丢弃。
- **为什么 `schedule_task` 不跑 Haiku 路由而是直接走 cronTools**？定时任务这种指令明确、接近 CRUD 的东西用 tool_call 最直，上 LLM 路由反而增加幻觉面。Haiku 留给 Day 4 的"要不要现在打扰用户"这种模糊判断。
- **为什么前端是 30s 轮询而不是 SSE**？inbox 事件很稀疏（大多数 agent 几小时才一条），长连接会占 Nginx worker 名额；30s 轮询一次只多几 KB 流量，未来真需要实时可以再上 SSE。

**未解决 / Day 4**：
- Haiku 低成本判断"现在该不该把这条 cron inbox 弹成系统通知"，还是安静留在红点里等用户自己打开看


### feat(phase4 day1): Agent Runtime 心跳层 — heartbeat loop + state/ 文件骨架

**分支**: `phase3/skills` · **commits**: 待提交

Phase 3 把"被动回应 + 按需加载工具"做完，Phase 4 开始让 Agent **主动有节奏**——后台每 5 分钟 tick 一次，未来挂载 Cron / Inbox / Memory Consolidator / Haiku 触发器。Day 1 先把管线铺到位，行为先设为 no-op，证明 fanout / 错误隔离 / graceful shutdown 都稳。

- **`backend/src/services/runtimeService.ts` 新增**
  - `startHeartbeat({ intervalMs, onTick, listAgents, logger })` / `stopHeartbeat()` / `tickNow()` / `getRuntimeState()`
  - 默认 5 分钟（`RUNTIME_HEARTBEAT_MS` 环境变量覆盖，最小 1s）；`RUNTIME_DISABLED=1` 关掉
  - 再入保护：上一个 tick 未结束就跳过下一个，不堆叠；`timer.unref()` 不阻止 Node 进程退出
  - 错误隔离：某个 agent 的 handler 抛异常只写一条 `outcome: "error"` 日志，不影响同 tick 其他 agent；单个 agent 写日志失败也不会让 tick 全部失败
  - `listAgents` 可注入，smoke 测试不依赖 Postgres

- **`backend/src/services/agentService.ts` 扩展**
  - `ensureAgentFiles()` 额外 bootstrap `state/heartbeat.log`（空）、`state/inbox.jsonl`（空）、`state/cron.json`（`{ jobs: [] }`）——读取路径不需要再处理 ENOENT
  - 新增跨用户 `listAllAgents()`（runtime 遍历用）
  - 新增 `HeartbeatLogEntry` + `appendHeartbeatLog` / `readHeartbeatLog({ tail })`
  - 新增 `InboxMessage` + `appendInboxMessage` / `readInbox({ onlyUnread, limit })`
  - 新增 `CronJob` / `CronFile` + `readCron` / `writeCron`（size-capped，合并 `DEFAULT_CONFIG` 逻辑复用 `assertSize`）

- **`backend/src/index.ts` 接线**
  - `start()` 末尾 `startHeartbeat()`（受 `RUNTIME_DISABLED` 开关控制）
  - SIGINT/SIGTERM 里 `await stopHeartbeat()`，等当前 tick 落盘再退出，防止 PM2 reload 写半截 heartbeat.log

- **`backend/src/scripts/phase4-runtime-smoke.ts` 新增**（覆盖 7 个断言）
  - ensureAgentFiles bootstrap 三个 state 文件
  - cron.json 读写 round-trip
  - inbox unread 过滤 + 默认字段填充
  - startHeartbeat 幂等（重复调用返回同一个 state）
  - tickNow 驱动，两次 tick 后 `ticksFired === 2`，每个 agent 各自得到 2 条 heartbeat.log
  - **错误隔离**：同一个 tick 里 agent_beta 抛错，agent_alpha 照样记 `idle`；beta 第二次才抛的设计也被 round-trip 校验
  - `readHeartbeatLog({ tail: 1 })` 返回最新 1 条
  - `stopHeartbeat()` 结束后 `getRuntimeState() === null`
  - 结果：✅ `Phase 4 Day 1 smoke: PASS`

**设计取舍**：
- 为什么在 Express 同进程？——Phase 4 行为本身很轻（每 5 分钟一次，不调 LLM），fork 子进程只会让部署复杂度上升。未来 Haiku 调用如果耗时长，再拆到独立 worker。
- 为什么 `state/` 是文件而不是 DB 表？——和 `soul.md` / `profile.md` 同一哲学：Agent 自己的状态要能 `grep` / `tail -f`，也不要让一个失控的 heartbeat 写挂 Postgres。
- 为什么 Day 1 handler 是 no-op？——先把"每 5 分钟能不能稳定 tick、异常能不能隔离、SIGTERM 能不能优雅退出"这三件事验了，再往里塞业务逻辑。Cron 调度 / Inbox 消费 / Haiku 触发都会作为独立 Day 增量加进来。

**未解决 / Day 2 起步**：
- Day 2：cron schedule 求值（最小实现：每 tick 扫描 jobs，按 `schedule` 对比 now，到期就把 `{source:"cron", prompt}` 追加到 `inbox.jsonl`，同时更新 `lastFiredAt`）
- Day 3：Inbox 到达时，若 Chat Sidebar 在线就浮红点；若不在线就下次打开再提示
- Day 4：Haiku 低成本轮询——"现在要不要打扰用户"


### feat(phase3): Tier 2 技能体系 — 可激活 Skill 包 + 工具按需加载 + 系统 Prompt 技能目录

**分支**: `phase3/skills` · **commits**: `6cfe7a9`, `00e2f4d`, `a8655e1`

Phase 1/2 把 Agent 的"身份 + 记忆"做好了，但所有工具（26 个）每轮都全量塞进 ARK 请求。Phase 3 按 OpenClaw 四层能力模型（`docs/chatbot-openclaw-plan.md` §4）切出 Tier 0/1/2，Tier 2 以 **Skill** 为单位按需激活。Agent 默认只看得到 10 个核心工具，用户一说"加个字段"触发自动激活，模型也能通过 `activate_skill` 显式挂载。

- **Day 1 · Skill 抽象 + table-skill 首个包**（`6cfe7a9`）
  - `mcp-server/src/skills/types.ts` 新增 `SkillDefinition`（name / displayName / description / artifacts / when / triggers / tools）
  - `mcp-server/src/skills/tableSkill.ts`：打包 `fieldTools` + `recordTools` + `viewTools` + 3 个 table 写入工具（create/rename/delete/reset，不含 list/get）。触发器覆盖中文"创建/删除/修改/批量/筛选"+ 英文 create/add/delete/remove/rename/batch 等
  - `mcp-server/src/skills/index.ts`：`allSkills` / `skillsByName` 注册
  - `mcp-server/src/tools/skillRouterTools.ts`：Tier 0 三件套 `find_skill` / `activate_skill` / `deactivate_skill`，通过 `ctx.onActivateSkill` 回调避免 skills → agent-service 的循环 import
  - `mcp-server/src/tools/tableTools.ts` 扩展 `ToolContext`：`{agentId, activeSkills, onActivateSkill, onDeactivateSkill}`
  - `mcp-server/src/tools/index.ts` 重写：`tier0Tools` / `tier1Tools` / `resolveActiveTools(activeSkillNames)` / `toArkToolFormat(tools?)`；`allTools` 仍包含全量用于 `toolsByName` 查找

- **Day 2 · 每会话 skill 状态 + Tier-aware 工具加载**（`00e2f4d`）
  - `chatAgentService.ts` 新增 `skillStateByConv: Map<conversationId, {active:Set, lastUsedTurn:Map, turnIndex:number}>`。`SKILL_EVICTION_TURNS = 10`，turn 末尾自动驱逐闲置 skill
  - `autoActivateByTriggers(state, userMessage)`：每轮 turn 开始前跑一次正则匹配，命中即加入 `state.active`，日志 `skill_auto_activated`
  - `runAgent` 构建 `toolCtx = {agentId, activeSkills, onActivate..., onDeactivate...}`，每一 round 用 `resolveActiveTools([...active])` 拿到当前工具子集，经 `toArkToolFormat(activeTools)` 只传给 ARK 它需要的那些
  - 每次工具执行命中时 bump 该工具 owning skill 的 `lastUsedTurn`；turn 末尾 `evictStaleSkills` 清理，日志 `skill_evicted`
  - `resumeAfterConfirm`（危险操作二次确认回流）同步重建 `toolCtx`，bump owning skill 的 `lastUsedTurn` 避免 round-trip 期间被驱逐

- **Day 3 · 系统 Prompt 技能目录 + ✅ 激活标记**（`a8655e1`）
  - `chatAgentService.buildSkillCatalog(activeSkillNames)`：把 `allSkills` 渲染成 `- **name** (displayName, N 个工具) — when`，已激活的前置 ✅ 标记
  - `assembleInput(..., activeSkillNames)` 把目录块塞在 Layer 2 Identity 和 Tool Guidance 之间——模型读完"我是谁"就看到"我能装什么能力"
  - `runAgent` 传 `[...skillState.active]` 进去：auto-activated 的 skill 在第一轮 ARK 请求的系统 Prompt 里就已经带 ✅，避免模型重复调 `activate_skill`

- **Day 4 · 烟囱脚本 + 文档**
  - `backend/src/scripts/phase3-skills-smoke.ts` 覆盖：baseline 工具严格 tier0+1（10 个）、激活 table-skill 后 +19 个、`find_skill` / `activate_skill` / `deactivate_skill` 走通回调、触发器命中 "帮我创建一个字段" 等典型句、不误伤 "你好"/"今天星期几"、`toolsByName` 无 orphan、`toArkToolFormat` 输出结构正确
  - CLAUDE.md Architecture Notes 新增 Tier 2 skills 说明（分层/激活/驱逐/目录）

**本地 smoke 验证**:
- `npx tsx backend/src/scripts/phase3-skills-smoke.ts` → `baseline tools=10, +table-skill=29, total registered=29, skills=1` ✅
- 现有 Phase 2 smoke (`phase2-memory-smoke.ts`) 仍然跑通，未破坏任何记忆链路
- `tsc --noEmit` 在 `chatAgentService` / `skills/` / `skillRouterTools` / 新脚本上零新增错误；dbStore / aiService / designRoutes / fieldSuggestService 的历史告警未动

### feat(phase2): Agent 记忆召回 — read_memory / recall_memory / 自动召回 / working→episodic 压缩

**分支**: `phase2/memory-recall` · **commits**: `c3285f8`, `5fe53d9`, `7209c1d`, `55aa8dd`

在 Phase 1 只能 **写** 记忆（`create_memory`）的基础上补齐 **读** + **自动召回** + **压缩** 三件事。Agent 现在可以在对话里"想起以前发生过什么"，而不是每一轮从零开始。完整方案见 `docs/chatbot-openclaw-plan.md` §4。

- **Day 1 · `read_memory` Tier 0 工具**（`c3285f8`）
  - `backend/src/services/agentService.ts` 新增 `listEpisodicMemories` / `readEpisodicMemory`：按 mtime 倒序列出、`tag` 过滤、`limit` 上限 100；文件名走 path-traversal 守卫；header parser 容忍 `# title` / `Tags:` / `Timestamp:` 之间的空白行
  - `backend/mcp-server/src/tools/memoryTools.ts`：单一 `read_memory` 工具，两种模式（不传 filename → 列出摘要；传 filename → 取全文）；与 metaTools 共用 `(args.agentId, ctx.agentId, "agent_default")` 解析顺序
  - `tools/index.ts` 把 memoryTools 挂在 metaTools 之后，Tier 0 三件套（identity + memory）统一停靠在函数列表顶端
  - Meta Prompt 加了 read_memory 的调用指引
  - Smoke: `backend/src/scripts/phase2-memory-smoke.ts` 验证列表顺序、tag filter、filename 加载、traversal 拒绝、missing 文件、limit；全部通过

- **Day 2 · `recall_memory` 评分检索**（`5fe53d9`）
  - `recallMemories(agentId, query, {tags?, limit?})`：`score = 3·keyword + 2·tag + 1·recency`；关键词切词支持 Latin 单词 + CJK 连续段；近因走 `exp(-days/14)` 半衰期 ≈ 10 天；命中为 0 且非空 query 的条目会被丢弃；空 query + 空 tags 则回退为纯近因排序
  - 每个 hit 返回 `reasons`（keyword / tag / recency / mtimeMs）便于人工调参
  - `recall_memory` MCP 工具落地 + Meta Prompt 调整为优先 recall_memory、再 fallback 到 read_memory
  - Smoke 新增：keyword 命中、tag-only、query+tag 组合加权、非匹配返回 0、空参数回退近因

- **Day 3 · 每轮自动召回注入 Layer 3**（`7209c1d`）
  - `chatAgentService.buildRecalledMemoriesSection(agentId, userMessage)`：每一轮 run recallMemories(limit=3)，把 top-K 摘要拼成一段 `# 自动召回的相关长期记忆` 塞进 Layer 3 Turn Context；不相关 query 直接产出空串不占 prompt
  - 每个 hit 渲染 title / 标签 badge / 日期 / 200 字预览 / `filename:...（想看全文就调用 read_memory）` 提示，引导 Agent 按需深挖
  - 故障隔离：召回异常被捕获并以占位文本返回，绝不打断 turn
  - Smoke: CRM query 产出 CRM 记忆；"今天天气怎么样" 产出空串

- **Day 4 · working.jsonl → episodic 压缩**（`55aa8dd`）
  - `agentService`：`WorkingMemoryEntry` + `appendWorkingMemory` / `readWorkingMemory` / `clearWorkingMemory` / `compressWorkingMemory`。压缩走确定性合成（token 频次 + 工具调用频次 + 日期区间），不调 LLM，方便测试且零 API 消耗
  - `chatAgentService.runAgent` 在每一轮 turn 结束、assistant message 持久化之后 **fire-and-forget** 一次 `appendWorkingMemory` + 条件性 `compressWorkingMemory`（阈值 10 轮）；过程异常只写日志、不抛错
  - 压缩成功会产出一条带 `working-memory-compaction` tag 的 episodic 记忆（title 包含 top 3 keyword）并清空 working.jsonl
  - Smoke: 注入 12 轮 → 阈值 100 时跳过、阈值 10 时压缩成功、working.jsonl 清空、episodic 文件可被 read_memory 列出

**本地 smoke 验证**:
- `AGENT_HOME=/tmp/imagebase-phase2-smoke npx --prefix backend tsx backend/src/scripts/phase2-memory-smoke.ts` 一次跑通 Day 1+2+3+4 所有断言
- `backend/src/scripts/phase1-registry-check.ts` 显示 `total tools: 25`，顶端 5 个为 `update_profile, update_soul, create_memory, read_memory, list_tables`（第 6 个已扩展为 `recall_memory`）
- Phase 2 新增代码在 `chatAgentService` / `agentService` / `memoryTools` / `phase2-memory-smoke` 中 `tsc --noEmit` 无新增报错；仅剩 dbStore / fieldSuggestService 预先存在的 JsonValue 告警（与 Phase 2 无关）

### feat(phase1): OpenClaw-style Agent MVP（身份文件 + 三层 Prompt + 元工具 + 身份编辑 UI）

**分支**: `phase1/agent-mvp` · **commits**: `f05a2c7`, `fa348fb`, `f0e9da2`, `ddd3014`, `871339f`

分五天分别 ship，把原本"工作空间绑定、无身份、无记忆"的 Chat Agent 升级成"用户本人拥有、长期演进、可自我编辑"的 OpenClaw 风格 Agent。完整方案见 `docs/chatbot-openclaw-plan.md`。

- **Day 1 · Prisma Agent 模型**（`f05a2c7`）
  - `schema.prisma` 新增 `Agent` 表（userId/name/avatarUrl，`@@map("agents")`），User 上加 `agents Agent[]`
  - `Conversation` 加 `agentId String?` + FK（`onDelete: SetNull`）+ `@@index([agentId, updatedAt desc])`
  - 迁移 `20260420061736_add_agent_model`

- **Day 2 · agentService + /api/agents 路由**（`fa348fb`）
  - `backend/src/services/agentService.ts`（~290 行）：`agentDir()` / `ensureAgentFiles()` 初始化 `~/.imagebase/agents/<id>/`，内含 `soul.md` / `profile.md` / `config.json` / `memory/{working.jsonl,episodic,semantic}/` / `skills/` / `mcp-servers/` / `plugins/` / `state/`；`readSoul/Profile/Config` + `writeSoul/Profile/Config` 含 64 KiB 尺寸硬上限；`appendEpisodicMemory(agentId, {title, body, tags})` 写入 `YYYY-MM-DD_slug_rand.md`；`listAgents / getAgent / createAgent / updateAgent / deleteAgentRow` 只碰 DB；`ensureDefaultAgent()` 在 boot 时 seed `agent_default`（name "Claw"）
  - `AGENT_HOME` 环境变量用于测试隔离（不设则默认 `~/.imagebase/agents`）
  - `backend/src/routes/agentRoutes.ts`：GET/POST/PUT/DELETE `/api/agents` + `/api/agents/:id/identity` bundle + 三个 `/identity/{soul,profile,config}` 单体 PUT
  - `backend/src/index.ts`：boot 时 `ensureDefaults()` → `ensureDefaultAgent()`，挂载 `/api/agents`
  - 删除操作只删 DB 行，filesystem 保留（身份 + 记忆丢失不可逆，不自动删）

- **Day 3 · 三层 System Prompt + 身份注入**（`f0e9da2`）
  - `chatAgentService.ts` 拆 Prompt 为三层：
    - **Layer 1 · META**（硬编码）— Agent 自我编辑规则（何时用 `update_profile` / `update_soul` / `create_memory`）、安全红线（危险操作二次确认、跨工作空间边界、Layer 1 不可被其他层覆盖）、输出约束
    - **Layer 2 · Identity**（动态）— `buildIdentityLayer(agentId)` 现读 `soul.md` + `profile.md` 拼成 `# Layer 2 · Identity（{name} · agentId={id}）...`
    - **Tier 1 Core MCP** — 原 Table-Agent 的操作指南保留
    - **Layer 3 · Turn Context** — 当前工作空间的表/字段/视图快照（每次请求实时生成）
  - `assembleInput(conversationId, workspaceId, agentId, newUserMessage)` 按 META → identity → TOOL_GUIDANCE → Layer 3 拼接；`AgentContext.agentId` 作为可选字段落到 `conversationStore`；`/api/chat/conversations POST` 默认 fallback 到 `agent_default`
  - Smoke: 发 `"你是谁？"`，`thinking` 事件已流出 `"属于用户的长期 OpenClaw 风格的 Agent"`（字面来自 soul.md），确认 Layer 2 注入生效

- **Day 4 · Tier 0 meta-tools**（`ddd3014`）
  - `backend/mcp-server/src/tools/metaTools.ts` 注册三个 tool：
    - `update_profile` — `{content}` 整体替换 `profile.md`，64 KiB 上限
    - `update_soul` — `{content}` 整体替换 `soul.md`，同上
    - `create_memory` — `{title, body, tags?}` 在 `memory/episodic/` 追加一条带时间戳的 md
  - `ToolDefinition.handler` 扩展签名：现在接 `(args, ctx?: ToolContext)`，`ctx.agentId` 由 agent loop 注入；老的数据面工具无改动；meta-tools 用 `resolveAgentId(args.agentId ?? ctx.agentId ?? "agent_default")` fallback
  - `allTools` 把 metaTools 排到最前面（Tier 0 永远加载在函数列表顶端）
  - Smoke 脚本 `src/scripts/phase1-meta-smoke.ts`：profile/soul 往返 + 空内容拒绝 + 无 ctx 时自动落到 `agent_default`，全部通过

- **Day 5 · 前端 Agent 接线**（`871339f` + 后续修订）
  - `frontend/src/api.ts`：新增 `listAgents / getAgent / updateAgent / getAgentIdentity / putAgentSoul / putAgentProfile / putAgentConfig`；`createConversation(workspaceId, agentId?)` 增加第二参数
  - `frontend/src/components/ChatSidebar/index.tsx`：接新 `agentId?: string` prop（默认 `"agent_default"`），两处 `createConversation(workspaceId)` 调用改为 `createConversation(workspaceId, agentId)`
  - `frontend/src/App.tsx`：新增 `AGENT_ID = "agent_default"` 常量传给 `<ChatSidebar>`（单 Agent MVP，多 Agent picker 待后续）
  - **Phase 1 产品决策修订**：soul / profile 不对用户暴露为交互式 UI。ChatSidebar header 移除 IdentityIcon 按钮与 AgentIdentityModal 渲染；Modal 组件文件保留但不再被 import，作为 Phase 2+ 复用素材。用户只能通过与 Agent 对话读写身份（Agent 通过 Tier 0 元工具自编辑）。`IdentityIcon` 在 `icons.tsx` 中保留、i18n 的 `chat.agent.*` 键保留但不再被渲染层消费。

**本地 smoke 验证**:
- `curl /api/agents` → 返回 `agent_default / Claw`；`PUT /identity/profile` 写入后 filesystem 立刻可见
- `phase1-meta-smoke.ts` 跑通 profile/soul/memory 往返 + 空值拒绝 + fallback 路径
- 通过 `/api/chat/conversations` 发消息 → `thinking` 事件输出 soul.md 中的身份措辞，Layer 2 注入端到端验证
- `cd frontend && npx tsc --noEmit` 干净通过；后端 tsc 仅剩 `dbStore.ts` / `aiService.ts` 里几处预先存在的 `JsonValue` 强转告警（与 Phase 1 无关）

### feat: 支持 Add Record（工具栏 & 表格底部均可触发）

- **改动点**: `TableView`、`Toolbar`、`App.tsx`、`api.ts` 联动支持「点击 + 空白行 + 首列自动进入编辑」的典型录入流
- **详细说明**:
  1. **API**: `frontend/src/api.ts` 新增 `createRecord(tableId, cells)`，包装后端 `POST /api/tables/:tableId/records`，返回 201 + 完整 `TableRecord`（id + cells + 时间戳）。
  2. **TableView**: Props 新增可选 `onAddRecord?: () => Promise<string>` 返回新记录 id；`.add-record-btn` 的 onClick 绑定到本地 `handleAddRecordClick`，先 `await onAddRecord()` 再用返回的 id + `visibleFields[0].id` 进入 `editing` 状态并 `scrollIntoView`。`<tr>` 新增 `data-record-id` 属性用于定位滚动目标。`TableViewHandle` 补 `addRecord()` 方法通过 `addRecordClickRef` 暴露给父组件，让工具栏按钮可以复用同一逻辑。
  3. **App.tsx**: 新增 `handleAddRecord()`：调 `createRecord()` → 乐观追加到 `allRecords`（与 `handleRemoteRecordCreate` 用 id 去重，避免 SSE 回声导致重复行）→ 返回新 id。同时把 `() => tableViewRef.current?.addRecord()` 传给 `<Toolbar>`。
  4. **Toolbar**: 新增 `onAddRecord?: () => void` prop，绑定到 `.toolbar-add-record` 的 onClick。
  5. **验证**：两个入口都能在表格最底部插入空白行（行数 102 → 103 → 104），首列 `<input>` 立即 focus 进入编辑态，DOM 结构 `td.td-editing` + `activeElement.tagName === "INPUT"`。

### feat: Sidebar 新建菜单精简

- **改动点**: `Sidebar.tsx` 新增 `HIDE_CREATE_MENU_KEYS` 白名单过滤
- **详细说明**: 产品决策隐藏 6 项未完全就绪的入口（`template` / `form` / `cm_dashboard` / `cm_workflow` / `import` / `app`）。代码保留完整，仅在 `createMenuItems.filter()` 环节跳过这些 key，后续恢复只需从 Set 中移除对应 key 或清空 Set 即可。

### feat: CreateTablePopover 标题 icon 统一为 Table 紫色图标

- **改动点**: `CreateTablePopover.tsx` 新增 `TABLE_ICON` 常量（`#8D55ED` 紫色，镜像 Sidebar `CM_ICONS.table`），替换原 AI gradient 四芒星 icon
- **详细说明**: 用户从 Sidebar「+」菜单 →「数据表」进入 popover 时，标题 icon 现在与菜单项 icon 一致，形成视觉上的操作链路反馈。生成 / 创建中动画沿用原 `AI_ICON`（AI 四芒星渐变），区分状态。

### feat: Chat 工具卡片体验优化（title 间距 / 步骤标签 / 信息确认改版）

- **改动点**: `ChatSidebar/ChatMessage/{ToolCallCard,ToolCallGroup,ThinkingIndicator,ConfirmCard}.tsx` + `ChatSidebar.css` + i18n
- **详细说明**:
  1. **展开卡片 title 下 8px 间距** — `.chat-expand-card-body` 顶部 padding 从 4px 调整为 8px，思考 / 工具卡片展开后标题与正文之间不再粘连。
  2. **工具步骤状态文案** — 新增 i18n `chat.tool.step.{running,success,error,awaiting}` 与 `chat.tool.stepStart`，工具卡片展开时在每步开头明示「执行中…」「执行完成」「执行失败」「等待确认中」，减少用户对进度的猜测。
  3. **信息确认卡片增强** — 新增 `chat.confirm.skip` / `chat.confirm.start` 与 `chat.confirm.title` i18n，`ConfirmCard` 样式和按钮语义调整；文本式 二次确认保留（用户偏好，不走卡片拦截）。
  4. **ChatSidebar index**: 保留粘底滚动 + More 菜单 + 缓存逻辑不变，小幅调整以配合新组件。

### feat: 页面标题与描述改为 Table Agent

- **改动点**: `frontend/index.html` `<title>` 改为 `Table Agent · AI 智能多维表格`，并新增 `<meta name="description">`
- **详细说明**: 与产品定位升级一致（单纯 AI 筛选 → 对话式 Table Agent），浏览器 tab / 分享卡片 / 搜索引擎抓取都会展示新品牌名。

### feat: Chat 流式输出不再强制抢走用户滚动；刷新会话菜单加 icon

- **改动点**: `ChatSidebar/index.tsx` 增加 `stickToBottomRef` 粘底自动滚动 + "刷新会话" 菜单项加圆形箭头 icon
- **详细说明**:
  1. **流式输出尊重用户滚动** — 原本只要 `messages` 状态变化（每个 thinking/message/tool 事件都会触发），useEffect 就强制 `scrollTop = scrollHeight`，用户在模型吐字时想向上翻阅历史会被反复弹回底部，体验很差。改为：监听 `.chat-messages` 的 scroll 事件计算 `distanceFromBottom`，超过 24px 阈值就把 `stickToBottomRef.current` 翻为 false，auto-scroll 立刻停手；用户滚回底部附近后重新 sticky。用户点击发送或切换到新对话时强制 sticky=true，确保新一轮对话从底部开始。
  2. **刷新会话菜单加 icon** — 原 `DropdownMenu` 只显示 "刷新会话" 文字，比较单薄。给这一项加上已有的 `RefreshIcon`（16×16 圆形箭头），与其他下拉菜单视觉风格保持一致。

### fix: Chat Agent 工具调用重复执行（每次执行两次）

- **改动点**: `backend/src/services/chatAgentService.ts` 的 `callArkStream` 增加 `yieldedCallIds` Set 去重
- **详细说明**: ARK Responses API 在流结束时会通过 `response.completed` 事件一次性回传完整的 output 列表，其中包含所有已经在 `response.output_item.done` 中发出过的 `function_call` items。原代码用 `pendingCalls.values().some(e => e.callId === callId)` 来判断是否已发出，但 `output_item.done` 的 handler 会立即 `pendingCalls.delete(itemId)`，等 `response.completed` 做去重检查时 Map 早已被清空，每次都命中"未发出"分支导致同一个工具调用被 yield 两次。修复方式：引入独立的 `yieldedCallIds: Set<string>`，`output_item.done` 和 `response.completed` 两条路径都先查表再决定是否 yield，彻底杜绝重复。创建数据表、创建字段、批量写入记录等所有工具调用从"每次 2 次"恢复到"每次 1 次"。

### feat: Chat 对话持久化 + 欢迎页 & 刷新会话交互优化

- **改动点**: 对话存储迁移到 Postgres、欢迎页文案与排版调整、刷新会话入口改版
- **详细说明**:
  1. **对话持久化到 Postgres（Prisma）** — `backend/prisma/schema.prisma` 新增 `Conversation` 和 `Message` 两张表（含 `@@index([documentId, updatedAt(sort: Desc)])` 与 `@@index([conversationId, timestamp])`），迁移 `20260419160227_add_conversations_and_messages`。`backend/src/services/conversationStore.ts` 从内存 Map 重写为 Prisma 客户端：保留原公有 DTO 形状（string id、epoch ms timestamp、Message role / toolCalls JSON），通过 `toConversation()` / `toMessage()` 辅助把 Date → number ms；`appendMessage()` 用 `$transaction` 串联 message 插入 + messageCount 递增 + 自动标题。`chatRoutes.ts` 6 个 handler 改为 async + await。重启 backend / pm2 reload / tsx watch 重编后对话不再丢失。
  2. **Bug 修复：batch-create 生成唯一 id** — `backend/src/routes/tableRoutes.ts` 的 `POST /api/tables/:tableId/records/batch-create` 区分两种调用：撤销恢复（records 已含 id/createdAt/updatedAt）走原路径；Agent 批量写入（只含 cells）改为循环 `createRecord` 生成 cuid + 服务端时间戳 + 默认值 + autonumber 计数，返回 `records[]` 让 SSE 收到真实 id，避免 React key 碰撞导致列表只显示 0 条。
  3. **欢迎页文案：去掉 "new"** — 中文 `chat.empty.title` 改为 "你好，我是你的智能助手"，英文改为 "Hi, I'm your chatbot"。新增 `renderTitleWithCommaBreak()` 辅助：将标题按首个中英文逗号拆成两段，每段 `white-space: nowrap`，中间插 `<wbr>`，narrow 宽度下只能在逗号后换行，不会在词中间断开。
  4. **刷新会话改版：More menu + 二次确认** — 原刷新 icon 替换为 More（⋯）icon，点击弹出 `DropdownMenu`（仅一个"刷新会话"菜单项），选择后弹 `ConfirmDialog` 告知用户"刷新后会开始一个全新的空白会话，当前会话仍会保留在对话历史中"。欢迎页（messages 为空且非 streaming 状态）隐藏 More 按钮以避免无意义操作。新增 i18n: `chat.menu.more` / `chat.menu.refresh` / `chat.refresh.confirm.{title,message,ok,cancel}`。
  5. **欢迎页顶部间距** — `.chat-empty` margin-top 从 4px 调整为 28px，使 `.chat-empty-hero` 距离 `.chat-part` 顶部正好 80px（header 36px + chat-messages padding-top 16px + margin-top 28px = 80px）；修正 CSS 注释中关于 header 高度的错误描述。

---

## 2026-04-19

### feat: Chat Sidebar 前端缓存 + 智能提示词建议

- **改动点**: 4 项 Chat Sidebar 体验增强
- **详细说明**:
  1. **前端缓存（防刷新闪烁）** — 新增 `localStorage` key `chat_cache_v1:${documentId}`，首次挂载通过 `useState` 初始化器同步读取缓存的 `activeConvId + messages + contextHint`，无需等 `/conversations` 返回即可渲染上次对话。打开面板后后台再 revalidate，若服务端 404（例如 backend 重启）则清缓存并走常规 list/create 流程。缓存上限 100 条消息，streaming 标志在读取时被重置避免卡死动画。
  2. **工具卡片与文字间距 12px** — `MessageBlock` 现在返回 `.chat-msg-assistant-block` 包裹 div，内部 `gap:12px`（思考指示 + 文字 + 工具卡片），外层 `.chat-messages` 保持 28px 消息间距。
  3. **后台定时任务：智能提示词建议** — 新增 `backend/src/services/suggestionService.ts`，启动后 5s 跑首轮、每 10min 刷新，基于文档表/字段结构调 ARK 生成 3-5 条 `{label, prompt}`，附签名去重避免无变更时浪费 tokens，失败回落到默认包。新增 `GET /api/chat/suggestions` 及 `POST /api/chat/suggestions/refresh` 路由。前端 EmptyState 优先渲染动态建议，空/失败时回落到 i18n 预设；新增 `fetchChatSuggestions()` 客户端。
  4. **create_table 主字段指引** — `backend/mcp-server/src/tools/tableTools.ts` 的 `create_table` 工具描述强化为"⚠️ 必须用 update_field 改造默认主字段，不许重复 create_field 新增第一列"，handler 回传新字段 `primaryField { id, name, type }` 和 `note` 文本。`chatAgentService.ts` 系统提示词同步新增硬规则，明确创建复杂表的正确顺序：create_table → update_field 改主字段 → create_field 追加其余 → batch_create_records。

---

## 2026-04-17

### feat: 多表管理（新建、切换、拖动排序、删除）
- **改动点**: 同一 Document 下支持新建多个数据表，Sidebar 动态显示、切换、排序、删除
- **详细说明**:
  1. 后端增强：`dbStore.ts` 新增 `listTablesForDocument()`、`batchReorderTables()`、`generateTableName()`、`deleteTableCascade()` 函数。`createTable()` 创建 1 个默认 Text 字段 + 5 条空记录 + Grid 视图
  2. 文档级 SSE：`eventBus.ts` 新增 `DocumentChangeEvent` 通道，`sseRoutes.ts` 新增 `GET /api/sync/documents/:docId/events` 端点，支持 `table:create`、`table:delete`、`table:reorder`、`table:rename` 事件
  3. 前端 `App.tsx` 核心重构：`TABLE_ID` 常量替换为 `activeTableId` 状态 + `activeTableIdRef` ref，~30 处引用更新，新增 `switchTable()`、`handleCreateTable()`、`handleDeleteTable()` 回调
  4. 新增 `useDocumentSync.ts` Hook 监听文档级 SSE，同步 sidebar 表列表变化
  5. Sidebar 重构：动态表列表、原生 mouse 事件拖动排序（蓝线指示器）、"+新建" 下拉菜单（Figma 设计、分组显示、240px 宽度）、表项右键/more icon 删除（180px 菜单、ConfirmDialog 确认）
  6. `DropdownMenu.tsx` 扩展：`section` 分组、`suffix` 右箭头、`noop` 静默项、`width` 固定宽度、`position: "above"` 向上弹出

### feat: Sidebar 宽度可调
- **改动点**: 支持拖动 Sidebar 右侧边缘调整宽度
- **详细说明**: 拖拽 6px 热区，范围 120px–400px，宽度通过 localStorage `sidebar_width` 持久化

### fix: 新表默认列宽 280px
- **改动点**: 新建数据表的主字段（Text）默认列宽从 120px 调整为 280px
- **详细说明**: `TableView/index.tsx` 新增 `getDefaultColWidth(field)` 辅助函数，isPrimary 字段返回 280px

### fix: 删除表切换到上一个表
- **改动点**: 删除当前活跃表时自动切换到前一个表，而非第一个
- **详细说明**: `handleDeleteTable` 使用 `remaining[Math.max(0, idx - 1)]` 选择目标表

### fix: 切换表时表名闪烁
- **改动点**: 修复 sidebar 点击切换表瞬间表名短暂显示其他表名
- **详细说明**: `switchTable` 中 `setTableName` 移到 async fetch 之前同步设置

### fix: 默认表名数字前加空格
- **改动点**: 自动生成的重复表名数字序号前增加空格（「数据表 2」而非「数据表2」）
- **详细说明**: `dbStore.ts` 中 `generateTableName()` 模板改为 `${baseName} ${i}`

### fix: 新建菜单非功能项不关闭菜单
- **改动点**: 点击非功能选项（如"通过AI创建"等）不再触发菜单关闭
- **详细说明**: `MenuItem` 新增 `noop` 属性，`DropdownMenu` 中 noop 项点击跳过 `onSelect`/`onClose`

---

## 2026-04-15

### feat: 英文/中文国际化语言切换 (i18n)
- **commit**: `da3584c`
- **改动点**: 零依赖 React Context i18n 方案，支持英文/简体中文切换
- **详细说明**:
  1. 新增 `frontend/src/i18n/en.ts`、`zh.ts`、`index.ts`：LanguageProvider + useTranslation hook + t() 函数，130+ 翻译条目覆盖所有非用户数据 UI 文本
  2. 头像下拉菜单新增 Language 子菜单，悬浮展开，当前语言显示 checkmark
  3. localStorage `app_lang` 持久化，切换时 `window.location.reload()` 确保模块作用域常量（OPERATORS_BY_TYPE、DATE_VALUE_OPTIONS 等）使用新语言重新初始化
  4. 子菜单 CSS 修复：`left: calc(100% + 4px)` → `right: calc(100% + 4px)` 防止右边缘溢出

### fix: undo 后端不同步问题修复
- **commit**: `96d05aa`
- **改动点**: 修复 undo 操作前端生效但后端未同步的问题
- **详细说明**:
  1. `api.ts`：`updateRecord`/`deleteRecords`/`batchCreateRecords` 增加 `res.ok` 检查，后端 4xx/5xx 不再静默吞掉
  2. `performUndo`：所有后端调用改为 `await`，失败时回退前端状态并 toast 提示 "撤销失败，数据未能同步，请刷新页面"
  3. `executeDelete`：通过 `deletePendingRef` 追踪删除 Promise，`performUndo` 执行前先 await，防止竞态条件（undo 在删除未完成时触发导致 batchCreate 先于 batchDelete）
  4. `handleCellChange`/`executeClearCells`：后端失败时回退乐观更新 + toast 提示

### feat: 增加请求日志中间件
- **commit**: `c905156`
- **改动点**: 所有 API 请求增加结构化日志
- **详细说明**: `index.ts` 新增中间件，记录 method、path、clientId、请求体（mutation）、响应状态码、耗时、响应摘要。SSE 和 health 端点跳过详细日志

### feat: 实时数据同步（SSE）
- **commit**: `c241340`
- **改动点**: 实现多标签页和多用户实时数据同步
- **详细说明**:
  - 新增 `eventBus.ts`：Node.js EventEmitter 事件总线，按 tableId 作用域
  - 新增 `sseRoutes.ts`：SSE 端点 `GET /api/sync/:tableId/events?clientId=xxx`，30 秒心跳
  - `tableRoutes.ts`：13 个变更端点添加 `eventBus.emitChange()`
  - `api.ts`：导出 `CLIENT_ID` + `mutationFetch` 包装函数注入 `X-Client-Id` 头
  - 新增 `useTableSync.ts`：前端 SSE 订阅 Hook，防回声 + 断线重连全量同步
  - `App.tsx`：12 个远程事件处理函数，远程变更不入 undo 栈
  - Nginx 配置 SSE location block（`proxy_buffering off`）

### fix: 输入框图标顺序与 Loading 截断优化
- **commit**: `e373adb`
- **改动点**: FilterPanel AI 输入框有文本时，叉号(X)和麦克风(🎤)图标互换位置；Loading 动效省略号距输入框右边保持 12px 间距
- **详细说明**: 有文本输入后图标顺序调整为 ✕ → 🎤 → ↑，符合「先清除、再语音、最后发送」的操作优先级。LoadingDots 组件设置 `flex-shrink: 0` 防止压缩，`.fp-ai-loading-text` 增加 `padding-right: 12px`

### fix: LoadingDots 作为截断标识，移除重复省略号
- **commit**: `45a352d`
- **改动点**: Loading 状态文本过长时，移除 CSS `text-overflow: ellipsis` 静态省略号，改用 LoadingDots 动画直接作为截断符
- **详细说明**: 之前长文本截断会同时显示 CSS 静态省略号和 LoadingDots 动态省略号。修改为 `.fp-ai-loading-query` 只用 `overflow: hidden` 裁剪文字，LoadingDots 紧跟其后作为唯一截断指示器

### fix: Loading 文本过长时省略号截断
- **commit**: `13a0d0d`
- **改动点**: "Generating filter by ..." Loading 文本超长时用省略号截断
- **详细说明**: 将 Loading 文字部分包裹在 `.fp-ai-loading-query` span 中（`flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis`），LoadingDots 保持在外部作为 flex 兄弟元素

### fix: AI 筛选输入框长文本截断
- **commit**: `1a8a6f8`
- **改动点**: 输入框文本过长时单行截断显示，不换行
- **详细说明**: `.fp-ai-input` 添加 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`。`.fp-ai-loading` 和 `.fp-ai-loading-text` 添加 `min-width: 0` 支持 flex 子元素截断

---

## 2026-04-14

### fix: 清空行单元格英文文案
- **commit**: `e924ad9`
- **改动点**: 确认弹窗和 Toast 统一使用英文文案
- **详细说明**: 弹窗标题 "Clear Records"，正文 "Are you sure you want to clear all cells of N record(s)?"，确认按钮 "Clear"。Toast 显示 "Cleared N records"（区别于单元格清空的 "Cleared N cells"）。`executeClearCells` 增加可选 `toastLabel` 参数

### fix: 清空记录单元格中文文案 + 确认后复选框恢复未选中
- **commit**: `e101029`
- **改动点**: 初始中文文案实现 + 确认清空后复选框自动取消勾选
- **详细说明**: TableView 新增 `clearRowSelection()` imperative method，App.tsx 在 `handleConfirmDelete` 和 `handleClearRowCells`（无 deleteProtection 时）调用

### feat: 复选框+Delete 清空行单元格，右键删除行
- **commit**: `f880b9e`
- **改动点**: 区分两种删除行为——复选框选中行 + Delete 键清空单元格（受 Safety Delete 管控），右键删除行删除记录（受 Safety Delete 管控）
- **详细说明**: 
  - TableView 新增 `onClearRowCells` prop，键盘 handler Priority 1 改为收集选中行所有可编辑单元格并调用 `onClearRowCells`
  - App.tsx 新增 `handleClearRowCells`：deleteProtection 开启时弹确认框（type: "rowCells"），关闭时直接执行
  - ConfirmDialog 新增 `"rowCells"` 类型，独立文案
  - 拖选单元格 + Delete 仍通过 `onClearCells` 直接执行（不受 Safety Delete 管控）

### fix: 键盘 handler 使用 ref 防止闭包过期
- **commit**: `72faa89`
- **改动点**: `selectedRowIds` 和 `cellRange` 使用 ref 同步最新状态
- **详细说明**: 添加 `selectedRowIdsRef` 和 `cellRangeRef`，每次渲染同步 `current` 值。键盘事件 handler 从 ref 读取（而非闭包捕获值），消除 checkbox click 与 Delete keydown 之间的竞态条件。useEffect deps 移除 `selectedRowIds` 和 `cellRange`

### fix: 首次启动 seed mock 数据，后续启动不覆盖
- **commit**: `adec6bc`
- **改动点**: 服务器启动时检查表是否已存在，不重复 seed
- **详细说明**: `backend/src/index.ts` 中 `loadTable(mockTable)` 改为先调用 `getTable(mockTable.id)` 检查，已存在则跳过。解决每次部署/重启后用户数据被覆盖的问题

### feat: 右键单元格选区显示删除覆盖行
- **commit**: `bb4dae2`
- **改动点**: 在单元格选区范围内右键时，「删除记录」选项作用于选区覆盖的所有行
- **详细说明**: `handleRowContextMenu` 增加 `cellRange` 判断，收集选区内 `minRow ~ maxRow` 范围所有行 ID

### fix: 复选框 + Delete 键正常工作
- **commit**: `94512a6`
- **改动点**: 修复勾选复选框后 Delete 键不生效的问题
- **详细说明**: 键盘 handler 中 INPUT 标签检查改为 `target.type !== "checkbox"` 放行复选框。`handleRowCheckChange` 和 `handleHeaderCheckChange` 调用 `setCellRange(null)` 清除单元格选区

### feat: Delete 键删除选中行/清空选中单元格
- **commit**: `9017f85`
- **改动点**: Delete/Backspace 键行为——行选择态删除行（Safety Delete），单元格选择态清空单元格（无确认）
- **详细说明**: 键盘 handler 优先级：selectedRowIds > cellRange。行删除走 `onDeleteRecords`，单元格清空走 `onClearCells`

### fix: 单元格编辑和清空持久化到后端
- **commit**: `d6c7e4a`
- **改动点**: `handleCellChange` 和 `executeClearCells` 增加 `updateRecord` API 调用
- **详细说明**: 乐观更新后异步调用 `updateRecord(TABLE_ID, recordId, cells)`，解决编辑/清空后刷新数据丢失的问题

### feat: 单元格拖选、Delete 清空、双击编辑、Undo
- **commit**: `0dc091e`
- **改动点**: 完整的单元格交互体系
- **详细说明**:
  - `CellRange` 模型：mousedown 起点 → mousemove 4px 阈值拖选 → mouseup 确认
  - `<td>` 绑定 `data-row-idx` / `data-col-idx`，`elementFromPoint` 获取目标
  - 双击进编辑、单击已选中单元格再次点击进编辑（`wasAlreadySelected`）
  - `justCellDraggedRef` 防止拖选后误触编辑
  - UndoItem 新增 `"cellEdit"` 和 `"cellBatchClear"` 类型

### feat: Safety Delete 文档级持久化
- **commit**: `c0c3b04`
- **改动点**: 安全删除开关存储在 localStorage（key: `doc_delete_protection`），默认开启
- **详细说明**: TopBar 中 Toggle 控件绑定 `deleteProtection` 状态，写入时同步 localStorage

### feat: 多步撤销栈、批量字段操作、语音改进、Shift 选择
- **commit**: `eee19be` (via merge `484333b`)
- **改动点**: 完整的撤销系统 + 批量字段删除/恢复 + 语音 Grace Period + Shift+Click 行选择
- **详细说明**:
  - `undoStackRef` 栈最多 20 项，支持 records / fields / cellEdit / cellBatchClear 四种类型
  - 字段删除快照包含字段定义、单元格数据、视图配置、筛选条件
  - 语音停止后 800ms Grace Period 等待最后结果
  - Shift+Click 行选择范围

### feat: 记录删除与撤销 + 上下文菜单
- **commit**: `0fbac86`
- **改动点**: 右键行上下文菜单 + 记录删除 + Toolbar Undo 按钮
- **详细说明**: 右键菜单定位、删除确认、Toast Undo action

### feat: Toast 通知 + 精确日期选择器 + AI 筛选反馈
- **commit**: `9deaf77`
- **改动点**: Toast 组件系统、DatePicker 绝对日期、AI 筛选 loading/error 状态
- **详细说明**: `ToastProvider` + `useToast()` hook，Toast 支持 action 按钮

---

## 2026-04-13

### feat: 语音输入
- **commit**: `67b7548`, `0b079cd`
- **改动点**: AI 筛选输入支持语音输入（Web Speech API）
- **详细说明**: 麦克风按钮 + 长按空格 500ms 触发，zh-CN 识别，Grace Period 800ms

### feat: 字段配置面板
- **commit**: `e874f25`, `33af631`, `b2e1b4c`
- **改动点**: Customize Field 面板，支持拖拽排序、搜索（拼音）、隐藏/显示字段、点击定位
- **详细说明**: `FieldConfigPanel` + `pinyin-pro` 模糊搜索 + `scrollIntoView` 定位

### feat: 拼音模糊搜索 + Mock 数据扩展
- **commit**: `9995b9d`
- **改动点**: 筛选面板字段下拉支持拼音搜索，mock 数据扩展到更多字段

### feat: AI 筛选查询回显
- **commit**: `238e584`
- **改动点**: AI 生成完成后，查询文本保留在输入框中作为 placeholder

### fix: 视图设置跨重启保持
- **commit**: `f1856f2`
- **改动点**: fieldOrder、hiddenFields 持久化到后端，服务重启不丢失

### feat: Lookup 字段（Phase 0-2）
- **commit**: `4895195`, `5667e34`, `5cde1a8`
- **改动点**: Lookup 字段数据模型、计算引擎、前端配置 UI

### feat: PostgreSQL + Prisma 迁移
- **commit**: `312c043`
- **改动点**: 从内存存储迁移到 PostgreSQL + Prisma ORM
- **详细说明**: JSONB 存储 fields/views/cells，GIN 索引加速查询

### 初始提交
- **commit**: `e33c994`
- **改动点**: 项目初始化——AI Filter for Lark Base clone
- **详细说明**: Express 后端 + React 前端 + Volcano ARK API 集成，基础表格视图 + 筛选面板 + AI 筛选生成
