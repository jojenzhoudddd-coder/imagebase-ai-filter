# API Conventions Skill

Use this skill when implementing or modifying any backend API endpoint, frontend API client function, or SSE event handler. It codifies the project's API naming, error handling, SSE event format, and request/response conventions to ensure consistency.

## When to Use
- Adding new API endpoints (routes)
- Adding new frontend API client functions (`api.ts`)
- Adding new SSE event types
- Modifying request/response formats
- Adding error handling to endpoints
- Reviewing API changes for consistency

## API Naming Conventions

### URL Structure
```
/api/tables                          — Table list
/api/tables/:tableId                 — Single table (GET/PUT/DELETE)
/api/tables/:tableId/fields          — Field list
/api/tables/:tableId/fields/:fieldId — Single field
/api/tables/:tableId/records         — Record list
/api/tables/:tableId/records/:recordId — Single record
/api/tables/:tableId/views           — View list
/api/tables/views/:viewId            — Single view (no tableId prefix)
/api/ai/filter/generate              — AI filter generation (SSE)
/api/ai/fields/suggest               — AI field suggestion
/api/ai/table/generate               — AI table generation (SSE)
/api/sync/:tableId/events            — Table-level SSE
/api/sync/documents/:docId/events    — Document-level SSE
/api/documents/:docId                — Document metadata
```

### HTTP Methods
| Operation | Method | URL Pattern | Example |
|-----------|--------|-------------|---------|
| List | GET | `/api/{resource}` | `GET /api/tables` |
| Get one | GET | `/api/{resource}/:id` | `GET /api/tables/:tableId` |
| Create | POST | `/api/{resource}` | `POST /api/tables/:tableId/fields` |
| Update | PUT | `/api/{resource}/:id` | `PUT /api/tables/:tableId` |
| Delete | DELETE | `/api/{resource}/:id` | `DELETE /api/tables/:tableId` |
| Batch delete | POST | `/api/{resource}/batch-delete` | `POST /api/tables/:tableId/records/batch-delete` |
| Batch create | POST | `/api/{resource}/batch-create` | `POST /api/tables/:tableId/records/batch-create` |
| Query (filtered) | POST | `/api/{resource}/query` | `POST /api/tables/:tableId/records/query` |
| Special action | POST | `/api/{resource}/:id/{action}` | `POST /api/tables/:tableId/reset` |

### Naming Rules
- Use kebab-case for multi-word URL segments: `batch-delete`, `batch-create`, `batch-restore`
- Resource names are plural: `tables`, `fields`, `records`, `views`, `documents`
- AI endpoints grouped under `/api/ai/`
- SSE endpoints grouped under `/api/sync/`
- No trailing slashes

## Request Conventions

### Headers
| Header | Required | Purpose |
|--------|----------|---------|
| `Content-Type: application/json` | Yes (POST/PUT) | Request body format |
| `X-Client-Id` | Recommended | Identifies client for SSE sync — events from same clientId are ignored by that client |

### Client ID
- Frontend generates a unique `CLIENT_ID` per browser tab (UUID v4, stored in module scope)
- All mutation requests include `X-Client-Id` header via `mutationFetch()` wrapper
- SSE connections require `clientId` query parameter: `?clientId=${encodeURIComponent(CLIENT_ID)}`
- Backend defaults to `"unknown"` if header is missing

### Request Body Patterns
```typescript
// Create — full object (minus id, which server generates)
POST /api/tables/:tableId/fields
{ "name": "Status", "type": "SingleSelect", "config": { "options": [...] } }

// Update — partial object (only changed fields)
PUT /api/tables/:tableId/fields/:fieldId
{ "name": "New Name" }  // only name changed, type/config unchanged

// Batch operations — array of IDs
POST /api/tables/:tableId/records/batch-delete
{ "recordIds": ["rec_001", "rec_002"] }

// Query — filter + sort
POST /api/tables/:tableId/records/query
{ "filter": { "logic": "and", "conditions": [...] }, "sort": { "fieldId": "...", "order": "asc" } }
```

## Response Conventions

### Success Responses
```typescript
// Single resource — return the resource object
{ "id": "fld_xxx", "name": "Status", "type": "SingleSelect", ... }

// List — return array directly (no wrapper)
[{ "id": "fld_xxx", ... }, { "id": "fld_yyy", ... }]

// Mutation with no meaningful return — return ok
{ "ok": true }

// Batch operation — return count
{ "deleted": 3 }
{ "created": 5 }

// Query — return records + total
{ "records": [...], "total": 42 }
```

### Error Responses
```typescript
// 400 Bad Request — missing or invalid parameters
{ "error": "query is required" }
{ "error": "tableId is required" }

// 404 Not Found — resource doesn't exist
{ "error": "Table not found" }
{ "error": "Field not found" }
{ "error": "Record not found" }
{ "error": "View not found" }

// 500 Internal Server Error — unexpected failures
{ "error": "Internal server error" }
```

### Error Code Patterns
- Error messages are human-readable English strings
- No numeric error codes — use HTTP status codes only
- Validate required fields first, return 400 before any processing
- Check resource existence second, return 404
- Wrap business logic in try-catch, return 500 with generic message

## SSE Event Format

### Connection Setup (Server)
```typescript
res.setHeader("Content-Type", "text/event-stream");
res.setHeader("Cache-Control", "no-cache");
res.setHeader("Connection", "keep-alive");
res.setHeader("X-Accel-Buffering", "no");  // Required for Nginx proxy
res.flushHeaders();
```

### Event Wire Format
```
event: {eventName}\ndata: {JSON}\n\n
```

### Standard SSE Events

#### Connection Events
```
event: connected
data: { "clientId": "xxx", "timestamp": 1234567890 }

event: heartbeat
data: {}
```
Heartbeat interval: 30 seconds.

#### Document-Level Events (`/api/sync/documents/:docId/events`)
```
event: document-change
data: {
  "type": "table:create" | "table:delete" | "table:reorder" | "table:rename",
  "documentId": "doc_xxx",
  "clientId": "sender-client-id",
  "timestamp": 1234567890,
  "payload": { ... }
}
```

#### Table-Level Events (`/api/sync/:tableId/events`)
```
event: table-change
data: {
  "type": "record:create" | "record:update" | "record:delete" | ...,
  "tableId": "tbl_xxx",
  "clientId": "sender-client-id",
  "timestamp": 1234567890,
  "payload": { ... }
}
```

Table-level event types:
- `document:update` — document metadata changed
- `table:update` — table metadata changed
- `record:create`, `record:update`, `record:delete`, `record:batch-delete`, `record:batch-create`
- `field:create`, `field:update`, `field:delete`, `field:batch-delete`, `field:batch-restore`
- `view:create`, `view:update`, `view:delete`
- `full-sync` — sent on reconnect, client should refetch all data

#### AI SSE Events (`/api/ai/filter/generate`, `/api/ai/table/generate`)
```
event: start
data: { "requestId": "req-1234567890" }

event: thinking        (filter only)
data: { "text": "..." }

event: result          (filter)
data: { "filter": { "logic": "and", "conditions": [...] } }

event: fields          (table generate)
data: { "fields": [{ "name": "...", "type": "...", ... }] }

event: error
data: { "code": "AI_ERROR", "message": "..." }

event: done
data: {}
```

### Frontend SSE Client Pattern
```typescript
// Use fetch + ReadableStream for POST SSE (EventSource only supports GET)
const response = await fetch(url, { method: "POST", body, signal: abortController.signal });
const reader = response.body!.getReader();
const decoder = new TextDecoder();

// Parse event/data line pairs from SSE stream
// See api.ts generateFilter() / generateTableStructure() for reference implementation
```

## EventBus Pattern (Backend)

### Emitting Events
```typescript
// Table-level change — after any mutation to fields/records/views
eventBus.emitChange({
  type: "record:update",
  tableId,
  clientId: getClientId(req),
  timestamp: Date.now(),
  payload: { record: updatedRecord },
});

// Document-level change — after table create/delete/reorder/rename
eventBus.emitDocumentChange({
  type: "table:create",
  documentId,
  clientId: getClientId(req),
  timestamp: Date.now(),
  payload: { table: { id, name, order } },
});
```

### Rules
1. Every mutation endpoint MUST emit a corresponding event
2. Always include `clientId` from request header
3. Payload should contain the affected resource (the created/updated/deleted object)
4. Use specific event types (`record:update`) not generic ones (`change`)

## Frontend API Client Pattern (`api.ts`)

### mutationFetch Wrapper
All mutation requests (POST/PUT/DELETE) go through `mutationFetch()` which:
1. Adds `X-Client-Id` header automatically
2. Adds `Content-Type: application/json` header
3. Calls `fetch()` with the provided options

### Function Naming
```typescript
// CRUD operations: verb + Resource
createField(tableId, field)
updateField(tableId, fieldId, updates)
deleteField(tableId, fieldId)
batchDeleteRecords(tableId, recordIds)

// AI operations: verb + purpose
generateFilter(opts)            // SSE streaming
suggestFields(tableId, opts)    // sync
generateTableStructure(opts)    // SSE streaming

// Table operations
createTable(name, documentId, language)
deleteTable(tableId, documentId)
renameTable(tableId, name)
resetTable(tableId, fields, language)
reorderTables(updates, documentId)
```

## ID Generation
- Table IDs: `tbl_` + UUID v4 (server-generated)
- Field IDs: `fld_` + UUID v4 (server-generated)
- Record IDs: `rec_` + UUID v4 (server-generated)
- View IDs: `view_` + UUID v4 (server-generated)
- Document IDs: `doc_` + static (currently `doc_default`)
- Client IDs: UUID v4 (frontend-generated per tab)
- Option IDs: `opt_` + random 4 chars (AI-generated for select fields)
- Agent IDs: `cuid()` (Prisma-generated); default seed uses fixed `agent_default`
- Conversation IDs: `cuid()` (Prisma-generated); `conv_` prefix when exposed over SSE
- Message IDs: `msg_` + UUID v4 when surfaced via SSE events

## Phase 1 · Agent Identity Endpoints

The Chat Agent's identity lives on the filesystem at `~/.imagebase/agents/<agentId>/`
but is accessed through this REST surface. Override the root with the
`AGENT_HOME` env var (used by tests).

```
GET    /api/agents                       — list agents for default user
POST   /api/agents                       — create agent { name?, avatarUrl? }
GET    /api/agents/:agentId              — agent metadata
PUT    /api/agents/:agentId              — { name?, avatarUrl? }
DELETE /api/agents/:agentId              — remove DB row (filesystem preserved!)

GET    /api/agents/:agentId/identity         — { soul, profile, config } bundle
PUT    /api/agents/:agentId/identity/soul    — { content } — replaces soul.md
PUT    /api/agents/:agentId/identity/profile — { content } — replaces profile.md
PUT    /api/agents/:agentId/identity/config  — JSON patch merged into config.json
```

Conventions specific to identity writes:
- **Size cap**: 64 KiB per file. Over → `400 { error: "内容超过 64 KiB 上限" }`.
- **Empty rejection**: soul/profile PUT with empty string or whitespace-only
  content → `400 { error: "content 不能为空" }`.
- **Delete semantics**: DELETE `/api/agents/:id` removes the DB row ONLY. The
  filesystem (identity + memory) is NEVER auto-deleted — irreversible loss
  avoidance. Operators clean up `~/.imagebase/agents/<id>/` manually if
  desired.
- **Fallback**: when a chat conversation has `agentId = NULL` (e.g. after its
  Agent was deleted), chatAgentService falls back to `agent_default` and the
  conversation continues.

## Phase 1 · Agent binding on chat conversations

`POST /api/chat/conversations` accepts an optional `agentId` in the body:

```jsonc
{ "workspaceId": "doc_default", "agentId": "agent_default" }
```

If omitted, server defaults to `"agent_default"`. The conversation row stores
`agentId` (nullable FK), and `chatAgentService` threads it into both the
three-layer system prompt (Layer 2 reads `<agent>/soul.md + profile.md`) and
into `ToolContext` so meta-tools can edit the right filesystem.

## ToolContext convention (MCP tools)

Tool handler signature is now:

```typescript
type ToolHandler = (args: any, ctx?: ToolContext) => Promise<string>;
interface ToolContext { agentId: string; }
```

Data-plane tools (tableTools / fieldTools / recordTools / viewTools) ignore
`ctx`. Meta-tools (update_profile / update_soul / create_memory) use
`resolveAgentId(args.agentId ?? ctx.agentId ?? "agent_default")` so MCP stdio
callers and ad-hoc tests can still pass `agentId` explicitly; the in-process
agent loop always injects `ctx.agentId`.
