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
      sseRoutes.ts    - Real-time sync SSE endpoint (/api/sync/:tableId/events)
    services/
      aiService.ts    - Volcano ARK API integration, tool definitions, prompt
      dataStore.ts    - In-memory data store, AI tool functions
      eventBus.ts     - Event bus for real-time sync (EventEmitter, per tableId)
      filterEngine.ts - Client-side filter evaluation
frontend/
  src/
    App.tsx           - Main app, state management, field order lifting
    api.ts            - API client functions (with CLIENT_ID + mutationFetch)
    hooks/
      useTableSync.ts - SSE subscription hook for real-time data sync
    components/
      FilterPanel/    - AI filter input + manual filter conditions UI
      TableView/      - Main table grid with drag-reorder, resize, edit
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
Domain: http://www.baseimage.cn

## Project Documentation
- `docs/design.md` - 系统设计文档（产品设计、PRD、技术方案、Edge Cases）
- `docs/test-plan.md` - 测试计划与测试用例（P0 功能可用性 + P1 产品体验）
- `docs/design-resources.md` - 设计资源（色彩、排版、间距、组件规范、交互规范）
- `docs/changelog.md` - 更新日志（所有发布部署记录）
- `.claude/skills/ux-frontend-design.md` - UX & 前端设计 Skill

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
