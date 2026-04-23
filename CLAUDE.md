# AI Filter - Claude Code Project Guide

## Project Overview
Lark Base (飞书多维表格) clone with AI smart filtering. Users can type natural language queries to generate table filter conditions via Volcano ARK API.

## Tech Stack
- **Frontend**: React + TypeScript + Vite (port 5173)
- **Backend**: Express + TypeScript + tsx (port 3001)
- **AI**: Volcano ARK Responses API (`/api/v3/responses`) with multi-turn tool calls
- **Deployment**: Server 163.7.1.94, Nginx reverse proxy, PM2 process manager

## Quick Start
```bash
# 1. Install dependencies
npm run install:all

# 2. Configure backend environment
cp backend/.env.example backend/.env
# Edit backend/.env and fill in ARK_API_KEY

# 3. Start development (backend + frontend concurrently)
npm run dev
```

## Key Commands
- `npm run dev` - Start both backend (3001) and frontend (5173) in dev mode
- `npm run dev:backend` - Start backend only
- `npm run dev:frontend` - Start frontend only
- `npm run build` - Build frontend for production
- `npm run start` - Start backend in production mode (serves built frontend)

## Project Structure
```
backend/
  src/
    index.ts          - Express server entry; boots ensureDefaults() + ensureDefaultAgent()
    mockData.ts       - Mock table data (fields, records)
    routes/
      tableRoutes.ts  - CRUD APIs for tables/fields/records/views
      aiRoutes.ts     - AI filter generation endpoint (SSE streaming)
      sseRoutes.ts    - Real-time sync SSE endpoints (table-level + document-level)
      chatRoutes.ts   - /api/chat/conversations + SSE message stream (Table Agent). SSE 事件支持 `tool_progress` / `tool_heartbeat`（Analyst P1 长任务协议，见 `services/longTaskService.ts`）。
      demoRoutes.ts   - /api/demos/* · Vibe Demo V1 owner-facing CRUD + file ops + build + publish。`POST /` 创建（id 走应用侧 `dm`+12位数字格式，见 services/idGenerator.ts）；`PUT /:id/file` 写文件到 ~/.imagebase/demos/<id>/files/；`PUT /:id/capabilities` 声明 dataTables/dataIdeas + capabilities JSON 白名单；`POST /:id/build` 跑 esbuild 打包 → dist/；`POST /:id/publish` 复制 dist → published/<N>/ + 生成 12 位 base62 slug；`GET /:id/preview/*` serve dist（供 iframe 预览，CSP 限制 connect-src 'self'）；`GET /:id/export` 流式打包 zip 供用户下载。
      demoRuntimeRoutes.ts - /api/demo-runtime/:demoId/* · Vibe Demo SDK 运行时接口（架构级切分：只有 7 种 Table 记录级 + 2 种 Idea 只读操作，schema 操作**没 handler 代码路径**）。所有 handler 经 `demoCapabilityGuard` 中间件（验 tableId/ideaId 在声明列表 + 操作在 capability 白名单 + 跨 workspace 隔离）。滑动窗口限流：读 200/min · 写 30/min · 日 100k/10k 兜底，key = `(demoId, ip, opFamily)`。`GET /:id/sdk.js` 根据当前 capabilities 动态生成 JS，window.ImageBase 只暴露声明过的方法。
      publicDemoRoutes.ts - /share/:slug/* · 公开匿名访问已发布 Demo 快照。读 Demo.publishSlug 解析 demoId + publishedVersion → serve published/<N>/。响应头 X-Robots-Tag: noindex + 5min cache。
      analystRoutes.ts - /api/analyst/* · AI 问数 (DuckDB) REST 代理。路径：`load-workspace-table`（首次调用自动生成 parquet 快照并以 `src_<tableId>` 视图挂载 DuckDB，同会话后续复用）；`describe`/`preview`/`filter`/`group-aggregate`/`pivot`/`join`/`time-bucket`/`top-n`；`run-sql`（只允许 SELECT / WITH / CREATE TABLE AS，AST 关键字黑名单阻断 DROP/DELETE/UPDATE/INSERT/ATTACH/COPY/PRAGMA/SET/EXPORT/IMPORT/ALTER 等）；`generate-chart`（vega-lite spec 生成器）；`propose-field-descriptions`（基于字段名 + 样本值的启发式数据字典推断）；`dictionary`（列出 workspace 字段字典）；`snapshots`（列 + purge）；`cache`（列 + purge，用于跨会话 parquet 结果复用）；`session/close`（删除 .duckdb 文件）；`handle/:handle/meta|rows`（写工具取 handle 完整数据）。领域函数：`finance/{irr,npv,wacc,cagr,volatility,sharpe,beta,max-drawdown}`、`accounting/{dupont,current-ratio,quick-ratio,debt-to-equity,margins}`、`internet/{dau-mau,funnel,cohort-retention,arpu}`。
      agentRoutes.ts  - /api/agents + identity (soul/profile/config) + Phase 4 runtime state (inbox list/ack, cron CRUD, heartbeat tail) + multi-model endpoints (`GET /models` workspace-wide list w/ availability, `GET|PUT /:agentId/model` selected-model read/write returning {selected, resolved, usedFallback})
      ideaRoutes.ts   - /api/ideas CRUD (Markdown doc artifact) + version-based optimistic save + `POST /:ideaId/write` anchor endpoint (Agent-scoped append/insert/replace-section) + transactional Mention diff on every content write and cascade on delete + `POST /:ideaId/stream/begin` and `POST /stream/:sessionId/end` (V2 streaming writes). PUT /content returns 423 when `isIdeaLocked(ideaId)` reports an active stream, so concurrent human saves can't clobber an in-flight Agent write.
      mentionRoutes.ts - /api/mentions/search — workspace-scoped fuzzy search over tables/fields/records/tastes/ideas/idea-sections for @mention picker; each hit carries `mentionUri` + `markdown` so Agent can splice a chip link directly
      mentionReverseRoutes.ts - /api/mentions/reverse?workspaceId&targetType&targetId — powered by the `Mention` table. Used by idea-delete UI to pre-fetch the "will become dead links" list and by chatAgentService.fetchIncomingRefsForConfirm to inject into the confirm SSE event
    services/
      aiService.ts          - Volcano ARK API integration, tool definitions, prompt
      chatAgentService.ts   - Chat Agent loop; three-layer System Prompt (Meta/Identity/Turn Context); resolves model once per turn via resolveModelForCall(), dispatches through resolveAdapter(model).stream()
      modelRegistry.ts      - Single source of truth for the 5-model whitelist (doubao-2.0, claude-opus-4.7/4.6, gpt-5.4, gpt-5.4-mini) + adapter dispatch + async availability probe (every 10 min). resolveModelForCall() falls back same-group → FALLBACK_MODEL_ID (doubao-2.0) without ever overwriting the user's saved preference — next turn auto-recovers when the preferred model comes back online. (`claude-sonnet-4.6` removed 2026-04-22 — unstable upstream whitelist; agents that saved it as their preference now resolve to an Opus sibling via same-group fallback.)
      providers/
        types.ts            - ProviderAdapter contract + canonical ProviderStreamEvent ({text_delta|thinking_delta|tool_call_done|done|error})
        arkAdapter.ts       - Volcano ARK Responses API (/api/v3/responses), used by doubao-2.0
        oneapiAdapter.ts    - OneAPI proxy. Branches on model.group: anthropic → /v1/messages (Anthropic-native, honors thinking:enabled with budget), openai → /v1/chat/completions (OpenAI-compatible, reasoning_content for GPT-5 native thinking). Note: this OneAPI channel strips thinking_delta text for Claude — adapter emits an empty thinking_delta marker when a thinking block opens so the "深度思考中…" UI indicator still fires.
        index.ts            - Registers adapters via registerProviderAdapter at module load (side-effect import)
      agentService.ts       - Agent filesystem I/O (~/.imagebase/agents/<id>/) + Prisma Agent CRUD + Phase 4 state/ helpers (heartbeat.log, inbox.jsonl, cron.json) + getSelectedModel/setSelectedModel (with LEGACY_MODEL_ALIASES for seed2.0-pro → doubao-2.0)
      runtimeService.ts     - Phase 4 heartbeat loop: ticks every RUNTIME_HEARTBEAT_MS (default 5min), fans out to per-agent onTick handler, appends to state/heartbeat.log
      cronScheduler.ts      - Phase 4 Day 2 cron parser + evaluator: 5-field + @aliases, Vixie OR day semantics, evaluateCron appends InboxMessage{source:"cron"} and bumps lastFiredAt; CRUD helpers addCronJob/removeCronJob/listCronJobs (validate before write)
      conversationStore.ts  - Prisma-backed Conversation+Message store (agentId FK)
      mentionIndex.ts       - Parses `[label](mention://type/id?…)` links out of Markdown content, skipping fenced code. Builds dedup-keyed `MentionRow[]` (uses composite `<ideaId>#<slug>` key for idea-sections). Writers call `buildMentionRows()` → overwrite Mention rows for that source inside a Prisma `$transaction`.
      ideaWriteService.ts   - `applyIdeaWrite(currentContent, anchor, payload) → {content, description, range}`. Anchor is `oneOf: {position: "end"|"start"} | {section: slug, mode: "append"|"prepend"|"replace"}`. HTML-aware — skips past open fenced code or unclosed block-level HTML (div, section, article, etc.) before splicing. Throws a structured error listing available section slugs when the anchor is unknown so the Agent can retry.
      tasteMetaService.ts   - AI 设计风格 meta 生成（主色/字体/间距/tags/description 等结构化字段）。每次 Taste 创建时 `enqueueMetaGeneration(tasteId)` fire-and-forget 入队，最多 3 并发 + 指数退避。用 `resolveModelForCall(agentId)` 拿 Agent 当前选中的模型 → `resolveAdapter(model).stream()` 消费成 JSON → `tasteMetaSchema.parse` 校验 → 落库 + 发 `taste:meta-updated` SSE。Prompt 按 `.claude/skills/ai-prompt-patterns.md` 的 6 段式。日志 `backend/logs/taste-meta-YYYY-MM-DD.log`。
      autoLayoutService.ts  - 画布自动排版工具：`computeGridLayout(tastes)` 按 Y 聚类成行 → 行内左右等距对齐 + 行间统一间距；`findEmptyPosition(existing, size)` 为新 taste 找不重叠落点。前后端共用同一套算法，backend 是 canonical 版（由 MCP `auto_layout_design` + REST `POST /api/designs/:id/auto-layout` 调用），frontend 为交互 latency 暂保留副本。
      longTaskService.ts    - Chatbot 基建：`LongTaskTracker` 包装每个工具调用的 start/progress/heartbeat/timeout 状态机。Agent 循环每次调用 `beginTool` 建立上下文，`ToolContext.progress()` 的回调把 ProgressPayload 推到共享队列 → 透传为 `tool_progress` SSE 事件；15s 静默自动合成 `tool_heartbeat` 保活 nginx / 浏览器 SSE 连接；180s 无进展触发 AbortController + TOOL_TIMEOUT。任何慢工具（analyst snapshot、大批量 record create、外部 API 调用等）均可受益。
      analyst/
        duckdbRuntime.ts    - 每个 conversation 一个 DuckDB 会话文件 `~/.imagebase/analyst/sessions/conv_<id>.duckdb`。核心 API：`getOrCreateSession` / `attachSnapshot`（挂载 parquet 为 `src_<tableId>` 只读视图）/ `createResult`（将 SQL 结果持久化为 `r_<handle>` 表 + 写 `_result_meta` 注册表）/ `resolveHandle` / `previewResult` / `describeResult`（DuckDB `approx_quantile` + `COUNT DISTINCT` + top-K，纯聚合无抽样）。`assertSafeSql` 做 AST 级白名单（仅 SELECT / WITH / CREATE TABLE AS）。所有查询经 session-scoped Promise queue 串行化避免 DuckDB Node binding 的并发问题。BigInt / Date / 内部类型在返回前自动 normalize 成 JSON 安全值。
        snapshotService.ts  - Parquet 快照：`createSnapshot(tableId)` 流式读 Prisma → 建内存 DuckDB → 批量 INSERT → `COPY TO parquet (FORMAT PARQUET, COMPRESSION ZSTD)`。字段类型映射：Number/Currency/Progress/Rating/AutoNumber → DOUBLE；Checkbox → BOOLEAN；DateTime/Created/Modified → TIMESTAMP；MultiSelect/User/Group（数组）→ JSON 字符串；其余 → VARCHAR。`resolveSnapshot(tableId, snapshotAt?)` 精准定位或取最新。`listSnapshots` / `purgeOldSnapshots(olderThanMs)` 用于 cleanupCron。
        resultCache.ts      - 跨会话结果复用：`buildCacheKey(canonicalSql, sourceSnapshotAts)` 生成 SHA-256 key；`hasCacheHit` / `cachePath` / `putCache` / `purgeCache`；命中直接 `COPY FROM parquet`，未命中再运行 group_aggregate。天然 invalidation——源快照换则 key 不同。
        domainFunctions.ts  - 纯函数库：`irr`（bisection 求根）、`npv` / `wacc` / `cagr` / `stddev` / `volatility` / `sharpe` / `beta` / `maxDrawdown`（P4c 金融）；`dupontAnalysis` / `currentRatio` / `quickRatio` / `debtToEquity` / `grossMargin` / `operatingMargin` / `netMargin`（P4b 财务）；`dauMau` / `funnelConversion`（阶段严格单调）/ `cohortRetention`（支持 day/week/month 粒度）/ `arpu`（P4a 互联网）。所有函数输入合法性自检，边界情况返回 NaN。
        cleanupCron.ts      - 每 30 min 扫：1) idle > 2h 的 session `closeSession`；2) > 7 天的 `.duckdb` 文件清除；3) > 30 天的 snapshot parquet purge；4) > 30 天的 cache parquet purge。`RUNTIME_DISABLED=1` 禁用。
      dataStore.ts          - In-memory data store, AI tool functions
      eventBus.ts           - Event bus for real-time sync (table-level + document-level)
      filterEngine.ts       - Client-side filter evaluation
    schemas/            - Shared Zod schemas (REST + MCP single source of truth)
    scripts/            - Dev helpers (phase1-meta-smoke.ts, phase1-registry-check.ts, phase2-memory-smoke.ts, phase3-skills-smoke.ts, phase4-runtime-smoke.ts)
  mcp-server/
    src/tools/
      metaTools.ts        - Tier 0 identity: update_profile / update_soul / create_memory (write-only)
      memoryTools.ts      - Tier 0 memory (Phase 2): read_memory (list/load) + recall_memory (keyword+tag+recency ranked)
      skillRouterTools.ts - Tier 0 skill routing (Phase 3): find_skill / activate_skill / deactivate_skill
      cronTools.ts        - Tier 0 cron meta-tools (Phase 4 Day 3): schedule_task / list_scheduled_tasks / cancel_task — Agent self-registers recurring work into cron.json, heartbeat fires them
      tableTools.ts       - Table CRUD tools (list/get are Tier 1; write ops live in table-skill)
      fieldTools.ts       - Field CRUD tools (bundled into table-skill)
      recordTools.ts      - Record CRUD tools (bundled into table-skill)
      viewTools.ts        - View CRUD tools (bundled into table-skill)
      ideaTools.ts        - Idea tools split into `ideaNavTools` (Tier 1: list_ideas/get_idea) + `ideaWriteTools` (Tier 2: create_idea/rename_idea/delete_idea⚠️/append_to_idea/insert_into_idea/replace_idea_content⚠️) + `ideaStreamTools` (Tier 2: begin_idea_stream_write/end_idea_stream_write — V2 streaming write bracket). Write tools accept an `anchor` object (oneOf position / section+mode) so the Agent can splice into a specific `## Heading` section without rewriting the whole doc.
      dictionaryTools.ts  - Tier 1 analyst nav: `get_data_dictionary` (列字段 + type + description + options) / `list_snapshots` (哪些表快照可复用). Agent 每次分析前先查字典做字段消歧义。
      demoTools.ts        - Vibe Demo V1 工具：`demoNavTools` (Tier 1: list_demos / get_demo) + `demoWriteTools` (Tier 2: create_demo / rename_demo / delete_demo⚠️ / list_demo_files / read_demo_file / write_demo_file / delete_demo_file⚠️ / update_demo_capabilities / build_demo / publish_demo⚠️ / unpublish_demo). 所有 write/build/publish 操作通过 HTTP 代理到 /api/demos/* 主 backend。
      analystTools.ts     - analyst-skill 核心 11 工具 (Tier 2): `load_workspace_table` (snapshot 生成 + parquet 挂载 + handle 创建)、`describe_result` (纯聚合描述，带 top-K)、`preview_result`、`filter_result` (SQL WHERE)、`group_aggregate` (count/sum/avg/min/max/count_distinct/median/stddev)、`pivot_result` (DuckDB 原生 PIVOT)、`join_results` (inner/left/right/full)、`time_bucket` (day/week/month/quarter/year)、`top_n`、`run_sql` (兜底 AST 白名单)、`generate_chart` (vega-lite spec)、`propose_field_descriptions` (启发式字典推断)。所有返回 `{_resultHandle, meta, preview}` 三元组。
      analystWriteTools.ts - 物化出口: `write_analysis_to_idea` (高频：创建 / 追加 Idea，含分析叙述 + Markdown 表 + 可选 vega-lite 图表代码块 + 时点声明) / `write_analysis_to_table` (低频：转为 workspace 数据表，硬限 50000 行；超限建议走 idea). 
      domainInternetTools.ts / domainAccountingTools.ts / domainFinanceTools.ts - P4 领域 skill 的 MCP 工具。互联网：dau_mau / funnel_conversion / cohort_retention / arpu_arppu（读 DuckDB handle 的行 → 纯函数计算）。财务：dupont_analysis / current_ratio / quick_ratio / debt_to_equity / profit_margins（数值输入）。金融：irr / npv / wacc / cagr / volatility / sharpe_ratio / beta / max_drawdown（数值输入）。
      mentionTools.ts     - Tier 1 cross-skill mention tools: `find_mentionable` (workspace+q → typed hits with pre-built `mentionUri` + `markdown`) + `list_incoming_mentions` (reverse-ref lookup for "what points at this?"). Always available — Agent uses these to build `@` links inside idea content without activating a skill.
      designTools.ts      - `designNavTools` (Tier 1: list_designs) + `designWriteTools` (Tier 2 in taste-skill: create_design / rename_design / delete_design⚠️ / auto_layout_design).
      tasteTools.ts       - `tasteNavTools` (Tier 1: list_tastes / get_taste with optional includeMeta + includeSvg) + `tasteWriteTools` (Tier 2 in taste-skill: create_taste_from_svg / rename_taste / update_taste / batch_update_tastes / delete_taste⚠️).
      index.ts            - Tier partitioning: tier0Tools / tier1Tools / resolveActiveTools(activeSkillNames). Tier 1 now includes `list_tables`, `get_table`, `list_ideas`, `get_idea`, `list_designs`, `list_tastes`, `get_taste`, `find_mentionable`, `list_incoming_mentions`, `get_data_dictionary`, `list_snapshots` (后两个是 Analyst P1 新增的 workspace 字段字典和 DuckDB 快照查询).
    src/skills/
      types.ts         - SkillDefinition (name / when / triggers / tools). Analyst P1 扩展：新增可选 `softDeps: string[]`（当此 skill 激活时，这些依赖 skill 的 `lastUsedTurn` 被自动续期，避免 10 轮 idle 驱逐；非传递）+ `promptFragment?: string`（激活时注入系统 prompt 的专属规则 / 术语段，供 analyst / 领域 skill 声明结果截断规则 / 字段消歧义 / 行业术语等）。
      tableSkill.ts    - Bundles field + record + view + table-write tools; triggers on 创建/删除/修改字段等
      ideaSkill.ts     - Bundles `ideaWriteTools` only (nav tools are Tier 1); triggers on 写/新增/追加/插入/替换 × 灵感/文档/idea/章节 in ZH + EN equivalents.
      tasteSkill.ts    - Bundles `designWriteTools` + `tasteWriteTools` (画布容器 + SVG 图片写入，9 个 tools). Tier 1 nav split out to index.ts. Triggers on 新建/删除/改名/移动/对齐/排版 × 画布/SVG/design/taste/canvas. 术语对齐：代码中的 "Design" = 产品语境 "Taste"（容器），代码中的 "Taste" = 产品语境 "Node"（SVG 图片），未来会统一重命名（见 docs/taste-chatbot-plan.md 术语对齐章节）。
      demoSkill.ts     - Vibe Demo 底层工具 skill (V1)。提供 `demoWriteTools` 工具集 + 基础 promptFragment（模板选择 / SDK 用法 / build retry 规则）。softDeps: [table-skill, analyst-skill]。
      vibeDesignSkill.ts - Vibe Design 视觉侧 overlay (V1)。无新工具，仅 promptFragment（吸纳 Anthropic frontend-design SKILL 的五大着力点 + 反例清单 + "Brutalist / retro / editorial" 极端方向选择 + 阶段化工作流：先提 3-4 方向 → 用户选 → 产 token → 移交 coding）。softDeps: [demo-skill, taste-skill]。
      vibeCodingSkill.ts - Vibe Coding 逻辑侧 overlay (V1)。无新工具，仅 promptFragment（等 design 阶段完成 / React+TS+Tailwind 栈规范 / CRUD 代码模式 / SDK try/catch 硬规则）。softDeps: [demo-skill, table-skill, analyst-skill]。
      analystSkill.ts  - AI 问数核心 skill (P2)。Bundles `analystTools` (11) + `analystWriteTools` (2)；`softDeps: ["idea-skill", "table-skill"]` 让分析过程末尾可以顺滑写入文档 / 新表而不会被 idle 驱逐；promptFragment 声明结果截断规则（≤100 行内联，>100 行前 20 行 + 声明真实行数 + 引导对话物化）+ 严格字段消歧义（字段名重复时必须反问用户或读 description）+ 快照时点声明。Triggers: 分析/统计/聚合/汇总/透视/排名/同比环比/趋势/top N/分布 等中英关键词。
      internetAnalystSkill.ts / accountingAnalystSkill.ts / financeAnalystSkill.ts - 三个 P4 领域 skill，每个 `softDeps: ["analyst-skill"]`（领域 skill 激活时保活 analyst-skill，反之不成立）。互联网：DAU/MAU/cohort/funnel/ARPU 术语 + 4 工具。财务：三张报表 / 杜邦 / 流动速动比 + 5 工具。金融：NPV/IRR/WACC/夏普/Beta/波动率/回撤 + 8 工具。计算层纯函数 (`domainFunctions.ts`)，术语 / 框架 / 判断走 promptFragment。
      index.ts         - allSkills / skillsByName registries (7 skills as of Analyst P4)
frontend/
  src/
    App.tsx           - Main app, multi-table state management, field order lifting
    api.ts            - API client functions (with CLIENT_ID + mutationFetch)
    hooks/
      useTableSync.ts   - Table-level SSE subscription hook for real-time data sync
      useDocumentSync.ts - Document-level SSE hook for sidebar table list sync
      useIdeaSync.ts    - Per-idea SSE hook (content + rename events) for Markdown editor live sync
      useDesignSync.ts  - Per-design SSE hook (subscribes to workspace channel, filters by designId). Feeds taste:create/update/delete/meta-updated + design:rename/delete/auto-layout into SvgCanvas so Agent-driven changes reflow live.
    i18n/
      en.ts           - English translations (130+ keys)
      zh.ts           - Chinese translations (130+ keys)
      index.ts        - LanguageProvider, useTranslation hook, t() function
    components/
      FilterPanel/          - AI filter input + manual filter conditions UI
      TableView/            - Main table grid with drag-reorder, resize, edit
      ChatSidebar/          - Right-side drawer for Table Agent; header carries ChatModelPicker pill (current model label + chevron → grouped DropdownMenu across Anthropic/OpenAI/Volcano families, ✓ selected, `offline` for unavailable, disabled mid-turn). No other identity surface in Phase 1.
      IdeaEditor/           - Markdown doc artifact (Cmd/Ctrl+/ source↔preview toggle, 60px L/R padding, debounced autosave, @mention picker, mention:// chip rendering)
      AgentIdentityModal/   - Dormant in Phase 1 (not imported anywhere); preserved for Phase 2+ when a user-facing identity editor may return
      Sidebar.tsx           - Sidebar with dynamic table list, drag-reorder, resize, create/delete
      DropdownMenu.tsx      - Generic dropdown menu with section grouping, noop items
      Toolbar.tsx           - Toolbar with filter button
    services/
      filterEngine.ts - Client-side filter matching
```

## Architecture Notes
- Data is in-memory (mockData.ts), not persisted. Server restart resets data.
- Frontend Vite dev server proxies `/api` requests to backend on port 3001.
- TableView maintains column order in localStorage (`field_order_v1`), lifted to App.tsx via `onFieldOrderChange` callback so FilterPanel dropdown matches table column order.
- AI filter uses PRD format (`["field", "operator", value]`) internally, converted to/from app's internal filter format.
- AI service logs all API calls, tool calls, and timing to `backend/logs/` directory with GMT+8 timestamps.
- **Chat Agent identity (Phase 1)**: every user owns at least one `Agent` row (default seeded as `agent_default` / name "Claw"). Identity files live on the filesystem at `~/.imagebase/agents/<agentId>/` (`soul.md`, `profile.md`, `config.json`, plus `memory/`, `skills/`, `mcp-servers/`, `plugins/`, `state/`). The DB only stores metadata. Override the root with `AGENT_HOME` env var for tests.
- **Three-layer System Prompt**: chatAgentService composes `META` (hardcoded meta-behavior rules, immutable) → `Identity` (live soul.md + profile.md) → `Tier 1 Core MCP` (tool guidance) → `Turn Context` (workspace schema snapshot + auto-recalled memories). Agent self-edits via three Tier 0 meta-tools: `update_profile`, `update_soul`, `create_memory`.
- **Agent memory (Phase 2)**: two Tier 0 read tools complement the Phase 1 write tool. `read_memory` lists recent episodic memories (newest first) or loads one by filename. `recall_memory` ranks by `3·keyword + 2·tag + 1·recency` (half-life ≈ 10 days) and returns top-K. Every chat turn auto-runs `recallMemories(userMessage, limit=3)` and injects hits into Layer 3 Turn Context, so Agent sees relevant history without having to explicitly call. Completed turns are appended to `memory/working.jsonl`; once 10 turns accumulate, the next turn fires a deterministic compression that folds them into one episodic `.md` (tagged `working-memory-compaction`) and truncates the working log. Compression runs fire-and-forget so the user's `done` event isn't delayed.
- **ToolContext** (`backend/mcp-server/src/tools/index.ts`): tool handlers accept an optional second arg. Phase 1 used `{agentId}`; Phase 3 extends it to `{agentId, activeSkills, onActivateSkill, onDeactivateSkill}`. The agent loop injects it so meta-tools know whose filesystem to touch and skill-router tools can mutate activation state. Data-plane tools ignore everything they don't need — fully backward compatible.
- **Tier 2 skills (Phase 3)**: Tools are now partitioned into four tiers (plan in `docs/chatbot-openclaw-plan.md` §4). Tier 0 = identity + memory + skill routing (always on, ~8 tools). Tier 1 = `list_tables` + `get_table` (workspace nav, always on). Tier 2 = opt-in skills registered as `SkillDefinition` objects under `mcp-server/src/skills/`. Today that's just `table-skill` (field/record/view/table-write = 19 tools). Per-conversation `skillStateByConv` in chatAgentService tracks active skills + `lastUsedTurn`; the chat loop calls `resolveActiveTools([...active])` every round so the model only sees the tools it needs. Activation happens two ways: (a) auto-match against `skill.triggers` before the first ARK call, (b) explicit `activate_skill` by the model. Skills idle for 10 turns are evicted end-of-turn. The system prompt now includes a compact skill catalog (name / when / tool count, ✅ for already-active) between Layer 2 and Tool Guidance so the model can discover bundles without a `find_skill` round trip.
- **Runtime heartbeat (Phase 4 Day 1)**: `runtimeService.startHeartbeat()` runs an in-process `setInterval` (default 5 min, override via `RUNTIME_HEARTBEAT_MS`; disable via `RUNTIME_DISABLED=1`). Each tick calls `listAllAgents()` and fans out to a per-agent `onTick(ctx)` handler, appending one `HeartbeatLogEntry` to `<agentDir>/state/heartbeat.log` per agent. The loop has per-agent error isolation via try/catch, a re-entrancy guard that skips overlapping ticks, and an `unref()`-ed timer so it doesn't hold the event loop open on its own. `ensureAgentFiles()` also bootstraps `state/heartbeat.log`, `state/inbox.jsonl`, and `state/cron.json` (`{ jobs: [] }`). `index.ts` wires a SIGINT/SIGTERM handler that awaits `stopHeartbeat()` so we don't corrupt heartbeat.log on PM2 reloads.
- **Cron scheduler (Phase 4 Day 2)**: `cronScheduler.ts` provides a zero-dep cron parser (5-field `minute hour dom month dow` + `@hourly / @daily / @weekly / @monthly / @yearly` aliases, with Vixie-cron day OR semantics when both dom and dow are restricted). `parseCron()` returns `null` on malformed input (never throws), `nextFireAfter(parsed, from)` steps strictly forward up to 2 years. `evaluateCron(agentId, now)` is the heartbeat's workhorse: baseline = `lastFiredAt ?? now-1h` prevents back-firing a brand-new job; each due job fires exactly once per call, appends one `InboxMessage{source:"cron", meta:{cronJobId, schedule, workspaceId?, skills?}}` and bumps `lastFiredAt`. `index.ts` wires `evaluateCron` as the heartbeat's `onTick`, and the entry's `details.cronFired` lists which jobs triggered. CRUD helpers `addCronJob / removeCronJob / listCronJobs` validate the schedule before writing.
- **Idea (灵感) artifact**: Third workspace entity alongside Table and Design/Taste. Prisma `Idea` model with `version: Int` for last-writer-wins optimistic concurrency. Routes: `POST/GET/PATCH/DELETE /api/ideas` + `PUT /api/ideas/:id/content` (rejects stale `baseVersion` with `{conflict:true, latest}` — no 409 to keep SSE flow simple) + `POST /api/ideas/:id/write` anchor endpoint for Agent-scoped insert/append/replace. Content is raw Markdown persisted as text. Frontend `IdeaEditor` does debounced (600ms) autosave, `Cmd/Ctrl+/` toggles source ↔ preview (`react-markdown` + `remark-gfm` + `rehype-raw` + `rehype-sanitize` with extended schema allowing inline SVG and the `mention://` URL scheme). Mentions are encoded as ordinary Markdown links `[@label](mention://type/id?table=...&design=...)` — the parser pattern-matches the scheme in `components.a` and swaps the anchor for a `<button class="idea-mention-chip">`. Workspace SSE carries `idea:create/rename/delete/reorder` events; per-idea SSE (`/api/sync/ideas/:id/events`) carries `content` + `rename`. Mention search endpoint scopes by `workspaceId` and ranks tables → fields → records → tastes → ideas → idea-sections; each hit carries `mentionUri` + `markdown` so Agent splicing is zero-logic. `@` in the textarea opens `MentionPicker` positioned at caret with document-level keydown capture so the textarea keeps focus. `focusEntity` state in `App.tsx` routes mention-chip clicks to the target artifact; consumption in TableView/SvgCanvas (scroll-to + highlight) is deferred P1.
- **Mention reverse index + 2-step delete confirm**: Mentions inside idea content are persisted to a dedicated `Mention` Prisma model (composite PK `sourceType+sourceId+targetType+targetId+targetKey`) indexed by `(workspaceId, targetType, targetId)` for reverse lookup. Content writes (`PUT /api/ideas/:id/content` and `POST /api/ideas/:id/write`) run inside a Prisma `$transaction`: update content → `deleteMany({sourceType, sourceId})` → `createMany(buildMentionRows(content))`. `DELETE /api/ideas/:id` cascades mention rows on both sides (source = this idea AND target = this idea, plus `target startsWith ${id}#` to sweep idea-section composite keys). Idea-section targets use a composite `<ideaId>#<slug>` key so heading-renames / deletes don't orphan references. Delete UX: `handleDeleteItem` for `type==="idea"` in `frontend/src/App.tsx` opens a references-aware `ConfirmDialog` that pre-fetches `fetchIncomingMentions(workspaceId, "idea", id)` and renders `sourceLabel` + `contextExcerpt` rows so the user sees the blast radius before committing. The chat Agent's confirm event for `delete_idea` follows the same pattern: `chatAgentService.fetchIncomingRefsForConfirm()` pre-fetches refs server-side and embeds `incomingRefs` in the `confirm` SSE event; `ConfirmCard` renders them without an FE round trip.
- **Idea streaming writes (V2)**: Long-form Agent writes run through a `begin_idea_stream_write` / `end_idea_stream_write` bracket instead of a single monolithic `append_to_idea` call. `ideaStreamSessionService.ts` owns an in-memory Map of `IdeaStreamSession` entries (keyed by `sessionId`, indexed by `ideaId` and `conversationId` for fast sweep). `begin(input)` versions-checks the idea, evicts any prior session on the same idea ("last begin wins"), computes an absolute character `startOffset` for the requested anchor (HTML + fenced-code aware, via `computeStartOffset`), records a 2-min idle timer (`unref()`-ed), and broadcasts `idea:stream-begin` on the per-idea SSE channel. `chatAgentService` intercepts subsequent `text_delta` events from the model and calls `ideaStream.pushDelta(sessionId, delta)` — deltas are buffered + broadcast as `idea:stream-delta` for live editor preview. The MCP tool result carries a `_stream: {mode: "begin"|"end", sessionId}` marker so chatAgentService can detect begin/end without hard-coding tool names; on begin it calls `attachConversation(sessionId, conversationId)` to wire up the abort sweep. `finalize({commit:true})` runs the same transactional pipeline as `POST /write` (applyIdeaWrite → deleteMany mentions → createMany mentions → version++) inside a Prisma `$transaction`, then broadcasts `idea:stream-finalize` with the authoritative content + new version so the editor overwrites its naive local splice. `{commit:false}` discards (broadcasts with `discarded:true`, FE rolls back to the pre-stream snapshot). Safety nets: 2-min idle auto-abort, `PUT /api/ideas/:id/content` returns 423 when `isIdeaLocked(ideaId)` is truthy, chatAgentService `abort(activeStreamSessionId, "turn-ended-without-end-call")` on natural turn-end and `abort(..., "confirmation-pause")` when danger-tool confirmation pauses the loop. FE `IdeaEditor` adds `streaming` state + three refs (`streamBaseRef` / `streamStartOffsetRef` / `streamBufferRef`) and subscribes to the three new SSE events via `useIdeaSync`'s `onStreamBegin / onStreamDelta / onStreamFinalize`; `scheduleSave()` early-returns while `streamSessionIdRef.current` is set so autosave can't fire against a locked doc.
- **Multi-model provider dispatch**: The chat agent routes each turn through the adapter resolved from the selected model's `provider` field (`modelRegistry.resolveAdapter(model)`). Two adapters today: `arkAdapter` (Volcano ARK Responses API for `doubao-2.0`) and `oneapiAdapter` which itself branches on `model.group` — anthropic → OneAPI's Anthropic-native `/v1/messages` (honors `thinking:{type:"enabled", budget_tokens}`, temperature forced to 1.0), openai → OneAPI's OpenAI-compatible `/v1/chat/completions` (surfaces GPT-5's `reasoning_content` delta as thinking). Users pick a model from the chat header pill (`ChatModelPicker`); selection persists to `~/.imagebase/agents/<id>/config.json` via `setSelectedModel()`. `resolveModelForCall(agentId)` returns `{requested, resolved, usedFallback}` — unavailable models fall back same-group → `FALLBACK_MODEL_ID` (doubao-2.0) without overwriting the saved preference, so the next turn auto-recovers when the preferred model comes back online. A 10-min in-process probe (`startModelProbe()`, gated on `RUNTIME_DISABLED`) refreshes `available` by pinging OneAPI's `/v1/models` and checking `ARK_API_KEY`. Two known OneAPI-Claude quirks live in `oneapiAdapter.ts`: (1) the channel strips `thinking_delta` text before forwarding — adapter emits an empty `thinking_delta` marker when a thinking block opens so the "深度思考中…" UI indicator still fires; (2) the channel runs Claude through the Claude Code SDK which injects its own ~2000-token "You are Claude Code…" system prompt that **overrides anything in the `system` field** (verified with direct curl: `system="your name is Claw"` → Claude still introduces itself as Claude Code). Workaround: `streamAnthropic` never sets `body.system`; instead it prepends a two-message bootstrap (`user: "<持久系统指令>…</持久系统指令>"` + `assistant: "明白，我会严格遵循以上系统指令。"`) before the real messages. OneAPI does not rewrite message content, so the identity / soul / profile / tool guidance survives end-to-end. Same workaround is NOT needed for the OpenAI branch (GPT-5 honors the `system` role normally).
- **Runtime REST + agent cron self-registration (Phase 4 Day 3)**: `agentRoutes.ts` exposes the runtime state surface: `GET /api/agents/:id/inbox[?unread=1&limit=N]` → `{messages, unreadCount}`, `POST /inbox/:msgId/ack` flips unread→read (atomic rewrite via `.tmp + rename`), `GET/POST/DELETE /cron`, `GET /heartbeat?tail=N`. Three Tier 0 MCP tools (`schedule_task`, `list_scheduled_tasks`, `cancel_task` in `cronTools.ts`) let the Agent self-register recurring work — the chat loop now sees these by default. Frontend: `TopBar.tsx` renders a small red badge on the four-pointed-star button; `App.tsx` polls `/api/agents/agent_default/inbox?unread=1&limit=1` every 30s and also refetches on chat open/close transitions. Badge truncates to `9+`.
- **Analyst (AI 问数) pipeline**: DuckDB-backed compute engine for data analysis questions. See `docs/analyst-skill-plan.md` for architecture rationale (混合路线：快捷工具 + SQL 兜底，确定性计算下沉到 DuckDB，LLM 只负责意图理解 + 结论表达). Session lifecycle: first `load_workspace_table(tableId)` creates a Parquet snapshot under `~/.imagebase/analyst/snapshots/` and attaches it as `src_<tableId>` read-only view in a per-conversation `.duckdb` file under `sessions/`. Every subsequent analyst tool `createResult`s a new `r_<handle>` table with meta in `_result_meta`; the handle round-trips through `tool_result._resultHandle` so the Agent can chain — e.g. load → filter → group_aggregate → top_n → write_analysis_to_idea — with each step only responsible for one SQL. Snapshot reuse within a conversation is automatic; user explicit "基于最新数据重新分析" → `{refresh:true}` forces a new snapshot. Concurrency across sessions is fully parallel; same-session queries serialize via a Promise queue (DuckDB Node binding isn't thread-safe). Chat UX: `analyst-skill`'s `promptFragment` enforces truncation rules (≤100 行内联，>100 行预览 + 强制声明真实行数 + 引导对话物化) and strict field disambiguation (ambiguous候选字段必须反问用户). Write out-gates: `write_analysis_to_idea` is the high-frequency path (creates/appends Markdown doc with narrative + table + optional vega-lite code blocks); `write_analysis_to_table` is low-frequency (hard-capped at 50k rows). Charts: `generate_chart` produces a vega-lite spec; the FE dynamically imports `vega-embed` (~800KB gzipped split into its own chunk) so messages without charts don't pay the cost. Domain skills layer: `internet-analyst-skill` (DAU/MAU, cohort retention, funnel, ARPU), `accounting-analyst-skill` (DuPont, current/quick ratio, debt-to-equity, margins), `finance-analyst-skill` (IRR, NPV, WACC, CAGR, volatility, Sharpe, Beta, max drawdown) — all declare `softDeps: ["analyst-skill"]` so activating any domain skill protects the base analyst from idle eviction. Domain computation is pure functions in `services/analyst/domainFunctions.ts`; domain knowledge (terminology, frameworks, healthy-ratio norms) lives in each skill's `promptFragment`. Cross-conversation `resultCache.ts` (keyed by SHA-256 of canonical SQL + source snapshot timestamps) enables reuse across users / sessions; `cleanupCron.ts` purges stale sessions (idle > 2h → close), files (> 7d → delete), snapshots + cache parquet (> 30d → unlink) every 30 minutes.
- **Long-task SSE keepalive protocol**: Chatbot-wide infrastructure that future-proofs any slow tool (not just Analyst). `LongTaskTracker` wraps each tool call with a progress/heartbeat/timeout state machine; tool handlers emit progress via `ctx.progress?.({phase, message, progress?, current?, total?})` which the agent loop forwards as `tool_progress` SSE events. 15s silence auto-synthesizes `tool_heartbeat` (keeps nginx + browser SSE alive); 180s without response triggers AbortController and yields a `TOOL_TIMEOUT` error. Frontend `ToolCallCard` renders a progress bar + elapsed timer below the header while status is `running`. Nginx `/api/chat/` location already has `proxy_buffering off` + `proxy_read_timeout 600s` so the protocol requires no server config changes.
- **Vibe Demo V1 pipeline**: generate + build + preview + publish a runnable frontend Demo (fourth artifact type alongside Table/Idea/Design). See `docs/vibe-demo-plan.md`. Key architecture:
  - **Prisma `Demo` model** (id format `dm` + 12 digits via `services/idGenerator.ts`, see `docs/vibe-demo-plan.md §3.5`) holds metadata + `dataTables[]` / `dataIdeas[]` / `capabilities` JSON. File content lives on filesystem at `~/.imagebase/demos/<demoId>/{files,dist,published}/` — not in DB.
  - **Build** = esbuild Node API (same module vite uses). Two templates: `static` (HTML copy + bundle JS if any) and `react-spa` (TSX → `dist/bundle.js`, React+ReactDOM from esm.sh via importmap, Tailwind via CDN `<script>`). Output `dist/index.html` + `dist/bundle.js` + `dist/sdk.js` + static assets. 30s hard timeout, per-demo build lock.
  - **window.ImageBase SDK** is generated per-Demo at build time based on `capabilities`. Methods not declared **don't exist on the object** — devtools attacker can't call `ImageBase.deleteRecord(...)` unless the Demo metadata declared `deleteRecord` for the target tableId. Two layers of defence: (1) `/api/demo-runtime/:demoId/*` namespace only has 7 Table record-level + 2 Idea read-only handlers; schema operations (createTable / createField / etc.) **don't have code paths** → 404 not 403. (2) `demoCapabilityGuard` middleware (in `services/demo/demoCapabilityGuard.ts`) rejects requests whose `tableId/ideaId` isn't in the Demo's declared list OR whose operation isn't in the per-resource capability array.
  - **Rate limit** per `(demoId, IP, opFamily)`: read 200/min + 100k/day, write 30/min + 10k/day. 429 + `Retry-After` when exceeded. In-memory sliding window; swap to Redis when multi-replica.
  - **Publishing**: `POST /api/demos/:id/publish` copies `dist/` → `published/<N>/`, allocates 12-char base62 slug (distinct from internal 12-digit IDs — slug targets anti-enumeration, IDs target readability). `/share/:slug/*` serves the snapshot anonymously with `X-Robots-Tag: noindex` + 5min cache. Unpublish clears the slug — re-publish generates a NEW slug (old permanently invalid).
  - **Skills** (three, under `mcp-server/src/skills/`): `demo-skill` (the toolset, always activates on Demo-related intent), `vibe-design-skill` (visual / aesthetic overlay, fires only on explicit design intent keywords), `vibe-coding-skill` (functional implementation overlay). Phased workflow via prompt: when both design + coding active, design skill leads (提方向 → 定 token), says "设计定稿，交给 coding 阶段实现", then coding skill reads tokens and writes code. Pure-functional requests ("搭个 CRM") skip design stage entirely.
  - **URL routing** was introduced in V1 as technical debt payoff: the whole FE now uses React Router with readable paths `/workspace/:wsId/{table,idea,design,demo,conversation}/:id` + `/share/:slug`. `App.tsx` has bidirectional URL↔state sync (URL params → activeTableId+activeItemType; state changes push history via navigateToArtifact). Cross-artifact deep links + browser back/forward + copy-URL-to-share all work without extra code per artifact type.
  - **Chat tool progression**: `build_demo` emits `tool_progress` events with phases `"preparing" | "bundling" | "injecting" | "finalizing"` — surfaced in the existing `ToolCallCard` ProgressStrip. ChatCodingFlowCard (multi-step visualization) deferred to V2.
  - **Env vars**: `DEMO_HOME` (default `~/.imagebase/demos`), `PUBLIC_URL_BASE` (default `https://www.imagebase.cc` in prod, `http://localhost:5173` in dev).
- **Skill cooperative activation (softDeps + _suggestActivate)**: Two mechanisms keep multi-skill workflows smooth. (1) `softDeps`: declarative per-skill dependency — when skill A is active and lists B in softDeps, B's `lastUsedTurn` is refreshed every end-of-turn, protecting it from 10-turn idle eviction. Non-transitive (A.softDeps=[B], B.softDeps=[C] → A only protects B, not C) to keep the graph tractable. Analyst sets `["idea-skill", "table-skill"]` so analysis sessions don't lose the ability to write to idea/table at the tail. Domain skills set `["analyst-skill"]` similarly. (2) `_suggestActivate`: tools return `_suggestActivate: [{skill, reason}]` in their output → agent loop activates those skills before the next round. The `processSuggestActivate` helper in `chatAgentService.ts` parses this post-JSON-decode; non-matching hints are ignored. Handled in addition to, not replacing, trigger-based auto-activation and explicit `activate_skill` calls. Active skills' `promptFragment` fields are concatenated into the system prompt so each skill's rules (e.g. Analyst's truncation + disambiguation; finance's "历史 ≠ 未来" caveat) are in force while loaded.

## Deployment
```bash
# On server (root@163.7.1.94):
cd /root/ai-filter-lark
git pull
npm run install:all
npm run build
pm2 restart ai-filter
```
Domain: https://www.imagebase.cc

## Project Documentation
- `docs/design.md` - 系统设计文档（产品设计、PRD、技术方案、Edge Cases）
- `docs/test-plan.md` - 测试计划与测试用例（P0 功能可用性 + P1 产品体验）
- `docs/design-resources.md` - 设计资源（色彩、排版、间距、组件规范、交互规范）
- `docs/changelog.md` - 更新日志（所有发布部署记录）
- `docs/case-study.md` - 项目案例文档（完整开发故事 + PM 协作指南）
- `docs/chat-sidebar-plan.md` - Chat Sidebar (Table Agent) 技术方案（MCP Server + 流式对话 + 上下文管理）
- `docs/chatbot-openclaw-plan.md` - OpenClaw-style Agent 架构方案（Agent identity / 多层 Prompt / 记忆体系 / 分阶段落地）
- `docs/idea-artifact-plan.md` - Idea（灵感）Markdown doc artifact 方案（Prisma model / version 乐观并发 / SSE / @mention 语法 + 跳转）
- `docs/analyst-skill-plan.md` - Analyst (AI 问数) 方案
- `docs/vibe-demo-plan.md` - Vibe Demo (Vibe design + Vibe coding) 方案（Demo artifact / URL 路由改造 / ID 格式统一 / window.ImageBase SDK / capability 声明 / publish to /share/:slug / V1-V5 分期）（DuckDB 计算引擎 + parquet 快照 + softDeps 链式激活 + 长任务 SSE 协议 + 三层领域 skill + P1-P5 分期）

## Skills（自动加载的专业指令集）
每个 Skill 在对应场景下会被 Claude Code 自动激活，无需手动引用。

| Skill 文件 | 使用场景 | 核心内容 |
|------------|---------|---------|
| `.claude/skills/ux-frontend-design.md` | 新增/修改任何 UI 组件、样式、交互 | 色彩体系、间距规范、组件尺寸、交互模式、Figma 库 Key、CSS 命名、动画规范 |
| `.claude/skills/api-conventions.md` | 新增/修改 API 端点、SSE 事件、前端 API 客户端 | URL 命名规范、HTTP 方法约定、请求/响应格式、SSE 事件格式、EventBus 模式、错误码、ID 生成规则 |
| `.claude/skills/ai-prompt-patterns.md` | 新增/修改 AI 功能、调试 Prompt、调参 | 温度选择策略、结构化输出模板、Tool Use 模式、Prompt 结构规范、三个 AI 服务对比、调试指南 |
| `.claude/skills/deployment.md` | 部署代码、配置服务器、排查生产问题、回滚 | 服务器信息、部署命令、PM2/Nginx 配置、SSL 证书、回滚策略、健康检查、常见问题排查 |

## Deployment Checklist (发布部署检查清单)
每次发布部署前，必须完成以下检查项：

### 必选项（阻断发布）
- [ ] **P0 用例全部通过** — 跑一遍 `docs/test-plan.md` 中所有 P0 用例，全部通过才可部署
- [ ] **更新 CLAUDE.md** — 如有架构/结构/命令变更，同步更新本文件
- [ ] **更新设计文档** — `docs/design.md` 中对应功能模块的 PRD、技术方案、Edge Cases
- [ ] **更新测试用例** — `docs/test-plan.md` 中新增/修改的功能对应的 P0 和 P1 用例
- [ ] **更新设计资源** — `docs/design-resources.md` 如有新增颜色、组件、交互模式
- [ ] **更新前端设计 Skill** — `.claude/skills/ux-frontend-design.md` 如有新的设计模式或规范
- [ ] **更新更新日志** — `docs/changelog.md` 添加本次发布记录（日期、commit、改动点、详细说明）
- [ ] **MCP 工具同步** — 如改动了 `backend/src/routes/*.ts`，必须同步更新 `backend/mcp-server/src/tools/*.ts`（见下方"MCP Server 与 REST API 的同步规则"）
- [ ] **Prisma schema 变更** — 如改动了 `backend/prisma/schema.prisma`，部署时必须同时跑 `npx prisma migrate deploy`（应用 SQL）**和** `npx prisma generate`（重新生成 TS 客户端）。两者缺一不可：只跑 migrate 会导致 DB 有新字段但 TS 代码引用不到（PrismaClientValidationError "Unknown field"）；只跑 generate 会导致代码引用数据库里还没有的字段。

### 部署流程
```bash
# 1. 确认所有文档已更新
# 2. 确认 P0 用例全部通过
# 3. 构建
npm run build
# 4. 提交代码
git add . && git commit
# 5. 推送并部署
git push origin <branch>
# Prisma schema 未变时：
ssh -i /path/to/key root@163.7.1.94 "cd /root/ai-filter-lark && git pull origin <branch> && npm run build && pm2 restart ai-filter"
# Prisma schema 有变时（新增/删字段、改类型等）— 注意必须同时 generate：
ssh -i /path/to/key root@163.7.1.94 "cd /root/ai-filter-lark && git pull origin <branch> && cd backend && npx prisma migrate deploy && npx prisma generate && cd .. && npm run build && pm2 restart ai-filter"
```

## MCP Server 与 REST API 的同步规则 (强制)

项目包含一个独立的 MCP Server (`backend/mcp-server/`)，将 REST API 暴露为模型可调用的工具给 Chat Agent 使用。**MCP 工具是 REST API 的镜像**，任何 API 变更都必须同步到对应的 MCP 工具，否则 Agent 会用错误的 schema 调用导致失败。

### 强制规则
每次修改任何 `backend/src/routes/*.ts` 文件时，**必须**同步检查并更新同名的 `backend/mcp-server/src/tools/*.ts`：

| REST 路由文件 | MCP 工具文件 | 映射关系 |
|---------------|--------------|---------|
| `routes/tableRoutes.ts` | `mcp-server/src/tools/tableTools.ts` | 每个 `router.post/put/delete` = 一个工具 |
| `routes/fieldRoutes.ts` | `mcp-server/src/tools/fieldTools.ts` | 同上 |
| `routes/recordRoutes.ts` | `mcp-server/src/tools/recordTools.ts` | 同上 |
| `routes/viewRoutes.ts` | `mcp-server/src/tools/viewTools.ts` | 同上 |

### 检查项（PR 提交前必过）
- [ ] **新增 endpoint** → 同步新增 MCP 工具（参数 schema + 工具描述）
- [ ] **删除 endpoint** → 同步删除对应 MCP 工具
- [ ] **修改参数/返回** → 更新 MCP 工具的 `inputSchema` 和返回格式
- [ ] **重命名 endpoint** → MCP 工具中的 URL 路径同步修改
- [ ] **共享 Zod schema** → `backend/src/schemas/` 目录是唯一数据源，route validator 和 MCP inputSchema 都必须 import 同一份

### 运行时校验机制
MCP server 启动时会调用主 backend 的 `GET /api/_schemas` 端点，对比本地工具定义与后端实际路由的 schema，不一致则启动失败。不要通过注释或 `// @ts-ignore` 绕过这个校验。

### 参考文档
完整技术方案见 `docs/chat-sidebar-plan.md` Phase 1.3 "MCP 工具与 REST API 的同步机制"。

## Figma Design Assets (强制使用)
每次涉及 UI 组件或图标的新增/修改时，**必须**：
1. 先激活 UX & Frontend Design Skill (`.claude/skills/ux-frontend-design.md`)
2. 通过 Figma MCP 工具从以下设计库获取最新规范，再进行编码：
   - **组件库**: File Key `7rik2X7IeAxfH0qXFklqjb` (UD-03-基础组件-桌面端)
   - **图标库**: File Key `z27mSnJ9vbBeW6VnkLVAg6` (UD-07-图标表情库)
3. 设计与代码不一致时，以 Figma 设计稿为准

## Important
- Never commit `backend/.env` (contains API keys). Use `.env.example` as template.
- The `thinking` mode in aiService.ts is set to `disabled` for the Volcano ARK API.
- `max_output_tokens` is set to 4096 to avoid truncation.
- Multi-model keys: `ARK_API_KEY` powers `doubao-2.0` via ARK; `ONEAPI_API_KEY` + `ONEAPI_BASE_URL` (default `https://oneapi.iline.work/v1`) power all Claude + GPT-5 models. Missing either key only downgrades the affected family — `doubao-2.0` stays available as the universal fallback.
- Analyst env vars (all optional, sensible defaults in `cleanupCron.ts` + `duckdbRuntime.ts`): `ANALYST_HOME` (override storage root, default `~/.imagebase/analyst`), `ANALYST_CLEANUP_INTERVAL_MS` (default 30 min), `ANALYST_IDLE_CLOSE_MS` (default 2h), `ANALYST_STALE_FILE_MS` (default 7d), `ANALYST_SNAPSHOT_MAX_AGE_MS` (default 30d).
