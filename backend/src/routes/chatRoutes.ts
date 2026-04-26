/**
 * /api/chat/* routes — Table Agent chat endpoints.
 *
 * REST:
 *   GET    /api/chat/conversations?workspaceId=xxx  — list conversations
 *   POST   /api/chat/conversations                  — create conversation { workspaceId }
 *   GET    /api/chat/conversations/:id/messages     — fetch message history
 *   DELETE /api/chat/conversations/:id              — delete conversation
 *
 * SSE:
 *   POST   /api/chat/conversations/:id/messages     — send user message, stream response
 *   POST   /api/chat/conversations/:id/confirm      — resolve pending danger-tool
 *   POST   /api/chat/conversations/:id/stop         — abort the current streaming turn
 */

import express, { type Request, type Response } from "express";
import * as convStore from "../services/conversationStore.js";
import { runAgent, resumeAfterConfirm, type AgentContext, type SseEvent } from "../services/chatAgentService.js";
import * as store from "../services/dbStore.js";
import { listSubagentRunsForConversation } from "../services/subagentRunStore.js";
import { listWorkflowRunsForConversation } from "../services/workflowRunStore.js";
import {
  getSuggestions,
  refreshSuggestions,
  DEFAULT_SUGGESTIONS,
} from "../services/suggestionService.js";

const router = express.Router();

// ─── Per-conversation ephemeral state (stored in the running server) ─────
// Aborts + pending confirmations are not persisted — they are ephemeral to
// the lifetime of a streaming turn.

interface TurnState {
  abortController: AbortController;
  pendingConfirmations: Map<string, { tool: string; args: Record<string, unknown> }>;
}

const turnStates = new Map<string, TurnState>();

function getOrCreateTurnState(conversationId: string): TurnState {
  let state = turnStates.get(conversationId);
  if (!state) {
    state = {
      abortController: new AbortController(),
      pendingConfirmations: new Map(),
    };
    turnStates.set(conversationId, state);
  }
  return state;
}

function resetAbortController(conversationId: string): AbortController {
  const state = getOrCreateTurnState(conversationId);
  state.abortController = new AbortController();
  return state.abortController;
}

// ─── SSE helpers ─────────────────────────────────────────────────────────

function setupSse(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function writeEvent(res: Response, e: SseEvent) {
  res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
}

// ─── REST endpoints ──────────────────────────────────────────────────────

// GET /api/chat/context-snapshot?workspaceId=xxx
// Thin summary of the current document — used by the chat sidebar's
// "refresh / new conversation" flow to render a "已加载 N 张表、M 个字段"
// hint so the user knows what the Agent will see before their first prompt.
// The full context (Document Snapshot) is still built inside chatAgentService
// on each message; this endpoint is purely a UX warm-up.
router.get("/context-snapshot", async (req: Request, res: Response) => {
  const workspaceId = (req.query.workspaceId as string) || "doc_default";
  try {
    const tables = await store.listTablesForWorkspace(workspaceId);
    let fieldCount = 0;
    let recordCount = 0;
    for (const t of tables) {
      const detail = await store.getTable(t.id);
      if (!detail) continue;
      fieldCount += detail.fields.length;
      recordCount += detail.records.length;
    }
    res.json({
      workspaceId,
      tableCount: tables.length,
      fieldCount,
      recordCount,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to build context snapshot",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// GET /api/chat/suggestions?workspaceId=xxx
// Returns the cached 3-5 AI-generated prompt suggestions for the document's
// welcome page. On cache-miss, kicks off an async refresh and returns
// defaults so the UI never shows an empty state.
router.get("/suggestions", (req: Request, res: Response) => {
  const workspaceId = (req.query.workspaceId as string) || "doc_default";
  const entry = getSuggestions(workspaceId);
  if (entry) {
    res.json({
      workspaceId,
      suggestions: entry.suggestions,
      updatedAt: entry.updatedAt,
      stale: false,
    });
    return;
  }
  // Fire-and-forget refresh so the next call is warm
  void refreshSuggestions(workspaceId);
  res.json({
    workspaceId,
    suggestions: DEFAULT_SUGGESTIONS,
    updatedAt: 0,
    stale: true,
  });
});

// POST /api/chat/suggestions/refresh
// Force-refresh hook (e.g. after significant document edits). Returns the
// freshly generated pack once ready — the scheduler will also pick it up on
// its next tick, this is just an impatient shortcut.
router.post("/suggestions/refresh", async (req: Request, res: Response) => {
  const { workspaceId = "doc_default" } = (req.body as { workspaceId?: string }) || {};
  try {
    const suggestions = await refreshSuggestions(workspaceId);
    const entry = getSuggestions(workspaceId);
    res.json({
      workspaceId,
      suggestions,
      updatedAt: entry?.updatedAt ?? Date.now(),
      stale: false,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to refresh suggestions",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// GET /api/chat/conversations?workspaceId=xxx
router.get("/conversations", async (req: Request, res: Response) => {
  const workspaceId = (req.query.workspaceId as string) || "doc_default";
  try {
    const list = await convStore.listConversations(workspaceId);
    res.json(list);
  } catch (err) {
    // Previously threw into Express default handler → bare 500 + empty
    // sidebar in the UI. Surface the real reason so "lost conversations"
    // isn't invisible.
    console.error(`[chatRoutes] list conversations (ws=${workspaceId}) failed:`, err);
    res.status(500).json({
      error: `Failed to list conversations: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

// POST /api/chat/conversations
// Body: { workspaceId, agentId? } — agentId defaults to "agent_default"
router.post("/conversations", async (req: Request, res: Response) => {
  const { workspaceId, agentId } = req.body as { workspaceId?: string; agentId?: string };
  if (!workspaceId) {
    res.status(400).json({ error: "workspaceId is required" });
    return;
  }
  const conv = await convStore.createConversation(
    workspaceId,
    undefined,
    agentId ?? "agent_default"
  );
  res.json(conv);
});

// GET /api/chat/conversations/:id/messages?limit=30&before=<msgId>
//   limit  默认 30(无上限,但前端只用 30/page)
//   before 指定时,返回 timestamp < 该消息的最新 N 条(用于"向上滚动加载更多")
//   返回 { conversation, messages: asc-order, hasMore }
//   不传 limit/before → 兼容旧版返回全部历史
router.get("/conversations/:id/messages", async (req: Request, res: Response) => {
  const conv = await convStore.getConversation(req.params.id);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const limitRaw = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : NaN;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : undefined;
  const before = typeof req.query.before === "string" ? req.query.before : undefined;
  const result = await convStore.getMessages(req.params.id, { limit, before });
  // V2.1 fetch + join SubagentRun + WorkflowRun for these messages so FE
  // can re-render SubagentBlock + WorkflowBlock on history reload.
  const messageIds = result.messages.map((m) => m.id);
  const [subagentRuns, workflowRuns] = await Promise.all([
    messageIds.length > 0
      ? listSubagentRunsForConversation(req.params.id).catch(() => [])
      : Promise.resolve([] as any[]),
    messageIds.length > 0
      ? listWorkflowRunsForConversation(req.params.id).catch(() => [])
      : Promise.resolve([] as any[]),
  ]);
  // Group runs by parentMessageId for FE attachment.
  const subagentByMsg: Record<string, any[]> = {};
  for (const r of subagentRuns) {
    const key = r.parentMessageId;
    (subagentByMsg[key] = subagentByMsg[key] || []).push(r);
  }
  const workflowByMsg: Record<string, any[]> = {};
  for (const r of workflowRuns) {
    const key = r.parentMessageId;
    (workflowByMsg[key] = workflowByMsg[key] || []).push(r);
  }
  // V1 PR3 used "pending_<conversationId>" as parentMessageId fallback (host
  // user msg not persisted yet). Reattach those rows to the LAST assistant
  // message of the conversation so they show up under the right turn.
  const pendingKey = `pending_${req.params.id}`;
  const lastAssistant = [...result.messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant) {
    if (subagentByMsg[pendingKey]) {
      subagentByMsg[lastAssistant.id] = [
        ...(subagentByMsg[lastAssistant.id] ?? []),
        ...subagentByMsg[pendingKey],
      ];
      delete subagentByMsg[pendingKey];
    }
    if (workflowByMsg[pendingKey]) {
      workflowByMsg[lastAssistant.id] = [
        ...(workflowByMsg[lastAssistant.id] ?? []),
        ...workflowByMsg[pendingKey],
      ];
      delete workflowByMsg[pendingKey];
    }
  }
  // Attach to messages.
  const enrichedMessages = result.messages.map((m) => ({
    ...m,
    subagentRuns: subagentByMsg[m.id] ?? [],
    workflowRuns: workflowByMsg[m.id] ?? [],
  }));
  res.json({ conversation: conv, messages: enrichedMessages, hasMore: result.hasMore });
});

// DELETE /api/chat/conversations/:id
router.delete("/conversations/:id", async (req: Request, res: Response) => {
  const ok = await convStore.deleteConversation(req.params.id);
  turnStates.delete(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json({ ok: true });
});

// ─── SSE: send message ──────────────────────────────────────────────────
// POST /api/chat/conversations/:id/messages
// Body: { message: string }
router.post("/conversations/:id/messages", async (req: Request, res: Response) => {
  // Outer guard: anything that throws *before* setupSse reaches this
  // handler and would otherwise bubble into Express's default 500 with no
  // body — the FE then only sees "HTTP 500" with no clue. Log the full
  // error and return a structured JSON body so the chat UI can surface a
  // real message.
  let sseStarted = false;
  try {
    const conv = await convStore.getConversation(req.params.id);
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const { message, mentions } = req.body as {
      message?: string;
      // PR2: structured @ mentions extracted FE-side. Used by the host
      // agent loop to apply strong typed routing — `model` mentions force
      // the workflow to spawn a subagent on that model; `table` / `idea`
      // mentions are injected into Turn Context as references.
      mentions?: Array<
        | { type: "model"; modelId: string }
        | { type: "table"; tableId: string }
        | { type: "idea"; ideaId: string }
        | { type: "idea-section"; ideaId: string; section: string }
        | { type: "design"; designId: string }
        | { type: "taste"; tasteId: string; designId: string }
      >;
    };
    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    setupSse(res);
    sseStarted = true;

    const state = getOrCreateTurnState(req.params.id);
    const ac = resetAbortController(req.params.id);

    // Client disconnect → abort
    let responseEnded = false;
    res.on("close", () => {
      if (!responseEnded) ac.abort();
    });

    const ctx: AgentContext = {
      conversationId: req.params.id,
      workspaceId: conv.workspaceId,
      agentId: conv.agentId ?? undefined,
      pendingConfirmations: state.pendingConfirmations,
      // 透传 JWT cookie，让 MCP loopback 调用时仍然认得出原 user
      authToken: (req as any).cookies?.ibase_auth,
      // PR2: passthrough — chatAgentService.runAgent reads this to compose
      // routing hints into the system prompt's Turn Context block.
      userMentions: Array.isArray(mentions) ? mentions : undefined,
    };

    try {
      for await (const event of runAgent(ctx, message.trim(), ac.signal)) {
        writeEvent(res, event);
      }
    } catch (err) {
      console.error("[chatRoutes] runAgent threw:", err);
      writeEvent(res, {
        event: "error",
        data: {
          code: "INTERNAL",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      responseEnded = true;
      res.end();
    }
  } catch (outerErr) {
    const msg = outerErr instanceof Error ? outerErr.message : String(outerErr);
    console.error("[chatRoutes] outer failure before/during SSE:", outerErr);
    if (!sseStarted) {
      // Express will serialize this into a 500 body the FE can parse, so the
      // user sees the actual reason instead of a bare "HTTP 500".
      res.status(500).json({ error: `chat request failed: ${msg}` });
    } else {
      // SSE already open — try to write a final error event if we still can.
      try {
        writeEvent(res, {
          event: "error",
          data: { code: "INTERNAL", message: msg },
        });
        res.end();
      } catch {
        /* response already closed */
      }
    }
  }
});

// ─── SSE: confirm danger tool ──────────────────────────────────────────
// POST /api/chat/conversations/:id/confirm
// Body: { callId: string, confirmed: boolean }
router.post("/conversations/:id/confirm", async (req: Request, res: Response) => {
  let sseStarted = false;
  try {
    const conv = await convStore.getConversation(req.params.id);
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const { callId, confirmed } = req.body as { callId?: string; confirmed?: boolean };
    if (!callId || typeof confirmed !== "boolean") {
      res.status(400).json({ error: "callId and confirmed are required" });
      return;
    }

    setupSse(res);
    sseStarted = true;

    const state = getOrCreateTurnState(req.params.id);
    const ac = resetAbortController(req.params.id);
    let responseEnded = false;
    res.on("close", () => {
      if (!responseEnded) ac.abort();
    });

    const ctx: AgentContext = {
      conversationId: req.params.id,
      workspaceId: conv.workspaceId,
      agentId: conv.agentId ?? undefined,
      pendingConfirmations: state.pendingConfirmations,
      authToken: (req as any).cookies?.ibase_auth,
    };

    try {
      for await (const event of resumeAfterConfirm(ctx, callId, confirmed, ac.signal)) {
        writeEvent(res, event);
      }
    } catch (err) {
      console.error("[chatRoutes] resumeAfterConfirm threw:", err);
      writeEvent(res, {
        event: "error",
        data: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      responseEnded = true;
      res.end();
    }
  } catch (outerErr) {
    const msg = outerErr instanceof Error ? outerErr.message : String(outerErr);
    console.error("[chatRoutes] confirm outer failure:", outerErr);
    if (!sseStarted) {
      res.status(500).json({ error: `confirm request failed: ${msg}` });
    } else {
      try {
        writeEvent(res, { event: "error", data: { code: "INTERNAL", message: msg } });
        res.end();
      } catch { /* closed */ }
    }
  }
});

// ─── Stop current turn ──────────────────────────────────────────────────
// POST /api/chat/conversations/:id/stop
router.post("/conversations/:id/stop", (req: Request, res: Response) => {
  const state = turnStates.get(req.params.id);
  if (state) {
    state.abortController.abort();
  }
  res.json({ ok: true });
});

export default router;
