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
      chatRoutes.ts   - /api/chat/conversations + SSE message stream (Table Agent)
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
      mentionTools.ts     - Tier 1 cross-skill mention tools: `find_mentionable` (workspace+q → typed hits with pre-built `mentionUri` + `markdown`) + `list_incoming_mentions` (reverse-ref lookup for "what points at this?"). Always available — Agent uses these to build `@` links inside idea content without activating a skill.
      index.ts            - Tier partitioning: tier0Tools / tier1Tools / resolveActiveTools(activeSkillNames). Tier 1 now includes `list_tables`, `get_table`, `list_ideas`, `get_idea`, `find_mentionable`, `list_incoming_mentions`.
    src/skills/
      types.ts         - SkillDefinition (name / when / triggers / tools)
      tableSkill.ts    - Bundles field + record + view + table-write tools; triggers on 创建/删除/修改字段等
      ideaSkill.ts     - Bundles `ideaWriteTools` only (nav tools are Tier 1); triggers on 写/新增/追加/插入/替换 × 灵感/文档/idea/章节 in ZH + EN equivalents. Design/taste write skill placeholder reserved for v3+.
      index.ts         - allSkills / skillsByName registries
frontend/
  src/
    App.tsx           - Main app, multi-table state management, field order lifting
    api.ts            - API client functions (with CLIENT_ID + mutationFetch)
    hooks/
      useTableSync.ts   - Table-level SSE subscription hook for real-time data sync
      useDocumentSync.ts - Document-level SSE hook for sidebar table list sync
      useIdeaSync.ts    - Per-idea SSE hook (content + rename events) for Markdown editor live sync
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
ssh -i /path/to/key root@163.7.1.94 "cd /root/ai-filter-lark && git pull origin <branch> && npm run build && pm2 restart ai-filter"
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
