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
    services/
      aiService.ts    - Volcano ARK API integration, tool definitions, prompt
      dataStore.ts    - In-memory data store, AI tool functions
      filterEngine.ts - Client-side filter evaluation
frontend/
  src/
    App.tsx           - Main app, state management, field order lifting
    api.ts            - API client functions
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

## Important
- Never commit `backend/.env` (contains API keys). Use `.env.example` as template.
- The `thinking` mode in aiService.ts is set to `disabled` for the Volcano ARK API.
- `max_output_tokens` is set to 4096 to avoid truncation.
