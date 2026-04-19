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
    index.ts          - Express server entry, serves static files in production
    mockData.ts       - Mock table data (fields, records)
    routes/
      tableRoutes.ts  - CRUD APIs for tables/fields/records/views
      aiRoutes.ts     - AI filter generation endpoint (SSE streaming)
      sseRoutes.ts    - Real-time sync SSE endpoints (table-level + document-level)
    services/
      aiService.ts    - Volcano ARK API integration, tool definitions, prompt
      dataStore.ts    - In-memory data store, AI tool functions
      eventBus.ts     - Event bus for real-time sync (table-level + document-level)
      filterEngine.ts - Client-side filter evaluation
frontend/
  src/
    App.tsx           - Main app, multi-table state management, field order lifting
    api.ts            - API client functions (with CLIENT_ID + mutationFetch)
    hooks/
      useTableSync.ts   - Table-level SSE subscription hook for real-time data sync
      useDocumentSync.ts - Document-level SSE hook for sidebar table list sync
    i18n/
      en.ts           - English translations (130+ keys)
      zh.ts           - Chinese translations (130+ keys)
      index.ts        - LanguageProvider, useTranslation hook, t() function
    components/
      FilterPanel/    - AI filter input + manual filter conditions UI
      TableView/      - Main table grid with drag-reorder, resize, edit
      Sidebar.tsx     - Sidebar with dynamic table list, drag-reorder, resize, create/delete
      DropdownMenu.tsx - Generic dropdown menu with section grouping, noop items
      Toolbar.tsx     - Toolbar with filter button
    services/
      filterEngine.ts - Client-side filter matching
```

## Architecture Notes
- Data is in-memory (mockData.ts), not persisted. Server restart resets data.
- Frontend Vite dev server proxies `/api` requests to backend on port 3001.
- TableView maintains column order in localStorage (`field_order_v1`), lifted to App.tsx via `onFieldOrderChange` callback so FilterPanel dropdown matches table column order.
- AI filter uses PRD format (`["field", "operator", value]`) internally, converted to/from app's internal filter format.
- AI service logs all API calls, tool calls, and timing to `backend/logs/` directory with GMT+8 timestamps.

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
